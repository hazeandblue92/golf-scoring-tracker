-- Migration 19: finalize team-ball competitions against team card attestations.
-- Individual-source formats continue to require current individual cards;
-- scramble/foursomes/greensomes/chapman require current team-ball cards.

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
  v_projection_hash text;
  v_best_k integer;
begin
  select * into v_comp from public.competitions
  where id = p_competition_id for update;
  if not found then raise exception 'competition not found' using errcode = 'P0002'; end if;
  if not app.actor_is_event_director(p_actor, v_comp.event_id) then
    raise exception 'event director role required' using errcode = '42501';
  end if;
  select * into v_event from public.events where id = v_comp.event_id for update;

  if v_event.status = 'scoring_open' then
    update public.competitions set status = 'scoring_closed'
      where event_id = v_event.id and status = 'scoring_open';
    update public.rounds set status = 'complete'
      where event_id = v_event.id and status = 'in_progress';
    update public.events set status = 'scoring_closed' where id = v_event.id;
    v_event.status := 'scoring_closed';
  end if;
  if v_event.status <> 'scoring_closed' then
    raise exception 'event must be open or closed for scoring' using errcode = '23514';
  end if;

  if v_comp.format in ('best_k', 'aggregate') then
    v_best_k := coalesce((v_comp.rules_json #>> '{team,bestK}')::integer, 1);
    select count(*) into v_missing
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and (
        select count(*)
        from public.event_team_members etm
        join public.individual_hole_scores s
          on s.event_entry_id = etm.event_entry_id
         and s.event_hole_id = eh.id
         and s.score_status <> 'not_started'
        where etm.event_team_id = ce.event_team_id
      ) < v_best_k;
  elsif v_comp.format in ('scramble', 'foursomes', 'greensomes', 'chapman') then
    select count(*) into v_missing
    from public.competition_entities ce
    join public.competition_rounds cr on cr.competition_id = ce.competition_id
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
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
    join public.event_holes eh on eh.round_id = cr.round_id
    where ce.competition_id = p_competition_id
      and ce.event_entry_id is not null
      and not exists (
        select 1 from public.individual_hole_scores s
        where s.event_entry_id = ce.event_entry_id
          and s.event_hole_id = eh.id
          and s.score_status <> 'not_started'
      );
  end if;

  select count(*) into v_conflicts
  from public.score_conflicts
  where event_id = v_event.id and status = 'open';

  if v_comp.format in ('scramble', 'foursomes', 'greensomes', 'chapman') then
    select count(*) into v_unattested
    from public.competition_entities ce
    where ce.competition_id = p_competition_id
      and ce.event_team_id is not null
      and not exists (
        select 1
        from public.scorecard_attestations sa
        join public.rounds r on r.id = sa.round_id and r.event_id = v_event.id
        where sa.event_team_id = ce.event_team_id
          and sa.score_revision = (
            select coalesce(sum(s.revision), 0)
            from public.team_hole_scores s
            where s.round_id = r.id and s.event_team_id = ce.event_team_id
          )
      );
  else
    select count(*) into v_unattested
    from public.event_entries ee
    where ee.event_id = v_event.id and ee.status = 'active'
      and not exists (
        select 1
        from public.scorecard_attestations sa
        join public.rounds r on r.id = sa.round_id and r.event_id = v_event.id
        where sa.event_entry_id = ee.id
          and sa.score_revision = (
            select coalesce(sum(s.revision), 0)
            from public.individual_hole_scores s
            where s.round_id = r.id and s.event_entry_id = ee.id
          )
      );
  end if;

  if (v_missing > 0 or v_conflicts > 0 or v_unattested > 0)
     and nullif(trim(coalesce(p_override_reason, '')), '') is null then
    return jsonb_build_object(
      'status', 'blocked', 'missingScores', v_missing,
      'openConflicts', v_conflicts, 'unattestedCards', v_unattested
    );
  end if;

  select projection_hash into v_projection_hash
  from public.competition_projections
  where competition_id = p_competition_id
    and event_revision = v_event.scoring_revision
    and status <> 'error';
  if v_projection_hash is null then
    return jsonb_build_object(
      'status', 'blocked', 'projectionStale', true,
      'missingScores', v_missing, 'openConflicts', v_conflicts,
      'unattestedCards', v_unattested
    );
  end if;

  update public.competitions set
    status = 'finalized', finalized_at = now(), finalized_by = p_actor,
    final_result_hash = v_projection_hash
  where id = p_competition_id;

  if not exists (
    select 1 from public.competitions
    where event_id = v_event.id and status <> 'finalized'
  ) then
    update public.events set status = 'finalized' where id = v_event.id;
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
      'missingScoreOverrides', v_missing,
      'conflictOverrides', v_conflicts,
      'attestationOverrides', v_unattested
    )
  );

  return jsonb_build_object(
    'status', 'finalized', 'eventId', v_event.id,
    'competitionId', p_competition_id,
    'finalResultHash', v_projection_hash,
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
