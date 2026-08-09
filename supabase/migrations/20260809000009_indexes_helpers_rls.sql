-- Migration 9: required indexes (spec section 11.9), app-schema helper
-- functions, and baseline Row Level Security per the section 14.3 matrix.
--
-- RLS philosophy: deny by default. Every table has RLS enabled; a table with
-- no policy is inaccessible to anon/authenticated. Tables that are mutated
-- only by Edge Functions with the service role deliberately have NO
-- insert/update/delete policies -- the service role bypasses RLS, and any
-- direct client write is denied. Those tables are marked below.

-- ===========================================================================
-- 1. Indexes (section 11.9: every FK used by RLS or join paths, the named
--    composite indexes, and partial active role/membership indexes).
-- ===========================================================================

-- identity / access
create index league_memberships_profile_active_idx
  on public.league_memberships (profile_id, league_id) where member_status = 'active';
create index league_memberships_league_idx on public.league_memberships (league_id);
create index role_assignments_profile_active_idx
  on public.role_assignments (profile_id, role, league_id) where revoked_at is null;
create index role_assignments_league_idx on public.role_assignments (league_id);
create index role_assignments_event_idx
  on public.role_assignments (event_id) where event_id is not null;
create index scoring_permissions_scorer_idx
  on public.scoring_permissions (scorer_profile_id, event_id, round_id);
create index scoring_permissions_event_idx on public.scoring_permissions (event_id);

-- league catalog
create index seasons_league_idx on public.seasons (league_id);
create index participants_league_idx on public.participants (league_id);
create index participants_profile_idx
  on public.participants (profile_id) where profile_id is not null;
create index participant_handicaps_participant_idx
  on public.participant_handicaps (participant_id, effective_from desc);
create index teams_league_idx on public.teams (league_id);
create index teams_season_idx on public.teams (season_id) where season_id is not null;
create index team_members_team_idx on public.team_members (team_id);
create index team_members_participant_idx on public.team_members (participant_id);

-- courses
create index courses_league_idx on public.courses (league_id);
create index course_layouts_course_idx on public.course_layouts (course_id);
create index tee_sets_layout_idx on public.tee_sets (course_layout_id);

-- events
create index events_league_status_starts_idx on public.events (league_id, status, starts_at);
create index events_season_idx on public.events (season_id);
create index rounds_event_idx on public.rounds (event_id);
create index event_tee_snapshots_round_idx on public.event_tee_snapshots (round_id);
create index event_tee_snapshots_source_idx on public.event_tee_snapshots (source_tee_set_id);
create index event_holes_round_idx on public.event_holes (round_id);
create index event_holes_snapshot_idx on public.event_holes (event_tee_snapshot_id);
create index flights_event_idx on public.flights (event_id);
create index event_entries_event_idx on public.event_entries (event_id);
create index event_entries_participant_idx on public.event_entries (participant_id);
create index event_entries_flight_idx on public.event_entries (flight_id) where flight_id is not null;
create index event_teams_event_idx on public.event_teams (event_id);
create index event_team_members_team_idx on public.event_team_members (event_team_id);
create index event_team_members_entry_idx on public.event_team_members (event_entry_id);
create index groups_round_idx on public.groups (round_id);
create index group_members_group_idx on public.group_members (group_id);

-- competitions
create index competitions_event_idx on public.competitions (event_id);
create index competition_rounds_round_idx on public.competition_rounds (round_id);
create index competition_entities_competition_idx on public.competition_entities (competition_id);
create index matches_competition_idx on public.matches (competition_id, round_id);

-- raw scoring (the two four-column uniques are required by section 11.9)
create unique index individual_hole_scores_scope_unique
  on public.individual_hole_scores (event_id, round_id, event_entry_id, event_hole_id);
create unique index team_hole_scores_scope_unique
  on public.team_hole_scores (event_id, round_id, event_team_id, event_hole_id);
create index individual_hole_scores_entry_idx on public.individual_hole_scores (event_entry_id);
create index individual_hole_scores_hole_idx on public.individual_hole_scores (event_hole_id);
create index team_hole_scores_team_idx on public.team_hole_scores (event_team_id);
create index team_hole_scores_hole_idx on public.team_hole_scores (event_hole_id);
create index score_mutations_event_time_idx on public.score_mutations (event_id, created_at desc);
create index score_mutations_actor_time_idx on public.score_mutations (actor_profile_id, created_at desc);
create index score_conflicts_event_status_idx on public.score_conflicts (event_id, status);
create index scorecard_attestations_round_idx on public.scorecard_attestations (round_id);

