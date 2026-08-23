-- Migration 34: enforce initial password activation in every privileged
-- service-role workflow, including callers that bypass the HTTP boundary.

create or replace function app.actor_has_league_role(
  p_actor uuid,
  p_league_id uuid,
  p_roles public.app_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles pr
    join public.role_assignments ra on ra.profile_id = pr.id
    where pr.id = p_actor
      and pr.status = 'active'
      and not pr.must_change_password
      and ra.league_id = p_league_id
      and ra.role = any (p_roles)
      and ra.revoked_at is null
  );
$$;

create or replace function app.actor_is_event_director(
  p_actor uuid,
  p_event_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.events e
    join public.profiles pr
      on pr.id = p_actor
     and pr.status = 'active'
     and not pr.must_change_password
    join public.role_assignments ra
      on ra.profile_id = p_actor
     and ra.revoked_at is null
     and (
       (ra.role = 'event_director' and ra.event_id = e.id)
       or (ra.role in ('owner', 'league_admin') and ra.league_id = e.league_id)
     )
    where e.id = p_event_id
  );
$$;

revoke all on function app.actor_has_league_role(
  uuid, uuid, public.app_role[]
) from public, anon, authenticated;
revoke all on function app.actor_is_event_director(uuid, uuid)
  from public, anon, authenticated;
grant execute on function app.actor_has_league_role(
  uuid, uuid, public.app_role[]
) to service_role;
grant execute on function app.actor_is_event_director(uuid, uuid)
  to service_role;
