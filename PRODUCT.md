# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Specified by the binding technical specification (§13): mobile-first React PWA — React 19.2 + React Router 7 (library mode) + TanStack Query 5 + Zod 4 + Dexie 4 (IndexedDB offline store) + vite-plugin-pwa/Workbox, built with Vite 8 and TypeScript 6 on Node 24 LTS. Backend is Supabase Free (PostgreSQL + RLS, Auth, Edge Functions, Realtime); static hosting on Cloudflare Pages Free at the generated pages.dev hostname. Monorepo with npm workspaces: `apps/web`, `packages/contracts`, `packages/scoring` (pure engine), `packages/test-vectors`, `supabase/`. Pin exact versions in the lockfile. Public GitHub repository, MIT license, GitHub Actions CI.

## Users

- **Primary: players/markers in the owner's league** — adults playing 2-man "throwdown" tournaments of fewer than 30 people, split into groups of 4 (two two-man teams per group). They score on their phones on the course, one-handed, in sunlight, with intermittent or absent cellular service.
- **Organizers** (league owner, league administrator, event director) — one or two trusted people who configure courses, tees, players, teams, events, handicaps, and competitions, run scoring day, resolve corrections, and finalize results without developer involvement.
- **Spectators** — read-only viewers of published leaderboards; default visibility is private to signed-in league members.

## Product Purpose

Replace paper aggregation and spreadsheet arithmetic during live golf competition. Players enter gross hole scores on their phones; the system applies frozen event rules and handicaps and updates live scorecards, leaderboards, matches, Stableford points, and skins within three seconds of a committed score. Success: an organizer publishes an event unaided, a player reaches the active scorecard within three interactions of sign-in, scores survive offline entry, results are deterministic and reproducible from exported raw facts, and the whole thing runs at $0/month.

## Positioning

A zero-cost, offline-first, audit-grade scoring engine for a single league — not a commercial SaaS. What a neighboring product can't truthfully copy: every result is reproducible byte-for-byte from an immutable published snapshot (course, tees, rosters, handicaps, rules) plus append-only raw score facts, with a deterministic result hash at finalization; and the entire deployment runs on vendor free tiers with no payment method attached and a portable self-hosted exit path. It deliberately is not a handicap authority, tee-time marketplace, GPS tool, payment platform, or rules adjudicator, and it is not a clone of any commercial product (no GolfXI assets, text, APIs, or trade dress).

## Operating Context

- **Launch use case (confirmed by owner):** 2-man throwdown tournaments, <30 players, groups of 4 with two two-man teams per group, using handicaps with gross, net, and net skins competitions running simultaneously off the same raw scores. This is the primary format to date; future formats TBD.
- On-course phone use: score entry mid-round between shots, screen locks, weak signal, bright sun. Entry is queued locally first (outbox with idempotency keys) and synced when online.
- Event day rhythm: organizer runs a readiness checklist 24–48 hours ahead (Supabase free projects can pause after inactivity), players cache the event before tee-off, director opens/closes scoring, resolves conflicts and corrections with audited reasons, then finalizes.
- Handicaps are organizer-supplied (manual verified, authorized import, league value, or explicit scratch); the app computes Course/Playing Handicaps under the USGA WHS 2024 profile but the director reviews and freezes them at publish.
- Printable/exported group lists and blank score sheets remain the offline fallback of last resort.

## Capabilities and Constraints

- **Binding authority:** `golf-scoring-tracker-technical-specification.docx` v1.0 (verified Aug 9, 2026) is the implementation authority, confirmed by the owner, including every Section 25 safe default (USGA WHS 2024 profile, private leaderboards, ties stand, carry-forward skins with expiring final carry, marker-per-group scorer model, manual/CSV course data). Departures from a MUST require owner approval and a spec update.
- **Zero-cost guardrail (absolute):** no payment method, no custom domain, no paid add-on, no SMS, no metered API, no production email dependency, no third-party analytics/fonts/scripts. When a free quota is reached the system degrades or stops rather than incurring a charge.
- **Capacity profile:** one league, ≤500 player profiles, ≤200 participants per event, ≤120 concurrent live devices, ≤12 simultaneous competitions per event, 9/18/36-hole rounds. The confirmed league (<30 players) sits far inside this.
- **Formats (phased):** individual gross/net stroke play, best-k-of-m best ball, Stableford/Modified Stableford, match play, skins (units, never money), scramble, foursomes, Greensomes/Chapman, shamble, Par/Bogey, Nassau segments, multi-round aggregation. Phase 2's field trial is the league's 2-man best ball + net skins.
- **Engine invariants:** pure TypeScript scoring package shared by client preview and server projection; deterministic canonical output and result hash; signed internal handicaps; raw facts are truth, leaderboards are replaceable projections; missing data propagates as provisional, never coerced to zero.
- **Terminology:** committee, participant, scoring entity, gross/net, Course/Playing Handicap, event revision, projection, provisional — per the spec glossary. "Handicap Index," "Slope Rating," etc. may be protected marks; never imply handicap-authority endorsement or issue official indexes.
- **Undecided product facts:** future formats beyond the launch use case (owner: "tbd if anything changes"); whether leaderboards ever go public; playoff/countback adoption; Web Push adoption timing (optional Phase 2).

## Brand Commitments

- **Name (confirmed by owner): "Golf Tournament Tracker"** — replaces the spec's code-only "League Golf Live" placeholder. Trademark check still due before release per spec §25.
- MIT license for original code; public repository.
- Spec default presentation constraints: system fonts, player initials rather than avatars, simple league colors, no image/video uploads in MVP, no remote assets (strict CSP, `default-src 'self'`).

## Evidence on Hand

- [golf-scoring-tracker-technical-specification.docx](golf-scoring-tracker-technical-specification.docx) — the complete 26-section spec with rule schemas, data model, API contracts, golden-vector list, runbooks, and a source/verification register (USGA rules, Supabase/Cloudflare/GitHub free-plan limits, all checked Aug 9, 2026).
- No logos, screenshots, testimonials, case studies, or real player data exist yet. Do not fabricate any; seed data must contain no real PII.

## Product Principles

1. **Raw facts over convenience.** Preserve append-only score history, frozen snapshots, and auditability above every convenience feature; totals are always reproducible from hole-level facts.
2. **Works where golf happens.** Offline-first score entry on a phone, one-handed, in sunlight, is the core scenario — connectivity improves the experience but never gates it.
3. **$0 is a requirement, not an aspiration.** Degrade or stop before spending; portability and export are acceptance criteria because free tiers change.
4. **The Committee decides, the app records.** Handicap allowances, tie policies, and rules disputes are frozen organizer decisions with audited reasons — never silent app judgment.
5. **Smallest system that satisfies every MUST.** Ordinary engineering freedom exists only where externally visible behavior, security, scoring results, portability, and cost are unchanged.

## Accessibility & Inclusion

WCAG 2.2 AA is a release gate (spec §18): ≥44×44 CSS px on-course targets, no drag-required input, 4.5:1 text contrast, color never the sole indicator for score relation/sync/rank/errors, 200% zoom at 320 px width, restrained live-region announcements for save/sync status, full keyboard operation, reduced-motion support, password-manager-friendly auth. Manual VoiceOver/TalkBack/sunlight field checks are required in addition to automated axe checks.
