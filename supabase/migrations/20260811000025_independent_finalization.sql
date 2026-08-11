-- Migration 25: independent competition finalization (Appendix B).
--
-- A competition seals only its own result and score inputs. Other
-- competitions in the event remain open until they are finalized separately;
-- the event and its rounds reach their terminal states only after every
-- competition is sealed.

-- ---------------------------------------------------------------------------
-- Competition score-input scope
-- ---------------------------------------------------------------------------
create or replace function app.score_fact_intersects_competition(
  p_competition_id uuid,
  p_round_id uuid,
  p_hole_id uuid,
  p_entry_id uuid,
  p_team_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.competitions c
    join public.competition_rounds cr
      on cr.competition_id = c.id
     and cr.round_id = p_round_id
    join public.event_holes eh
      on eh.id = p_hole_id
     and eh.round_id = cr.round_id
    join public.competition_entities ce
      on ce.competition_id = c.id
     and ce.eligibility_status = 'eligible'
    where c.id = p_competition_id
      and case
        -- An explicit competition-round scope wins. As in the projection
        -- builder, an empty array means the whole round.
        when cr.hole_scope is not null then
          cardinality(cr.hole_scope) = 0
          or eh.hole_ordinal = any(cr.hole_scope)
        -- Otherwise the Terms-level scope applies when present.
        when jsonb_typeof(c.rules_json -> 'holeScope') = 'array'
          and jsonb_array_length(c.rules_json -> 'holeScope') > 0 then
          exists (
            select 1
            from jsonb_array_elements_text(c.rules_json -> 'holeScope') scope(value)
            where scope.value::integer = eh.hole_ordinal
          )
        else true
      end
      and (
        (
          p_entry_id is not null
          and (
            ce.event_entry_id = p_entry_id
            or (
              ce.event_team_id is not null
              and exists (
                select 1
                from public.event_team_members etm
                where etm.event_team_id = ce.event_team_id
                  and etm.event_entry_id = p_entry_id
              )
            )
          )
        )
        or (p_team_id is not null and ce.event_team_id = p_team_id)
      )
  );
$$;