-- projections / ops
create index leaderboard_rows_rank_idx on public.leaderboard_rows (competition_id, event_revision, rank);
create index hole_results_projection_idx on public.hole_results (competition_id, event_revision, entity_id);
create index event_revision_feed_event_idx on public.event_revision_feed (event_id, published_at desc);
create index audit_events_event_time_idx on public.audit_events (scope_event_id, created_at desc);
create index audit_events_league_time_idx on public.audit_events (scope_league_id, created_at desc);
create index push_subscriptions_profile_idx on public.push_subscriptions (profile_id);
create index app_error_events_last_seen_idx on public.app_error_events (last_seen_at desc);

-- ===========================================================================
-- 2. Helper functions (SECURITY DEFINER, STABLE). Owned by the migration
--    role (table owner), so they evaluate without recursive RLS. search_path
--    is pinned empty; all references are schema-qualified.
-- ===========================================================================

create or replace function app.is_league_member(p_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.league_memberships m
    where m.league_id = p_league_id
      and m.profile_id = auth.uid()
      and m.member_status = 'active'
  );
$$;

create or replace function app.has_role(p_league_id uuid, p_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.role_assignments ra
    where ra.league_id = p_league_id
      and ra.profile_id = auth.uid()
      and ra.role = any (p_roles)
      and ra.revoked_at is null
  );
$$;

-- Directors of a specific event, plus league admins/owner of its league.
create or replace function app.is_event_director(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.events e
    join public.role_assignments ra
      on ra.profile_id = auth.uid()
     and ra.revoked_at is null
     and (
       (ra.role = 'event_director' and ra.event_id = e.id)
       or (ra.role in ('owner', 'league_admin') and ra.league_id = e.league_id)
     )
    where e.id = p_event_id
  );
$$;

-- Event visibility (sections 2.2, 14.3): directors always; league members for
-- non-draft league-visible events; anyone (including anon spectators) for
-- non-draft public events; organizer-only events for directors only.
create or replace function app.can_read_event(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.events e
    where e.id = p_event_id
      and (
        app.is_event_director(e.id)
        or (e.status <> 'draft' and e.visibility = 'league' and app.is_league_member(e.league_id))
        or (e.status <> 'draft' and e.visibility = 'public')
      )
  );
$$;

-- Competition visibility layered on event visibility.
create or replace function app.can_read_competition(p_competition_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.competitions c
    join public.events e on e.id = c.event_id
    where c.id = p_competition_id
      and (
        app.is_event_director(e.id)
        or (c.visibility = 'public' and app.can_read_event(e.id))
        or (c.visibility = 'league' and app.can_read_event(e.id) and app.is_league_member(e.league_id))
      )
  );
$$;

-- The signed-in user owns this event entry (their own scorecard).
create or replace function app.is_entry_owner(p_entry_id uuid)
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

-- The signed-in user is a member of this event team.
create or replace function app.is_team_member(p_event_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.event_team_members etm
    join public.event_entries ee on ee.id = etm.event_entry_id
    join public.participants p on p.id = ee.participant_id
    where etm.event_team_id = p_event_team_id
      and p.profile_id = auth.uid()
  );
$$;

-- Active scorer assignment covering an individual entry (directly by
-- participant, or via a team the participant belongs to in this event).
create or replace function app.can_score_entry(p_event_id uuid, p_round_id uuid, p_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.scoring_permissions sp
    join public.event_entries ee on ee.id = p_entry_id
    where sp.event_id = p_event_id
      and sp.round_id = p_round_id
      and sp.scorer_profile_id = auth.uid()
      and sp.valid_from <= now()
      and (sp.valid_to is null or sp.valid_to > now())
      and (
        sp.participant_id = ee.participant_id
        or (sp.team_id is not null and exists (
              select 1
              from public.event_teams et
              join public.event_team_members etm on etm.event_team_id = et.id
              where et.event_id = p_event_id
                and et.source_team_id = sp.team_id
                and etm.event_entry_id = ee.id
        ))
      )
  );
$$;

-- Active scorer assignment covering a team ball (directly by team, or via a
-- participant who is a member of the event team).
create or replace function app.can_score_team(p_event_id uuid, p_round_id uuid, p_event_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.scoring_permissions sp
    join public.event_teams et on et.id = p_event_team_id
    where sp.event_id = p_event_id
      and sp.round_id = p_round_id
      and sp.scorer_profile_id = auth.uid()
      and sp.valid_from <= now()
      and (sp.valid_to is null or sp.valid_to > now())
      and (
        (sp.team_id is not null and sp.team_id = et.source_team_id)
        or (sp.participant_id is not null and exists (
              select 1
              from public.event_team_members etm
              join public.event_entries ee on ee.id = etm.event_entry_id
              where etm.event_team_id = et.id
                and ee.participant_id = sp.participant_id
        ))
      )
  );
