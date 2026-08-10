-- Migration 22: organizer flight/division management (spec §5.2, §272).
--
-- Flights already drive per-flight ranking and per-flight skins pools, but
-- nothing could CREATE one. This adds a single explicit entry point rather
-- than threading flights through the two large draft RPCs, which would mean
-- dropping and recreating both for a concern neither of them owns.
--
-- Replace-whole-set semantics: the caller sends the flights it wants, and
-- anything omitted is removed. Assignments are keyed by PARTICIPANT because
-- that is what the setup screen holds; the function resolves each to its entry
-- in this event.
--
-- Setup is frozen at publish (§6.2 freezes the roster snapshot), so this is
-- rejected once the event leaves draft — a flight change afterwards would
-- silently re-cut a division that results were already published against.

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
  v_kept uuid[] := '{}';
  v_assigned integer := 0;
  v_index integer := 0;
begin
  if auth.uid() is null then
    return jsonb_build_object('status', 'rejected', 'error_code', 'AUTH_REQUIRED');
  end if;

  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'unknown event');
  end if;

  if not (
    app.is_event_director(p_event_id)
    or app.has_role(v_event.league_id, array['owner', 'league_admin']::public.app_role[])
  ) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'NOT_ASSIGNED');
  end if;

  if v_event.status <> 'draft' then
    return jsonb_build_object('status', 'rejected', 'error_code', 'EVENT_LOCKED',
      'detail', format('flights are part of frozen setup; event status is %s', v_event.status));
  end if;

  if jsonb_typeof(p_flights) <> 'array' then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'flights must be an array');
  end if;

  -- Replace-whole-set means assignments are not sticky: clear every existing
  -- assignment first, then apply exactly what the caller sent. Without this an
  -- organizer could add a player to a flight but never remove one, because a
  -- kept flight would hold on to members the new payload omits.
  update public.event_entries
    set flight_id = null, updated_at = now()
  where event_id = p_event_id and flight_id is not null;

  update public.event_teams
    set flight_id = null, updated_at = now()
  where event_id = p_event_id and flight_id is not null;

  for v_flight in select * from jsonb_array_elements(p_flights)
  loop
    v_index := v_index + 1;
    if coalesce(btrim(v_flight ->> 'name'), '') = '' then
      return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
        'detail', 'every flight needs a name');
    end if;

    v_flight_id := coalesce((v_flight ->> 'id')::uuid, gen_random_uuid());
    insert into public.flights (id, event_id, name, sort_order)
    values (v_flight_id, p_event_id, btrim(v_flight ->> 'name'), v_index)
    on conflict (id) do update
      set name = excluded.name,
          sort_order = excluded.sort_order,
          updated_at = now();
    v_kept := array_append(v_kept, v_flight_id);

    -- Assign the named participants' entries to this flight.
    update public.event_entries ee
      set flight_id = v_flight_id, updated_at = now()
    where ee.event_id = p_event_id
      and ee.participant_id in (
        select (value)::uuid
        from jsonb_array_elements_text(coalesce(v_flight -> 'participantIds', '[]'::jsonb))
      );
    get diagnostics v_assigned = row_count;
  end loop;

  -- Assignments were cleared up front, so anything still pointing at a flight
  -- points at one the caller kept. Only the dropped flights remain to remove.
  delete from public.flights
  where event_id = p_event_id
    and not (id = any(v_kept));

  insert into public.audit_events (actor_profile_id, action, target_type, target_id)
  values (auth.uid(), 'event.flights_set', 'event', p_event_id);

  return jsonb_build_object(
    'status', 'saved',
    'flights', coalesce(array_length(v_kept, 1), 0)
  );
end;
$$;

revoke all on function public.set_event_flights(uuid, jsonb) from public, anon;
grant execute on function public.set_event_flights(uuid, jsonb) to authenticated, service_role;

comment on function public.set_event_flights(uuid, jsonb) is
  'Replace an event''s flights and their participant assignments. Draft-only: setup is frozen at publish (section 6.2). Payload: [{ id?, name, participantIds: [uuid] }].';