revoke all on function app.score_fact_intersects_competition(
  uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated;

create or replace function app.score_fact_intersects_finalized_competition(
  p_event_id uuid,
  p_round_id uuid,
  p_hole_id uuid,
  p_entry_id uuid,
  p_team_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.competitions c
    where c.event_id = p_event_id
      and c.status = 'finalized'
      and app.score_fact_intersects_competition(
        c.id,
        p_round_id,
        p_hole_id,
        p_entry_id,
        p_team_id
      )
  );
$$;

revoke all on function app.score_fact_intersects_finalized_competition(
  uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Authoritative score RPC guard
-- ---------------------------------------------------------------------------
-- Preserve the existing mutation implementation behind a private wrapper.
-- The wrapper locks the event before checking sealed scopes, so a mutation
-- cannot race a finalization at the same event revision. Exact idempotent
-- replays still return their original receipt after a competition is sealed.
alter function public.apply_score_mutation(
  uuid, uuid, uuid, text, uuid, uuid, uuid, integer,
  public.score_status, smallint, text, timestamptz, text
) rename to apply_score_mutation_without_finalization_guard;

revoke all on function public.apply_score_mutation_without_finalization_guard(
  uuid, uuid, uuid, text, uuid, uuid, uuid, integer,
  public.score_status, smallint, text, timestamptz, text
) from public, anon, authenticated, service_role;

create function public.apply_score_mutation(
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
  v_authorized boolean := false;
begin
  -- Idempotency precedes lifecycle state in the original protocol. Delegate
  -- existing keys so an exact retry remains safe and a mismatched retry keeps
  -- returning SCORE_INVALID.
  if exists (
    select 1
    from public.score_mutations sm
    where sm.idempotency_key = p_idempotency_key
  ) then
    return public.apply_score_mutation_without_finalization_guard(
      p_idempotency_key, p_event_id, p_round_id, p_target_kind,
      p_entry_id, p_team_id, p_hole_id, p_base_revision, p_status,
      p_gross_strokes, p_notes, p_client_recorded_at, p_device_id_hash
    );
  end if;

  -- Preserve the original validation and authorization result ordering. Only
  -- an otherwise authorized, well-shaped write receives the sealed-scope
  -- lifecycle rejection.
  if v_actor is null
    or exists (
      select 1 from public.profiles pr
      where pr.id = v_actor and pr.must_change_password
    )
    or p_target_kind not in ('individual', 'team')
    or (
      p_target_kind = 'individual'
      and (p_entry_id is null or p_team_id is not null)
    )
    or (
      p_target_kind = 'team'
      and (p_team_id is null or p_entry_id is not null)
    )
    or p_base_revision is null
    or p_base_revision < 0
    or p_status is null
    or p_status = 'not_started'
    or ((p_status = 'complete') <> (p_gross_strokes is not null))
  then
    return public.apply_score_mutation_without_finalization_guard(
      p_idempotency_key, p_event_id, p_round_id, p_target_kind,
      p_entry_id, p_team_id, p_hole_id, p_base_revision, p_status,
      p_gross_strokes, p_notes, p_client_recorded_at, p_device_id_hash
    );
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found or v_event.status <> 'scoring_open' then
    return public.apply_score_mutation_without_finalization_guard(
      p_idempotency_key, p_event_id, p_round_id, p_target_kind,
      p_entry_id, p_team_id, p_hole_id, p_base_revision, p_status,
      p_gross_strokes, p_notes, p_client_recorded_at, p_device_id_hash
    );
  end if;

  if app.is_event_director(p_event_id) then
    v_authorized := true;
  elsif p_target_kind = 'individual' then
    v_authorized := app.can_score_entry(p_event_id, p_round_id, p_entry_id)
      or app.is_self_entry(p_entry_id);
  else
    v_authorized := app.can_score_team(p_event_id, p_round_id, p_team_id);
  end if;

  if not v_authorized then
    return public.apply_score_mutation_without_finalization_guard(
      p_idempotency_key, p_event_id, p_round_id, p_target_kind,
      p_entry_id, p_team_id, p_hole_id, p_base_revision, p_status,
      p_gross_strokes, p_notes, p_client_recorded_at, p_device_id_hash
    );
  end if;

  if app.score_fact_intersects_finalized_competition(
    p_event_id,
    p_round_id,
    p_hole_id,
    p_entry_id,
    p_team_id
  ) then
    return jsonb_build_object(
      'status', 'rejected',
      'error_code', 'EVENT_LOCKED',
      'detail', 'score is sealed by a finalized competition; reopen it before editing'
    );
  end if;

  return public.apply_score_mutation_without_finalization_guard(
    p_idempotency_key, p_event_id, p_round_id, p_target_kind,
    p_entry_id, p_team_id, p_hole_id, p_base_revision, p_status,
    p_gross_strokes, p_notes, p_client_recorded_at, p_device_id_hash
  );
end;
$$;

revoke all on function public.apply_score_mutation(
  uuid, uuid, uuid, text, uuid, uuid, uuid, integer,
  public.score_status, smallint, text, timestamptz, text
) from public, anon;
grant execute on function public.apply_score_mutation(
  uuid, uuid, uuid, text, uuid, uuid, uuid, integer,
  public.score_status, smallint, text, timestamptz, text
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Raw-table defense in depth
-- ---------------------------------------------------------------------------
-- Service/import code must not be able to change sealed inputs accidentally.
-- Portable restore uses narrowly scoped service-only RPCs below to recreate
-- an existing sealed artifact in a fresh project.
create or replace function app.enforce_finalized_individual_score_fact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.allow_finalized_score_restore', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op <> 'INSERT'
    and app.score_fact_intersects_finalized_competition(
      old.event_id, old.round_id, old.event_hole_id, old.event_entry_id, null
    )
  then
    raise exception 'individual score is sealed by a finalized competition; reopen it before editing'
      using errcode = '23514';
  end if;

  if tg_op <> 'DELETE'
    and app.score_fact_intersects_finalized_competition(
      new.event_id, new.round_id, new.event_hole_id, new.event_entry_id, null
    )
  then
    raise exception 'individual score is sealed by a finalized competition; reopen it before editing'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function app.enforce_finalized_team_score_fact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.allow_finalized_score_restore', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op <> 'INSERT'
    and app.score_fact_intersects_finalized_competition(
      old.event_id, old.round_id, old.event_hole_id, null, old.event_team_id
    )
  then
    raise exception 'team score is sealed by a finalized competition; reopen it before editing'
      using errcode = '23514';
  end if;

  if tg_op <> 'DELETE'
    and app.score_fact_intersects_finalized_competition(
      new.event_id, new.round_id, new.event_hole_id, null, new.event_team_id
    )
  then
    raise exception 'team score is sealed by a finalized competition; reopen it before editing'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function app.enforce_finalized_individual_score_fact()
  from public, anon, authenticated;
revoke all on function app.enforce_finalized_team_score_fact()
  from public, anon, authenticated;

create trigger individual_hole_scores_finalized_scope_guard
  before insert or update or delete on public.individual_hole_scores
  for each row execute function app.enforce_finalized_individual_score_fact();

create trigger team_hole_scores_finalized_scope_guard
  before insert or update or delete on public.team_hole_scores
  for each row execute function app.enforce_finalized_team_score_fact();

-- ---------------------------------------------------------------------------
-- Portable restore exception
-- ---------------------------------------------------------------------------
create or replace function public.restore_portable_individual_scores(p_rows jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restored bigint;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'score restore payload must be an array' using errcode = '22023';
  end if;

  perform set_config('app.allow_finalized_score_restore', 'on', true);
  insert into public.individual_hole_scores
  select restored.*
  from jsonb_populate_recordset(
    null::public.individual_hole_scores,
    p_rows
  ) restored;
  get diagnostics v_restored = row_count;
  return v_restored;
end;
$$;

create or replace function public.restore_portable_team_scores(p_rows jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restored bigint;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'score restore payload must be an array' using errcode = '22023';
  end if;

  perform set_config('app.allow_finalized_score_restore', 'on', true);
  insert into public.team_hole_scores
  select restored.*
  from jsonb_populate_recordset(
    null::public.team_hole_scores,
    p_rows
  ) restored;
  get diagnostics v_restored = row_count;
  return v_restored;
end;
$$;

revoke all on function public.restore_portable_individual_scores(jsonb)
  from public, anon, authenticated;
revoke all on function public.restore_portable_team_scores(jsonb)
  from public, anon, authenticated;
grant execute on function public.restore_portable_individual_scores(jsonb)
  to service_role;
grant execute on function public.restore_portable_team_scores(jsonb)
  to service_role;

-- Delayed projection repair considers only competitions that are still
-- mutable. A finalized competition intentionally has no projection at later
-- event revisions, so its sealed revision must not keep the repair lease hot.
create or replace function public.event_projections_current(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.events where id = p_event_id)
    and not exists (
      select 1
      from public.competitions c
      join public.events e on e.id = c.event_id
      where c.event_id = p_event_id
        and c.status not in ('finalized', 'archived')
        and coalesce((
          select max(cp.event_revision)
          from public.competition_projections cp
          where cp.competition_id = c.id
        ), -1) < e.scoring_revision
    );
$$;

revoke all on function public.event_projections_current(uuid)
  from public, anon, authenticated;
grant execute on function public.event_projections_current(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Audited correction workflow
-- ---------------------------------------------------------------------------
-- The Edge Function supplies the MFA-verified actor. Reopening one target
-- clears only that sealed artifact. Other finalized competitions remain
-- protected, including any score facts whose scopes overlap the reopened
-- target.
create or replace function public.reopen_competition(
  p_actor uuid,
  p_competition_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_comp public.competitions%rowtype;
  v_event public.events%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_before jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'a correction reason is required' using errcode = '22023';
  end if;

  select * into v_comp
  from public.competitions
  where id = p_competition_id
  for update;
  if not found then
    raise exception 'competition not found' using errcode = 'P0002';
  end if;
  if not app.actor_is_event_director(p_actor, v_comp.event_id) then
    raise exception 'event director role required' using errcode = '42501';
  end if;
  if v_comp.status <> 'finalized' then
    raise exception 'competition must be finalized before reopening'
      using errcode = '23514';
  end if;

  select * into v_event
  from public.events
  where id = v_comp.event_id
  for update;
  if v_event.status not in ('scoring_open', 'scoring_closed', 'finalized') then
    raise exception 'parent event cannot be reopened from status %', v_event.status
      using errcode = '23514';
  end if;

  v_before := jsonb_build_object(
    'competitionStatus', v_comp.status,
    'eventStatus', v_event.status,
    'finalizedAt', v_comp.finalized_at,
    'finalizedBy', v_comp.finalized_by,
    'finalResultHash', v_comp.final_result_hash,
    'engineVersion', v_comp.engine_version
  );

  -- Follow the database-enforced transition graph one edge at a time.
  update public.competitions
  set status = 'scoring_closed',
      finalized_at = null,
      finalized_by = null,
      final_result_hash = null
  where id = p_competition_id;
  update public.competitions
  set status = 'scoring_open'
  where id = p_competition_id;

  if v_event.status = 'finalized' then
    update public.events set status = 'scoring_closed' where id = v_event.id;
    v_event.status := 'scoring_closed';
  end if;
  if v_event.status = 'scoring_closed' then
    update public.events set status = 'scoring_open' where id = v_event.id;
    v_event.status := 'scoring_open';
  end if;

  update public.rounds r
  set status = 'in_progress'
  where r.status = 'complete'
    and exists (
      select 1
      from public.competition_rounds cr
      where cr.competition_id = p_competition_id
        and cr.round_id = r.id
    );

  insert into public.audit_events (
    actor_profile_id, action, scope_league_id, scope_event_id,
    target_type, target_id, reason, before_json, after_json
  ) values (
    p_actor, 'competition.reopened', v_event.league_id, v_event.id,
    'competition', p_competition_id, v_reason, v_before,
    jsonb_build_object(
      'competitionStatus', 'scoring_open',
      'eventStatus', v_event.status,
      'finalizedAt', null,
      'finalizedBy', null,
      'finalResultHash', null,
      'engineVersion', v_comp.engine_version
    )
  );

  return jsonb_build_object(
    'status', 'reopened',
    'eventId', v_event.id,
    'competitionId', p_competition_id,
    'eventStatus', v_event.status,
    'competitionStatus', 'scoring_open'
  );
end;
$$;

revoke all on function public.reopen_competition(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.reopen_competition(uuid, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Independent finalization
-- ---------------------------------------------------------------------------
-- finalize_phase1_competition replaces migration 24's version. The blocker
-- logic per format is unchanged; only two things move:
--
--   1. Blocker scope. An open conflict blocks a competition only when the
--      disputed score fact is actually one of that competition's inputs. A
--      conflict on a hole outside the Terms hole scope, or on a player who is
--      not an eligible entity, belongs to a different competition.
--   2. Lifecycle transitions. Sealing one competition no longer closes
--      scoring for its siblings. The competition alone walks
--      scoring_open -> scoring_closed -> finalized, and it does so only in the
--      call that actually seals a final hash, so a blocked or not-yet-final
--      attempt leaves every status untouched. Rounds complete once every
--      competition that spans them is sealed, and the event reaches
--      scoring_closed/finalized only when nothing is left open.
--
-- Sealed inputs stay protected by the score-fact guards above rather than by
-- closing the whole event.
create or replace function public.finalize_phase1_competition(
  p_actor uuid,
  p_competition_id uuid,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_comp public.competitions%rowtype;
  v_event public.events%rowtype;
  v_missing integer := 0;
  v_conflicts integer;
  v_unattested integer;
  v_match_blockers integer := 0;
  v_carry_blockers integer := 0;
  v_projection_hash text;
  v_projection_engine_version text;
  v_projection_status text;
  v_projection_warnings jsonb;
  v_best_k integer;
begin
  select * into v_comp from public.competitions
  where id = p_competition_id for update;
  if not found then raise exception 'competition not found' using errcode = 'P0002'; end if;
  if not app.actor_is_event_director(p_actor, v_comp.event_id) then
    raise exception 'event director role required' using errcode = '42501';
  end if;
  select * into v_event from public.events where id = v_comp.event_id for update;

  if v_comp.status = 'finalized' then
    return jsonb_build_object(
      'status', 'finalized',
      'eventId', v_event.id,
      'competitionId', p_competition_id,
      'finalResultHash', v_comp.final_result_hash,
      'engineVersion', v_comp.engine_version
    );
  end if;
  if v_event.status not in ('scoring_open', 'scoring_closed') then
    raise exception 'event must be open or closed for scoring' using errcode = '23514';
  end if;
  -- Report an unscorable competition directly instead of letting the sealing
  -- update below fail against the transition trigger.
  if v_comp.status not in ('scoring_open', 'scoring_closed') then
    raise exception 'competition must be open or closed for scoring, not %', v_comp.status
      using errcode = '23514';
  end if;

  -- A current projection is required before the workflow changes lifecycle
  -- state. This prevents a failed preflight from silently closing scoring.
  select projection_hash, engine_version, status, warnings
    into v_projection_hash, v_projection_engine_version,
      v_projection_status, v_projection_warnings
  from public.competition_projections
  where competition_id = p_competition_id
    and event_revision = v_event.scoring_revision
    and status <> 'error';
  if v_projection_hash is null then
    return jsonb_build_object(
      'status', 'blocked', 'projectionStale', true,
      'missingScores', 0, 'openConflicts', 0,
      'unattestedCards', 0, 'matchBlockers', 0, 'carryBlockers', 0
    );
  end if;

  if v_comp.format = 'match' then
    -- Match completion is defined by the pairing lifecycle, not by eighteen
    -- stroke-card holes: clinched and conceded matches intentionally leave
    -- later holes unplayed. A competition with no pairing is also unresolved.
    select case
      when count(*) = 0 then 1
      else count(*) filter (
        where status not in ('complete', 'conceded', 'walkover')
      )
    end::integer
    into v_match_blockers
    from public.matches
    where competition_id = p_competition_id;
  elsif v_comp.format in ('best_k', 'aggregate', 'shamble') then
    v_best_k := coalesce((v_comp.rules_json #>> '{team,bestK}')::integer, 1);
    select count(*) into v_missing
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and ce.eligibility_status = 'eligible'
      and (
        select count(*)
        from public.event_team_members etm
        join public.individual_hole_scores s
          on s.event_entry_id = etm.event_entry_id
         and s.event_hole_id = eh.id
         and s.score_status <> 'not_started'
        where etm.event_team_id = ce.event_team_id
      ) < v_best_k;
  elsif v_comp.format in ('scramble', 'foursomes', 'greensomes', 'chapman')
    or (v_comp.format = 'skins' and v_comp.rules_json #>> '{skins,population}' = 'teams')
  then
    select count(*) into v_missing
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and ce.eligibility_status = 'eligible'
      and not exists (
        select 1 from public.team_hole_scores s
        where s.event_team_id = ce.event_team_id
          and s.event_hole_id = eh.id
          and s.score_status <> 'not_started'
      );
  else
    select count(*) into v_missing
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.rounds r on r.id = cr.round_id
    join public.event_entries ee on ee.id = ce.event_entry_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_entry_id is not null
      and ce.eligibility_status = 'eligible'
      and ee.status = 'active'
      and (
        ee.effective_from_round_id is null
        or exists (
          select 1 from public.rounds entry_start
          where entry_start.id = ee.effective_from_round_id
            and entry_start.round_number <= r.round_number
        )
      )
      and not exists (
        select 1
        from public.event_entries successor
        join public.rounds successor_start
          on successor_start.id = successor.effective_from_round_id
        where successor.replaces_entry_id = ee.id
          and successor_start.round_number <= r.round_number
      )
      and not exists (
        select 1 from public.individual_hole_scores s
        where s.event_entry_id = ce.event_entry_id
          and s.event_hole_id = eh.id
          and s.score_status <> 'not_started'
      );
  end if;

  -- Only conflicts over this competition's own inputs block it. A dispute on
  -- a hole or player that this competition never reads belongs to whichever
  -- sibling competition actually scores it.
  select count(*) into v_conflicts
  from public.score_conflicts sc
  where sc.event_id = v_event.id
    and sc.status = 'open'
    and app.score_fact_intersects_competition(
      p_competition_id,
      sc.round_id,
      sc.event_hole_id,
      sc.event_entry_id,
      sc.event_team_id
    );

  if v_comp.format = 'skins' then
    select count(*) into v_carry_blockers
    from jsonb_array_elements(coalesce(v_projection_warnings, '[]'::jsonb)) warning
    where warning ->> 'code' = 'SKINS_SUDDEN_DEATH_PENDING';
  end if;

  if v_comp.format = 'match' then
    select count(*) into v_unattested
    from (
      -- Individual sides always use their own card.
      select distinct
        m.round_id,
        ce.event_entry_id,
        null::uuid as event_team_id
      from public.matches m
      join public.competition_entities ce
        on ce.id in (m.side_a_entity_id, m.side_b_entity_id)
      where m.competition_id = p_competition_id
        and ce.eligibility_status = 'eligible'
        and ce.event_entry_id is not null
      union
      -- Team best-ball is frozen explicitly in Terms and requires each
      -- member card that actually supplied a score.
      select distinct
        m.round_id,
        etm.event_entry_id,
        null::uuid as event_team_id
      from public.matches m
      join public.competition_entities ce
        on ce.id in (m.side_a_entity_id, m.side_b_entity_id)
      join public.event_team_members etm on etm.event_team_id = ce.event_team_id
      where m.competition_id = p_competition_id
        and ce.eligibility_status = 'eligible'
        and ce.event_team_id is not null
        and v_comp.rules_json #>> '{team,scoreSource}' = 'individual'
      union
      -- Team-ball matches use one team card and therefore require a team
      -- attestation, not attestations for unrelated member cards.
      select distinct
        m.round_id,
        null::uuid as event_entry_id,
        ce.event_team_id
      from public.matches m
      join public.competition_entities ce
        on ce.id in (m.side_a_entity_id, m.side_b_entity_id)
      where m.competition_id = p_competition_id
        and ce.eligibility_status = 'eligible'
        and ce.event_team_id is not null
        and v_comp.rules_json #>> '{team,scoreSource}' = 'team_ball'
    ) cards
    where (
      cards.event_entry_id is not null
      and exists (
        select 1
        from public.individual_hole_scores scored
        where scored.round_id = cards.round_id
          and scored.event_entry_id = cards.event_entry_id
          and scored.score_status <> 'not_started'
      )
      and not exists (
        select 1
        from public.scorecard_attestations sa
        where sa.event_entry_id = cards.event_entry_id
          and sa.round_id = cards.round_id
          and sa.score_revision = (
            select coalesce(sum(s.revision), 0)
            from public.individual_hole_scores s
            where s.round_id = cards.round_id
              and s.event_entry_id = cards.event_entry_id
          )
      )
    ) or (
      cards.event_team_id is not null
      and exists (
        select 1
        from public.team_hole_scores scored
        where scored.round_id = cards.round_id
          and scored.event_team_id = cards.event_team_id
          and scored.score_status <> 'not_started'
      )
      and not exists (
        select 1
        from public.scorecard_attestations sa
        where sa.event_team_id = cards.event_team_id
          and sa.round_id = cards.round_id
          and sa.score_revision = (
            select coalesce(sum(s.revision), 0)
            from public.team_hole_scores s
            where s.round_id = cards.round_id
              and s.event_team_id = cards.event_team_id
          )
      )
    );
  elsif v_comp.format in ('scramble', 'foursomes', 'greensomes', 'chapman')
    or (v_comp.format = 'skins' and v_comp.rules_json #>> '{skins,population}' = 'teams')
  then
    select count(*) into v_unattested
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and ce.eligibility_status = 'eligible'
      and not exists (
        select 1
        from public.scorecard_attestations sa
        where sa.event_team_id = ce.event_team_id
          and sa.round_id = cr.round_id
          and sa.score_revision = (
            select coalesce(sum(s.revision), 0)
            from public.team_hole_scores s
            where s.round_id = cr.round_id
              and s.event_team_id = ce.event_team_id
          )
      );
  elsif v_comp.format in ('best_k', 'aggregate', 'shamble') then
    select count(*) into v_unattested
    from (
      select distinct cr.round_id, etm.event_entry_id
      from public.competition_entities ce
      join public.competition_rounds cr on cr.competition_id = ce.competition_id
      join public.event_team_members etm on etm.event_team_id = ce.event_team_id
      join public.event_entries ee on ee.id = etm.event_entry_id
      where ce.competition_id = p_competition_id
        and ce.event_team_id is not null
        and ce.eligibility_status = 'eligible'
        and ee.status = 'active'
    ) cards
    where not exists (
      select 1
      from public.scorecard_attestations sa
      where sa.event_entry_id = cards.event_entry_id
        and sa.round_id = cards.round_id
        and sa.score_revision = (
          select coalesce(sum(s.revision), 0)
          from public.individual_hole_scores s
          where s.round_id = cards.round_id
            and s.event_entry_id = cards.event_entry_id
        )
    );
  else
    select count(*) into v_unattested
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.rounds r on r.id = cr.round_id
    join public.event_entries ee on ee.id = ce.event_entry_id
    where ce.competition_id = p_competition_id
      and ce.event_entry_id is not null
      and ce.eligibility_status = 'eligible'
      and ee.status = 'active'
      and (
        ee.effective_from_round_id is null
        or exists (
          select 1 from public.rounds entry_start
          where entry_start.id = ee.effective_from_round_id
            and entry_start.round_number <= r.round_number
        )
      )
      and not exists (
        select 1
        from public.event_entries successor
        join public.rounds successor_start
          on successor_start.id = successor.effective_from_round_id
        where successor.replaces_entry_id = ee.id
          and successor_start.round_number <= r.round_number
      )
      and not exists (
        select 1
        from public.scorecard_attestations sa
        where sa.event_entry_id = ee.id
          and sa.round_id = cr.round_id
          and sa.score_revision = (
            select coalesce(sum(s.revision), 0)
            from public.individual_hole_scores s
            where s.round_id = cr.round_id and s.event_entry_id = ee.id
          )
      );
  end if;

  -- A free-text committee override can document incomplete cards, conflicts,
  -- or missing attestations. It cannot manufacture a match winner or resolve
  -- a skins carry: those require an authoritative terminal/result fact before
  -- the final projection can become final.
  if v_match_blockers > 0
    or v_carry_blockers > 0
    or (
      (
        v_missing > 0
        or v_conflicts > 0
        or v_unattested > 0
      )
      and nullif(trim(coalesce(p_override_reason, '')), '') is null
    ) then
    return jsonb_build_object(
      'status', 'blocked', 'missingScores', v_missing,
      'openConflicts', v_conflicts, 'unattestedCards', v_unattested,
      'matchBlockers', v_match_blockers, 'carryBlockers', v_carry_blockers
    );
  end if;

  -- Preflight passed but the published artifact is still the live one. The
  -- caller republishes this target under final missing-data policy and calls
  -- again to seal that exact hash. Nothing changes status here, so an
  -- interrupted attempt leaves the competition exactly where it started.
  if v_projection_status <> 'final' then
    return jsonb_build_object(
      'status', 'ready',
      'eventId', v_event.id,
      'competitionId', p_competition_id,
      'missingScores', v_missing, 'openConflicts', v_conflicts,
      'unattestedCards', v_unattested,
      'matchBlockers', v_match_blockers, 'carryBlockers', v_carry_blockers
    );
  end if;

  -- Walk this competition alone through the enforced transition graph. Its
  -- siblings keep scoring; their inputs are untouched.
  if v_comp.status = 'scoring_open' then
    update public.competitions set status = 'scoring_closed'
      where id = p_competition_id;
  end if;

  update public.competitions set
    status = 'finalized', finalized_at = now(), finalized_by = p_actor,
    final_result_hash = v_projection_hash,
    engine_version = v_projection_engine_version
  where id = p_competition_id;

  -- A round is complete once no competition spanning it is still open.
  update public.rounds r
  set status = 'complete'
  where r.event_id = v_event.id
    and r.status = 'in_progress'
    and exists (
      select 1 from public.competition_rounds cr where cr.round_id = r.id
    )
    and not exists (
      select 1
      from public.competition_rounds cr
      join public.competitions c on c.id = cr.competition_id
      where cr.round_id = r.id
        and c.status not in ('finalized', 'archived')
    );

  if not exists (
    select 1 from public.competitions
    where event_id = v_event.id and status not in ('finalized', 'archived')
  ) then
    if v_event.status = 'scoring_open' then
      update public.events set status = 'scoring_closed' where id = v_event.id;
      v_event.status := 'scoring_closed';
    end if;
    update public.events set status = 'finalized' where id = v_event.id;
    v_event.status := 'finalized';
  end if;

  insert into public.audit_events (
    actor_profile_id, action, scope_league_id, scope_event_id,
    target_type, target_id, reason, after_json
  ) values (
    p_actor, 'competition.finalized', v_event.league_id, v_event.id,
    'competition', p_competition_id,
    nullif(trim(coalesce(p_override_reason, '')), ''),
    jsonb_build_object(
      'finalResultHash', v_projection_hash,
      'engineVersion', v_projection_engine_version,
      'missingScoreOverrides', v_missing,
      'conflictOverrides', v_conflicts,
      'attestationOverrides', v_unattested
    )
  );

  return jsonb_build_object(
    'status', 'finalized', 'eventId', v_event.id,
    'competitionId', p_competition_id,
    'finalResultHash', v_projection_hash,
    'engineVersion', v_projection_engine_version,
    'missingScoreOverrides', v_missing,
    'conflictOverrides', v_conflicts,
    'attestationOverrides', v_unattested
  );
end;
$$;

revoke all on function public.finalize_phase1_competition(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.finalize_phase1_competition(uuid, uuid, text)
  to service_role;

comment on function public.finalize_phase1_competition(uuid, uuid, text) is
  'Seal one competition independently (Appendix B): blockers are scoped to the competition''s own inputs, only the sealing call changes status, and the event/rounds close only after every competition is sealed.';

comment on function public.reopen_competition(uuid, uuid, text) is
  'Reopen one finalized competition for audited corrections (§26 runbook). Clears that competition''s final hash only; sibling sealed results and their score facts stay locked.';
