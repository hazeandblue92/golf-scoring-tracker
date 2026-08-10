/**
 * Scoring-ready fixture builder for the integration/database test layers.
 *
 * `supabase/seed.sql` deliberately stops at a DRAFT event with no entries,
 * holes, or competitions — it is a development fixture, not a test rig. These
 * tests need a live, scorable event plus real accounts whose JWTs carry the
 * `authenticated` role, because that is the only context in which RLS and
 * `auth.uid()` mean anything (spec §7.2).
 *
 * Every builder call creates a FRESH event, round, entries and competitions
 * hanging off the seeded league/course, so suites running in the same database
 * never collide. Accounts are created through the auth admin API and given
 * real sessions via a password grant, matching how `username-login` mints one.
 */

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PUBLISHABLE_KEY, SUPABASE_URL, serviceClient } from './stack.ts'
import { createClient } from '@supabase/supabase-js'

// Seeded reference data (supabase/seed.sql).
export const LEAGUE_ID = '00000000-0000-4000-8000-000000000001'
export const SEASON_ID = '00000000-0000-4000-8000-000000000101'
export const TEE_SET_BLUE = '00000000-0000-4000-8000-000000000321'

/** Standard 18-hole layout: pars sum to 72, stroke indexes are 1..18. */
const PARS = [4, 5, 3, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4]
const STROKE_INDEXES = [5, 11, 17, 1, 7, 15, 13, 3, 9, 6, 18, 12, 2, 8, 16, 4, 14, 10]

export interface TestAccount {
  profileId: string
  username: string
  password: string
  accessToken: string
  displayName: string
}

export interface FixtureHole {
  id: string
  ordinal: number
  par: number
  strokeIndex: number
}

export interface FixtureEntry {
  entryId: string
  participantId: string
  displayName: string
  playingHandicap: number
  /** Set when this entry belongs to a linked account. */
  profileId?: string
}

export interface ScoringFixture {
  eventId: string
  roundId: string
  holes: FixtureHole[]
  entries: FixtureEntry[]
  competitions: { grossId: string; netId: string; skinsId: string }
  /** Full league+event control (spec §2.2). */
  director: TestAccount
  /** Assigned scorer for this round, holds no entry of their own. */
  scorer: TestAccount
  /** A player whose own entry is `entries[0]` — exercises self-entry. */
  player: TestAccount
  /** League member with no scoring assignment: read yes, write no. */
  outsider: TestAccount
  service: SupabaseClient
}

function must<T>(
  result: { data: T | null; error: { message: string } | null },
  what: string,
): T {
  if (result.error) throw new Error(`fixture: ${what} failed — ${result.error.message}`)
  if (result.data === null) throw new Error(`fixture: ${what} returned no rows`)
  return result.data
}

/**
 * Create an account with a usable session.
 *
 * `must_change_password` defaults to true (organizer-provisioned temporary
 * password, FR-AUTH-003) and blocks score writes, so callers that intend to
 * score clear it — exactly what complete-activation does.
 */
export async function createAccount(
  service: SupabaseClient,
  opts: { username?: string; mustChangePassword?: boolean; displayName?: string } = {},
): Promise<TestAccount> {
  const suffix = randomUUID().slice(0, 8)
  const username = (opts.username ?? `t${suffix}`).toLowerCase()
  const password = `Test-${randomUUID()}`
  // The internal auth email is an implementation detail of auth.users and is
  // never exposed by the app (§14.1); tests fabricate one to drive the grant.
  const email = `${username}@integration.invalid`
  const displayName = opts.displayName ?? `Test ${suffix}`

  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (created.error || !created.data.user) {
    throw new Error(`fixture: createUser failed — ${created.error?.message}`)
  }
  const profileId = created.data.user.id

  must(
    await service
      .from('profiles')
      .insert({
        id: profileId,
        username,
        display_name: displayName,
        status: 'active',
        must_change_password: opts.mustChangePassword ?? false,
        privacy_accepted_at: new Date().toISOString(),
      })
      .select('id')
      .single(),
    `profile insert for ${username}`,
  )

  const auth = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const signIn = await auth.auth.signInWithPassword({ email, password })
  if (signIn.error || !signIn.data.session) {
    throw new Error(`fixture: sign-in failed for ${username} — ${signIn.error?.message}`)
  }

  return {
    profileId,
    username,
    password,
    displayName,
    accessToken: signIn.data.session.access_token,
  }
}