$$;

-- Deployment operators: owner/league_admin of any league (ops tables carry no
-- league scope; the supported deployment has one active league).
create or replace function app.is_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.role_assignments ra
    where ra.profile_id = auth.uid()
      and ra.role in ('owner', 'league_admin')
      and ra.revoked_at is null
  );
$$;

-- Organizer-only notes accessor (section 11.3). Lives in public so PostgREST
-- exposes it as an RPC; returns NULL for callers without organizer roles.
create or replace function public.participant_organizer_notes(p_participant_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when app.has_role(p.league_id, array['owner', 'league_admin', 'event_director']::public.app_role[])
      then p.organizer_notes
    else null
  end
  from public.participants p
  where p.id = p_participant_id;
$$;

grant execute on all functions in schema app to anon, authenticated, service_role;
grant execute on function public.participant_organizer_notes(uuid) to authenticated;

-- ===========================================================================
-- 3. Enable RLS on EVERY table. No policy means no access (deny by default).
-- ===========================================================================

alter table public.profiles enable row level security;
alter table public.leagues enable row level security;
alter table public.league_memberships enable row level security;
alter table public.role_assignments enable row level security;
alter table public.scoring_permissions enable row level security;
alter table public.seasons enable row level security;
alter table public.participants enable row level security;
alter table public.participant_handicaps enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.courses enable row level security;
alter table public.course_layouts enable row level security;
alter table public.tee_sets enable row level security;
alter table public.tee_holes enable row level security;
alter table public.events enable row level security;
alter table public.rounds enable row level security;
alter table public.event_tee_snapshots enable row level security;
alter table public.event_holes enable row level security;
alter table public.flights enable row level security;
alter table public.event_entries enable row level security;
alter table public.event_teams enable row level security;
alter table public.event_team_members enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.competitions enable row level security;
alter table public.competition_rounds enable row level security;
alter table public.competition_entities enable row level security;
alter table public.matches enable row level security;
alter table public.individual_hole_scores enable row level security;
alter table public.team_hole_scores enable row level security;
alter table public.score_mutations enable row level security;
alter table public.score_conflicts enable row level security;
alter table public.scorecard_attestations enable row level security;
alter table public.competition_projections enable row level security;
alter table public.leaderboard_rows enable row level security;
alter table public.hole_results enable row level security;
alter table public.event_revision_feed enable row level security;
alter table public.audit_events enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.app_error_events enable row level security;
alter table public.backup_runs enable row level security;

-- ===========================================================================
-- 4. Policies (section 14.3 matrix).
-- ===========================================================================

-- profiles: own row, plus league admins for members of their league.
-- NO write policies: profile mutations happen only through the account-admin
-- and complete-activation Edge Functions with the service role (section 12.2).
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_select_league_admin on public.profiles
  for select to authenticated
  using (
    exists (
      select 1
      from public.league_memberships lm
      where lm.profile_id = profiles.id
        and app.has_role(lm.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  );

-- leagues: members read; owner/admin update settings. No client insert/delete
-- (league creation is a bootstrap operation performed with the service role).
create policy leagues_select_member on public.leagues
  for select to authenticated
  using (
    app.is_league_member(id)
    or app.has_role(id, array['owner', 'league_admin']::public.app_role[])
  );

create policy leagues_update_admin on public.leagues
  for update to authenticated
  using (app.has_role(id, array['owner', 'league_admin']::public.app_role[]))
  with check (app.has_role(id, array['owner', 'league_admin']::public.app_role[]));

-- league_memberships: own rows plus admins. NO write policies (account-admin
-- Edge Function only).
create policy league_memberships_select_self on public.league_memberships
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy league_memberships_select_admin on public.league_memberships
  for select to authenticated
  using (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]));

-- role_assignments: own grants; admins in league; directors for their events.
-- NO write policies (role grants are privileged, service role only).
create policy role_assignments_select_self on public.role_assignments
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy role_assignments_select_admin on public.role_assignments
  for select to authenticated
  using (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]));

create policy role_assignments_select_director on public.role_assignments
  for select to authenticated
  using (event_id is not null and app.is_event_director(event_id));

