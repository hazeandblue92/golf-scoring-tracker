-- Preview and apply share one database snapshot; apply commits all rows or none.
create or replace function public.import_participants_atomic(
  p_actor uuid, p_league_id uuid, p_rows jsonb,
  p_apply boolean default false, p_preview_token text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb;
  v_match public.participants%rowtype;
  v_profile uuid;
  v_id uuid;
  v_count integer;
  v_plan jsonb := '[]';
  v_token text;
  v_result jsonb;
  v_issues jsonb := '[]';
  v_unknown boolean;
  v_row_number integer := 0; -- CsvIssue.row is 1-based over data rows.
begin
  if not exists (
    select 1 from public.role_assignments r join public.profiles p on p.id = r.profile_id
    where r.profile_id = p_actor and r.league_id = p_league_id
      and r.role in ('owner', 'league_admin') and r.revoked_at is null
      and p.status = 'active' and not p.must_change_password
  ) then raise exception 'Organizer access required' using errcode = '42501'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'Expected at most 500 participant rows';
  end if;
  -- Cover other catalog write paths too, not only competing imports. Locks are
  -- released with the RPC transaction, including when validation raises.
  lock table public.participants, public.participant_handicaps, public.profiles
    in share row exclusive mode;
  select md5(jsonb_build_array(p_rows, current_date,
    (select jsonb_agg(to_jsonb(p) order by p.id) from public.participants p where p.league_id = p_league_id),
    (select jsonb_agg(to_jsonb(h) order by h.id) from public.participant_handicaps h
      join public.participants p on p.id = h.participant_id where p.league_id = p_league_id),
    (select jsonb_agg(jsonb_build_array(p.id, p.username) order by p.id) from public.profiles p
      where p.username in (select r->>'username' from jsonb_array_elements(p_rows) r))
  )::text) into v_token;
  if p_apply and p_preview_token is distinct from v_token then
    raise exception 'Roster or import changed. Preview again before applying.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
    group by lower(r->>'displayName') having count(*) > 1) then
    raise exception 'Duplicate display names must be disambiguated before import';
  end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_row_number := v_row_number + 1;
    v_unknown := false;
    if coalesce(btrim(v_row->>'displayName'), '') = '' or
      v_row->>'status' not in ('active', 'inactive', 'archived') then
      raise exception 'Invalid participant name or status';
    end if;
    select count(*) into v_count from public.participants
      where league_id = p_league_id and lower(display_name) = lower(v_row->>'displayName');
    if v_count > 1 then raise exception 'Ambiguous roster name: %', v_row->>'displayName'; end if;
    select * into v_match from public.participants
      where league_id = p_league_id and lower(display_name) = lower(v_row->>'displayName');
    v_profile := v_match.profile_id;
    if v_row->>'username' is not null then
      select id into v_profile from public.profiles where username = v_row->>'username';
      if v_profile is null then
        v_unknown := true;
        v_issues := v_issues || jsonb_build_array(jsonb_build_object(
          'row', v_row_number, 'column', 'username', 'code', 'required',
          'warning', true, 'message', 'No account matches this username; imported as a guest.'));
      end if;
    end if;
    v_plan := v_plan || jsonb_build_array(jsonb_build_object(
      'displayName', v_row->>'displayName', 'action', case when v_match.id is null then 'create' else 'update' end,
      'handicap', v_row->'handicapValue', 'status', v_row->>'status',
      'account', case when v_unknown then 'unknown_username' when v_profile is null then 'no_account' else 'linked' end));
    if not p_apply then continue; end if;
    v_id := coalesce(v_match.id, gen_random_uuid());
    insert into public.participants(id, league_id, profile_id, display_name, sort_name, status)
      values(v_id, p_league_id, v_profile, v_row->>'displayName', lower(v_row->>'displayName'), v_row->>'status')
      on conflict (id) do update set profile_id = excluded.profile_id,
        display_name = excluded.display_name, sort_name = excluded.sort_name, status = excluded.status;
    if v_row->>'handicapValue' is not null then
      v_result := public.record_participant_handicap(p_actor, v_id,
        (v_row->>'handicapValue')::numeric, (v_row->>'handicapSource')::public.handicap_source,
        (v_row->>'effectiveFrom')::date, null);
      if v_result->>'status' not in ('recorded', 'corrected') then
        raise exception 'Handicap rejected: %', v_result;
      end if;
    end if;
  end loop;
  if p_apply then
    insert into public.audit_events(actor_profile_id, action, scope_league_id, target_type, after_json)
      values(p_actor, 'catalog.import-participants.apply', p_league_id, 'participant',
        jsonb_build_object('rows', jsonb_array_length(p_rows), 'previewToken', v_token));
  end if;
  return jsonb_build_object('applied', case when p_apply then jsonb_array_length(p_rows) else 0 end,
    'plan', v_plan, 'previewToken', v_token, 'issues', v_issues);