/** rules_json for a single-round individual stroke competition (§6.1). */
function strokeRules(metric: 'gross' | 'net') {
  return {
    format: 'individual_stroke',
    schemaVersion: 1,
    metric,
    holeScope: Array.from({ length: 18 }, (_, i) => i + 1),
    handicap: {
      profile: metric === 'net' ? 'usga_whs_2024' : 'none',
      allowance: 1,
      rounding: 'half_up_toward_positive_infinity',
      matchNormalizeFromLowest: false,
      allocation: 'stroke_index',
    },
    ties: { mode: 'tied', sequence: [] },
    incomplete: { live: 'provisional', final: 'no_return' },
    visibility: 'league',
  }
}

/** rules_json for net skins — the launch use case (2-man throwdown). */
function skinsRules() {
  return {
    format: 'skins',
    schemaVersion: 1,
    metric: 'net',
    holeScope: Array.from({ length: 18 }, (_, i) => i + 1),
    handicap: {
      profile: 'usga_whs_2024',
      allowance: 1,
      rounding: 'half_up_toward_positive_infinity',
      matchNormalizeFromLowest: false,
      allocation: 'stroke_index',
    },
    ties: { mode: 'tied', sequence: [] },
    incomplete: { live: 'provisional', final: 'no_return' },
    visibility: 'league',
    skins: {
      population: 'field',
      carryMode: 'carry_forward',
      unitsPerHole: 1,
      finalCarry: 'expire',
    },
  }
}

export interface BuildOptions {
  /** Number of players entered in the event. */
  playerCount?: number
  /** Leave the event in `published` so EVENT_LOCKED paths can be exercised. */
  leaveClosed?: boolean
}

/**
 * Build a complete, scorable event and the four accounts the security tests
 * need. Returns handles rather than fixed UUIDs so suites stay independent.
 */
