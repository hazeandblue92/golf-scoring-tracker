-- Migration 24: acceptance hardening for deterministic scoring provenance,
-- multi-round integrity, match ownership, substitutions, and finalization.

-- §8.14 weights are multipliers. A zero-weight round is not a harmless no-op
-- for best-r-of-n: it is always selected as the lowest "score" and silently
-- reduces the number of real rounds that count. Keep the database contract in
-- step with the pure engine and require a positive multiplier.
alter table public.competition_rounds
  drop constraint if exists competition_rounds_weight_positive;
alter table public.competition_rounds
  add constraint competition_rounds_weight_positive check (weight > 0);

-- Substitution references must stay inside one event. The original single-
-- column foreign keys prove that a row exists, but not that it belongs to the
-- event whose frozen results are being rebuilt.
alter table public.event_entries
  drop constraint if exists event_entries_effective_round_same_event_fk,
  drop constraint if exists event_entries_replacement_same_event_fk;
alter table public.event_entries
  add constraint event_entries_effective_round_same_event_fk
    foreign key (effective_from_round_id, event_id)
    references public.rounds (id, event_id) on delete restrict,
  add constraint event_entries_replacement_same_event_fk
    foreign key (replaces_entry_id, event_id)
    references public.event_entries (id, event_id) on delete restrict;

alter table public.scoring_permissions
  drop constraint if exists scoring_permissions_round_fk;
alter table public.scoring_permissions
  add constraint scoring_permissions_round_same_event_fk
    foreign key (round_id, event_id)
    references public.rounds (id, event_id) on delete cascade;

-- A match side, winner, and round must belong to the match's own competition.
-- Without these composite keys a service writer could create a pairing that
-- the projection layer silently interpreted as a bye.
alter table public.competition_entities
  drop constraint if exists competition_entities_id_competition_unique;
alter table public.competition_entities
  add constraint competition_entities_id_competition_unique
    unique (id, competition_id);

alter table public.matches
  drop constraint if exists matches_competition_round_fk,
  drop constraint if exists matches_side_a_competition_fk,
  drop constraint if exists matches_side_b_competition_fk,
  drop constraint if exists matches_winner_competition_fk,
  drop constraint if exists matches_winner_is_side;
alter table public.matches
  add constraint matches_competition_round_fk
    foreign key (competition_id, round_id)
    references public.competition_rounds (competition_id, round_id)
    on delete cascade,
  add constraint matches_side_a_competition_fk
    foreign key (side_a_entity_id, competition_id)
    references public.competition_entities (id, competition_id)
    on delete cascade,
  add constraint matches_side_b_competition_fk
    foreign key (side_b_entity_id, competition_id)
    references public.competition_entities (id, competition_id)
    on delete cascade,
  add constraint matches_winner_competition_fk
    foreign key (winner_entity_id, competition_id)
    references public.competition_entities (id, competition_id)
    on delete set null (winner_entity_id),
  add constraint matches_winner_is_side check (
    winner_entity_id is null
    or winner_entity_id = side_a_entity_id
    or winner_entity_id = side_b_entity_id
  );

-- Relationship tables without an event_id column need an explicit ownership
-- guard. Single-column foreign keys prove that both endpoints exist, but they
-- otherwise permit a service writer (or a future broader policy) to splice
-- roster, round, or scoring entities across frozen events.
create or replace function app.enforce_event_team_member_same_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.event_teams et
    join public.event_entries ee on ee.id = new.event_entry_id
    where et.id = new.event_team_id and et.event_id = ee.event_id
  ) then
    raise exception 'team member entry must belong to the team event'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists event_team_members_same_event_guard
  on public.event_team_members;
create trigger event_team_members_same_event_guard
  before insert or update of event_team_id, event_entry_id
  on public.event_team_members
  for each row execute function app.enforce_event_team_member_same_event();

create or replace function app.enforce_group_member_same_event()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_event_id uuid;
begin
  select r.event_id into v_event_id
  from public.groups g
  join public.rounds r on r.id = g.round_id
  where g.id = new.group_id;
  if v_event_id is null
    or (
      new.event_entry_id is not null
      and not exists (
        select 1 from public.event_entries ee
        where ee.id = new.event_entry_id and ee.event_id = v_event_id
      )
    )
    or (
      new.event_team_id is not null
      and not exists (
        select 1 from public.event_teams et
        where et.id = new.event_team_id and et.event_id = v_event_id
      )
    )
  then
    raise exception 'group member target must belong to the group event'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists group_members_same_event_guard on public.group_members;
