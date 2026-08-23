-- Migration 33: one-time initial owner bootstrap.
--
-- Auth user creation remains in the operator-only CLI because PostgreSQL
-- cannot create a GoTrue user transactionally. This function atomically
-- installs the application-side identity graph after the CLI has created a
-- confirmed, opaque @users.invalid Auth user with a one-use password.
--
-- The advisory lock and historical-owner guard make this a first-owner path,
-- never an account recovery or privilege-escalation path. A new league can be
-- created only in an entirely empty deployment. An explicit attach operation
-- may target one existing active league (for example, the synthetic local
-- development seed), but it can never create a second league.

create or replace function public.bootstrap_initial_owner(
  p_profile_id uuid,
  p_username text,
  p_display_name text,
  p_existing_league_id uuid,
  p_league_name text,
  p_league_slug text,
  p_timezone text,
  p_locale text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_league_id uuid;
  v_created_league boolean := false;
  v_email text;
  v_email_confirmed_at timestamptz;
  v_bootstrap_marker text;
  v_username text := lower(btrim(p_username));
  v_display_name text := btrim(p_display_name);
  v_league_name text := btrim(p_league_name);
  v_league_slug text := lower(btrim(p_league_slug));
  v_timezone text := btrim(p_timezone);
  v_locale text := btrim(p_locale);
begin
  -- Serialize all attempts, including two CLIs racing before either owner
  -- grant exists. The lock is transaction-scoped and releases automatically.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('gtt:initial-owner-bootstrap', 0)
  );

  -- Any historical owner grant proves bootstrap has already happened. A
  -- revoked owner must use the documented recovery process; bootstrap cannot
  -- be reused to bypass revocation or MFA.
  if exists (
    select 1
    from public.role_assignments
    where role = 'owner'::public.app_role
  ) then
    raise exception 'initial owner bootstrap is no longer available'
      using errcode = '42501';
  end if;

  if p_profile_id is null then
    raise exception 'profile id is required' using errcode = '22023';
  end if;

  if v_username is null or v_username !~ '^[a-z0-9._-]{3,32}$' then
    raise exception 'username is invalid' using errcode = '22023';
  end if;

  if v_display_name is null
     or char_length(v_display_name) < 1
     or char_length(v_display_name) > 80 then
    raise exception 'display name is invalid' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.profiles
    where id = p_profile_id
       or username = v_username::extensions.citext
  ) then
    raise exception 'profile already exists' using errcode = '23505';
  end if;

  -- Accept only an Auth user minted by the bootstrap CLI. The marker lives in
  -- server-controlled app metadata and is removed by the CLI after success.
  select
    users.email,
    users.email_confirmed_at,
    users.raw_app_meta_data ->> 'initial_owner_bootstrap'
  into v_email, v_email_confirmed_at, v_bootstrap_marker
  from auth.users as users
  where users.id = p_profile_id;

  if not found
     or v_email !~ '^[0-9a-f]{32}@users[.]invalid$'
     or v_email_confirmed_at is null
     or v_bootstrap_marker is distinct from 'true' then
    raise exception 'bootstrap auth user is invalid' using errcode = '22023';
  end if;

  if p_existing_league_id is null then
    -- Strictly empty means empty, including archived leagues. This prevents a
    -- stale or restored deployment from using bootstrap to create league two.
    if exists (select 1 from public.leagues) then
      raise exception 'an existing league must be attached explicitly'
        using errcode = '42501';
    end if;

    if v_league_name is null
       or char_length(v_league_name) < 1
       or char_length(v_league_name) > 120 then
      raise exception 'league name is invalid' using errcode = '22023';
    end if;

    if v_league_slug is null
       or v_league_slug !~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$' then
      raise exception 'league slug is invalid' using errcode = '22023';
    end if;

    if v_timezone is null or not exists (
      select 1 from pg_catalog.pg_timezone_names where name = v_timezone
    ) then
      raise exception 'timezone is invalid' using errcode = '22023';
    end if;

    if v_locale is null
       or char_length(v_locale) < 2
       or char_length(v_locale) > 35
       or v_locale !~ '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$' then
      raise exception 'locale is invalid' using errcode = '22023';
    end if;

    insert into public.leagues (
      name,
      slug,
      timezone,
      locale,
      privacy_notice_version,
      settings_json,
      status
    ) values (
      v_league_name,
      v_league_slug,
      v_timezone,
      v_locale,
      1,
      '{}'::jsonb,
      'active'
    )
    returning id into v_league_id;

    v_created_league := true;
  else
    select id
    into v_league_id
    from public.leagues
    where id = p_existing_league_id
      and status = 'active';

    if not found then
      raise exception 'active league was not found' using errcode = '22023';
    end if;
  end if;

  insert into public.profiles (
    id,
    username,
    display_name,
    status,
    must_change_password,
    privacy_accepted_at
  ) values (
    p_profile_id,
    v_username,
    v_display_name,
    'active',
    true,
    null
  );

  insert into public.league_memberships (
    league_id,
    profile_id,
    member_status
  ) values (
    v_league_id,
    p_profile_id,
    'active'
  );

  insert into public.role_assignments (
    league_id,
    profile_id,
    role,
    granted_by
  ) values (
    v_league_id,
    p_profile_id,
    'owner',
    null
  );

  insert into public.audit_events (
    actor_profile_id,
    action,
    scope_league_id,
    target_type,
    target_id,
    after_json
  ) values (
    null,
    'deployment.initial_owner_bootstrapped',
    v_league_id,
    'profile',
    p_profile_id,
    pg_catalog.jsonb_build_object('created_league', v_created_league)
  );

  return pg_catalog.jsonb_build_object(
    'status', 'bootstrapped',
    'profileId', p_profile_id,
    'leagueId', v_league_id,
    'createdLeague', v_created_league
  );
end;
$$;

comment on function public.bootstrap_initial_owner(
  uuid, text, text, uuid, text, text, text, text
) is
  'Service-only, one-time initial owner bootstrap. Atomically creates/attaches the league identity graph; never returns or stores a credential.';

-- PostgreSQL grants function execution to PUBLIC by default. Only the
-- operator-held service role may reach this RPC; browsers cannot call it.
revoke all on function public.bootstrap_initial_owner(
  uuid, text, text, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.bootstrap_initial_owner(
  uuid, text, text, uuid, text, text, text, text
) to service_role;