-- scoring_permissions: scorers see their own assignments; directors manage
-- assignments for their events (insert/update; expiry via valid_to, no DELETE).
create policy scoring_permissions_select_self on public.scoring_permissions
  for select to authenticated
  using (scorer_profile_id = (select auth.uid()));

create policy scoring_permissions_select_director on public.scoring_permissions
  for select to authenticated
  using (app.is_event_director(event_id));

create policy scoring_permissions_insert_director on public.scoring_permissions
  for insert to authenticated
  with check (app.is_event_director(event_id));

create policy scoring_permissions_update_director on public.scoring_permissions
  for update to authenticated
  using (app.is_event_director(event_id))
  with check (app.is_event_director(event_id));

-- seasons: league members read; owner/admin write (soft lifecycle, no DELETE).
create policy seasons_select_member on public.seasons
  for select to authenticated
  using (
    app.is_league_member(league_id)
    or app.has_role(league_id, array['owner', 'league_admin']::public.app_role[])
  );

create policy seasons_insert_admin on public.seasons
  for insert to authenticated
  with check (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]));

create policy seasons_update_admin on public.seasons
  for update to authenticated
  using (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]))
  with check (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]));

-- participants: league members read minimal fields (see column grants below);
-- owner/admin write. Spectators get no direct directory access (names appear
-- only inside published projection payloads).
create policy participants_select_member on public.participants
  for select to authenticated
  using (
    app.is_league_member(league_id)
    or app.has_role(league_id, array['owner', 'league_admin', 'event_director']::public.app_role[])
  );

create policy participants_insert_admin on public.participants
  for insert to authenticated
  with check (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]));

create policy participants_update_admin on public.participants
  for update to authenticated
  using (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]))
  with check (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]));

-- Section 14.3: players see league-visible minimal fields only. The
-- organizer_notes column is excluded from the authenticated column grant and
-- surfaced to organizers via public.participant_organizer_notes(). Clients
-- must select explicit columns (select * would be denied).
revoke select on public.participants from anon, authenticated;
grant select (id, league_id, profile_id, display_name, sort_name, external_ref, status, created_at, updated_at)
  on public.participants to authenticated;

-- participant_handicaps: organizer roles only (section 14.3 -- players see
-- only their frozen event snapshot on event_entries; imports run through the
-- import-csv Edge Function, manual verified values through admins).
create policy participant_handicaps_select_organizer on public.participant_handicaps
  for select to authenticated
  using (
    exists (
      select 1 from public.participants p
      where p.id = participant_id
        and app.has_role(p.league_id, array['owner', 'league_admin', 'event_director']::public.app_role[])
    )
  );

create policy participant_handicaps_insert_admin on public.participant_handicaps
  for insert to authenticated
  with check (
    exists (
      select 1 from public.participants p
      where p.id = participant_id
        and app.has_role(p.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  );

create policy participant_handicaps_update_admin on public.participant_handicaps
  for update to authenticated
  using (
    exists (
      select 1 from public.participants p
      where p.id = participant_id
        and app.has_role(p.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  )
  with check (
    exists (
      select 1 from public.participants p
      where p.id = participant_id
        and app.has_role(p.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  );

-- teams / team_members: league members read; owner/admin write.
create policy teams_select_member on public.teams
  for select to authenticated
  using (
    app.is_league_member(league_id)
    or app.has_role(league_id, array['owner', 'league_admin', 'event_director']::public.app_role[])
  );

create policy teams_insert_admin on public.teams
  for insert to authenticated
  with check (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]));

create policy teams_update_admin on public.teams
  for update to authenticated
  using (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]))
  with check (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]));

create policy team_members_select_member on public.team_members
  for select to authenticated
  using (
    exists (
      select 1 from public.teams t
      where t.id = team_id
        and (
          app.is_league_member(t.league_id)
          or app.has_role(t.league_id, array['owner', 'league_admin', 'event_director']::public.app_role[])
        )
    )
  );

create policy team_members_insert_admin on public.team_members
  for insert to authenticated
  with check (
    exists (
      select 1 from public.teams t
      where t.id = team_id
        and app.has_role(t.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  );

create policy team_members_update_admin on public.team_members
  for update to authenticated
  using (
    exists (
      select 1 from public.teams t
      where t.id = team_id
        and app.has_role(t.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  )
  with check (
    exists (
      select 1 from public.teams t
      where t.id = team_id
        and app.has_role(t.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  );

-- courses catalog: league members read; owner/admin write.
create policy courses_select_member on public.courses
  for select to authenticated
  using (
    app.is_league_member(league_id)
    or app.has_role(league_id, array['owner', 'league_admin', 'event_director']::public.app_role[])
  );

create policy courses_insert_admin on public.courses
  for insert to authenticated
  with check (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]));

create policy courses_update_admin on public.courses
  for update to authenticated
  using (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]))
  with check (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]));

