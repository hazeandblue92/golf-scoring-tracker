/**
 * rules_json schema (spec §6.1, Appendix A).
 *
 * A Zod discriminated union on `format` built from strict objects, so
 * irrelevant or unknown fields are REJECTED, not ignored (Appendix A:
 * "Production schemas use discriminated unions so irrelevant fields are
 * rejected, not ignored").
 */

import { z } from 'zod'

// ── Shared component schemas ────────────────────────────────────────────────

/** Committee-defined rounding profile (mirrors engine RoundingProfileCustom). */
export const committeeCustomRoundingSchema = z.strictObject({
  kind: z.literal('committee_custom'),
  /** Decimal places retained at intermediate steps; final step rounds to 0. */
  intermediatePrecision: z.number().int().min(0),
  tieDirection: z.enum(['up', 'down', 'toward_zero', 'away_from_zero']),
  stepOrder: z.enum(['allowance_then_round', 'round_then_allowance']),
})

/** Appendix A `handicap.rounding`: the WHS default token or a custom profile. */
export const handicapRoundingSchema = z.union([
  z.literal('half_up_toward_positive_infinity'),
  committeeCustomRoundingSchema,
])

export const handicapConfigSchema = z.strictObject({
  profile: z.enum(['usga_whs_2024', 'committee_custom', 'none']),
  /** Allowance fraction, e.g. 0.85; ignored when profile is 'none'. */
  allowance: z.number().min(0).max(2),
  rounding: handicapRoundingSchema,
  matchNormalizeFromLowest: z.boolean(),
  allocation: z.literal('stroke_index'),
})

/**
 * Multi-round aggregation (§8.14): "sum of stroke totals, sum of points, match
 * points table, and best r of n rounds".
 *
 * This lives in rules_json, not on competition_rounds, because it is one
 * decision for the whole competition rather than a property of each round —
 * and because rules_json is what publish freezes. Per-round WEIGHT genuinely
 * is per round and stays on competition_rounds.
 */
export const multiRoundConfigSchema = z
  .strictObject({
    aggregation: z.enum(['sum', 'best_r_of_n', 'match_points']),
    /** Rounds that count. Required for best_r_of_n, meaningless otherwise. */
    count: z.number().int().min(1).optional(),
  })
  .refine(
    (config) => config.aggregation !== 'best_r_of_n' || config.count !== undefined,
    { message: 'best_r_of_n requires the number of rounds to count', path: ['count'] },
  )
  .refine(
    (config) => config.aggregation === 'best_r_of_n' || config.count === undefined,
    { message: 'count applies only to best_r_of_n', path: ['count'] },
  )

export const tiesConfigSchema = z.strictObject({
  mode: z.enum(['tied', 'countback', 'playoff']),
  /** Countback segments in order, e.g. ['last_9','last_6','last_3','hole_18']. */
  sequence: z.array(z.string()),
})

export const incompleteConfigSchema = z.strictObject({
  live: z.literal('provisional'),
  final: z.literal('no_return'),
})

export const teamConfigSchema = z
  .strictObject({
    teamSize: z.number().int().min(1),
    /** best_k_of_m: number of counting scores per hole. */
    bestK: z.number().int().min(1),
    scoreSource: z.enum(['individual', 'team_ball']),
    /** Scramble-style handicap weights (low to high), e.g. [0.35, 0.15]. */
    weights: z.array(z.number().min(0).max(1)).optional(),
  })
  .refine((team) => team.bestK <= team.teamSize, {
    message: 'bestK must not exceed teamSize',
    path: ['bestK'],
  })

/** Team aggregate is calculated from each member's individual hole score. */
export const aggregateTeamConfigSchema = teamConfigSchema.refine(
  (team) => team.scoreSource === 'individual',
  {
    message: 'team aggregate requires individual scoreSource',
    path: ['scoreSource'],
  },
)

/** Match team sides are either one team ball or the best one individual ball. */
export const matchTeamConfigSchema = teamConfigSchema.refine(
  (team) => team.bestK === 1,
  {
    message: 'match team scoring requires bestK 1',
    path: ['bestK'],
  },
)

/** Scramble records one team ball and freezes one weight per team member. */
export const scrambleTeamConfigSchema = z
  .strictObject({
    teamSize: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    bestK: z.literal(1),
    scoreSource: z.literal('team_ball'),
    weights: z.array(z.number().min(0).max(1)).min(2).max(4),
  })
  .refine((team) => team.weights.length === team.teamSize, {
    message: 'scramble requires one weight per team member',
    path: ['weights'],
  })

/**
 * Points map keyed by relation to par: a signed integer ('-3'..'2') or a
 * nonnegative integer with a trailing '+' meaning "this relation and worse"
 * (Appendix A example: { "-3": 5, "-2": 4, "-1": 3, "0": 2, "1": 1, "2+": 0 }).
 */
export const pointsConfigSchema = z
  .record(z.string().regex(/^(-?\d+|\d+\+)$/), z.number().int())
  .refine((points) => Object.keys(points).length > 0, {
    message: 'points map requires at least one relation entry',
  })

