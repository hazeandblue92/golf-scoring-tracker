-- Resolve a score conflict as one director-authorized transaction. The prior
-- Edge implementation applied the selected score under the caller before its
-- service-role resolution RPC checked director authority, so a scorer could
-- change the raw fact and then receive a denial while leaving the conflict
-- open. This workflow validates authority first and commits the score, event
-- revision, mutation ledger, conflict state, and audit record together.

create or replace function public.resolve_score_conflict_atomic(
  p_actor uuid,
  p_conflict_id uuid,
  p_choice text,
  p_manual_value jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conflict public.score_conflicts%rowtype;
  v_event public.events%rowtype;
  v_value jsonb;
  v_status public.score_status;
  v_gross smallint;
  v_notes text;
  v_max_gross smallint;
  v_score_id uuid;
  v_current_revision integer;
  v_current_status public.score_status;
  v_current_gross smallint;
  v_current_notes text;
  v_new_score_revision integer;
  v_prior_value jsonb;
  v_event_revision bigint;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_score_changed boolean := false;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'service role required' using errcode = '42501';
  end if;

  if p_actor is null or not exists (
    select 1
    from public.profiles profile
    where profile.id = p_actor
      and profile.status = 'active'
      and not profile.must_change_password
  ) then
    raise exception 'active actor required' using errcode = '42501';
  end if;
  if p_choice not in ('local', 'server', 'manual') then
    raise exception 'invalid conflict choice' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'resolution reason required' using errcode = '22023';
  end if;

  select * into v_conflict
  from public.score_conflicts
  where id = p_conflict_id
  for update;
  if not found then
    raise exception 'conflict not found' using errcode = 'P0002';
  end if;
  if not app.actor_is_event_director(p_actor, v_conflict.event_id) then
    raise exception 'event director role required' using errcode = '42501';
  end if;

  select * into v_event
  from public.events
  where id = v_conflict.event_id
  for update;
  if not found then
    raise exception 'event not found' using errcode = 'P0002';
  end if;
  if v_conflict.status <> 'open' then
    return jsonb_build_object(
      'status', 'duplicate',
      'conflictId', p_conflict_id,
      'eventId', v_event.id,
      'eventRevision', v_event.scoring_revision,
      'scoreChanged', false
    );
  end if;
  if v_event.status <> 'scoring_open' then
    raise exception 'event is not open for scoring' using errcode = '55000';
  end if;

  v_value := case p_choice
    when 'local' then v_conflict.local_payload
    when 'server' then v_conflict.server_payload
    else p_manual_value
  end;
  if p_choice <> 'server' then
    if v_value is null or jsonb_typeof(v_value) <> 'object' then
      raise exception 'resolution value must be an object' using errcode = '22023';
    end if;

    begin
      v_status := (v_value ->> 'status')::public.score_status;
      v_gross := (v_value ->> 'grossStrokes')::smallint;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid resolution score value' using errcode = '22023';
    end;
    v_notes := nullif(v_value ->> 'notes', '');
    if v_status is null
      or v_status = 'not_started'
      or ((v_status = 'complete') <> (v_gross is not null))
    then
      raise exception 'gross strokes are required exactly for a complete score'
        using errcode = '22023';
    end if;
    if v_notes is not null and length(v_notes) > 500 then
      raise exception 'score notes exceed 500 characters' using errcode = '22023';
    end if;

    select greatest(
      15,
      coalesce((league.settings_json ->> 'max_gross_strokes')::smallint, 25)
    ) into v_max_gross
    from public.leagues league
    where league.id = v_event.league_id;
    if v_gross is not null and (v_gross < 1 or v_gross > v_max_gross) then
      raise exception 'gross strokes must be within 1..%', v_max_gross
        using errcode = '22023';
    end if;
  end if;

  -- Every resolution choice, including "server", is based on the exact raw
  -- fact captured when the conflict was created. Otherwise an old conflict
  -- could be used to bless a newer value without committee review.
  if v_conflict.target_kind = 'individual' then
    select score.id, score.revision, score.score_status,
           score.gross_strokes, score.notes
      into v_score_id, v_current_revision, v_current_status,
           v_current_gross, v_current_notes
    from public.individual_hole_scores score
    where score.event_entry_id = v_conflict.event_entry_id
      and score.event_hole_id = v_conflict.event_hole_id
    for update;
  else
    select score.id, score.revision, score.score_status,
           score.gross_strokes, score.notes
      into v_score_id, v_current_revision, v_current_status,
           v_current_gross, v_current_notes
    from public.team_hole_scores score
    where score.event_team_id = v_conflict.event_team_id
      and score.event_hole_id = v_conflict.event_hole_id
    for update;
  end if;

  if v_current_revision is distinct from v_conflict.server_revision
    or (
      v_score_id is null
      and v_conflict.server_payload <> 'null'::jsonb
    )
    or (
      v_score_id is not null
      and (
        jsonb_typeof(v_conflict.server_payload) <> 'object'
        or v_conflict.server_payload ->> 'status'
          is distinct from v_current_status::text
        or (v_conflict.server_payload ->> 'grossStrokes')::smallint
          is distinct from v_current_gross
      )
    )
  then
    raise exception 'score changed after this conflict was recorded'
      using errcode = '40001';
  end if;

  -- Choosing the unchanged server value resolves the dispute without writing
  -- a score or advancing the event revision. Local/manual choices replace it
  -- and append a normal mutation receipt.
  if p_choice <> 'server' then
    if v_score_id is not null then
      v_prior_value := jsonb_build_object(
        'status', v_current_status::text,
        'grossStrokes', v_current_gross,
        'notes', v_current_notes
      );
      v_new_score_revision := v_current_revision + 1;
      if v_conflict.target_kind = 'individual' then
        update public.individual_hole_scores set
          gross_strokes = v_gross,
          score_status = v_status,
          revision = v_new_score_revision,
          entered_by = p_actor,
          source = 'director',
          client_recorded_at = now(),
          server_recorded_at = now(),
          notes = v_notes
        where id = v_score_id;
      else
        update public.team_hole_scores set
          gross_strokes = v_gross,
          score_status = v_status,
          revision = v_new_score_revision,
          entered_by = p_actor,
          source = 'director',
          client_recorded_at = now(),
          server_recorded_at = now(),
          notes = v_notes
        where id = v_score_id;
      end if;
    else
      v_new_score_revision := 1;
      if v_conflict.target_kind = 'individual' then
        insert into public.individual_hole_scores (
          event_id, round_id, event_entry_id, event_hole_id,
          gross_strokes, score_status, revision, entered_by, source,
          client_recorded_at, notes
        ) values (
          v_conflict.event_id, v_conflict.round_id,
          v_conflict.event_entry_id, v_conflict.event_hole_id,
          v_gross, v_status, v_new_score_revision, p_actor, 'director',
          now(), v_notes
        ) returning id into v_score_id;
      else
        insert into public.team_hole_scores (
          event_id, round_id, event_team_id, event_hole_id,
          gross_strokes, score_status, revision, entered_by, source,
          client_recorded_at, notes
        ) values (
          v_conflict.event_id, v_conflict.round_id,
          v_conflict.event_team_id, v_conflict.event_hole_id,
          v_gross, v_status, v_new_score_revision, p_actor, 'director',
          now(), v_notes
        ) returning id into v_score_id;
      end if;
    end if;

    perform set_config('app.allow_scoring_revision_change', 'on', true);
    update public.events
      set scoring_revision = scoring_revision + 1
    where id = v_event.id
    returning scoring_revision into v_event_revision;
    perform set_config('app.allow_scoring_revision_change', '', true);

    insert into public.score_mutations (
      idempotency_key, event_id, round_id, target_kind, event_entry_id,
      event_team_id, event_hole_id, base_revision, prior_value, new_value,
      actor_profile_id, result, event_revision, reason, client_recorded_at
    ) values (
      gen_random_uuid(), v_conflict.event_id, v_conflict.round_id,
      v_conflict.target_kind, v_conflict.event_entry_id,
      v_conflict.event_team_id, v_conflict.event_hole_id,
      coalesce(v_current_revision, 0), v_prior_value, v_value,
      p_actor, 'committed', v_event_revision, v_reason, now()
    );
    v_score_changed := true;
  else
    v_event_revision := v_event.scoring_revision;
    v_new_score_revision := v_conflict.server_revision;
  end if;

  update public.score_conflicts set
    status = 'resolved',
    resolution_choice = p_choice,
    resolution_value = v_value,
    resolution_reason = v_reason,
    resolved_by = p_actor,
    resolved_at = now()
  where id = p_conflict_id;

  insert into public.audit_events (
    actor_profile_id, action, scope_league_id, scope_event_id,
    target_type, target_id, reason, before_json, after_json
  ) values (
    p_actor, 'score_conflict.resolved', v_event.league_id, v_event.id,
    'score_conflict', p_conflict_id, v_reason,
    jsonb_build_object(
      'status', v_conflict.status,
      'serverRevision', v_conflict.server_revision
    ),
    jsonb_build_object(
      'choice', p_choice,
      'value', v_value,
      'eventRevision', v_event_revision,
      'scoreRevision', v_new_score_revision
    )
  );

  return jsonb_build_object(
    'status', 'resolved',
    'conflictId', p_conflict_id,
    'eventId', v_event.id,
    'eventRevision', v_event_revision,
    'scoreRevision', v_new_score_revision,
    'scoreChanged', v_score_changed
  );
end;
$$;

revoke all on function public.resolve_score_conflict_atomic(
  uuid, uuid, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.resolve_score_conflict_atomic(
  uuid, uuid, text, jsonb, text
) to service_role;

revoke execute on function public.mark_score_conflict_resolved(
  uuid, uuid, text, jsonb, text
) from service_role;