create policy course_layouts_select_member on public.course_layouts
  for select to authenticated
  using (
    exists (
      select 1 from public.courses c
      where c.id = course_id
        and (
          app.is_league_member(c.league_id)
          or app.has_role(c.league_id, array['owner', 'league_admin', 'event_director']::public.app_role[])
        )
    )
  );

create policy course_layouts_insert_admin on public.course_layouts
  for insert to authenticated
  with check (
    exists (
      select 1 from public.courses c
      where c.id = course_id
        and app.has_role(c.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  );

create policy course_layouts_update_admin on public.course_layouts
  for update to authenticated
  using (
    exists (
      select 1 from public.courses c
      where c.id = course_id
        and app.has_role(c.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = course_id
        and app.has_role(c.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  );

create policy tee_sets_select_member on public.tee_sets
  for select to authenticated
  using (
    exists (
      select 1
      from public.course_layouts cl
      join public.courses c on c.id = cl.course_id
      where cl.id = course_layout_id
        and (
          app.is_league_member(c.league_id)
          or app.has_role(c.league_id, array['owner', 'league_admin', 'event_director']::public.app_role[])
        )
    )
  );

create policy tee_sets_insert_admin on public.tee_sets
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.course_layouts cl
      join public.courses c on c.id = cl.course_id
      where cl.id = course_layout_id
        and app.has_role(c.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  );

create policy tee_sets_update_admin on public.tee_sets
  for update to authenticated
  using (
    exists (
      select 1
      from public.course_layouts cl
      join public.courses c on c.id = cl.course_id
      where cl.id = course_layout_id
        and app.has_role(c.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  )
  with check (
    exists (
      select 1
      from public.course_layouts cl
      join public.courses c on c.id = cl.course_id
      where cl.id = course_layout_id
        and app.has_role(c.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  );

create policy tee_holes_select_member on public.tee_holes
  for select to authenticated
  using (
    exists (
      select 1
      from public.tee_sets ts
      join public.course_layouts cl on cl.id = ts.course_layout_id
      join public.courses c on c.id = cl.course_id
      where ts.id = tee_set_id
        and (
          app.is_league_member(c.league_id)
          or app.has_role(c.league_id, array['owner', 'league_admin', 'event_director']::public.app_role[])
        )
    )
  );

create policy tee_holes_insert_admin on public.tee_holes
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.tee_sets ts
      join public.course_layouts cl on cl.id = ts.course_layout_id
      join public.courses c on c.id = cl.course_id
      where ts.id = tee_set_id
        and app.has_role(c.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  );

create policy tee_holes_update_admin on public.tee_holes
  for update to authenticated
  using (
    exists (
      select 1
      from public.tee_sets ts
      join public.course_layouts cl on cl.id = ts.course_layout_id
      join public.courses c on c.id = cl.course_id
      where ts.id = tee_set_id
        and app.has_role(c.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  )
  with check (
    exists (
      select 1
      from public.tee_sets ts
      join public.course_layouts cl on cl.id = ts.course_layout_id
      join public.courses c on c.id = cl.course_id
      where ts.id = tee_set_id
        and app.has_role(c.league_id, array['owner', 'league_admin']::public.app_role[])
    )
  );

-- events: visibility-based read (anon included for public events); admins
-- create; directors update. Status transitions and scoring_revision are
-- trigger-guarded (migration 10); publish/finalize additionally require the
-- MFA-gated Edge Functions. Hard DELETE is allowed only while draft.
create policy events_select_visible on public.events
  for select to anon, authenticated
  using (app.can_read_event(id));

create policy events_insert_admin on public.events
  for insert to authenticated
  with check (app.has_role(league_id, array['owner', 'league_admin']::public.app_role[]));

create policy events_update_director on public.events
  for update to authenticated
  using (app.is_event_director(id))
  with check (app.is_event_director(id));

create policy events_delete_draft_director on public.events
  for delete to authenticated
  using (status = 'draft' and app.is_event_director(id));

-- rounds: read with the event; directors write; hard delete only in draft.
create policy rounds_select_visible on public.rounds
  for select to anon, authenticated
  using (app.can_read_event(event_id));

create policy rounds_insert_director on public.rounds
  for insert to authenticated
  with check (app.is_event_director(event_id));

create policy rounds_update_director on public.rounds
  for update to authenticated
  using (app.is_event_director(event_id))
  with check (app.is_event_director(event_id));

create policy rounds_delete_draft_director on public.rounds
  for delete to authenticated
  using (
    app.is_event_director(event_id)
    and exists (select 1 from public.events e where e.id = event_id and e.status = 'draft')
  );

-- event_tee_snapshots / event_holes: frozen snapshot data. Read with the
-- event. NO client write policies: rows are created only by the publish-event
-- Edge Function with the service role (section 12.2) and are immutable.
create policy event_tee_snapshots_select_visible on public.event_tee_snapshots
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.rounds r
      where r.id = round_id and app.can_read_event(r.event_id)
    )
  );

create policy event_holes_select_visible on public.event_holes
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.rounds r
      where r.id = round_id and app.can_read_event(r.event_id)
    )
  );

-- flights
create policy flights_select_visible on public.flights
  for select to anon, authenticated
  using (app.can_read_event(event_id));

create policy flights_insert_director on public.flights
  for insert to authenticated
  with check (app.is_event_director(event_id));

create policy flights_update_director on public.flights
  for update to authenticated
  using (app.is_event_director(event_id))
  with check (app.is_event_director(event_id));

create policy flights_delete_draft_director on public.flights
  for delete to authenticated
  using (
    app.is_event_director(event_id)
    and exists (select 1 from public.events e where e.id = event_id and e.status = 'draft')
  );

-- event_entries: read with the event (frozen playing-handicap fields are the
-- published snapshot, section 14.3); directors write. Handicap freezing at
-- publish is re-validated by the publish-event Edge Function.
create policy event_entries_select_visible on public.event_entries
  for select to anon, authenticated
  using (app.can_read_event(event_id));

create policy event_entries_insert_director on public.event_entries
  for insert to authenticated
  with check (app.is_event_director(event_id));

create policy event_entries_update_director on public.event_entries
  for update to authenticated
  using (app.is_event_director(event_id))
  with check (app.is_event_director(event_id));

create policy event_entries_delete_draft_director on public.event_entries
  for delete to authenticated
  using (
    app.is_event_director(event_id)
    and exists (select 1 from public.events e where e.id = event_id and e.status = 'draft')
  );

-- event_teams
create policy event_teams_select_visible on public.event_teams
  for select to anon, authenticated
  using (app.can_read_event(event_id));

create policy event_teams_insert_director on public.event_teams
  for insert to authenticated
  with check (app.is_event_director(event_id));

create policy event_teams_update_director on public.event_teams
  for update to authenticated
  using (app.is_event_director(event_id))
  with check (app.is_event_director(event_id));

create policy event_teams_delete_draft_director on public.event_teams
  for delete to authenticated
  using (
    app.is_event_director(event_id)
    and exists (select 1 from public.events e where e.id = event_id and e.status = 'draft')
  );

-- event_team_members
create policy event_team_members_select_visible on public.event_team_members
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.event_teams et
      where et.id = event_team_id and app.can_read_event(et.event_id)
    )
  );

create policy event_team_members_insert_director on public.event_team_members
  for insert to authenticated
  with check (
    exists (
      select 1 from public.event_teams et
      where et.id = event_team_id and app.is_event_director(et.event_id)
    )
  );

create policy event_team_members_update_director on public.event_team_members
  for update to authenticated
  using (
    exists (
      select 1 from public.event_teams et
      where et.id = event_team_id and app.is_event_director(et.event_id)
    )
  )
  with check (
    exists (
      select 1 from public.event_teams et
      where et.id = event_team_id and app.is_event_director(et.event_id)
    )
  );

create policy event_team_members_delete_draft_director on public.event_team_members
  for delete to authenticated
  using (
    exists (
      select 1
      from public.event_teams et
      join public.events e on e.id = et.event_id
      where et.id = event_team_id
        and e.status = 'draft'
        and app.is_event_director(e.id)
    )
  );

-- groups
create policy groups_select_visible on public.groups
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.rounds r
      where r.id = round_id and app.can_read_event(r.event_id)
    )
  );

create policy groups_insert_director on public.groups
  for insert to authenticated
  with check (
    exists (
      select 1 from public.rounds r
      where r.id = round_id and app.is_event_director(r.event_id)
    )
  );

create policy groups_update_director on public.groups
  for update to authenticated
  using (
    exists (
      select 1 from public.rounds r
      where r.id = round_id and app.is_event_director(r.event_id)
    )
  )
  with check (
    exists (
      select 1 from public.rounds r
      where r.id = round_id and app.is_event_director(r.event_id)
    )
  );

create policy groups_delete_draft_director on public.groups
  for delete to authenticated
  using (
    exists (
      select 1
      from public.rounds r
      join public.events e on e.id = r.event_id
      where r.id = round_id
        and e.status = 'draft'
        and app.is_event_director(e.id)
    )
  );

-- group_members
create policy group_members_select_visible on public.group_members
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.groups g
      join public.rounds r on r.id = g.round_id
      where g.id = group_id and app.can_read_event(r.event_id)
    )
  );

create policy group_members_insert_director on public.group_members
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.groups g
      join public.rounds r on r.id = g.round_id
      where g.id = group_id and app.is_event_director(r.event_id)
    )
  );

