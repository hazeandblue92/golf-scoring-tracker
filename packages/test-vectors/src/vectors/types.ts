/**
 * Golden-vector object shapes (spec §20.1-20.2).
 *
 * Every vector is `{ id, kind, section, description, input, expected }`:
 * `input` is the exact typed engine input and `expected` is a hand-computed
 * asserted SUBSET of the engine output (arrays in `expected` must match the
 * actual array length and are compared index-wise; each element asserts only
 * the fields it names). The `kind` discriminant tells the test runner which
 * engine function to dispatch to.
 */

import type {
  BestBallInput,
  BestBallRow,
  BestBallTeamHole,
  CourseHandicapInput,
  HoleSnapshot,
  IndividualHoleScore,
  MatchAllocationInput,
  MatchInput,
  MatchState,
  ParBogeyInput,
  ParBogeyRow,
  Rational,
  RoundingProfile,
  SkinsEntryHole,
  SkinsHoleOutcome,
  SkinsInput,
  StablefordHolePoints,
  StablefordInput,
  StablefordRow,
  StrokePlayInput,
  StrokePlayRow,
  TeamAggregateInput,
} from '@gtt/scoring'

export interface VectorBase<Kind extends string, Input, Expected> {
  id: string
  kind: Kind
  /** Spec section(s) grounding this vector. */
  section: string
  description: string
  input: Input
  expected: Expected
}

// ── Handicap engine vectors ─────────────────────────────────────────────────

export type CourseHandicapVector = VectorBase<
  'course_handicap',
  {
    course: CourseHandicapInput
    allowance: Rational
    rounding: RoundingProfile
  },
  {
    /** Exact unrounded CH retained before the allowance (spec §9.3). */
    courseHandicapUnrounded: Rational
    /** Exact CH x allowance before the one rounding step (spec §9.4). */
    playingHandicapUnrounded: Rational
    playingHandicap: number
  }
>

export type PlayingHandicapRoundingVector = VectorBase<
  'playing_handicap_rounding',
  {
    courseHandicap: Rational
    allowance: Rational
    rounding: RoundingProfile
  },
  { playingHandicap: number }
>

export type AllocationVector = VectorBase<
  'allocation',
  { playingHandicap: number; holes: HoleSnapshot[] },
  {
    /** Full holeId -> signed strokes-received map (compared exactly). */
    strokesByHole: Record<string, number>
  }
>

// ── Format vectors ──────────────────────────────────────────────────────────

export type StrokePlayVector = VectorBase<
  'stroke_play',
  StrokePlayInput,
  {
    rows: Array<Partial<StrokePlayRow>>
    provisional?: boolean
    warningCodes?: string[]
  }
>

export type BestBallVector = VectorBase<
  'best_ball',
  BestBallInput,
  {
    rows: Array<Partial<BestBallRow>>
    teamHoles?: Array<Partial<BestBallTeamHole>>
    provisional?: boolean
  }
>

export type TeamAggregateVector = VectorBase<
  'team_aggregate',
  TeamAggregateInput,
  {
    rows: Array<Partial<BestBallRow>>
    teamHoles?: Array<Partial<BestBallTeamHole>>
    provisional?: boolean
  }
>

export type StablefordVector = VectorBase<
  'stableford',
  StablefordInput,
  {
    rows: Array<Partial<StablefordRow>>
    holePoints?: Array<Partial<StablefordHolePoints>>
  }
>

export type ParBogeyVector = VectorBase<
  'par_bogey',
  ParBogeyInput,
  { rows: Array<Partial<ParBogeyRow>> }
>

export type MatchVector = VectorBase<
  'match',
  MatchInput,
  Partial<Omit<MatchState, 'outcomes'>> & {
    /** When present, one entry per regulation hole in play order. */
    outcomes?: Array<{ holeId: string; winner: 'a' | 'b' | 'half' | null }>
  }
>

export type MatchAllocationVector = VectorBase<
  'match_allocation',
  MatchAllocationInput,
  {
    strokesA: Record<string, number>
    strokesB: Record<string, number>
  }
>

export type SkinsVector = VectorBase<
  'skins',
  SkinsInput,
  {
    holeOutcomes: Array<Partial<SkinsHoleOutcome>>
    totals: Array<{ entityId: string; units: number }>
    unawardedUnits: number
    provisional: boolean
    warningCodes?: string[]
  }
>

// ── Team handicap preset vectors ────────────────────────────────────────────

export interface TeamHandicapExpectation {
  teamPlayingHandicapUnrounded: Rational
  teamPlayingHandicap: number
}

export type ScrambleHandicapVector = VectorBase<
  'scramble_handicap',
  {
    courseHandicaps: Rational[]
    /** Low-to-high weights paired with the ascending-sorted handicaps. */
    weights: Rational[]
    rounding: RoundingProfile
  },
  TeamHandicapExpectation
>

export type PairTeamHandicapVector = VectorBase<
  'foursomes_handicap' | 'greensomes_handicap',
  { a: Rational; b: Rational; rounding: RoundingProfile },
  TeamHandicapExpectation
>

// ── Union ───────────────────────────────────────────────────────────────────

export type GoldenVector =
  | CourseHandicapVector
  | PlayingHandicapRoundingVector
  | AllocationVector
  | StrokePlayVector
  | BestBallVector
  | TeamAggregateVector
  | StablefordVector
  | ParBogeyVector
  | MatchVector
  | MatchAllocationVector
  | SkinsVector
  | ScrambleHandicapVector
  | PairTeamHandicapVector

// ── Small deterministic input builders ──────────────────────────────────────
// Builders only assemble score FACTS positionally against a hole list; every
// expected value stays hand-written in the vector modules.

/** One card slot: gross strokes, a terminal non-numeric status, or no fact. */
export type CardEntry =
  | number
  | 'picked_up'
  | 'conceded'
  | 'not_played'
  | 'no_score'
  | null

/**
 * Build IndividualHoleScore facts from a positional card aligned with
 * `holes`. `null` means no fact was recorded for that hole (missing data).
 */
export function scoresFor(
  participantId: string,
  holes: readonly HoleSnapshot[],
  card: readonly CardEntry[],
): IndividualHoleScore[] {
  if (card.length !== holes.length) {
    throw new RangeError(
      `card length ${card.length} does not match hole count ${holes.length}`,
    )
  }
  const out: IndividualHoleScore[] = []
  for (let i = 0; i < holes.length; i += 1) {
    const hole = holes[i]
    const entry = card[i]
    if (hole === undefined || entry === null || entry === undefined) continue
    if (typeof entry === 'number') {
      out.push({
        participantId,
        holeId: hole.id,
        grossStrokes: entry,
        status: 'complete',
        revision: 1,
      })
    } else {
      out.push({ participantId, holeId: hole.id, status: entry, revision: 1 })
    }
  }
  return out
}

/**
 * Build skins hole metrics from a positional list aligned with `holes`.
 * Skins consume already-resolved metric values (gross or net) per spec §8.7;
 * `null` means the entity's required score is still missing.
 */
export function skinsCard(
  holes: readonly HoleSnapshot[],
  values: ReadonlyArray<number | null>,
): SkinsEntryHole[] {
  if (values.length !== holes.length) {
    throw new RangeError(
      `skins card length ${values.length} does not match hole count ${holes.length}`,
    )
  }
  const out: SkinsEntryHole[] = []
  for (let i = 0; i < holes.length; i += 1) {
    const hole = holes[i]
    const value = values[i]
    if (hole === undefined) continue
    out.push({ holeId: hole.id, score: value ?? null, terminal: false })
  }
  return out
}
