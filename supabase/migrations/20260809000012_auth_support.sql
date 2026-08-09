-- Migration 12: auth support — PostgreSQL-backed fixed-window rate limiting
-- (spec §12.5: "Store rate-limit buckets in PostgreSQL or rely on platform
-- limits plus database checks; never require a paid gateway", §14.1: the
-- username-login function is rate-limited by a privacy-preserving
-- client-network hash and normalized username).
--
-- The bucket key is an opaque string built by the Edge Function, e.g.
--   'login:' || sha256(client ip) || ':' || normalized username
-- so no raw IP address is ever stored (§11.8 privacy posture).

-- ---------------------------------------------------------------------------
-- app.rate_limit_buckets: one row per active fixed window per bucket key.
-- Never exposed via PostgREST (schema `app` is not in the API schema list)
-- and never readable by client roles.
-- ---------------------------------------------------------------------------
create table app.rate_limit_buckets (
  bucket_key text primary key,
  window_started_at timestamptz not null default now(),
  count integer not null default 0
);

comment on table app.rate_limit_buckets is
  'Fixed-window rate-limit counters (spec §12.5). Keys are privacy-preserving hashes built by Edge Functions; raw IPs are never stored.';

revoke all on app.rate_limit_buckets from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- app.consume_rate_limit: consume one unit from a fixed window.
--   * If the bucket does not exist or its window has expired, start a fresh
--     window with count = 1.
--   * Otherwise increment the count.
--   * Returns true while count <= p_max (the request is allowed), false once
--     the window's budget is exhausted.
-- SECURITY DEFINER, callable by service_role only (Edge Functions).
-- ---------------------------------------------------------------------------
create or replace function app.consume_rate_limit(
  p_bucket text,
  p_max integer,
  p_window interval
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into app.rate_limit_buckets as b (bucket_key, window_started_at, count)
  values (p_bucket, now(), 1)
  on conflict (bucket_key) do update
    set window_started_at = case
          when b.window_started_at + p_window <= now() then now()
          else b.window_started_at
        end,
        count = case
          when b.window_started_at + p_window <= now() then 1
          else b.count + 1
        end
  returning b.count into v_count;

  return v_count <= p_max;
end;
$$;

-- Functions default to EXECUTE for PUBLIC; lock this down to service_role.
revoke all on function app.consume_rate_limit(text, integer, interval) from public, anon, authenticated;
grant execute on function app.consume_rate_limit(text, integer, interval) to service_role;

-- ---------------------------------------------------------------------------
-- public.consume_rate_limit: thin PostgREST-reachable wrapper. The `app`
-- schema is intentionally NOT exposed through the Data API (config.toml
-- [api].schemas), so Edge Functions call this wrapper via the service-role
-- client's rpc(). It is service_role-only; anon/authenticated can never
-- consume or probe rate-limit state.
-- ---------------------------------------------------------------------------
create or replace function public.consume_rate_limit(
  p_bucket text,
  p_max integer,
  p_window interval
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select app.consume_rate_limit(p_bucket, p_max, p_window);
$$;

revoke all on function public.consume_rate_limit(text, integer, interval) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, interval) to service_role;

-- ---------------------------------------------------------------------------
-- Service-role table privileges for the auth Edge Functions (§14.1, §12.2).
-- This deployment uses the always-revoked Data API model (config.toml
-- [api]): no role gets automatic privileges on new tables, so the narrow
-- set needed by username-login / complete-activation / account-admin is
-- granted explicitly here. The service-role key exists only server-side
-- (§2.3); anon/authenticated grants are unchanged.
-- ---------------------------------------------------------------------------
grant select, insert, update on public.profiles to service_role;
grant select on public.leagues to service_role;
grant select, insert, update on public.league_memberships to service_role;
grant select on public.role_assignments to service_role;
-- audit_events is append-only (migration 8 trigger); insert + select only.
grant select, insert on public.audit_events to service_role;