create policy group_members_update_director on public.group_members
  for update to authenticated
  using (
    exists (
      select 1
      from public.groups g
      join public.rounds r on r.id = g.round_id
      where g.id = group_id and app.is_event_director(r.event_id)
    )
  )
  with check (
    exists (
      select 1
      from public.groups g
      join public.rounds r on r.id = g.round_id
      where g.id = group_id and app.is_event_director(r.event_id)
    )
  );

create policy group_members_delete_draft_director on public.group_members
  for delete to authenticated
  using (
    exists (
      select 1
      from public.groups g
      join public.rounds r on r.id = g.round_id
      join public.events e on e.id = r.event_id
      where g.id = group_id
        and e.status = 'draft'
        and app.is_event_director(e.id)
    )
  );

-- competitions: layered visibility read; directors write. Finalization and
-- reopening happen only through the finalize-competition Edge Function with
-- MFA (section 12.2); the transition trigger (migration 10) enforces the
-- lifecycle graph regardless of the caller.
create policy competitions_select_visible on public.competitions
  for select to anon, authenticated
  using (app.can_read_competition(id));

create policy competitions_insert_director on public.competitions
  for insert to authenticated
  with check (app.is_event_director(event_id));

create policy competitions_update_director on public.competitions
  for update to authenticated
  using (app.is_event_director(event_id))
  with check (app.is_event_director(event_id));

