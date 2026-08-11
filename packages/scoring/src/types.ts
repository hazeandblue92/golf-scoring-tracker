/**
 * Core scoring engine types (spec §7.4, §4.5, §6.1).
 *
 * The engine is pure: every calculation receives a complete immutable
 * snapshot and returns serializable results plus validation messages. No
 * network, database, browser, clock, locale, or global-state dependency.
 */

import type { Rational } from './rational.ts'

export const ENGINE_VERSION = '0.2.0'
export const RULES_SCHEMA_VERSION = 1

// ── Snapshot inputs ──────────────────────────────────────────────────────────

export interface HoleSnapshot {
  id: string
  /** 1-based position in the competition's published hole order. */
  ordinal: number
  par: number
  /** Stroke index within this competition's allocation set (1..N). */
  strokeIndex: number
  /** e.g. 'front' | 'back' | 'full'; segmented competitions (Nassau). */
  segment?: string
}

export interface HandicapSnapshot {
  /**
   * Source handicap value in signed tenths (plus handicaps negative):
   * 12.3 -> 123, +2.0 -> -20. Spec §7.3 signed internal convention.
   */
  sourceValueTenths: number
  /** Exact unrounded Course Handicap (spec §9.3). */
  courseHandicapUnrounded: Rational
  /** Allowance applied to the unrounded Course Handicap (spec §9.4). */
  allowance: Rational
  /** Final signed integer Playing Handicap after the one rounding step. */
  playingHandicap: number
}

// ── Hole score facts ─────────────────────────────────────────────────────────

/** Spec §4.5 hole status values. */
export type HoleScoreStatus =
  | 'not_started'
  | 'complete'
  | 'picked_up'
  | 'conceded'
  | 'not_played'
  | 'no_score'
  | 'withdrawn'
  | 'disqualified'

/** Statuses that terminally exclude a numeric gross value. */
export const NON_NUMERIC_TERMINAL_STATUSES: readonly HoleScoreStatus[] = [
  'picked_up',
  'conceded',
  'not_played',
  'no_score',
  'withdrawn',
  'disqualified',
]

export interface IndividualHoleScore {
  participantId: string
  holeId: string
  /** Official gross strokes inclusive of penalties; absent unless complete. */
  grossStrokes?: number
  status: HoleScoreStatus
  revision: number
}

export interface TeamHoleScore {
  teamId: string
  holeId: string
  grossStrokes?: number
  status: HoleScoreStatus
  revision: number
}

// ── Entity status (competition-scoped, spec §4.4/§21.1) ─────────────────────

export type EntityStatus =
  | 'active'
  | 'withdrawn'
  | 'no_return'
  | 'disqualified'

// ── Competition rules (spec §6.1, Appendix A) ───────────────────────────────

export type CompetitionFormat =
  | 'individual_stroke'
  | 'best_k'
  | 'stableford'
  | 'match'
  | 'skins'
  | 'scramble'
  | 'foursomes'
  | 'greensomes'
  | 'chapman'
  | 'shamble'
  | 'par_bogey'
  | 'aggregate'

export type ScoringMetric = 'gross' | 'net' | 'points'

export interface RoundingProfileUsga {
  kind: 'usga_whs_2024'
}

export interface RoundingProfileCustom {
  kind: 'committee_custom'
  /** Decimal places retained at intermediate steps; final step rounds to 0. */
  intermediatePrecision: number
  tieDirection: 'up' | 'down' | 'toward_zero' | 'away_from_zero'
  /** Whether allowance applies before or after any intermediate rounding. */
  stepOrder: 'allowance_then_round' | 'round_then_allowance'
}

export type RoundingProfile = RoundingProfileUsga | RoundingProfileCustom

export interface HandicapRules {
  profile: 'usga_whs_2024' | 'committee_custom' | 'none'
  /** e.g. percent(85); ignored when profile is 'none'. */
  allowance: Rational
  rounding: RoundingProfile
  /** Match play: normalize strokes from the lowest unrounded CH (spec §8.6). */
  matchNormalizeFromLowest: boolean
  allocation: 'stroke_index'
}

export interface TeamRules {
  teamSize: number
  /** best_k_of_m: number of counting scores per hole. */
  bestK: number
  scoreSource: 'individual' | 'team_ball'
  /** Scramble-style handicap weights (low to high), as exact rationals. */
  weights?: Rational[]
}

export interface TieRules {
  mode: 'tied' | 'countback' | 'playoff'
  /** Countback segments in order, e.g. ['last_9','last_6','last_3','hole_18']. */
  sequence: string[]
}

export interface IncompleteRules {
  live: 'provisional'
  final: 'no_return'
}

export type SkinsCarryMode = 'carry_forward' | 'no_carry' | 'split_tied'
export type SkinsFinalCarry =
  | 'split_final_tied'
  | 'award_last_unique_winner'
  | 'expire'
  | 'sudden_death'

export interface SkinsRules {
  population: 'field' | 'flight' | 'group' | 'teams'
  carryMode: SkinsCarryMode
  unitsPerHole: number
  finalCarry: SkinsFinalCarry
  /** Fractional units for split_tied; off by default (spec §8.7). */
  fractionalUnits: boolean
}

export interface StablefordRules {
  /**
   * Ordered map from relation-to-par to points, e.g. {-3:5,-2:4,-1:3,0:2,1:1}.
   * Relations below the smallest key and pickups receive `floorPoints`.
   */
  pointsByRelation: Record<number, number>
  floorPoints: number
}

export interface MaximumScoreRules {
  policy: 'fixed' | 'par_plus_n' | 'net_double_bogey'
  value?: number
}

export interface CompetitionRules {
  schemaVersion: number
  format: CompetitionFormat
  metric: ScoringMetric
  /** Ordinals of competition holes within the round's published order. */
  holeScope: number[]
  handicap: HandicapRules
  team?: TeamRules
  ties: TieRules
  incomplete: IncompleteRules
  skins?: SkinsRules
  stableford?: StablefordRules
  maximumScore?: MaximumScoreRules
}

// ── Results / projections (spec §7.3-7.4) ───────────────────────────────────

export interface EngineWarning {
  code: string
  message: string
  context?: Record<string, string | number>
}

export interface LeaderboardRow {
  entityId: string
  rank: number | null
  isTied: boolean
  /** Holes completed toward this competition, for thru display. */
  thru: number
  /** Primary integer result (strokes or points) when computable. */
  resultPrimary: number | null
  resultSecondary: number | null
  status: EntityStatus | 'provisional' | 'complete'
  provisional: boolean
}

export interface HoleResult {
  entityId: string
  holeId: string
  gross: number | null
  strokesReceived: number
  net: number | null
  /** Metric value relative to par when computable. */
  relativeToPar: number | null
  status: HoleScoreStatus
  provisional: boolean
}

export interface CompetitionProjection {
  eventRevision: number
  engineVersion: string
  rulesSchemaVersion: number
  provisional: boolean
  rows: LeaderboardRow[]
  holeResults: HoleResult[]
  /** Format-specific awards: skins winners, match results, etc. */
  awards: Record<string, unknown>
  warnings: EngineWarning[]
  hash: string
}