create trigger group_members_same_event_guard
  before insert or update of group_id, event_entry_id, event_team_id
  on public.group_members
  for each row execute function app.enforce_group_member_same_event();

create or replace function app.enforce_scoring_permission_same_league()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.events e
    where e.id = new.event_id
      and (
        new.participant_id is null
        or exists (
          select 1 from public.participants p
          where p.id = new.participant_id and p.league_id = e.league_id
        )
      )
      and (
        new.team_id is null
        or exists (
          select 1 from public.teams t
          where t.id = new.team_id and t.league_id = e.league_id
        )
      )
  ) then
    raise exception 'scoring permission target must belong to the event league'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists scoring_permissions_same_league_guard
  on public.scoring_permissions;
create trigger scoring_permissions_same_league_guard
  before insert or update of event_id, participant_id, team_id
  on public.scoring_permissions
  for each row execute function app.enforce_scoring_permission_same_league();

create or replace function app.enforce_competition_round_same_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.competitions c
    join public.rounds r on r.id = new.round_id
    where c.id = new.competition_id and c.event_id = r.event_id
  ) then
    raise exception 'competition round must belong to the competition event'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists competition_rounds_same_event_guard
  on public.competition_rounds;
create trigger competition_rounds_same_event_guard
  before insert or update of competition_id, round_id
  on public.competition_rounds
  for each row execute function app.enforce_competition_round_same_event();

create or replace function app.enforce_competition_entity_same_event()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_event_id uuid;
begin
  select event_id into v_event_id
  from public.competitions
  where id = new.competition_id;
  if v_event_id is null
    or (
      new.event_entry_id is not null
      and not exists (
        select 1 from public.event_entries ee
        where ee.id = new.event_entry_id and ee.event_id = v_event_id
      )
    )
    or (
      new.event_team_id is not null
      and not exists (
        select 1 from public.event_teams et
        where et.id = new.event_team_id and et.event_id = v_event_id
      )
    )
    or (
      new.flight_id is not null
      and not exists (
        select 1 from public.flights f
        where f.id = new.flight_id and f.event_id = v_event_id
      )
    )
  then
    raise exception 'competition entity targets must belong to the competition event'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists competition_entities_same_event_guard
  on public.competition_entities;
create trigger competition_entities_same_event_guard
  before insert or update of competition_id, event_entry_id, event_team_id, flight_id
  on public.competition_entities
  for each row execute function app.enforce_competition_entity_same_event();

-- Once an event leaves draft, the configuration used to build its frozen
-- snapshot cannot be edited through a broad organizer UPDATE policy. Raw
-- score/status facts remain mutable through their controlled workflows, but
-- setup, handicap, roster, and Terms inputs do not (AC-003, §11.3).
create or replace function app.enforce_published_event_inputs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'draft' and (
    new.league_id is distinct from old.league_id
    or new.season_id is distinct from old.season_id
    or new.name is distinct from old.name
    or new.slug is distinct from old.slug
    or new.timezone is distinct from old.timezone
    or new.starts_at is distinct from old.starts_at
    or new.ends_at is distinct from old.ends_at
    or new.visibility is distinct from old.visibility
    or new.created_by is distinct from old.created_by
    or new.published_snapshot_version is distinct from old.published_snapshot_version
  ) then
    raise exception 'published event configuration is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists events_published_inputs_guard on public.events;
create trigger events_published_inputs_guard
  before update on public.events
  for each row execute function app.enforce_published_event_inputs();

create or replace function app.enforce_published_round_inputs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.events
    where id in (old.event_id, new.event_id) and status <> 'draft'
  ) and (
    new.event_id is distinct from old.event_id
    or new.round_number is distinct from old.round_number
    or new.name is distinct from old.name
    or new.starts_at is distinct from old.starts_at
    or new.hole_count is distinct from old.hole_count
    or new.snapshot_version is distinct from old.snapshot_version
    or new.source_tee_set_id is distinct from old.source_tee_set_id
  ) then
    raise exception 'published round configuration is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists rounds_published_inputs_guard on public.rounds;
