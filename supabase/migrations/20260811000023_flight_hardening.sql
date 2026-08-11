-- Migration 23: make flight replacement atomic and propagate divisions through
-- every draft scoring entity (spec §5.2, §6.1, §11.8).
--
-- The original replace-whole-set function cleared assignments before it had
-- validated the full payload. Because a PL/pgSQL RETURN commits prior writes,
-- a rejected later flight could still erase valid assignments. This replacement
-- validates and normalizes the complete request while holding the event lock,
-- and only then begins the mutation phase.

create or replace function public.set_event_flights(
  p_event_id uuid,
  p_flights jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.events%rowtype;
  v_flight jsonb;
  v_flight_id uuid;
  v_existing_event_id uuid;
  v_participant_text text;
  v_participant_id uuid;
  v_name text;
  v_index integer := 0;
  v_kept uuid[] := array[]::uuid[];
  v_seen_flight_ids uuid[] := array[]::uuid[];
  v_seen_names text[] := array[]::text[];
  v_seen_participant_ids uuid[] := array[]::uuid[];
  v_flight_participant_ids uuid[];
  v_participant_flights jsonb := '{}'::jsonb;
  v_normalized jsonb := '[]'::jsonb;
  v_before_flights jsonb;
  v_after_flights jsonb;
  v_before jsonb;
  v_after jsonb;
  v_flighting text;
  v_skins_population text;
  v_temp_prefix text := '__gtt_flight_replace_' || gen_random_uuid()::text || '_';
begin
  if auth.uid() is null then
    return jsonb_build_object('status', 'rejected', 'error_code', 'AUTH_REQUIRED');
  end if;

  -- A disabled profile must not retain organizer powers through an already
  -- issued JWT. Keep the public error vocabulary aligned with session checks.
  if not exists (
    select 1
    from public.profiles
    where id = auth.uid() and status = 'active'
  ) then
    return jsonb_build_object(
      'status', 'rejected',
      'error_code', 'AUTH_REQUIRED',
      'detail', 'inactive profile'
    );
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;
  if not found then
    return jsonb_build_object(
      'status', 'rejected',
      'error_code', 'SNAPSHOT_INVALID',
      'detail', 'unknown event'
    );
  end if;

  if not (
    app.is_event_director(p_event_id)
    or app.has_role(v_event.league_id, array['owner', 'league_admin']::public.app_role[])
  ) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'NOT_ASSIGNED');
  end if;

  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    return jsonb_build_object(
      'status', 'rejected',
      'error_code', 'MFA_REQUIRED',
      'detail', 'Complete multi-factor verification before changing flights'
    );
  end if;

  if v_event.status <> 'draft' then
    return jsonb_build_object(
      'status', 'rejected',
      'error_code', 'EVENT_LOCKED',
      'detail', format(
        'flights are part of frozen setup; event status is %s',
        v_event.status
      )
    );
  end if;

  if p_flights is null or jsonb_typeof(p_flights) is distinct from 'array' then
    return jsonb_build_object(
      'status', 'rejected',
      'error_code', 'SNAPSHOT_INVALID',
      'detail', 'flights must be an array'
    );
  end if;

  -- Validation and normalization phase. No authoritative rows are changed
  -- before this loop and the team-coherence check below both finish.
  for v_flight in
    select item.value from jsonb_array_elements(p_flights) as item(value)
  loop
    v_index := v_index + 1;
    if jsonb_typeof(v_flight) is distinct from 'object' then
      return jsonb_build_object(
        'status', 'rejected',
        'error_code', 'SNAPSHOT_INVALID',
        'detail', format('flight %s must be an object', v_index)
      );
    end if;
    if exists (
      select 1
      from jsonb_object_keys(v_flight) as keys(key)
      where key not in ('id', 'name', 'participantIds')
    ) then
      return jsonb_build_object(
        'status', 'rejected',
        'error_code', 'SNAPSHOT_INVALID',
        'detail', format('flight %s contains an unknown field', v_index)
      );
    end if;
    if jsonb_typeof(v_flight -> 'name') is distinct from 'string' then
      return jsonb_build_object(
        'status', 'rejected',
        'error_code', 'SNAPSHOT_INVALID',
        'detail', format('flight %s needs a name', v_index)
      );
    end if;

    v_name := btrim(v_flight ->> 'name');
    if v_name = '' or char_length(v_name) > 60 then
      return jsonb_build_object(
        'status', 'rejected',
        'error_code', 'SNAPSHOT_INVALID',
        'detail', 'every flight needs a name of 1 to 60 characters'
      );
    end if;
    if lower(v_name) = any(v_seen_names) then
      return jsonb_build_object(
        'status', 'rejected',
        'error_code', 'SNAPSHOT_INVALID',
        'detail', format('duplicate flight name: %s', v_name)
      );
    end if;
    v_seen_names := array_append(v_seen_names, lower(v_name));

    if v_flight ? 'id' and jsonb_typeof(v_flight -> 'id') <> 'null' then
      if jsonb_typeof(v_flight -> 'id') is distinct from 'string'
        or (v_flight ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then
        return jsonb_build_object(
          'status', 'rejected',
          'error_code', 'SNAPSHOT_INVALID',
          'detail', format('flight %s has an invalid id', v_index)
        );
      end if;
      v_flight_id := (v_flight ->> 'id')::uuid;
    else
      v_flight_id := gen_random_uuid();
    end if;

    if v_flight_id = any(v_seen_flight_ids) then
      return jsonb_build_object(
        'status', 'rejected',
        'error_code', 'SNAPSHOT_INVALID',
        'detail', format('duplicate flight id: %s', v_flight_id)
      );
    end if;
    v_seen_flight_ids := array_append(v_seen_flight_ids, v_flight_id);

    select event_id into v_existing_event_id
    from public.flights
    where id = v_flight_id;
    if found and v_existing_event_id <> p_event_id then
      return jsonb_build_object(
        'status', 'rejected',
        'error_code', 'SNAPSHOT_INVALID',
        'detail', format('flight %s belongs to another event', v_flight_id)
      );
    end if;

    if jsonb_typeof(v_flight -> 'participantIds') is distinct from 'array' then
      return jsonb_build_object(
        'status', 'rejected',
        'error_code', 'SNAPSHOT_INVALID',
        'detail', format('flight %s participantIds must be an array', v_index)
      );
    end if;
    if exists (
      select 1
      from jsonb_array_elements(v_flight -> 'participantIds') as participant(value)
      where jsonb_typeof(value) <> 'string'
    ) then
      return jsonb_build_object(
        'status', 'rejected',
        'error_code', 'SNAPSHOT_INVALID',
        'detail', format('flight %s contains an invalid participant id', v_index)
      );
    end if;

    v_flight_participant_ids := array[]::uuid[];
    for v_participant_text in
      select participant.value
      from jsonb_array_elements_text(v_flight -> 'participantIds') as participant(value)
    loop
      if v_participant_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return jsonb_build_object(
          'status', 'rejected',
          'error_code', 'SNAPSHOT_INVALID',
          'detail', format('flight %s contains an invalid participant id', v_index)
        );
      end if;
      v_participant_id := v_participant_text::uuid;
      if v_participant_id = any(v_seen_participant_ids) then
        return jsonb_build_object(
          'status', 'rejected',
          'error_code', 'SNAPSHOT_INVALID',
          'detail', format('participant %s is assigned more than once', v_participant_id)
        );
      end if;
      if not exists (
        select 1
        from public.event_entries
        where event_id = p_event_id
          and participant_id = v_participant_id
          and status = 'active'
      ) then
        return jsonb_build_object(
          'status', 'rejected',
          'error_code', 'SNAPSHOT_INVALID',
          'detail', format('participant %s is not entered in this event', v_participant_id)
        );
      end if;
      v_seen_participant_ids := array_append(v_seen_participant_ids, v_participant_id);
      v_flight_participant_ids := array_append(
        v_flight_participant_ids,
        v_participant_id
      );
      v_participant_flights := v_participant_flights || jsonb_build_object(
        v_participant_id::text,
        v_flight_id::text
      );
    end loop;

    if cardinality(v_flight_participant_ids) = 0 then
      return jsonb_build_object(
        'status', 'rejected',
        'error_code', 'SNAPSHOT_INVALID',
        'detail', format('flight %s needs at least one active participant', v_index)
      );
    end if;

    v_kept := array_append(v_kept, v_flight_id);
    v_normalized := v_normalized || jsonb_build_array(jsonb_build_object(
      'id', v_flight_id,
      'name', v_name,
      'sortOrder', v_index,
      'participantIds', v_flight_participant_ids
    ));
  end loop;

  if jsonb_array_length(v_normalized) > 0 and cardinality(v_seen_participant_ids) <> (
    select count(*)
    from public.event_entries
    where event_id = p_event_id and status = 'active'
  ) then
    return jsonb_build_object(
      'status', 'rejected',
      'error_code', 'SNAPSHOT_INVALID',
      'detail', 'every active event participant must be assigned exactly once'
    );
  end if;

  -- A team is one scoring entity, so it cannot be divided between flights or
  -- inherit a flight while one of its members is unassigned. An empty flight
  -- set intentionally removes all division assignments and is allowed.
  if jsonb_array_length(v_normalized) > 0 and exists (
    select 1
    from public.event_teams et
    where et.event_id = p_event_id
      and (
        not exists (
          select 1
          from public.event_team_members etm
          where etm.event_team_id = et.id
        )
        or exists (
          select 1
          from public.event_team_members etm
          join public.event_entries ee on ee.id = etm.event_entry_id
          where etm.event_team_id = et.id
            and not (v_participant_flights ? ee.participant_id::text)
        )
        or 1 <> (
          select count(distinct v_participant_flights ->> ee.participant_id::text)
          from public.event_team_members etm
          join public.event_entries ee on ee.id = etm.event_entry_id
          where etm.event_team_id = et.id
        )
      )
  ) then
    return jsonb_build_object(
      'status', 'rejected',
      'error_code', 'SNAPSHOT_INVALID',
      'detail', 'every team member must be assigned to the same flight'
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id,
    'name', f.name,
    'sortOrder', f.sort_order,
    'participantIds', coalesce((
      select jsonb_agg(ee.participant_id order by p.sort_name, ee.participant_id)
      from public.event_entries ee
      join public.participants p on p.id = ee.participant_id
      where ee.event_id = p_event_id and ee.flight_id = f.id
    ), '[]'::jsonb),
    'teamIds', coalesce((
      select jsonb_agg(et.id order by et.name, et.id)
      from public.event_teams et
      where et.event_id = p_event_id and et.flight_id = f.id
    ), '[]'::jsonb)
  ) order by f.sort_order, f.id), '[]'::jsonb)
  into v_before_flights
  from public.flights f
  where f.event_id = p_event_id;
  v_before := jsonb_build_object(
    'flighting', case when jsonb_array_length(v_before_flights) > 0
      then 'per_flight' else 'none' end,
    'flights', v_before_flights
  );

  -- Mutation phase. All rejection paths are above this point; any unexpected
  -- database error below aborts the RPC statement and rolls back the whole set.
  update public.competition_entities ce
  set flight_id = null, updated_at = now()
  where exists (
    select 1
    from public.competitions c
    where c.id = ce.competition_id and c.event_id = p_event_id
  ) and ce.flight_id is not null;

  update public.event_teams
  set flight_id = null, updated_at = now()
  where event_id = p_event_id and flight_id is not null;

  update public.event_entries
  set flight_id = null, updated_at = now()
  where event_id = p_event_id and flight_id is not null;

  -- Move incumbent names out of the unique (event_id, name) namespace before
  -- upserts so renames and A/B name swaps remain atomic.
  update public.flights
  set name = v_temp_prefix || id::text, updated_at = now()
  where event_id = p_event_id;

  for v_flight in
    select item.value from jsonb_array_elements(v_normalized) as item(value)
  loop
    v_flight_id := (v_flight ->> 'id')::uuid;
    update public.flights
    set name = v_flight ->> 'name',
        sort_order = (v_flight ->> 'sortOrder')::integer,
        updated_at = now()
    where id = v_flight_id and event_id = p_event_id;
    if not found then
      -- A concurrent insert of the same caller-supplied id raises a unique
      -- violation here and rolls back the replacement; it can never update a
      -- flight owned by another event.
      insert into public.flights (id, event_id, name, sort_order)
      values (
        v_flight_id,
        p_event_id,
        v_flight ->> 'name',
        (v_flight ->> 'sortOrder')::integer
      );
    end if;
  end loop;

  delete from public.flights
  where event_id = p_event_id and not (id = any(v_kept));

  for v_flight in
    select item.value from jsonb_array_elements(v_normalized) as item(value)
  loop
    update public.event_entries ee
    set flight_id = (v_flight ->> 'id')::uuid, updated_at = now()
    where ee.event_id = p_event_id
      and ee.participant_id in (
        select participant.value::uuid
        from jsonb_array_elements_text(v_flight -> 'participantIds') as participant(value)
      );
  end loop;

  update public.event_teams et
  set flight_id = (
    select min(ee.flight_id::text)::uuid
    from public.event_team_members etm
    join public.event_entries ee on ee.id = etm.event_entry_id
    where etm.event_team_id = et.id
  ), updated_at = now()
  where et.event_id = p_event_id;

  update public.competition_entities ce
  set flight_id = case
    when ce.event_entry_id is not null then (
      select ee.flight_id from public.event_entries ee where ee.id = ce.event_entry_id
    )
    else (
      select et.flight_id from public.event_teams et where et.id = ce.event_team_id
    )
  end,
  updated_at = now()
  where exists (
    select 1
    from public.competitions c
    where c.id = ce.competition_id and c.event_id = p_event_id
  );

  v_flighting := case when jsonb_array_length(v_normalized) > 0
    then 'per_flight' else 'none' end;
  v_skins_population := case when v_flighting = 'per_flight'
    then 'flight' else 'field' end;
  update public.competitions
  set rules_json = case
        when format = 'skins' then jsonb_set(
          jsonb_set(rules_json, '{flighting}', to_jsonb(v_flighting), true),
          '{skins,population}',
          to_jsonb(v_skins_population),
          true
        )
        else jsonb_set(rules_json, '{flighting}', to_jsonb(v_flighting), true)
      end,
      updated_at = now()
  where event_id = p_event_id and status = 'draft';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id,
    'name', f.name,
    'sortOrder', f.sort_order,
    'participantIds', coalesce((
      select jsonb_agg(ee.participant_id order by p.sort_name, ee.participant_id)
      from public.event_entries ee
      join public.participants p on p.id = ee.participant_id
      where ee.event_id = p_event_id and ee.flight_id = f.id
    ), '[]'::jsonb),
    'teamIds', coalesce((
      select jsonb_agg(et.id order by et.name, et.id)
      from public.event_teams et
      where et.event_id = p_event_id and et.flight_id = f.id
    ), '[]'::jsonb)
  ) order by f.sort_order, f.id), '[]'::jsonb)
  into v_after_flights
  from public.flights f
  where f.event_id = p_event_id;
  v_after := jsonb_build_object(
    'flighting', v_flighting,
    'flights', v_after_flights
  );

  insert into public.audit_events (
    actor_profile_id,
    action,
    scope_league_id,
    scope_event_id,
    target_type,
    target_id,
    before_json,
    after_json
  ) values (
    auth.uid(),
    'event.flights_set',
    v_event.league_id,
    p_event_id,
    'event',
    p_event_id,
    v_before,
    v_after
  );

  return jsonb_build_object(
    'status', 'saved',
    'flightCount', jsonb_array_length(v_after_flights),
    'flights', v_after_flights
  );
end;
$$;

revoke all on function public.set_event_flights(uuid, jsonb) from public, anon;
grant execute on function public.set_event_flights(uuid, jsonb) to authenticated, service_role;

comment on function public.set_event_flights(uuid, jsonb) is
  'Atomically replace a draft event''s flights, roster/team/entity assignments, and draft competition flighting rules. Payload: [{ id?, name, participantIds: [uuid] }].';
