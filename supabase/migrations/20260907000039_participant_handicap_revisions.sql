-- Migration 39: record a handicap revision without breaking the interval.
--
-- §4.2 requires maintaining "handicap history with effective dates, source
-- (manual, authority_import, league_calculated, none), and verifier". The
-- table has always modelled that — participant_handicaps carries
-- [effective_from, effective_to) as a half-open range, protected by a gist
-- exclusion constraint so two values can never claim the same day.
--
-- Only the write path was missing. `catalog-admin`'s save-participant inserts a
-- row unconditionally, which succeeds exactly once per participant: the second
-- value collides with the open-ended first and raises 23P01. In practice that
-- meant a handicap could be set when a player was created and never changed
-- again, which is the opposite of history.
--
-- Closing the open interval and opening the next one must be one statement.
-- Two round trips from an Edge Function can be interrupted between them, and
-- the failure is silent and asymmetric: the old value is already closed, so
-- the participant has NO handicap for the new period, and a net competition
-- would treat them as unhandicapped rather than as an error.
--
-- Superseded rows are never deleted or edited. A frozen event snapshot cites
-- the value that was effective on its own date (§6.2), so rewriting history
-- here would change results that were already published.
--
-- The actor is passed explicitly rather than read from auth.uid(), following
-- save_phase2_event_draft and the other Edge-invoked RPCs: the caller is
-- `catalog-admin` holding the service role, for which auth.uid() is NULL. The
-- Edge Function has already proved the caller's role; this check is the second
-- one, against the same league, so a compromised function still cannot write a
-- handicap for a league its caller does not administer.

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

      insert into public.audit_events (actor_profile_id, action, scope_league_id, target_type, target_id)
      values (p_actor, 'participant.handicap_corrected', v_participant.league_id,
        'participant', p_participant_id);

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

  insert into public.audit_events (actor_profile_id, action, scope_league_id, target_type, target_id)
  values (p_actor, 'participant.handicap_recorded', v_participant.league_id,
    'participant', p_participant_id);

  return jsonb_build_object('status', 'recorded', 'handicapId', v_id,
    'effectiveFrom', v_effective);
end;
$$;

-- Service-role only: the actor is a parameter, so granting this to
-- `authenticated` would let any signed-in caller name someone else as the
-- actor. Every write arrives through `catalog-admin`, which proves the
-- caller's identity from their JWT before passing it here.
revoke all on function public.record_participant_handicap(uuid, uuid, numeric, public.handicap_source, date, text)
  from public, anon, authenticated;
grant execute on function public.record_participant_handicap(uuid, uuid, numeric, public.handicap_source, date, text)
  to service_role;

comment on function public.record_participant_handicap(uuid, uuid, numeric, public.handicap_source, date, text) is
  'Record a handicap revision for a participant, closing the interval it supersedes in the same statement (section 4.2). Same-day changes correct the current row; earlier dates back-fill and are bounded by the next interval. Superseded rows are never deleted, because frozen event snapshots cite them.';