create policy competitions_delete_draft_director on public.competitions
  for delete to authenticated
  using (
    app.is_event_director(event_id)
    and exists (select 1 from public.events e where e.id = event_id and e.status = 'draft')
  );

-- competition_rounds
create policy competition_rounds_select_visible on public.competition_rounds
  for select to anon, authenticated
  using (app.can_read_competition(competition_id));

create policy competition_rounds_insert_director on public.competition_rounds
  for insert to authenticated
  with check (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id and app.is_event_director(c.event_id)
    )
  );

create policy competition_rounds_update_director on public.competition_rounds
  for update to authenticated
  using (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id and app.is_event_director(c.event_id)
    )
  )
  with check (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id and app.is_event_director(c.event_id)
    )
  );

create policy competition_rounds_delete_draft_director on public.competition_rounds
  for delete to authenticated
  using (
    exists (
      select 1
      from public.competitions c
      join public.events e on e.id = c.event_id
      where c.id = competition_id
        and e.status = 'draft'
        and app.is_event_director(e.id)
    )
  );

-- competition_entities
create policy competition_entities_select_visible on public.competition_entities
  for select to anon, authenticated
  using (app.can_read_competition(competition_id));

create policy competition_entities_insert_director on public.competition_entities
  for insert to authenticated
  with check (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id and app.is_event_director(c.event_id)
    )
  );

create policy competition_entities_update_director on public.competition_entities
  for update to authenticated
  using (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id and app.is_event_director(c.event_id)
    )
  )
  with check (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id and app.is_event_director(c.event_id)
    )
  );

create policy competition_entities_delete_draft_director on public.competition_entities
  for delete to authenticated
  using (
    exists (
      select 1
      from public.competitions c
      join public.events e on e.id = c.event_id
      where c.id = competition_id
        and e.status = 'draft'
        and app.is_event_director(e.id)
    )
  );

-- matches
create policy matches_select_visible on public.matches
  for select to anon, authenticated
  using (app.can_read_competition(competition_id));

create policy matches_insert_director on public.matches
  for insert to authenticated
  with check (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id and app.is_event_director(c.event_id)
    )
  );

