# Runbook: Deploying a release

Spec §16.3 and §24. Deployment is manual on purpose — work lands on `main`
continuously, and a live event runs against whatever was deployed last, so
changing that is an operator decision rather than a consequence of a push.

Two workflows do the work:

| Workflow | Trigger | What it changes |
| --- | --- | --- |
| `Database migrations` | Manual, `mode` defaults to `dry-run` | Hosted PostgreSQL schema |
| `Deploy` | Manual, `target` defaults to `all` | Cloudflare Pages site and Supabase Edge Functions |

## One-time setup

### Vendor accounts (zero-cost guardrail, §24)

Cloudflare Pages Free and Supabase Free, on the generated `pages.dev` hostname,
with **no payment method attached to either account**. No custom domain, no
paid add-on. A quota increase is a product decision and a specification update,
not an operational fix.

### Repository variables

Public build configuration. These end up in the browser bundle by design; the
publishable key grants nothing without a JWT and Row Level Security.

| Variable | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The project's publishable key |
| `SUPABASE_PROJECT_REF` | The project ref, e.g. `dhdctelabkzfbxoppjck` |
| `CLOUDFLARE_PAGES_PROJECT` | The Pages project name |

### Repository secrets

| Secret | Where it comes from | Scope to grant |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → API tokens | Account → Cloudflare Pages → Edit, nothing else |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard sidebar | — |
| `SUPABASE_ACCESS_TOKEN` | Supabase account → Access tokens | — |
| `SUPABASE_DB_PASSWORD` | The project's database password | Migrations only |

Never place a service-role key, database URL, or any of the above in a
`VITE_`-prefixed variable. `npm run test:security` fails the build if one
reaches a bundle, but the allow-list is not a substitute for care.

### Optional: protect the apply path

Give the `Database migrations` workflow a GitHub environment named
`production-database` with yourself as a required reviewer. `mode=apply` then
pauses for an explicit approval; `mode=dry-run` is unaffected. The workflow
already references that environment, so creating it is the only step.

## Releasing

Order matters. Functions call RPCs that migrations add, and `health` reports a
schema version the operations screen compares against the release.

1. **Confirm the commit is green.** CI must be passing on the commit you intend
   to ship. The deploy workflow re-runs the release gates anyway and will stop
   before shipping anything, but finding out here is cheaper.

2. **Dry-run the migrations.** Run `Database migrations` with `mode=dry-run`.
   Read the plan. It should contain exactly the migrations added since the last
   release and nothing else — an unexpected entry means the hosted project and
   the repository disagree about history, which is a stop-and-investigate.

3. **Apply the migrations.** Re-run with `mode=apply`. The job prints the dry
   run again immediately before applying, then lists the applied state.

4. **Deploy.** Run `Deploy` with `target=all` and `deployment_url` set to the
   Pages origin (`https://<project>.pages.dev`). The workflow type-checks,
   tests, lints, builds, enforces the JavaScript budget, runs the secret and
   CSP scans, ships the exact bytes that passed, sets `RELEASE_VERSION` on the
   Edge project to match the web build, deploys the functions, and then
   verifies the live origin.

5. **Record the evidence.** Attach the run URL to
   `docs/season-launch-checklist.md`. The `verify` job's output is the
   deployed-header evidence AC-SEC-003 asks for.

6. **Bootstrap the first owner on a new project.** After the first successful
   migration/function deployment only, follow
   [initial-owner-bootstrap.md](initial-owner-bootstrap.md). The guarded
   command closes permanently after the first owner grant and is never part of
   an ordinary release.

## Verifying by hand

```bash
npm run verify:deployment -- https://<project>.pages.dev
```

Checks the served CSP and security headers against the same list the source
gate uses, plus `no-store` on the shell, `immutable` on hashed assets, and the
SPA fallback on a deep link. It needs no credentials.

## If a deploy goes wrong

- **The site is broken, the schema is fine.** Redeploy the previous good commit
  with `target=web`. Pages keeps prior deployments, so a rollback in the
  Cloudflare dashboard is also immediate.
- **A function is broken.** Redeploy the previous good commit with
  `target=functions`. Raw score facts are append-only and unaffected.
- **A migration is wrong.** There is no automatic rollback. Write a forward
  migration that corrects it and apply that; never edit an applied migration
  file. If results are already sealed, follow
  [scoring-defect-after-finalization.md](scoring-defect-after-finalization.md)
  instead — reopening a competition is an audited action, not a redeploy.
- **The deployed check fails but the site loads.** The host is not applying
  `_headers`. Confirm the Pages project's output directory is the deployment
  root and that `_headers` and `_redirects` are present at the top of the
  uploaded directory; the `web` job refuses to deploy without them.
