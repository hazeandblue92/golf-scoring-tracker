# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to the repository owner. Do not open
a public issue containing exploit details, credentials, or league data.

## Security boundaries

- PostgreSQL Row Level Security (RLS) is the primary data-authorization
  boundary. Every API-exposed table has RLS enabled; authorization is enforced
  in policies or security-definer functions and repeated at Edge Function
  boundaries.
- The Supabase publishable key is public by design and confers no access
  without a user JWT and RLS.
- The Supabase service-role key exists only as an Edge Function or CI secret.
  It is never bundled into the web app, committed, or logged.
- Finalized scoring records are immutable to ordinary users; reopening requires
  an event director and an audited reason.

## Secret handling

Secrets live only in vendor secret stores (Supabase, GitHub Actions,
Cloudflare) or local untracked `.env` files. See `.env.example` for the
variable inventory and `docs/runbooks/` for the rotation runbook.

## Supported profile

This deployment targets the zero-cost profile in the technical specification
(§24). There is no service-level agreement.