export async function buildScoringFixture(
  options: BuildOptions = {},
): Promise<ScoringFixture> {
  const playerCount = options.playerCount ?? 4
  const service = serviceClient()

  const [director, scorer, player, outsider] = await Promise.all([
    createAccount(service, { displayName: 'Director' }),
    createAccount(service, { displayName: 'Scorer' }),
    createAccount(service, { displayName: 'Player One' }),
    createAccount(service, { displayName: 'Outsider' }),
  ])

  // ── Event (created draft, then walked through the state machine) ──────────
  const eventId = randomUUID()
  must(
    await service
      .from('events')
      .insert({
        id: eventId,
        league_id: LEAGUE_ID,
        season_id: SEASON_ID,
        name: `Integration Event ${eventId.slice(0, 8)}`,
        slug: `it-${eventId.slice(0, 8)}`,
        status: 'draft',
        scoring_revision: 0,
        starts_at: new Date().toISOString(),
        timezone: 'America/Detroit',
      })
      .select('id')
      .single(),
    'event insert',
  )

  const roundId = randomUUID()
  must(
    await service
      .from('rounds')
      .insert({
        id: roundId,
        event_id: eventId,
        round_number: 1,
        name: 'Round 1',
        hole_count: 18,
        status: 'scheduled',
      })
      .select('id')
      .single(),
    'round insert',
  )

  // Tee snapshot: the event freezes course data at publish time (§4.3).
  const snapshotId = randomUUID()
  must(
    await service
      .from('event_tee_snapshots')
      .insert({
        id: snapshotId,
        round_id: roundId,
        source_tee_set_id: TEE_SET_BLUE,
        course_name: 'GTT Dev Course',
        layout_name: 'Championship 18',
        tee_name: 'Blue',
        course_rating: 71.4,
        slope_rating: 128,
        par: 72,
        hole_count: 18,
        snapshot_version: 1,
        snapshot_hash: `test-${snapshotId.slice(0, 12)}`,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single(),
    'tee snapshot insert',
  )

  const holeRows = PARS.map((par, i) => ({
    id: randomUUID(),
    round_id: roundId,
    event_tee_snapshot_id: snapshotId,
    hole_ordinal: i + 1,
    label: String(i + 1),
    par,
    stroke_index: STROKE_INDEXES[i],
  }))
  must(await service.from('event_holes').insert(holeRows).select('id'), 'event_holes insert')

  const holes: FixtureHole[] = holeRows.map((h) => ({
    id: h.id,
    ordinal: h.hole_ordinal,
    par: h.par,
    strokeIndex: h.stroke_index,
  }))

  // ── Participants and entries ──────────────────────────────────────────────
  // entries[0] belongs to `player`, so self-entry scoring is exercisable.
  const participantRows = Array.from({ length: playerCount }, (_, i) => ({
    id: randomUUID(),
    league_id: LEAGUE_ID,
    profile_id: i === 0 ? player.profileId : null,
    display_name: i === 0 ? player.displayName : `Player ${i + 1}`,
    sort_name: i === 0 ? 'player, one' : `player, ${i + 1}`,
    status: 'active',
  }))
  must(
    await service.from('participants').insert(participantRows).select('id'),
    'participants insert',
  )

  const handicaps = [4, 12, 18, 25, 8, 15, 2, 30]
  const entryRows = participantRows.map((p, i) => ({
    id: randomUUID(),
    event_id: eventId,
    participant_id: p.id,
    status: 'active',
    handicap_source: 'manual_verified',
    handicap_value: handicaps[i % handicaps.length],
    course_handicap_unrounded: handicaps[i % handicaps.length],
    playing_handicap: handicaps[i % handicaps.length],
    allowance: 1,
  }))
  must(await service.from('event_entries').insert(entryRows).select('id'), 'event_entries insert')

  const entries: FixtureEntry[] = entryRows.map((e, i) => ({
    entryId: e.id,
    participantId: e.participant_id,
    displayName: participantRows[i].display_name,
    playingHandicap: e.playing_handicap,
    profileId: i === 0 ? player.profileId : undefined,
  }))

  // ── Competitions: gross, net, net skins (the launch use case) ─────────────
  const grossId = randomUUID()
  const netId = randomUUID()
  const skinsId = randomUUID()
  must(
    await service
      .from('competitions')
      .insert([
        {
          id: grossId, event_id: eventId, name: 'Gross', format: 'individual_stroke',
          metric: 'gross', status: 'scoring_open', rules_schema_version: 1,
          rules_json: strokeRules('gross'), engine_version: 'test', sort_order: 1,
        },
        {
          id: netId, event_id: eventId, name: 'Net', format: 'individual_stroke',
          metric: 'net', status: 'scoring_open', rules_schema_version: 1,
          rules_json: strokeRules('net'), engine_version: 'test', sort_order: 2,
        },
        {
          id: skinsId, event_id: eventId, name: 'Net Skins', format: 'skins',
          metric: 'net', status: 'scoring_open', rules_schema_version: 1,
          rules_json: skinsRules(), engine_version: 'test', sort_order: 3,
        },
      ])
      .select('id'),
    'competitions insert',
  )

  must(
    await service
      .from('competition_rounds')
      .insert([grossId, netId, skinsId].map((competition_id) => ({
        competition_id, round_id: roundId, hole_scope: null, weight: 1,
      })))
      .select('competition_id'),
    'competition_rounds insert',
  )

  must(
    await service
      .from('competition_entities')
      .insert(
        [grossId, netId, skinsId].flatMap((competition_id) =>
          entries.map((e) => ({
            competition_id,
            event_entry_id: e.entryId,
            eligibility_status: 'eligible',
          })),
        ),
      )
      .select('id'),
    'competition_entities insert',
  )

  // ── Roles and scoring assignments (§2.2) ──────────────────────────────────
  must(
    await service
      .from('role_assignments')
      .insert([
        { league_id: LEAGUE_ID, event_id: eventId, profile_id: director.profileId, role: 'event_director' },
      ])
      .select('id'),
    'role_assignments insert',
  )

  must(
    await service
      .from('league_memberships')
      .insert(
        [director, scorer, player, outsider].map((a) => ({
          league_id: LEAGUE_ID,
          profile_id: a.profileId,
          member_status: 'active',
        })),
      )
      .select('id'),
    'league_memberships insert',
  )

  // The scorer may score every entry in this round.
  must(
    await service
      .from('scoring_permissions')
      .insert(
        entries.map((e) => ({
          event_id: eventId,
          round_id: roundId,
          scorer_profile_id: scorer.profileId,
          participant_id: e.participantId,
          permission_type: 'marker',
        })),
      )
      .select('id'),
    'scoring_permissions insert',
  )

  // ── Open scoring: draft → published → scoring_open ────────────────────────
  must(
    await service.from('events').update({ status: 'published' }).eq('id', eventId).select('id').single(),
    'event publish',
  )
  if (!options.leaveClosed) {
    must(
      await service.from('events').update({ status: 'scoring_open' }).eq('id', eventId).select('id').single(),
      'event open scoring',
    )
  }

  return {
    eventId,
    roundId,
    holes,
    entries,
    competitions: { grossId, netId, skinsId },
    director,
    scorer,
    player,
    outsider,
    service,
  }
}

/** Minimal valid submit-score body; callers override what they are testing. */
export function scoreRequest(
  fx: ScoringFixture,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    idempotencyKey: randomUUID(),
    eventId: fx.eventId,
    roundId: fx.roundId,
    target: { kind: 'individual', entryId: fx.entries[0].entryId, holeId: fx.holes[0].id },
    baseRevision: 0,
    value: { status: 'complete', grossStrokes: 4, notes: null },
    clientRecordedAt: new Date().toISOString(),
    clientRelease: '0.1.0',
    ...overrides,
  }
}
