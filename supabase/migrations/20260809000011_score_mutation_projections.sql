-- Migration 11: the revision-safe write and projection protocol (spec §7.2,
-- §10.4, §12.5). Two functions:
--
--   public.apply_score_mutation  — called by the submit-score Edge Function
--     with the CALLER's auth context (§7.2). Checks permissions, event state,
--     value, and idempotency; locks the target score; applies or records an
--     explicit conflict (never last-write-wins); appends the mutation ledger;
--     increments events.scoring_revision under the migration-10 GUC guard;
--     returns the committed score plus new event revision.
--
--   public.publish_projections   — called with service credentials only.
--     Publishes derived projections if and only if the event's current
--     scoring revision still equals the calculated revision; otherwise
--     returns 'stale' so the Edge Function retries from a newer snapshot.

-- ---------------------------------------------------------------------------
-- Self-scoring helper (§25 default scorer model: players may enter self).
-- ---------------------------------------------------------------------------
create or replace function app.is_self_entry(p_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.event_entries ee
    join public.participants p on p.id = ee.participant_id
    where ee.id = p_entry_id
      and p.profile_id = auth.uid()
  );
$$;

revoke all on function app.is_self_entry(uuid) from public;
grant execute on function app.is_self_entry(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- apply_score_mutation
-- ---------------------------------------------------------------------------
create or replace function public.apply_score_mutation(
  p_idempotency_key uuid,
  p_event_id uuid,
  p_round_id uuid,
  p_target_kind text,
  p_entry_id uuid,
  p_team_id uuid,
  p_hole_id uuid,
  p_base_revision integer,
  p_status public.score_status,
  p_gross_strokes smallint,
  p_notes text,
  p_client_recorded_at timestamptz,
  p_device_id_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_event public.events%rowtype;
  v_new_value jsonb;
  v_existing public.score_mutations%rowtype;
  v_max_gross smallint;
  v_cur_revision integer;
  v_cur_gross smallint;
  v_cur_status public.score_status;
  v_cur_actor uuid;
  v_prior_value jsonb;
  v_score_id uuid;
  v_new_revision integer;
  v_conflict_id uuid;
  v_authorized boolean := false;
begin
  -- ── Authentication ────────────────────────────────────────────────────────
  if v_actor is null then
    return jsonb_build_object('status', 'rejected', 'error_code', 'AUTH_REQUIRED');
  end if;

  -- FR-AUTH-003: a temporary password must be changed before any score
  -- mutation; complete-activation clears the flag.
  if exists (
    select 1 from public.profiles pr
    where pr.id = v_actor and pr.must_change_password
  ) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'AUTH_REQUIRED',
      'detail', 'password change required');
  end if;

  -- ── Input shape ───────────────────────────────────────────────────────────
  if p_target_kind not in ('individual', 'team')
     or (p_target_kind = 'individual' and (p_entry_id is null or p_team_id is not null))
     or (p_target_kind = 'team' and (p_team_id is null or p_entry_id is not null)) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SCORE_INVALID',
      'detail', 'target kind/id mismatch');
  end if;
  if p_base_revision is null or p_base_revision < 0 then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SCORE_INVALID',
      'detail', 'base revision must be >= 0');
  end if;

  -- §4.5: numeric value exactly when status = 'complete'; 'not_started' is a
  -- device UI state, never a submitted fact.
  if p_status = 'not_started' then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SCORE_INVALID',
      'detail', 'not_started is not a submittable status');
  end if;
  if (p_status = 'complete') <> (p_gross_strokes is not null) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SCORE_INVALID',
      'detail', 'gross strokes are required exactly when status is complete');
  end if;

  v_new_value := jsonb_build_object(
    'status', p_status::text,
    'grossStrokes', p_gross_strokes,
    'notes', p_notes
  );

  -- ── Idempotency (§12.5): same key + same payload returns the original
  -- receipt; same key + different payload is a security/error condition. ────
  select * into v_existing
  from public.score_mutations
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing.new_value = v_new_value
       and v_existing.actor_profile_id = v_actor then
      return jsonb_build_object(
        'status', 'duplicate',
        'result', v_existing.result::text,
        'score_revision', coalesce((
          select ihs.revision from public.individual_hole_scores ihs
          where ihs.event_entry_id = v_existing.event_entry_id
            and ihs.event_hole_id = v_existing.event_hole_id
        ), (
          select ths.revision from public.team_hole_scores ths
          where ths.event_team_id = v_existing.event_team_id
            and ths.event_hole_id = v_existing.event_hole_id
        )),
        'event_revision', v_existing.event_revision
      );
    end if;
    return jsonb_build_object('status', 'rejected', 'error_code', 'SCORE_INVALID',
      'detail', 'idempotency key reused with a different payload');
  end if;

  -- ── Event state (lock the event row: serializes revision increments) ─────
  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'unknown event');
  end if;
  if v_event.status <> 'scoring_open' then
    return jsonb_build_object('status', 'rejected', 'error_code', 'EVENT_LOCKED',
      'detail', format('event status is %s', v_event.status));
  end if;

  -- ── Authorization (§2.2/§25): director, assigned scorer, or self-entry ───
  if app.is_event_director(p_event_id) then
    v_authorized := true;
  elsif p_target_kind = 'individual' then
    v_authorized := app.can_score_entry(p_event_id, p_round_id, p_entry_id)
                    or app.is_self_entry(p_entry_id);
  else
    v_authorized := app.can_score_team(p_event_id, p_round_id, p_team_id);
  end if;

  if not v_authorized then
    return jsonb_build_object('status', 'rejected', 'error_code', 'NOT_ASSIGNED');
  end if;

  -- ── Value range (§4.5): default 1..25; league settings may raise the
  -- maximum but never below 15. ────────────────────────────────────────────
  select greatest(15, coalesce((l.settings_json ->> 'max_gross_strokes')::smallint, 25))
    into v_max_gross
  from public.leagues l
  where l.id = v_event.league_id;

  if p_gross_strokes is not null
     and (p_gross_strokes < 1 or p_gross_strokes > v_max_gross) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SCORE_INVALID',
      'detail', format('gross strokes must be within 1..%s', v_max_gross));
  end if;

  -- ── Lock and read the target score row ───────────────────────────────────
  if p_target_kind = 'individual' then
    select ihs.id, ihs.revision, ihs.gross_strokes, ihs.score_status, ihs.entered_by
      into v_score_id, v_cur_revision, v_cur_gross, v_cur_status, v_cur_actor
    from public.individual_hole_scores ihs
    where ihs.event_entry_id = p_entry_id and ihs.event_hole_id = p_hole_id
    for update;
  else
    select ths.id, ths.revision, ths.gross_strokes, ths.score_status, ths.entered_by
      into v_score_id, v_cur_revision, v_cur_gross, v_cur_status, v_cur_actor
    from public.team_hole_scores ths
    where ths.event_team_id = p_team_id and ths.event_hole_id = p_hole_id
    for update;
  end if;

  if v_score_id is not null then
    v_prior_value := jsonb_build_object(
      'status', v_cur_status::text,
      'grossStrokes', v_cur_gross,
      'notes', null
    );
  end if;

  -- ── Revision policy (§10.4) ──────────────────────────────────────────────
  if v_score_id is null then
    if p_base_revision <> 0 then
      -- The client believes a row exists that does not: explicit conflict.
      v_conflict_id := app.record_score_conflict(
        p_event_id, p_round_id, p_target_kind, p_entry_id, p_team_id, p_hole_id,
        v_new_value, coalesce(v_prior_value, 'null'::jsonb),
        v_actor, null, p_base_revision, null);
      insert into public.score_mutations (
        idempotency_key, event_id, round_id, target_kind, event_entry_id,
        event_team_id, event_hole_id, base_revision, prior_value, new_value,
        actor_profile_id, device_id_hash, result, event_revision,
        client_recorded_at)
      values (
        p_idempotency_key, p_event_id, p_round_id, p_target_kind, p_entry_id,
        p_team_id, p_hole_id, p_base_revision, v_prior_value, v_new_value,
        v_actor, p_device_id_hash, 'conflict', v_event.scoring_revision,
        p_client_recorded_at);
      return jsonb_build_object('status', 'conflict', 'conflict_id', v_conflict_id,
        'error_code', 'BASE_REVISION_STALE',
        'event_revision', v_event.scoring_revision);
    end if;
  elsif p_base_revision <> v_cur_revision then
    -- Stale base. Same actor replaying the identical current value is
    -- returned as success (§10.4); anything else is an explicit conflict.
    if v_cur_actor = v_actor
       and v_cur_status = p_status
       and v_cur_gross is not distinct from p_gross_strokes then
      return jsonb_build_object(
        'status', 'committed',
        'replayed', true,
        'score_revision', v_cur_revision,
        'event_revision', v_event.scoring_revision);
    end if;
    v_conflict_id := app.record_score_conflict(
      p_event_id, p_round_id, p_target_kind, p_entry_id, p_team_id, p_hole_id,
      v_new_value, v_prior_value,
      v_actor, v_cur_actor, p_base_revision, v_cur_revision);
    insert into public.score_mutations (
      idempotency_key, event_id, round_id, target_kind, event_entry_id,
      event_team_id, event_hole_id, base_revision, prior_value, new_value,
      actor_profile_id, device_id_hash, result, event_revision,
      client_recorded_at)
    values (
      p_idempotency_key, p_event_id, p_round_id, p_target_kind, p_entry_id,
      p_team_id, p_hole_id, p_base_revision, v_prior_value, v_new_value,
      v_actor, p_device_id_hash, 'conflict', v_event.scoring_revision,
      p_client_recorded_at);
    return jsonb_build_object('status', 'conflict', 'conflict_id', v_conflict_id,
      'error_code', 'BASE_REVISION_STALE',
      'event_revision', v_event.scoring_revision,
      'server_revision', v_cur_revision);
  end if;

  -- ── Apply ────────────────────────────────────────────────────────────────
  if v_score_id is null then
    v_new_revision := 1;
    if p_target_kind = 'individual' then
      insert into public.individual_hole_scores (
        event_id, round_id, event_entry_id, event_hole_id, gross_strokes,
        score_status, revision, entered_by, device_id_hash, source,
        client_recorded_at, notes)
      values (
        p_event_id, p_round_id, p_entry_id, p_hole_id, p_gross_strokes,
        p_status, v_new_revision, v_actor, p_device_id_hash, 'app',
        p_client_recorded_at, p_notes)
      returning id into v_score_id;
    else
      insert into public.team_hole_scores (
        event_id, round_id, event_team_id, event_hole_id, gross_strokes,
        score_status, revision, entered_by, device_id_hash, source,
        client_recorded_at, notes)
      values (
        p_event_id, p_round_id, p_team_id, p_hole_id, p_gross_strokes,
        p_status, v_new_revision, v_actor, p_device_id_hash, 'app',
        p_client_recorded_at, p_notes)
      returning id into v_score_id;
    end if;
  else
    v_new_revision := v_cur_revision + 1;
    if p_target_kind = 'individual' then
      update public.individual_hole_scores set
        gross_strokes = p_gross_strokes,
        score_status = p_status,
        revision = v_new_revision,
        entered_by = v_actor,
        device_id_hash = p_device_id_hash,
        client_recorded_at = p_client_recorded_at,
        server_recorded_at = now(),
        notes = p_notes
      where id = v_score_id;
    else
      update public.team_hole_scores set
        gross_strokes = p_gross_strokes,
        score_status = p_status,
        revision = v_new_revision,
        entered_by = v_actor,
        device_id_hash = p_device_id_hash,
        client_recorded_at = p_client_recorded_at,
        server_recorded_at = now(),
        notes = p_notes
      where id = v_score_id;
    end if;
  end if;

  -- ── Advance the event scoring revision (migration-10 guard) ──────────────
  perform set_config('app.allow_scoring_revision_change', 'on', true);
  update public.events
    set scoring_revision = scoring_revision + 1
    where id = p_event_id;
  perform set_config('app.allow_scoring_revision_change', '', true);

  -- ── Append the mutation ledger ───────────────────────────────────────────
  insert into public.score_mutations (
    idempotency_key, event_id, round_id, target_kind, event_entry_id,
    event_team_id, event_hole_id, base_revision, prior_value, new_value,
    actor_profile_id, device_id_hash, result, event_revision,
    client_recorded_at)
  values (
    p_idempotency_key, p_event_id, p_round_id, p_target_kind, p_entry_id,
    p_team_id, p_hole_id, p_base_revision, v_prior_value, v_new_value,
    v_actor, p_device_id_hash, 'committed', v_event.scoring_revision + 1,
    p_client_recorded_at);

  return jsonb_build_object(
    'status', 'committed',
    'score_id', v_score_id,
    'score_revision', v_new_revision,
    'event_revision', v_event.scoring_revision + 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- Conflict recorder (private helper).
-- ---------------------------------------------------------------------------
create or replace function app.record_score_conflict(
  p_event_id uuid,
  p_round_id uuid,
  p_target_kind text,
  p_entry_id uuid,
  p_team_id uuid,
  p_hole_id uuid,
  p_local_payload jsonb,
  p_server_payload jsonb,
  p_local_actor uuid,
  p_server_actor uuid,
  p_base_revision integer,
  p_server_revision integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.score_conflicts (
    event_id, round_id, target_kind, event_entry_id, event_team_id,
    event_hole_id, local_payload, server_payload, local_actor_profile_id,
    server_actor_profile_id, base_revision, server_revision)
  values (
    p_event_id, p_round_id, p_target_kind, p_entry_id, p_team_id,
    p_hole_id, p_local_payload, coalesce(p_server_payload, 'null'::jsonb),
    p_local_actor, p_server_actor, p_base_revision, p_server_revision)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function app.record_score_conflict(uuid, uuid, text, uuid, uuid, uuid, jsonb, jsonb, uuid, uuid, integer, integer) from public;

-- apply_score_mutation runs with the caller's auth context via the Edge
-- Function; authenticated users may execute it (RLS-equivalent checks are
-- inside), anon may not.
revoke all on function public.apply_score_mutation(uuid, uuid, uuid, text, uuid, uuid, uuid, integer, public.score_status, smallint, text, timestamptz, text) from public;
grant execute on function public.apply_score_mutation(uuid, uuid, uuid, text, uuid, uuid, uuid, integer, public.score_status, smallint, text, timestamptz, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- publish_projections (§7.2): service-role only. Publishes only when the
-- event's current scoring revision still equals the calculated revision.
--
-- p_result shape (canonical JSON produced by the shared engine):
-- {
--   "competitions": [
--     { "competitionId": uuid,
--       "engineVersion": text,
--       "projectionHash": text,
--       "status": "live" | "final",
--       "warnings": [...],
--       "summary": {...},
--       "rows": [ { "entityId": uuid, "rank": int|null, "isTied": bool,
--                   "thru": int|null, "resultPrimary": number|null,
--                   "resultSecondary": number|null, "displayPrimary": text|null,
--                   "status": text, "detail": {...} } ],
--       "holeResults": [ { "entityId": uuid, "eventHoleId": uuid, ... } ] }
--   ]
-- }
-- ---------------------------------------------------------------------------
create or replace function public.publish_projections(
  p_event_id uuid,
  p_revision bigint,
  p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current bigint;
  v_comp jsonb;
  v_comp_id uuid;
  v_changed uuid[] := '{}';
begin
  select scoring_revision into v_current
  from public.events
  where id = p_event_id
  for update;

  if not found then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID');
  end if;

  -- An older computation must never overwrite a newer one (§7.2).
  if v_current <> p_revision then
    return jsonb_build_object('status', 'stale',
      'current_revision', v_current, 'calculated_revision', p_revision);
  end if;

  for v_comp in select * from jsonb_array_elements(p_result -> 'competitions')
  loop
    v_comp_id := (v_comp ->> 'competitionId')::uuid;
    v_changed := array_append(v_changed, v_comp_id);

    insert into public.competition_projections (
      competition_id, event_revision, engine_version, projection_hash,
      status, warnings, summary_json)
    values (
      v_comp_id, p_revision,
      v_comp ->> 'engineVersion',
      v_comp ->> 'projectionHash',
      coalesce(v_comp ->> 'status', 'live'),
      coalesce(v_comp -> 'warnings', '[]'::jsonb),
      coalesce(v_comp -> 'summary', '{}'::jsonb))
    on conflict (competition_id, event_revision) do update set
      engine_version = excluded.engine_version,
      projection_hash = excluded.projection_hash,
      status = excluded.status,
      warnings = excluded.warnings,
      summary_json = excluded.summary_json,
      calculated_at = now();

    delete from public.leaderboard_rows
    where competition_id = v_comp_id and event_revision = p_revision;

    insert into public.leaderboard_rows (
      competition_id, event_revision, entity_id, rank, is_tied, thru,
      result_primary, result_secondary, display_primary, status, detail_json)
    select
      v_comp_id, p_revision,
      (r ->> 'entityId')::uuid,
      (r ->> 'rank')::integer,
      coalesce((r ->> 'isTied')::boolean, false),
      (r ->> 'thru')::smallint,
      (r ->> 'resultPrimary')::numeric,
      (r ->> 'resultSecondary')::numeric,
      r ->> 'displayPrimary',
      coalesce(r ->> 'status', 'provisional'),
      coalesce(r -> 'detail', '{}'::jsonb)
    from jsonb_array_elements(v_comp -> 'rows') as r;

    delete from public.hole_results
    where competition_id = v_comp_id and event_revision = p_revision;

    insert into public.hole_results (
      competition_id, event_revision, entity_id, event_hole_id,
      gross, strokes_received, net, relative_to_par, status, provisional,
      contributor_entry_ids, match_result, skin_units, skin_carried_units,
      skin_winner, detail_json)
    select
      v_comp_id, p_revision,
      (h ->> 'entityId')::uuid,
      (h ->> 'eventHoleId')::uuid,
      (h ->> 'gross')::smallint,
      coalesce((h ->> 'strokesReceived')::smallint, 0),
      (h ->> 'net')::smallint,
      (h ->> 'relativeToPar')::smallint,
      (h ->> 'status')::public.score_status,
      coalesce((h ->> 'provisional')::boolean, false),
      case when h -> 'contributorEntryIds' is null then null
           else (select array_agg(x::uuid)
                 from jsonb_array_elements_text(h -> 'contributorEntryIds') as x)
      end,
      h ->> 'matchResult',
      (h ->> 'skinUnits')::integer,
      (h ->> 'skinCarriedUnits')::integer,
      (h ->> 'skinWinner')::boolean,
      coalesce(h -> 'detail', '{}'::jsonb)
    from jsonb_array_elements(v_comp -> 'holeResults') as h;
  end loop;

  -- Emit the compact realtime revision event (§10.5) and keep short history.
  insert into public.event_revision_feed (
    event_id, score_revision, projection_revision, changed_competition_ids)
  values (p_event_id, v_current, p_revision, v_changed);

  delete from public.event_revision_feed
  where event_id = p_event_id
    and id not in (
      select id from public.event_revision_feed
      where event_id = p_event_id
      order by published_at desc, id
      limit 20
    );

  return jsonb_build_object('status', 'published',
    'event_revision', p_revision,
    'competitions', coalesce(array_length(v_changed, 1), 0));
end;
$$;

-- Service-role only: projections are written exclusively by the projection
-- publisher (§12.1); never by browsers.
revoke all on function public.publish_projections(uuid, bigint, jsonb) from public;
revoke all on function public.publish_projections(uuid, bigint, jsonb) from anon, authenticated;
grant execute on function public.publish_projections(uuid, bigint, jsonb) to service_role;