create trigger rounds_published_inputs_guard
  before update on public.rounds
  for each row execute function app.enforce_published_round_inputs();

create or replace function app.enforce_published_entry_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.events
    where id in (old.event_id, new.event_id) and status <> 'draft'
  ) and (
    new.event_id is distinct from old.event_id
    or new.participant_id is distinct from old.participant_id
    or new.flight_id is distinct from old.flight_id
    or new.seed is distinct from old.seed
    or new.handicap_source is distinct from old.handicap_source
    or new.handicap_value is distinct from old.handicap_value
    or new.course_handicap_unrounded is distinct from old.course_handicap_unrounded
    or new.playing_handicap is distinct from old.playing_handicap
    or new.allowance is distinct from old.allowance
    or new.handicap_profile is distinct from old.handicap_profile
    or new.tee_snapshot_id is distinct from old.tee_snapshot_id
    or new.snapshot_hash is distinct from old.snapshot_hash
    or new.effective_from_round_id is distinct from old.effective_from_round_id
    or new.replaces_entry_id is distinct from old.replaces_entry_id
    or new.substitution_reason is distinct from old.substitution_reason
  ) then
    raise exception 'published event entry snapshot is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists event_entries_published_snapshot_guard on public.event_entries;
create trigger event_entries_published_snapshot_guard
  before update on public.event_entries
  for each row execute function app.enforce_published_entry_snapshot();

create or replace function app.enforce_published_team_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.events
    where id in (old.event_id, new.event_id) and status <> 'draft'
  ) and (
    new.event_id is distinct from old.event_id
    or new.source_team_id is distinct from old.source_team_id
    or new.name is distinct from old.name
    or new.flight_id is distinct from old.flight_id
    or new.seed is distinct from old.seed
    or new.course_handicap_unrounded is distinct from old.course_handicap_unrounded
    or new.playing_handicap is distinct from old.playing_handicap
    or new.allowance is distinct from old.allowance
    or (
      new.snapshot_hash is distinct from old.snapshot_hash
      and not (old.snapshot_hash is null and new.snapshot_hash is not null)
    )
  ) then
    raise exception 'published event team snapshot is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists event_teams_published_snapshot_guard on public.event_teams;
create trigger event_teams_published_snapshot_guard
  before update on public.event_teams
  for each row execute function app.enforce_published_team_snapshot();

-- The indexed routing columns are a cache of the authoritative structured
-- Terms. They must never disagree: projection dispatch reads rules_json while
-- workflow/finalization dispatch reads these columns.
create or replace function app.enforce_competition_rules_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.rules_json ->> 'format' is distinct from new.format::text
    or new.rules_json ->> 'metric' is distinct from new.metric::text
    or new.rules_json ->> 'schemaVersion'
      is distinct from new.rules_schema_version::text
  then
    raise exception 'competition columns must match authoritative rules_json'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists competitions_rules_identity_guard on public.competitions;
create trigger competitions_rules_identity_guard
  before insert or update of format, metric, rules_schema_version, rules_json
  on public.competitions
  for each row execute function app.enforce_competition_rules_identity();

create or replace function app.enforce_published_competition_inputs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (
    old.status <> 'draft'
    or exists (
      select 1 from public.events
      where id in (old.event_id, new.event_id) and status <> 'draft'
    )
  ) and (
    new.event_id is distinct from old.event_id
    or new.name is distinct from old.name
    or new.format is distinct from old.format
    or new.metric is distinct from old.metric
    or new.rules_schema_version is distinct from old.rules_schema_version
    or new.rules_json is distinct from old.rules_json
    or new.rules_text is distinct from old.rules_text
    or new.visibility is distinct from old.visibility
    or new.sort_order is distinct from old.sort_order
  ) then
    raise exception 'published competition terms are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists competitions_published_inputs_guard on public.competitions;
create trigger competitions_published_inputs_guard
  before update on public.competitions
  for each row execute function app.enforce_published_competition_inputs();

create or replace function app.enforce_finalized_match_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old_competition_id uuid;
  v_new_competition_id uuid;
begin
  if tg_op <> 'INSERT' then v_old_competition_id := old.competition_id; end if;
  if tg_op <> 'DELETE' then v_new_competition_id := new.competition_id; end if;
  if exists (
    select 1
    from public.competitions c
    join public.events e on e.id = c.event_id
    where c.id in (v_old_competition_id, v_new_competition_id)
      and (c.status = 'finalized' or e.status = 'finalized')
  ) then
    raise exception 'finalized match facts are immutable; reopen first'
      using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists matches_finalized_immutability_guard on public.matches;
