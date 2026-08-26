# Runbook: Initial owner bootstrap

Use this once after migrations have been applied to a new Supabase project.
It creates the first owner account and either creates the deployment's only
league or explicitly attaches the account to one existing active league.

This is not an account-recovery command. It permanently closes as soon as any
owner grant has existed, including a later-revoked grant. After bootstrap,
owner recovery follows the normal organizer-mediated credential process and
the credential-compromise runbook.

## Safety properties

- The Supabase service-role key is read only from the process environment. It
  is never accepted as an argument, printed, or written to the repository.
- The internal Auth address is random, confirmed, under `users.invalid`, and
  never printed or placed in an application table.
- The temporary password is generated locally and displayed once. PostgreSQL,
  audit events, and application logs never receive it.
- Profile, league membership, owner role, and audit rows are committed in one
  guarded database transaction. Concurrent attempts serialize; only the first
  can succeed.
- A new league is allowed only when the deployment has no league rows at all.
  Attaching requires an explicit ID for an existing active league.
- The owner starts with `must_change_password=true` and no privacy acceptance.
  Scoring and privileged operations stay blocked until the normal activation
  screen replaces the password and accepts the privacy notice.

## Prerequisites

1. Use a private terminal on an owner-controlled computer. Do not run this in
   CI, a shared terminal, or a recorded screen-sharing session.
2. Apply every database migration, not a subset. Migration 33 introduces the
   bootstrap RPC and migration 34 closes the temporary-password authorization
   boundary for the owner it creates, so 34 is the minimum this procedure
   needs — it is not a stopping point, and later migrations must be applied
   too.
3. Deploy `username-login` and `complete-activation` before attempting the
   first sign-in.
4. Confirm that this is a new deployment with no past owner. If an owner ever
   existed, stop and use account recovery instead.
5. Have the project URL and service-role key available from the Supabase
   project settings. Never put the key directly in shell history.

## Load the service credential without shell history

In the repository root, use hidden terminal input. The following form is for
the default macOS `zsh` shell:

```sh
read "SUPABASE_URL?Supabase project URL: "
read -s "SUPABASE_SERVICE_ROLE_KEY?Service-role key (hidden): "
echo
export SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
```

The key remains in this terminal process only until it is unset or the
terminal closes.

## Fresh hosted project: create the league and first owner

Replace the example names and slug. Use an IANA timezone such as
`America/Detroit`.

```sh
npm run bootstrap:owner -- \
  --username league_owner \
  --display-name "League Owner" \
  --league-name "My Golf League" \
  --league-slug my-golf-league \
  --timezone America/Detroit \
  --locale en-US \
  --confirm
```

The command first prints the Auth user ID, username, and temporary password,
then confirms the database transaction. Do not redirect, save, photograph, or
paste this output into chat. If the command does not end with `Bootstrap
complete.`, the commit outcome is uncertain: keep the displayed credential
until you follow the interrupted-attempt checks below.

## Existing active league: attach the first owner

This is useful for the deterministic local seed or a fresh portable restore
that already contains its league. It never creates another league.

```sh
npm run bootstrap:owner -- \
  --username league_owner \
  --display-name "League Owner" \
  --league-id 00000000-0000-4000-8000-000000000001 \
  --confirm
```

The UUID shown is the synthetic local development league. For any other
deployment, use that deployment's actual active league ID.

## Complete activation immediately

1. Open the deployed app and sign in with the printed username and temporary
   password.
2. On **Activate account**, choose a new unique passphrase and accept the
   league privacy notice. Confirm the old temporary password no longer works.
3. Open **Settings** and enroll a TOTP authenticator. Administrative account
   and event operations require an MFA-verified session, not just enrollment.
4. In **Players**, create one synthetic test player account and verify its
   one-time credential/activation flow before adding friends.
5. Unset the privileged terminal value:

```sh
unset SUPABASE_SERVICE_ROLE_KEY
```

## Interrupted attempt

An ordinary failure deletes the just-created Auth user before exiting. If
that cleanup also fails, the command prints the marked orphan's user ID. A
hard process termination can leave the same kind of orphan; find the internal
user in Supabase Auth whose app metadata contains
`initial_owner_bootstrap: true`.

If the command was interrupted while the database request was in flight, first
try signing in with the credential that was already displayed. A successful
database commit leaves that credential usable and permanently closes the
bootstrap. Continue with recovery only when sign-in has no application access
and Supabase contains no owner grant.

Repeat the original create-or-attach command with this additional option:

```sh
--recover-user-id 11111111-1111-4111-8111-111111111111
```

Recovery accepts only a confirmed `users.invalid` Auth user carrying the
server-controlled bootstrap marker. It replaces that orphan's unknown
temporary password, displays the new value once, and retries the guarded
transaction. It cannot recover or replace an established owner.

## Expected refusals

Stop rather than work around any of these messages:

- `Bootstrap is closed because an owner grant already exists`: use normal
  account recovery; never delete role history to reopen bootstrap.
- `A league already exists`: rerun only with the intended active league's
  explicit `--league-id`.
- `The selected active league was not found`: verify the target project and
  league ID before retrying.
- `Bootstrap preflight failed`: verify migrations are applied through 34 and that the
  environment contains the server-side service-role key, not the browser's
  publishable key.

For local development, `npm run backend:seed` resets the database and erases
the local owner before recreating synthetic league data. Never run a database
reset against the hosted project.
