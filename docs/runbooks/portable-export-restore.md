# Portable Export and Restore

Directors can download an event export from **Operations**. The JSON includes
the frozen tee and roster snapshots, raw scores, competition rules, derived
projections, an integrity hash, and each finalized result hash. Authentication
identities and organizer-only notes are deliberately excluded.

Restore only into a fresh Supabase project whose migrations have been applied:

```bash
SUPABASE_URL=https://project.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=server-only-key \
npm run restore:export -- ./gtt-event.json
```

Run this command from a trusted operator machine. Never place the service-role
key in the web app or commit it. The restore stops on the first rejected table,
verifies the file integrity hash before writing, and verifies every finalized
competition hash afterward. Re-provision player and organizer accounts on the
target deployment; exported participants intentionally restore as guests.