create trigger matches_finalized_immutability_guard
  before insert or update or delete on public.matches
  for each row execute function app.enforce_finalized_match_immutability();

-- Direct browser inserts are draft-only. SECURITY DEFINER workflow functions
-- (publish, substitution, and projection repair) continue to bypass RLS while
-- applying their stronger validation and audit contracts.
drop policy if exists rounds_insert_director on public.rounds;
create policy rounds_insert_director on public.rounds
  for insert to authenticated
  with check (
    app.is_event_director(event_id)
    and exists (select 1 from public.events where id = event_id and status = 'draft')
  );

drop policy if exists flights_insert_director on public.flights;
create policy flights_insert_director on public.flights
  for insert to authenticated
  with check (
    app.is_event_director(event_id)
    and exists (select 1 from public.events where id = event_id and status = 'draft')
  );

drop policy if exists flights_update_director on public.flights;
create policy flights_update_director on public.flights
  for update to authenticated
  using (
    app.is_event_director(event_id)
    and exists (select 1 from public.events where id = event_id and status = 'draft')
  )
  with check (
    app.is_event_director(event_id)
    and exists (select 1 from public.events where id = event_id and status = 'draft')
  );

drop policy if exists event_entries_insert_director on public.event_entries;
create policy event_entries_insert_director on public.event_entries
  for insert to authenticated
  with check (
    app.is_event_director(event_id)
    and exists (select 1 from public.events where id = event_id and status = 'draft')
  );

drop policy if exists event_teams_insert_director on public.event_teams;
create policy event_teams_insert_director on public.event_teams
  for insert to authenticated
  with check (
    app.is_event_director(event_id)
    and exists (select 1 from public.events where id = event_id and status = 'draft')
  );

drop policy if exists event_team_members_insert_director on public.event_team_members;
create policy event_team_members_insert_director on public.event_team_members
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.event_teams et
      join public.events e on e.id = et.event_id
      where et.id = event_team_id
        and e.status = 'draft'
        and app.is_event_director(e.id)
    )
  );

drop policy if exists event_team_members_update_director on public.event_team_members;
create policy event_team_members_update_director on public.event_team_members
  for update to authenticated
  using (
    exists (
      select 1
      from public.event_teams et
      join public.events e on e.id = et.event_id
      where et.id = event_team_id
        and e.status = 'draft'
        and app.is_event_director(e.id)
    )
  )
  with check (
    exists (
      select 1
      from public.event_teams et
      join public.events e on e.id = et.event_id
      where et.id = event_team_id
        and e.status = 'draft'
        and app.is_event_director(e.id)
    )
  );

drop policy if exists competitions_insert_director on public.competitions;
create policy competitions_insert_director on public.competitions
  for insert to authenticated
  with check (
    app.is_event_director(event_id)
    and exists (select 1 from public.events where id = event_id and status = 'draft')
  );

drop policy if exists competition_rounds_insert_director on public.competition_rounds;
create policy competition_rounds_insert_director on public.competition_rounds
  for insert to authenticated
  with check (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id
        and c.status = 'draft'
        and app.is_event_director(c.event_id)
    )
  );

drop policy if exists competition_rounds_update_director on public.competition_rounds;
create policy competition_rounds_update_director on public.competition_rounds
  for update to authenticated
  using (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id
        and c.status = 'draft'
        and app.is_event_director(c.event_id)
    )
  )
  with check (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id
        and c.status = 'draft'
        and app.is_event_director(c.event_id)
    )
  );

drop policy if exists competition_entities_insert_director on public.competition_entities;
create policy competition_entities_insert_director on public.competition_entities
  for insert to authenticated
  with check (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id
        and c.status = 'draft'
        and app.is_event_director(c.event_id)
    )
  );

drop policy if exists competition_entities_update_director on public.competition_entities;
create policy competition_entities_update_director on public.competition_entities
  for update to authenticated
  using (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id
        and c.status = 'draft'
        and app.is_event_director(c.event_id)
    )
  )
  with check (
    exists (
      select 1 from public.competitions c
      where c.id = competition_id
        and c.status = 'draft'
        and app.is_event_director(c.event_id)
    )
  );

