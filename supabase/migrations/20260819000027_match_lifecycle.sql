-- Migration 27: authoritative match lifecycle.
--
-- Match rows are raw Committee facts, but authenticated clients intentionally
-- have SELECT-only table privileges. This transaction is the sole live-event
-- write path: the MFA-gated Edge Function supplies the verified actor, the
-- database repeats authorization and lifecycle validation, updates the match,
-- advances the event scoring revision, and appends a scoped audit event as one
-- atomic commit. Projection publication happens after the durable fact.

-- Terminal winner shape is data integrity, not merely API validation. Keep the
-- constraint NOT VALID so a deployment can surface and repair any historical
-- malformed row without blocking the migration; PostgreSQL still enforces it
-- for every new or changed row.
alter table public.matches
  drop constraint if exists matches_status_winner_shape;
alter table public.matches
  add constraint matches_status_winner_shape check (
    (
      status in ('scheduled', 'in_progress', 'cancelled')
      and winner_entity_id is null
    )
    or (
      status = 'complete'
      and side_a_entity_id is not null
      and side_b_entity_id is not null
    )
    or (
      status = 'conceded'
      and side_a_entity_id is not null
      and side_b_entity_id is not null
      and winner_entity_id is not null
    )
    or (
      status = 'walkover'
      and num_nonnulls(side_a_entity_id, side_b_entity_id) >= 1
      and winner_entity_id is not null
    )
  ) not valid;

create or replace function public.set_match_result(
  p_actor uuid,
  p_match_id uuid,
  p_status text,
  p_winner_entity_id uuid,
  p_result_summary text,
  p_reason text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match public.matches%rowtype;
  v_comp public.competitions%rowtype;
  v_event public.events%rowtype;
  v_summary text := nullif(trim(coalesce(p_result_summary, '')), '');
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_concession_by uuid;
  v_concession_reason text;
  v_revision bigint;
  v_before jsonb;
  v_after jsonb;
  v_changed boolean;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'service role required' using errcode = '42501';
  end if;

  if p_status not in ('complete', 'conceded', 'walkover') then
    raise exception 'terminal match status must be complete, conceded, or walkover'
      using errcode = '22023';
  end if;
  if v_summary is null or char_length(v_summary) > 80 then
    raise exception 'result summary must contain 1 to 80 characters'
      using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'committee reason must contain 3 to 500 characters'
      using errcode = '22023';
  end if;

  select * into v_match
  from public.matches
  where id = p_match_id
  for update;
  if not found then
    raise exception 'match not found' using errcode = 'P0002';
  end if;

  select * into v_comp
  from public.competitions
  where id = v_match.competition_id
  for update;
  if not found or v_comp.format <> 'match' then
    raise exception 'match competition not found' using errcode = '23514';
  end if;

  select * into v_event
  from public.events
  where id = v_comp.event_id
  for update;
  if not found then
    raise exception 'event not found' using errcode = 'P0002';
  end if;

  if not app.actor_is_event_director(p_actor, v_event.id) then
    raise exception 'event director role required' using errcode = '42501';
  end if;
  if v_comp.status = 'finalized' or v_event.status = 'finalized' then
    raise exception 'finalized match facts are immutable; reopen the competition first'
      using errcode = '23514';
  end if;
  if v_comp.status not in ('scoring_open', 'scoring_closed')
    or v_event.status not in ('scoring_open', 'scoring_closed')
  then
    raise exception 'match results require scoring to be open or closed'
      using errcode = '23514';
  end if;

  if p_winner_entity_id is not null
    and p_winner_entity_id is distinct from v_match.side_a_entity_id
    and p_winner_entity_id is distinct from v_match.side_b_entity_id
  then
    raise exception 'winner must be one of the match sides' using errcode = '23514';
  end if;
  if p_status in ('conceded', 'walkover') and p_winner_entity_id is null then
    raise exception '% requires a winning side', p_status using errcode = '23514';
  end if;
  if p_status in ('complete', 'conceded')
    and (v_match.side_a_entity_id is null or v_match.side_b_entity_id is null)
  then
    raise exception '% requires two present sides', p_status using errcode = '23514';
  end if;
  if p_status = 'walkover'
    and num_nonnulls(v_match.side_a_entity_id, v_match.side_b_entity_id) = 0
  then
    raise exception 'walkover requires one present side' using errcode = '23514';
  end if;

  v_concession_by := case when p_status = 'conceded' then p_actor else null end;
  v_concession_reason := case when p_status = 'conceded' then v_reason else null end;
  v_before := jsonb_build_object(
    'status', v_match.status,
    'winnerEntityId', v_match.winner_entity_id,
    'resultSummary', v_match.result_summary,
    'concessionBy', v_match.concession_by,
    'concessionReason', v_match.concession_reason
  );

  v_changed := v_match.status is distinct from p_status
    or v_match.winner_entity_id is distinct from p_winner_entity_id
    or v_match.result_summary is distinct from v_summary
    or v_match.concession_by is distinct from v_concession_by
    or v_match.concession_reason is distinct from v_concession_reason;

  if v_changed then
    update public.matches
    set status = p_status,
        winner_entity_id = p_winner_entity_id,
        result_summary = v_summary,
        concession_by = v_concession_by,
        concession_reason = v_concession_reason
    where id = p_match_id;

    -- Migration 10 rejects every direct scoring_revision edit unless the
    -- authoritative workflow opens this transaction-local guard explicitly.
    perform set_config('app.allow_scoring_revision_change', 'on', true);
    update public.events
    set scoring_revision = scoring_revision + 1,
        updated_at = now()
    where id = v_event.id
    returning scoring_revision into v_revision;
    perform set_config('app.allow_scoring_revision_change', '', true);

    v_after := jsonb_build_object(
      'status', p_status,
      'winnerEntityId', p_winner_entity_id,
      'resultSummary', v_summary,
      'concessionBy', v_concession_by,
      'concessionReason', v_concession_reason,
      'eventRevision', v_revision
    );

    insert into public.audit_events (
      actor_profile_id,
      action,
      scope_league_id,
      scope_event_id,
      target_type,
      target_id,
      reason,
      before_json,
      after_json,
      correlation_id
    ) values (
      p_actor,
      'match.result_set',
      v_event.league_id,
      v_event.id,
      'match',
      p_match_id,
      v_reason,
      v_before,
      v_after,
      p_correlation_id
    );
  else
    v_revision := v_event.scoring_revision;
  end if;

  return jsonb_build_object(
    'status', 'saved',
    'changed', v_changed,
    'matchId', p_match_id,
    'eventId', v_event.id,
    'competitionId', v_comp.id,
    'matchStatus', p_status,
    'winnerEntityId', p_winner_entity_id,
    'eventRevision', v_revision
  );
end;
$$;

revoke all on function public.set_match_result(
  uuid, uuid, text, uuid, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.set_match_result(
  uuid, uuid, text, uuid, text, text, uuid
) to service_role;

comment on function public.set_match_result(
  uuid, uuid, text, uuid, text, text, uuid
) is
  'Atomically record one MFA-authorized terminal match fact, bump the parent event scoring revision, and append a league/event-scoped audit record. Unfinished matches remain non-overridable at competition finalization.';
