-- Migration 36: Best Ball finalization requires every member card, not bestK.
--
-- `finalize_phase1_competition` counted, per team and hole, how many member
-- scores were resolved and treated the hole as complete once that reached
-- `rules_json -> team -> bestK`. For the Two-Person Throwdown bestK is 1, so a
-- single partner's card satisfied the whole team hole and both Best Ball
-- competitions could seal while the other partner's card was still blank.
--
-- That is unsafe twice over:
--
--   1. The pending partner can still post a LOWER score, which would become
--      the counting ball. The sealed result is therefore not the result.
--   2. Sealing locks every raw fact the competition consumed. Best Ball reads
--      member `individual_hole_scores` — the very same facts Individual
--      Gross/Net and Gross/Net Skins read. Once Best Ball seals early, the
--      missing partner scores become legitimately locked facts and cannot be
--      entered for ANY of the six competitions until Best Ball is reopened.
--
-- Completeness now matches the attestation rule this function already applies
-- to the same formats: every ACTIVE member of an eligible team must have a
-- resolved score on every in-scope hole. `bestK` still governs scoring — how
-- many cards count — it just no longer governs completeness.
--
-- A committee can still finalize early through the documented override path,
-- which records a reason; this only changes the unattended default.
--
-- Rebased on migration 26 (20260819000026_lifecycle_completion.sql), which
-- holds the current definition — NOT migration 25, whose copy is superseded.
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
  if not exists (
    select 1
    from public.competition_rounds cr
    where cr.competition_id = p_competition_id
  ) then
    raise exception 'competition has no authoritative round scope'
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
    -- bestK governs SCORING (how many cards count), not completeness:
    -- every member card must exist before the ball can be called.
    select count(*) into v_missing
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.event_teams et on et.id = ce.event_team_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and ce.eligibility_status = 'eligible'
      and et.status = 'active'
      and case
        when cr.hole_scope is not null then
          cardinality(cr.hole_scope) = 0
          or eh.hole_ordinal = any(cr.hole_scope)
        when jsonb_typeof(v_comp.rules_json -> 'holeScope') = 'array'
          and jsonb_array_length(v_comp.rules_json -> 'holeScope') > 0 then
          exists (
            select 1
            from jsonb_array_elements_text(v_comp.rules_json -> 'holeScope') scope(value)
            where scope.value::integer = eh.hole_ordinal
          )
        else true
      end
      and exists (
        select 1
        from public.event_team_members etm
        join public.event_entries ee on ee.id = etm.event_entry_id
        where etm.event_team_id = ce.event_team_id
          and ee.status = 'active'
          and not exists (
            select 1
            from public.individual_hole_scores s
            where s.event_entry_id = etm.event_entry_id
              and s.event_hole_id = eh.id
              and s.score_status <> 'not_started'
          )
      );
  elsif v_comp.format in ('scramble', 'foursomes', 'greensomes', 'chapman')
    or (v_comp.format = 'skins' and v_comp.rules_json #>> '{skins,population}' = 'teams')
  then
    select count(*) into v_missing
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.event_teams et on et.id = ce.event_team_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and ce.eligibility_status = 'eligible'
      and et.status = 'active'
      and case
        when cr.hole_scope is not null then
          cardinality(cr.hole_scope) = 0
          or eh.hole_ordinal = any(cr.hole_scope)
        when jsonb_typeof(v_comp.rules_json -> 'holeScope') = 'array'
          and jsonb_array_length(v_comp.rules_json -> 'holeScope') > 0 then
          exists (
            select 1
            from jsonb_array_elements_text(v_comp.rules_json -> 'holeScope') scope(value)
            where scope.value::integer = eh.hole_ordinal
          )
        else true
      end
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
      and case
        when cr.hole_scope is not null then
          cardinality(cr.hole_scope) = 0
          or eh.hole_ordinal = any(cr.hole_scope)
        when jsonb_typeof(v_comp.rules_json -> 'holeScope') = 'array'
          and jsonb_array_length(v_comp.rules_json -> 'holeScope') > 0 then
          exists (
            select 1
            from jsonb_array_elements_text(v_comp.rules_json -> 'holeScope') scope(value)
            where scope.value::integer = eh.hole_ordinal
          )
        else true
      end
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
      join public.event_teams et
        on et.id = ce.event_team_id and et.status = 'active'
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
      join public.event_teams et
        on et.id = ce.event_team_id and et.status = 'active'
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
    join public.event_teams et on et.id = ce.event_team_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and ce.eligibility_status = 'eligible'
      and et.status = 'active'
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
      join public.event_teams et on et.id = ce.event_team_id
      join public.event_team_members etm on etm.event_team_id = ce.event_team_id
      join public.event_entries ee on ee.id = etm.event_entry_id
      where ce.competition_id = p_competition_id
        and ce.event_team_id is not null
        and ce.eligibility_status = 'eligible'
        and et.status = 'active'
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
    and r.status in ('scheduled', 'in_progress')
    and (
      exists (
        select 1
        from public.competition_rounds linked
        where linked.round_id = r.id
      )
      or not exists (
        select 1
        from public.competitions remaining
        where remaining.event_id = v_event.id
          and remaining.status not in ('finalized', 'archived')
      )
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