end;
$$;
revoke all on function public.import_participants_atomic(uuid, uuid, jsonb, boolean, text)
  from public, anon, authenticated;
grant execute on function public.import_participants_atomic(uuid, uuid, jsonb, boolean, text) to service_role;

-- Record original values and their replacements in the same transaction.
create or replace function public.record_participant_handicap(
  p_actor uuid,
  p_participant_id uuid,
  p_value numeric,
  p_source public.handicap_source,
  p_effective_from date default null,
  p_source_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_participant public.participants%rowtype;
  v_effective date := coalesce(p_effective_from, current_date);
  v_current public.participant_handicaps%rowtype;
  v_id uuid;
begin
  if p_actor is null then
    return jsonb_build_object('status', 'rejected', 'error_code', 'AUTH_REQUIRED');
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'unknown participant');
  end if;

  if not exists (
    select 1
    from public.role_assignments ra
    where ra.league_id = v_participant.league_id
      and ra.profile_id = p_actor
      and ra.role in ('owner', 'league_admin')
      and ra.revoked_at is null
  ) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'NOT_ASSIGNED');
  end if;

  -- numeric(5, 1): tenths precision, signed, plus handicaps negative (§7.3).
  if p_value is null or p_value <> round(p_value, 1) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'handicap value must be given in tenths');
  end if;
  if p_value < -10 or p_value > 54 then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'handicap value is outside the supported -10 to 54 range');
  end if;

  -- The row covering the new effective date, if any. Ordering by effective_from
  -- desc picks the latest interval that has already begun.
  select * into v_current
  from public.participant_handicaps
  where participant_id = p_participant_id
    and effective_from <= v_effective
    and (effective_to is null or effective_to > v_effective)
  order by effective_from desc
  limit 1;

  if found then
    if v_current.effective_from = v_effective then
      -- Same day: a correction to a value that has not yet been superseded,
      -- not a new interval. Overwriting is what the organizer means, and the
      -- unique (participant_id, effective_from) constraint requires it.
      update public.participant_handicaps
        set value = p_value,
            source = p_source,
            source_reference = p_source_reference,
            verified_at = now(),
            verified_by = p_actor,
            updated_at = now()
      where id = v_current.id;

      insert into public.audit_events (actor_profile_id, action, scope_league_id, target_type, target_id, before_json, after_json)
      values (p_actor, 'participant.handicap_corrected', v_participant.league_id,
        'participant', p_participant_id, to_jsonb(v_current),
        (select to_jsonb(h) from public.participant_handicaps h where h.id = v_current.id));

      return jsonb_build_object('status', 'corrected', 'handicapId', v_current.id,
        'effectiveFrom', v_effective);
    end if;

    -- Close the open interval the day the new one starts. Half-open ranges
    -- mean effective_to is exclusive, so there is no gap and no overlap.
    update public.participant_handicaps
      set effective_to = v_effective, updated_at = now()
    where id = v_current.id;
  end if;

  -- A later interval already starting after v_effective would overlap the new
  -- open-ended row. Bound the new row at the next one's start instead of
  -- failing, so back-filling an older value stays possible.
  insert into public.participant_handicaps (
    participant_id, value, source, effective_from, effective_to,
    verified_at, verified_by, source_reference
  )
  values (
    p_participant_id, p_value, p_source, v_effective,
    (
      select min(effective_from)
      from public.participant_handicaps
      where participant_id = p_participant_id
        and effective_from > v_effective
    ),
    now(), p_actor, p_source_reference
  )
  returning id into v_id;

  insert into public.audit_events (actor_profile_id, action, scope_league_id, target_type, target_id, before_json, after_json)
  values (p_actor, 'participant.handicap_recorded', v_participant.league_id,
    'participant', p_participant_id, to_jsonb(v_current),
      jsonb_build_object('recorded', (select to_jsonb(h) from public.participant_handicaps h where h.id = v_id),
        'superseded', (select to_jsonb(h) from public.participant_handicaps h where h.id = v_current.id)));

  return jsonb_build_object('status', 'recorded', 'handicapId', v_id,
    'effectiveFrom', v_effective);
end;
$$;