create policy matches_update_director on public.matches
  for update to authenticated
  using (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id and app.is_event_director(c.event_id)
    )
  )
  with check (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id and app.is_event_director(c.event_id)
    )
  );

create policy matches_delete_draft_director on public.matches
  for delete to authenticated
  using (
    exists (
      select 1
      from public.competitions c
      join public.events e on e.id = c.event_id
      where c.id = competition_id
        and e.status = 'draft'
        and app.is_event_director(e.id)
    )
  );

-- individual_hole_scores: directors full event; entry owner; assigned scorer.
-- Spectators NEVER read raw scores (projections only, section 14.3): no anon
-- policy. NO write policies: all mutations flow through the submit-score /
-- resolve-score-conflict Edge Functions with the service role (idempotency,
-- revision checks, and projection rebuild live there).
create policy individual_hole_scores_select_scoped on public.individual_hole_scores
  for select to authenticated
  using (
    app.is_event_director(event_id)
    or app.is_entry_owner(event_entry_id)
    or app.can_score_entry(event_id, round_id, event_entry_id)
  );

-- team_hole_scores: directors; team members; assigned scorer. Same
-- Edge-Function-only write rule as individual_hole_scores.
create policy team_hole_scores_select_scoped on public.team_hole_scores
  for select to authenticated
  using (
    app.is_event_director(event_id)
    or app.is_team_member(event_team_id)
    or app.can_score_team(event_id, round_id, event_team_id)
  );

-- score_mutations: own recent receipts; directors full event audit
-- (section 14.3). Append-only; written only by submit-score (service role).
create policy score_mutations_select_scoped on public.score_mutations
  for select to authenticated
  using (
    actor_profile_id = (select auth.uid())
    or app.is_event_director(event_id)
  );

-- score_conflicts: directors, plus the involved actors. Resolution happens
-- only through the resolve-score-conflict Edge Function (service role).
create policy score_conflicts_select_scoped on public.score_conflicts
  for select to authenticated
  using (
    app.is_event_director(event_id)
    or local_actor_profile_id = (select auth.uid())
    or server_actor_profile_id = (select auth.uid())
  );

-- scorecard_attestations: directors, attester, and card owner read. Created
-- only by the submit/attest Edge Function flow (service role).
create policy scorecard_attestations_select_scoped on public.scorecard_attestations
  for select to authenticated
  using (
    profile_id = (select auth.uid())
    or (event_entry_id is not null and app.is_entry_owner(event_entry_id))
    or (event_team_id is not null and app.is_team_member(event_team_id))
    or exists (
      select 1 from public.rounds r
      where r.id = round_id and app.is_event_director(r.event_id)
    )
  );

-- Projections: readable per competition/event visibility, including anon
-- spectators for published public competitions. Written only by the
-- projection publisher (service role); NO client write policies.
create policy competition_projections_select_visible on public.competition_projections
  for select to anon, authenticated
  using (app.can_read_competition(competition_id));

create policy leaderboard_rows_select_visible on public.leaderboard_rows
  for select to anon, authenticated
  using (app.can_read_competition(competition_id));

create policy hole_results_select_visible on public.hole_results
  for select to anon, authenticated
  using (app.can_read_competition(competition_id));

-- event_revision_feed: readable with the event (drives realtime badges).
-- Written only by the projection publisher (service role).
create policy event_revision_feed_select_visible on public.event_revision_feed
  for select to anon, authenticated
  using (app.can_read_event(event_id));

-- audit_events: admins/owner in league scope; directors in event scope
-- (section 11.8/14.3). Append-only; written by Edge Functions only.
create policy audit_events_select_scoped on public.audit_events
  for select to authenticated
  using (
    (scope_league_id is not null
      and app.has_role(scope_league_id, array['owner', 'league_admin']::public.app_role[]))
    or (scope_event_id is not null and app.is_event_director(scope_event_id))
  );

-- push_subscriptions: own rows only (endpoint/keys are sensitive). Directors
-- get delivery metadata only via the send-web-push Edge Function.
create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy push_subscriptions_insert_own on public.push_subscriptions
  for insert to authenticated
  with check (profile_id = (select auth.uid()));

create policy push_subscriptions_update_own on public.push_subscriptions
  for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

-- Operations tables: admin/owner read only; all writes via Edge Functions or
-- CI with the service role (section 14.3 "Operations/errors/backups").
create policy app_error_events_select_operator on public.app_error_events
  for select to authenticated
  using (app.is_operator());

create policy backup_runs_select_operator on public.backup_runs
  for select to authenticated
  using (app.is_operator());