-- New editable competitions always begin on the current engine. Older
-- finalized imports keep their recorded provenance; they are not relabelled.
create or replace function app.set_current_competition_engine_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'finalized' and new.final_result_hash is null then
    new.engine_version := '0.2.0';
  end if;
  return new;
end;
$$;

drop trigger if exists competitions_current_engine_version on public.competitions;
create trigger competitions_current_engine_version
  before insert on public.competitions
  for each row execute function app.set_current_competition_engine_version();

-- Projection publishes are the authoritative point at which a competition's
-- engine provenance advances. A finalized result may be rebuilt only by the
-- same engine version; changing it would leave final_result_hash describing a
-- different artifact while claiming identical provenance (§7.3, AC-010).
create or replace function app.enforce_projection_engine_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_comp public.competitions%rowtype;
begin
  select * into v_comp
  from public.competitions
  where id = new.competition_id
  for update;

  if not found then
    raise exception 'competition not found for projection' using errcode = '23503';
  end if;

  if v_comp.status = 'finalized' and v_comp.engine_version <> new.engine_version then
    raise exception
      'finalized competition engine version mismatch: stored %, attempted %',
      v_comp.engine_version, new.engine_version
      using errcode = '23514';
  end if;

  if v_comp.status = 'finalized'
    and v_comp.final_result_hash is not null
    and v_comp.final_result_hash <> new.projection_hash
  then
    raise exception
      'finalized competition projection hash mismatch: stored %, attempted %',
      v_comp.final_result_hash, new.projection_hash
      using errcode = '23514';
  end if;

  if v_comp.status <> 'finalized' and v_comp.engine_version <> new.engine_version then
    update public.competitions
      set engine_version = new.engine_version, updated_at = now()
    where id = new.competition_id;
  end if;
  return new;
end;
$$;

drop trigger if exists competition_projections_engine_version
  on public.competition_projections;
create trigger competition_projections_engine_version
  before insert or update of engine_version, projection_hash
  on public.competition_projections
  for each row execute function app.enforce_projection_engine_version();