export const skinsConfigSchema = z.strictObject({
  population: z.enum(['field', 'flight', 'group', 'teams']),
  carryMode: z.enum(['carry_forward', 'no_carry', 'split_tied']),
  unitsPerHole: z.number().int().min(1),
  finalCarry: z.enum([
    'split_final_tied',
    'award_last_unique_winner',
    'expire',
    'sudden_death',
  ]),
  /** Fractional units for split_tied; off by default (spec §8.7). */
  fractionalUnits: z.boolean().optional(),
})

// ── Common fields shared by every format variant ────────────────────────────

const commonFields = {
  schemaVersion: z.literal(1),
  metric: z.enum(['gross', 'net', 'points']),
  /** Ordinals of competition holes within the round's published order. */
  holeScope: z.array(z.number().int().min(1)).min(1),
  handicap: handicapConfigSchema,
  ties: tiesConfigSchema,
  incomplete: incompleteConfigSchema,
  visibility: z.enum(['league', 'public', 'organizers']),
  /** Present only when the competition spans more than one round (§8.14). */
  multiRound: multiRoundConfigSchema.optional(),
  /**
   * Flighted ranking. 'per_flight' ranks entrants within their own flight or
   * division so each flight has its own rank 1; 'none' ranks the whole field.
   * Omitted behaves as 'none' so existing frozen rules keep their meaning.
   */
  flighting: z.enum(['none', 'per_flight']).optional(),
} as const

// ── Format variants ─────────────────────────────────────────────────────────

export const individualStrokeRulesSchema = z.strictObject({
  format: z.literal('individual_stroke'),
  ...commonFields,
})

export const bestKRulesSchema = z.strictObject({
  format: z.literal('best_k'),
  ...commonFields,
  team: teamConfigSchema,
})

export const stablefordRulesSchema = z.strictObject({
  format: z.literal('stableford'),
  ...commonFields,
  points: pointsConfigSchema,
})

export const matchRulesSchema = z.strictObject({
  format: z.literal('match'),
  ...commonFields,
  /** Required at runtime when either pairing side is a team entity. */
  team: matchTeamConfigSchema.optional(),
})

export const skinsRulesSchema = z.strictObject({
  format: z.literal('skins'),
  ...commonFields,
  skins: skinsConfigSchema,
})

export const scrambleRulesSchema = z.strictObject({
  format: z.literal('scramble'),
  ...commonFields,
  team: scrambleTeamConfigSchema,
})

export const foursomesRulesSchema = z.strictObject({
  format: z.literal('foursomes'),
  ...commonFields,
  team: teamConfigSchema,
})

export const greensomesRulesSchema = z.strictObject({
  format: z.literal('greensomes'),
  ...commonFields,
  team: teamConfigSchema,
})

export const chapmanRulesSchema = z.strictObject({
  format: z.literal('chapman'),
  ...commonFields,
  team: teamConfigSchema,
})

/**
 * Shamble (§8.11): after the selected drive every player finishes their own
 * ball, so the competition is scored from EXPLICIT INDIVIDUAL hole scores as
 * best k of m or team aggregate. A team_ball source would contradict the
 * format — there is no single team ball after the drive.
 */
export const shambleTeamConfigSchema = teamConfigSchema.refine(
  (team) => team.scoreSource === 'individual',
  {
    message: 'shamble is scored from individual hole scores, not a team ball',
    path: ['scoreSource'],
  },
)

export const shambleRulesSchema = z.strictObject({
  format: z.literal('shamble'),
  ...commonFields,
  team: shambleTeamConfigSchema,
})

export const parBogeyRulesSchema = z.strictObject({
  format: z.literal('par_bogey'),
  ...commonFields,
  points: pointsConfigSchema,
})

export const aggregateRulesSchema = z.strictObject({
  format: z.literal('aggregate'),
  ...commonFields,
  team: aggregateTeamConfigSchema,
})

// ── rules_json discriminated union ──────────────────────────────────────────

export const rulesJsonSchema = z.discriminatedUnion('format', [
  individualStrokeRulesSchema,
  bestKRulesSchema,
  stablefordRulesSchema,
  matchRulesSchema,
  skinsRulesSchema,
  scrambleRulesSchema,
  foursomesRulesSchema,
  greensomesRulesSchema,
  chapmanRulesSchema,
  shambleRulesSchema,
  parBogeyRulesSchema,
  aggregateRulesSchema,
])

// ── Inferred types ──────────────────────────────────────────────────────────

export type CommitteeCustomRounding = z.infer<typeof committeeCustomRoundingSchema>
export type HandicapRounding = z.infer<typeof handicapRoundingSchema>
export type HandicapConfig = z.infer<typeof handicapConfigSchema>
export type TiesConfig = z.infer<typeof tiesConfigSchema>
export type IncompleteConfig = z.infer<typeof incompleteConfigSchema>
export type TeamConfig = z.infer<typeof teamConfigSchema>
export type PointsConfig = z.infer<typeof pointsConfigSchema>
export type SkinsConfig = z.infer<typeof skinsConfigSchema>
export type RulesJson = z.infer<typeof rulesJsonSchema>
export type RulesFormat = RulesJson['format']
