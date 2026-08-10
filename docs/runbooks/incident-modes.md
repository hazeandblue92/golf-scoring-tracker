# Runbook: Event-day incident modes

Spec §17.6 and Appendix C.2–C.3. The prime directive in every mode: **never
clear the outbox, never sign out scorers, never clear site data.**

## Realtime degraded (C.2)

Keep scoring open as long as HTTPS commits work. The app shows polling mode and
polls the active projection revision every 10 seconds while visible. Do not
manually re-enter scores that show "saved on device" or "server saved". When
realtime returns, clients reconnect and refetch authoritative revisions.

## Backend unavailable / project paused (C.3)

Tell scorers to keep the PWA open and continue scoring locally. Do not sign
out, reinstall, clear site data, or switch accounts — that discards the queued
outbox. Live leaderboards are stale; say so rather than improvising. Record a
paper backup if a device battery is at risk. When the backend returns, sync one
group at a time if the backlog is large, and resolve all conflicts before
finalization.

## Static host down

Previously installed/cached PWA devices keep working; new devices cannot load
the app. Prioritize getting assigned scorers (whose devices are cached) through
the round.

## Projection stuck

Raw scores remain authoritative. The director opens **Operations → Projection
repair** and invokes **Rebuild projections** for the event. Never edit scores
to "fix" a stale leaderboard.

## Bad release

Close scoring only if correctness or security requires it. Roll back the static
bundle and/or Edge Function version, then let devices sync. Raw facts are
append-only; nothing is lost by rolling back the frontend.