-- Organizer substitution workflow (§8.14). The replacement is a new frozen
-- event entry; the outgoing entry and all of its historical scores remain
-- untouched. Team membership has no effective-round columns yet, so reject a
-- team-member substitution explicitly instead of corrupting prior team cards.
create or replace function public.substitute_event_entry(
  p_event_id uuid,
  p_outgoing_entry_id uuid,
  p_incoming_participant_id uuid,
  p_effective_round_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.events%rowtype;
  v_outgoing public.event_entries%rowtype;
  v_round public.rounds%rowtype;
  v_participant public.participants%rowtype;
  v_handicap public.participant_handicaps%rowtype;
  v_tee public.event_tee_snapshots%rowtype;
  v_entry_id uuid := gen_random_uuid();
  v_effective_number integer;
  v_course_handicap numeric(12, 6);
  v_playing_handicap smallint;
  v_handicap_source public.handicap_source;
  v_handicap_value numeric(5, 1);
  v_snapshot_hash text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null then
    return jsonb_build_object('status', 'rejected', 'error_code', 'AUTH_REQUIRED');
  end if;
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'active'
  ) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'ACCOUNT_DISABLED');
  end if;
  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'unknown event');
  end if;
  if not (
    app.is_event_director(p_event_id)
    or app.has_role(v_event.league_id, array['owner', 'league_admin']::public.app_role[])
  ) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'NOT_ASSIGNED');
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    return jsonb_build_object(
      'status', 'rejected',
      'error_code', 'MFA_REQUIRED',
      'detail', 'Complete multi-factor verification before substituting a player'
    );
  end if;
  if v_event.status not in ('published', 'scoring_open', 'scoring_closed') then
    return jsonb_build_object('status', 'rejected', 'error_code', 'EVENT_LOCKED',
      'detail', format('substitutions are unavailable while event status is %s', v_event.status));
  end if;
  if v_reason is null or length(v_reason) > 500 then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'a substitution reason of 1-500 characters is required');
  end if;

  select * into v_outgoing
  from public.event_entries
  where id = p_outgoing_entry_id and event_id = p_event_id
  for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'outgoing entry does not belong to this event');
  end if;
  if v_outgoing.status <> 'active' then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'outgoing entry must remain active to preserve its scoring slot');
  end if;
  if exists (
    select 1 from public.event_entries where replaces_entry_id = v_outgoing.id
  ) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'CONFLICT',
      'detail', 'this entry already has a substitute');
  end if;
  if exists (
    select 1 from public.event_team_members where event_entry_id = v_outgoing.id
  ) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'team-member substitutions require an effective-dated team roster');
  end if;

  select * into v_round
  from public.rounds
  where id = p_effective_round_id and event_id = p_event_id;
  if not found or v_round.status not in ('scheduled', 'in_progress') then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'effective round must be a scheduled or in-progress round in this event');
  end if;
  v_effective_number := v_round.round_number;
  if v_outgoing.effective_from_round_id is not null and exists (
    select 1
    from public.rounds outgoing_start
    where outgoing_start.id = v_outgoing.effective_from_round_id
      and outgoing_start.round_number > v_effective_number
  ) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'a replacement cannot take effect before the outgoing entry');
  end if;
  if exists (
    select 1
    from public.individual_hole_scores score
    join public.rounds score_round on score_round.id = score.round_id
    where score.event_entry_id = v_outgoing.id
      and score_round.round_number >= v_effective_number
      and score.score_status <> 'not_started'
  ) or exists (
    select 1
    from public.scorecard_attestations attestation
    join public.rounds attested_round on attested_round.id = attestation.round_id
    where attestation.event_entry_id = v_outgoing.id
      and attested_round.round_number >= v_effective_number
  ) or exists (
    select 1
    from public.score_conflicts conflict
    join public.rounds conflict_round on conflict_round.id = conflict.round_id
    where conflict.event_entry_id = v_outgoing.id
      and conflict.status = 'open'
      and conflict_round.round_number >= v_effective_number
  ) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'CONFLICT',
      'detail', 'choose a future round with no existing scorecard facts for the outgoing player');
  end if;
  if exists (
    select 1
    from public.competition_entities outgoing_entity
    join public.matches affected_match
      on affected_match.competition_id = outgoing_entity.competition_id
     and outgoing_entity.id in (
       affected_match.side_a_entity_id,
       affected_match.side_b_entity_id,
       affected_match.winner_entity_id
     )
    join public.rounds match_round on match_round.id = affected_match.round_id
    where outgoing_entity.event_entry_id = v_outgoing.id
      and match_round.event_id = p_event_id
      and match_round.round_number >= v_effective_number
      and affected_match.status <> 'scheduled'
  ) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'CONFLICT',
      'detail', 'a match involving the outgoing player has already started');
  end if;

  select * into v_participant
  from public.participants
  where id = p_incoming_participant_id
    and league_id = v_event.league_id
    and status = 'active';
  if not found then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'incoming player must be active in this league');
  end if;
  if exists (
    select 1 from public.event_entries
    where event_id = p_event_id and participant_id = p_incoming_participant_id
  ) then
    return jsonb_build_object('status', 'rejected', 'error_code', 'CONFLICT',
      'detail', 'incoming player is already entered in this event');
  end if;

  select * into v_tee
  from public.event_tee_snapshots target_tee
  where target_tee.round_id = v_round.id
    and (
      v_outgoing.tee_snapshot_id is null
      or target_tee.source_tee_set_id = (
        select source_tee.source_tee_set_id
        from public.event_tee_snapshots source_tee
        where source_tee.id = v_outgoing.tee_snapshot_id
      )
    )
  order by snapshot_version desc
  limit 1;
  if not found then
    return jsonb_build_object('status', 'rejected', 'error_code', 'SNAPSHOT_INVALID',
      'detail', 'the effective round has no matching frozen tee snapshot');
  end if;

  select * into v_handicap
  from public.participant_handicaps
  where participant_id = p_incoming_participant_id
    and effective_from <= coalesce(v_round.starts_at, v_event.starts_at)::date
    and (effective_to is null or effective_to > coalesce(v_round.starts_at, v_event.starts_at)::date)
  order by effective_from desc
  limit 1;

  if found then
    v_handicap_source := v_handicap.source;
    v_handicap_value := v_handicap.value;
  else
    v_handicap_source := 'scratch_fallback';
    v_handicap_value := 0;
  end if;
  v_course_handicap := round(
    (v_handicap_value * v_tee.slope_rating::numeric / 113)
      + (v_tee.course_rating - v_tee.par),
    6
  );
  v_playing_handicap := floor(v_course_handicap + 0.5)::smallint;
  v_snapshot_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'participantId', p_incoming_participant_id,
    'handicapSource', v_handicap_source,
    'handicapValue', v_handicap_value::text,
    'courseHandicap', v_course_handicap::text,
    'playingHandicap', v_playing_handicap,
    'allowance', '1.0000',
    'teeSnapshotHash', v_tee.snapshot_hash
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.event_entries (
    id, event_id, participant_id, flight_id, status,
    handicap_source, handicap_value, course_handicap_unrounded,
    playing_handicap, allowance, handicap_profile, tee_snapshot_id,
    snapshot_hash, effective_from_round_id, replaces_entry_id,
    substitution_reason
  ) values (
    v_entry_id, p_event_id, p_incoming_participant_id, v_outgoing.flight_id,
    'active', v_handicap_source, v_handicap_value, v_course_handicap,
    v_playing_handicap, 1, 'usga_whs_2024', v_tee.id,
    v_snapshot_hash, p_effective_round_id, v_outgoing.id, v_reason
  );

  -- Put the substitute into every applicable individual competition. An
  -- overall competition is included once any linked round is at/after the
  -- handover; a prior-round-only competition remains historical.
  insert into public.competition_entities (
    competition_id, event_entry_id, eligibility_status, flight_id, seed
  )
  select distinct ce.competition_id, v_entry_id, ce.eligibility_status,
    coalesce(ce.flight_id, v_outgoing.flight_id), ce.seed
  from public.competition_entities ce
  where ce.event_entry_id = v_outgoing.id
    and exists (
      select 1
      from public.competition_rounds cr
      join public.rounds r on r.id = cr.round_id
      where cr.competition_id = ce.competition_id
        and r.event_id = p_event_id
        and r.round_number >= v_effective_number
    );

  -- Future match pairings refer to competition-entity identities rather than
  -- directly to event entries. Move only the effective and later pairing
  -- references to the newly-created entity; earlier matches remain attributed
  -- to the player who contested them.
  update public.matches m
  set side_a_entity_id = case
        when m.side_a_entity_id = outgoing_entity.id then incoming_entity.id
        else m.side_a_entity_id
      end,
      side_b_entity_id = case
        when m.side_b_entity_id = outgoing_entity.id then incoming_entity.id
        else m.side_b_entity_id
      end,
      winner_entity_id = case
        when m.winner_entity_id = outgoing_entity.id then incoming_entity.id
        else m.winner_entity_id
      end,
      updated_at = now()
  from public.competition_entities outgoing_entity
  join public.competition_entities incoming_entity
    on incoming_entity.competition_id = outgoing_entity.competition_id
   and incoming_entity.event_entry_id = v_entry_id
  join public.rounds match_round on true
  where outgoing_entity.event_entry_id = v_outgoing.id
    and m.competition_id = outgoing_entity.competition_id
    and match_round.id = m.round_id
    and match_round.event_id = p_event_id
    and match_round.round_number >= v_effective_number
    and m.status = 'scheduled'
    and (
      m.side_a_entity_id = outgoing_entity.id
      or m.side_b_entity_id = outgoing_entity.id
      or m.winner_entity_id = outgoing_entity.id
    );

  -- Preserve the group/marker layout from the outgoing slot for the effective
  -- and later rounds. Historical memberships are not edited.
  insert into public.group_members (group_id, event_entry_id, sort_order)
  select gm.group_id, v_entry_id, gm.sort_order
  from public.group_members gm
  join public.groups g on g.id = gm.group_id
  join public.rounds r on r.id = g.round_id
  where gm.event_entry_id = v_outgoing.id
    and r.event_id = p_event_id
    and r.round_number >= v_effective_number
  on conflict do nothing;

  delete from public.group_members gm
  using public.groups g, public.rounds r
  where gm.group_id = g.id
    and g.round_id = r.id
    and gm.event_entry_id = v_outgoing.id
    and r.event_id = p_event_id
    and r.round_number >= v_effective_number;

  insert into public.scoring_permissions (
    event_id, round_id, scorer_profile_id, participant_id,
    permission_type, valid_from, valid_to
  )
  select sp.event_id, sp.round_id, sp.scorer_profile_id,
    p_incoming_participant_id, sp.permission_type, now(), sp.valid_to
  from public.scoring_permissions sp
  join public.rounds r on r.id = sp.round_id
  where sp.event_id = p_event_id
    and sp.participant_id = v_outgoing.participant_id
    and r.round_number >= v_effective_number
    and (sp.valid_to is null or sp.valid_to > now())
    and not exists (
      select 1 from public.scoring_permissions existing
      where existing.event_id = sp.event_id
        and existing.round_id = sp.round_id
        and existing.scorer_profile_id = sp.scorer_profile_id
        and existing.participant_id = p_incoming_participant_id
        and existing.valid_to is null
    );

  update public.scoring_permissions sp
  set valid_to = now(), updated_at = now()
  from public.rounds r
  where sp.event_id = p_event_id
    and sp.round_id = r.id
    and sp.participant_id = v_outgoing.participant_id
    and r.round_number >= v_effective_number
    and sp.valid_from < now()
    and (sp.valid_to is null or sp.valid_to > now());

  delete from public.scoring_permissions sp
  using public.rounds r
  where sp.event_id = p_event_id
    and sp.round_id = r.id
    and sp.participant_id = v_outgoing.participant_id
    and r.round_number >= v_effective_number
    and sp.valid_from >= now();

  if v_participant.profile_id is not null then
    insert into public.scoring_permissions (
      event_id, round_id, scorer_profile_id, participant_id, permission_type
    )
    select p_event_id, r.id, v_participant.profile_id,
      p_incoming_participant_id, 'self'
    from public.rounds r
    where r.event_id = p_event_id and r.round_number >= v_effective_number
      and not exists (
        select 1 from public.scoring_permissions existing
        where existing.event_id = p_event_id
          and existing.round_id = r.id
          and existing.scorer_profile_id = v_participant.profile_id
          and existing.participant_id = p_incoming_participant_id
          and existing.valid_to is null
      );
  end if;

  insert into public.audit_events (
    actor_profile_id, action, scope_league_id, scope_event_id,
    target_type, target_id, reason, before_json, after_json
  ) values (
    auth.uid(), 'event.entry_substituted', v_event.league_id, p_event_id,
    'event_entry', v_entry_id, v_reason,
    jsonb_build_object(
      'outgoingEntryId', v_outgoing.id,
      'outgoingParticipantId', v_outgoing.participant_id
    ),
    jsonb_build_object(
      'incomingEntryId', v_entry_id,
      'incomingParticipantId', p_incoming_participant_id,
      'effectiveRoundId', p_effective_round_id
    )
  );

  return jsonb_build_object(
    'status', 'saved',
    'eventEntryId', v_entry_id,
    'effectiveRoundId', p_effective_round_id
  );
