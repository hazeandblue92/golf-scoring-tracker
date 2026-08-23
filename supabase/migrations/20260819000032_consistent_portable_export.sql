-- Migration 32: build each portable export from one MVCC snapshot.
--
-- The Edge Function previously followed table relationships through many
-- paged PostgREST requests. Stable primary-key ordering prevented static
-- truncation, but an active score commit between requests could still combine
-- event metadata from one revision with raw facts from another. A STABLE SQL
-- function evaluates every relation inside the calling statement's snapshot
-- and returns one JSON value, so PostgREST's row limit cannot truncate it.

create or replace function public.export_portable_snapshot(
  p_actor uuid,
  p_league_id uuid,
  p_event_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
with
access_check as materialized (
  select exists (
    select 1
    from public.profiles profile
    where profile.id = p_actor
      and profile.status = 'active'
      and not profile.must_change_password
      and exists (
        select 1
        from public.role_assignments assignment
        where assignment.profile_id = p_actor
          and assignment.league_id = p_league_id
          and assignment.revoked_at is null
          and (
            assignment.role in ('owner', 'league_admin')
            or (
              p_event_id is not null
              and assignment.role = 'event_director'
              and assignment.event_id = p_event_id
            )
          )
      )
  ) as authorized
),
scoped_leagues as materialized (
  select league.*
  from public.leagues league
  cross join access_check access
  where league.id = p_league_id
    and access.authorized
),
scoped_seasons as materialized (
  select season.*
  from public.seasons season
  join scoped_leagues league on league.id = season.league_id
),
scoped_events as materialized (
  select event_row.*
  from public.events event_row
  join scoped_leagues league on league.id = event_row.league_id
  where event_row.league_id = p_league_id
    and (p_event_id is null or event_row.id = p_event_id)
),
scoped_rounds as materialized (
  select round_row.*
  from public.rounds round_row
  join scoped_events event_row on event_row.id = round_row.event_id
),
scoped_entries as materialized (
  select entry.*
  from public.event_entries entry
  join scoped_events event_row on event_row.id = entry.event_id
),
scoped_participants as materialized (
  select participant.*
  from public.participants participant
  join scoped_leagues league on league.id = participant.league_id
  where p_event_id is null
    or exists (
      select 1
      from scoped_entries entry
      where entry.participant_id = participant.id
    )
),
scoped_handicaps as materialized (
  select handicap.*
  from public.participant_handicaps handicap
  where exists (
    select 1
    from scoped_participants participant
    where participant.id = handicap.participant_id
  )
),
scoped_teams as materialized (
  select team.*
  from public.teams team
  join scoped_leagues league on league.id = team.league_id
  where p_event_id is null
),
scoped_team_members as materialized (
  select member.*
  from public.team_members member
  join scoped_teams team on team.id = member.team_id
  join scoped_participants participant on participant.id = member.participant_id
),
scoped_courses as materialized (
  select course.*
  from public.courses course
  join scoped_leagues league on league.id = course.league_id
),
scoped_course_layouts as materialized (
  select layout.*
  from public.course_layouts layout
  join scoped_courses course on course.id = layout.course_id
),
scoped_tee_sets as materialized (
  select tee_set.*
  from public.tee_sets tee_set
  join scoped_course_layouts layout on layout.id = tee_set.course_layout_id
),
scoped_tee_holes as materialized (
  select tee_hole.*
  from public.tee_holes tee_hole
  join scoped_tee_sets tee_set on tee_set.id = tee_hole.tee_set_id
),
scoped_tee_snapshots as materialized (
  select snapshot.*
  from public.event_tee_snapshots snapshot
  join scoped_rounds round_row on round_row.id = snapshot.round_id
),
scoped_event_holes as materialized (
  select event_hole.*
  from public.event_holes event_hole
  join scoped_rounds round_row on round_row.id = event_hole.round_id
),
scoped_flights as materialized (
  select flight.*
  from public.flights flight
  join scoped_events event_row on event_row.id = flight.event_id
),
scoped_event_teams as materialized (
  select event_team.*
  from public.event_teams event_team
  join scoped_events event_row on event_row.id = event_team.event_id
),
scoped_event_team_members as materialized (
  select member.*
  from public.event_team_members member
  join scoped_event_teams event_team on event_team.id = member.event_team_id
),
scoped_groups as materialized (
  select group_row.*
  from public.groups group_row
  join scoped_rounds round_row on round_row.id = group_row.round_id
),
scoped_group_members as materialized (
  select member.*
  from public.group_members member
  join scoped_groups group_row on group_row.id = member.group_id
  where (
    member.event_entry_id is null
    or exists (
      select 1 from scoped_entries entry where entry.id = member.event_entry_id
    )
  )
  and (
    member.event_team_id is null
    or exists (
      select 1
      from scoped_event_teams event_team
      where event_team.id = member.event_team_id
    )
  )
),
scoped_competitions as materialized (
  select competition.*
  from public.competitions competition
  join scoped_events event_row on event_row.id = competition.event_id
),
scoped_competition_rounds as materialized (
  select competition_round.*
  from public.competition_rounds competition_round
  join scoped_competitions competition
    on competition.id = competition_round.competition_id
),
scoped_entities as materialized (
  select entity.*
  from public.competition_entities entity
  join scoped_competitions competition on competition.id = entity.competition_id
),
scoped_matches as materialized (
  select match_row.*
  from public.matches match_row
  join scoped_competitions competition
    on competition.id = match_row.competition_id
),
scoped_individual_scores as materialized (
  select score.*
  from public.individual_hole_scores score
  join scoped_events event_row on event_row.id = score.event_id
),
scoped_team_scores as materialized (
  select score.*
  from public.team_hole_scores score
  join scoped_events event_row on event_row.id = score.event_id
),
scoped_score_mutations as materialized (
  select mutation.*
  from public.score_mutations mutation
  join scoped_events event_row on event_row.id = mutation.event_id
),
-- Live competitions export their newest rebuildable projection. A sealed
-- competition exports only the exact revision/hash/engine/status tuple that
-- was finalized; a later coincidentally identical hash cannot rewrite sealed
-- provenance during restore.
selected_projection_keys as materialized (
  select
    competition.id as competition_id,
    selected.event_revision
  from scoped_competitions competition
  cross join lateral (
    select projection.event_revision
    from public.competition_projections projection
    where projection.competition_id = competition.id
      and (
        competition.final_result_hash is null
        or (
          projection.event_revision = competition.finalized_revision
          and projection.projection_hash = competition.final_result_hash
          and projection.engine_version = competition.engine_version
          and projection.status = 'final'
        )
      )
    order by projection.event_revision desc
    limit 1
  ) selected
),
scoped_projections as materialized (
  select projection.*
  from public.competition_projections projection
  join selected_projection_keys selected
    on selected.competition_id = projection.competition_id
   and selected.event_revision = projection.event_revision
),
scoped_leaderboard_rows as materialized (
  select leaderboard.*
  from public.leaderboard_rows leaderboard
  join selected_projection_keys selected
    on selected.competition_id = leaderboard.competition_id
   and selected.event_revision = leaderboard.event_revision
  join scoped_entities entity
    on entity.id = leaderboard.entity_id
   and entity.competition_id = leaderboard.competition_id
),
scoped_hole_results as materialized (
  select hole_result.*
  from public.hole_results hole_result
  join selected_projection_keys selected
    on selected.competition_id = hole_result.competition_id
   and selected.event_revision = hole_result.event_revision
),
scoped_attestations as materialized (
  select attestation.*
  from public.scorecard_attestations attestation
  join scoped_rounds round_row on round_row.id = attestation.round_id
),
scoped_audit_events as materialized (
  select audit.*
  from public.audit_events audit
  where exists (select 1 from scoped_leagues)
    and (
      exists (
        select 1
        from scoped_events event_row
        where event_row.id = audit.scope_event_id
      )
      or (
        p_event_id is null
        and audit.scope_league_id = p_league_id
      )
    )
)
select jsonb_build_object(
  'authorized', (select access.authorized from access_check access),
  'tables', jsonb_build_object(
    'leagues', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_leagues item
    ), '[]'::jsonb),
    'seasons', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_seasons item
    ), '[]'::jsonb),
    'participants', coalesce((
      select jsonb_agg(
        to_jsonb(item) || jsonb_build_object(
          'profile_id', null,
          'organizer_notes', null
        )
        order by item.id
      )
      from scoped_participants item
    ), '[]'::jsonb),
    'participant_handicaps', coalesce((
      select jsonb_agg(
        to_jsonb(item) || jsonb_build_object('verified_by', null)
        order by item.id
      )
      from scoped_handicaps item
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_teams item
    ), '[]'::jsonb),
    'team_members', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_team_members item
    ), '[]'::jsonb),
    'courses', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_courses item
    ), '[]'::jsonb),
    'course_layouts', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_course_layouts item
    ), '[]'::jsonb),
    'tee_sets', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_tee_sets item
    ), '[]'::jsonb),
    'tee_holes', coalesce((
      select jsonb_agg(
        to_jsonb(item) order by item.tee_set_id, item.hole_ordinal
      )
      from scoped_tee_holes item
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(
        to_jsonb(item) || jsonb_build_object('created_by', null)
        order by item.id
      )
      from scoped_events item
    ), '[]'::jsonb),
    'rounds', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_rounds item
    ), '[]'::jsonb),
    'event_tee_snapshots', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_tee_snapshots item
    ), '[]'::jsonb),
    'event_holes', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_event_holes item
    ), '[]'::jsonb),
    'flights', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_flights item
    ), '[]'::jsonb),
    'event_entries', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_entries item
    ), '[]'::jsonb),
    'event_teams', coalesce((
      select jsonb_agg(
        to_jsonb(item) || jsonb_build_object(
          'source_team_id', case
            when p_event_id is null then item.source_team_id
            else null
          end
        )
        order by item.id
      )
      from scoped_event_teams item
    ), '[]'::jsonb),
    'event_team_members', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_event_team_members item
    ), '[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(
        to_jsonb(item) || jsonb_build_object('marker_profile_id', null)
        order by item.id
      )
      from scoped_groups item
    ), '[]'::jsonb),
    'group_members', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_group_members item
    ), '[]'::jsonb),
    'competitions', coalesce((
      select jsonb_agg(
        to_jsonb(item) || jsonb_build_object('finalized_by', null)
        order by item.id
      )
      from scoped_competitions item
    ), '[]'::jsonb),
    'competition_rounds', coalesce((
      select jsonb_agg(
        to_jsonb(item) order by item.competition_id, item.round_id
      )
      from scoped_competition_rounds item
    ), '[]'::jsonb),
    'competition_entities', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_entities item
    ), '[]'::jsonb),
    'matches', coalesce((
      select jsonb_agg(
        to_jsonb(item) || jsonb_build_object('concession_by', null)
        order by item.id
      )
      from scoped_matches item
    ), '[]'::jsonb),
    'individual_hole_scores', coalesce((
      select jsonb_agg(
        to_jsonb(item) || jsonb_build_object(
          'entered_by', null,
          'device_id_hash', null
        )
        order by item.id
      )
      from scoped_individual_scores item
    ), '[]'::jsonb),
    'team_hole_scores', coalesce((
      select jsonb_agg(
        to_jsonb(item) || jsonb_build_object(
          'entered_by', null,
          'device_id_hash', null
        )
        order by item.id
      )
      from scoped_team_scores item
    ), '[]'::jsonb),
    'score_conflicts', '[]'::jsonb,
    'competition_projections', coalesce((
      select jsonb_agg(
        to_jsonb(item) order by item.competition_id, item.event_revision
      )
      from scoped_projections item
    ), '[]'::jsonb),
    'leaderboard_rows', coalesce((
      select jsonb_agg(
        to_jsonb(item)
        order by item.competition_id, item.event_revision, item.entity_id
      )
      from scoped_leaderboard_rows item
    ), '[]'::jsonb),
    'hole_results', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.id)
      from scoped_hole_results item
    ), '[]'::jsonb)
  ),
  'attestationRecords', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', item.id,
        'round_id', item.round_id,
        'event_entry_id', item.event_entry_id,
        'event_team_id', item.event_team_id,
        'attestation_type', item.attestation_type,
        'score_revision', item.score_revision,
        'attested_at', item.attested_at,
        'reason', item.reason
      )
      order by item.id
    )
    from scoped_attestations item
  ), '[]'::jsonb),
  'scoreMutationRecords', coalesce((
    select jsonb_agg(
      to_jsonb(item) || jsonb_build_object(
        'actor_profile_id', null,
        'device_id_hash', null
      )
      order by item.created_at, item.idempotency_key
    )
    from scoped_score_mutations item
  ), '[]'::jsonb),
  'auditRecords', coalesce((
    select jsonb_agg(
      to_jsonb(item) || jsonb_build_object('actor_profile_id', null)
      order by item.created_at, item.id
    )
    from scoped_audit_events item
  ), '[]'::jsonb),
  'finalResultHashes', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'competitionId', item.id,
        'hash', item.final_result_hash
      )
      order by item.id
    )
    from scoped_competitions item
    where item.final_result_hash is not null
  ), '[]'::jsonb),
  'missingSealedCompetitionIds', coalesce((
    select jsonb_agg(to_jsonb(item.id) order by item.id)
    from scoped_competitions item
    where item.final_result_hash is not null
      and not exists (
        select 1
        from selected_projection_keys selected
        where selected.competition_id = item.id
      )
  ), '[]'::jsonb)
);
$$;

revoke all on function public.export_portable_snapshot(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.export_portable_snapshot(uuid, uuid, uuid)
  to service_role;

comment on function public.export_portable_snapshot(uuid, uuid, uuid) is
  'Service-only portable export reader. Rechecks active, fully activated organizer authorization and returns all scoped tables plus sanitized append-only evidence from one stable SQL-statement snapshot as a single JSON value.';