end;
$$;

revoke all on function public.substitute_event_entry(uuid, uuid, uuid, uuid, text)
  from public, anon;
grant execute on function public.substitute_event_entry(uuid, uuid, uuid, uuid, text)
  to authenticated, service_role;

comment on function public.substitute_event_entry(uuid, uuid, uuid, uuid, text) is
  'Create an audited, effective-dated replacement entry without rewriting the outgoing player or historical scores (§8.14). Individual entries only until team membership is effective-dated.';

-- Finalization must treat shamble as an individual-score team format. The
-- previous dispatch fell through to an entry-entity query even though shamble
-- competition entities are teams, so a completely empty shamble card reported
-- zero missing scores.
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

  select count(*) into v_conflicts
  from public.score_conflicts
  where event_id = v_event.id and status = 'open';

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

  -- Only a successful preflight closes scoring. The caller then republishes
  -- this target using final-phase engine policy and calls this function again
  -- to seal that exact hash. This avoids ever stamping a live/provisional hash
  -- as the official final artifact.
  if v_event.status = 'scoring_open' then
    update public.competitions set status = 'scoring_closed'
      where event_id = v_event.id and status = 'scoring_open';
    update public.rounds set status = 'complete'
      where event_id = v_event.id and status = 'in_progress';
    update public.events set status = 'scoring_closed' where id = v_event.id;
    v_event.status := 'scoring_closed';
  end if;

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

  update public.competitions set
    status = 'finalized', finalized_at = now(), finalized_by = p_actor,
    final_result_hash = v_projection_hash,
    engine_version = v_projection_engine_version
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
