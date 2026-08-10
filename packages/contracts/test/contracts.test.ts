import { describe, expect, it } from 'vitest'

import {
  submitScoreRequestSchema,
  submitScoreResponseSchema,
  scoreValueSchema,
} from '../src/api.ts'
import { ERROR_CODES, errorCodeSchema } from '../src/errors.ts'
import { rulesJsonSchema } from '../src/rules.ts'

// ── Fixtures ────────────────────────────────────────────────────────────────

const handicap = {
  profile: 'usga_whs_2024',
  allowance: 0.85,
  rounding: 'half_up_toward_positive_infinity',
  matchNormalizeFromLowest: false,
  allocation: 'stroke_index',
} as const

const common = {
  schemaVersion: 1,
  metric: 'net',
  holeScope: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  handicap,
  ties: { mode: 'tied', sequence: [] },
  incomplete: { live: 'provisional', final: 'no_return' },
  visibility: 'league',
} as const

const individualStroke = { format: 'individual_stroke', ...common } as const

const stableford = {
  format: 'stableford',
  ...common,
  metric: 'points',
  points: { '-3': 5, '-2': 4, '-1': 3, '0': 2, '1': 1, '2+': 0 },
} as const

const skins = {
  format: 'skins',
  ...common,
  skins: {
    population: 'field',
    carryMode: 'carry_forward',
    unitsPerHole: 1,
    finalCarry: 'expire',
  },
} as const

const scramble = {
  format: 'scramble',
  ...common,
  team: {
    teamSize: 4,
    bestK: 1,
    scoreSource: 'team_ball',
    weights: [0.25, 0.2, 0.15, 0.1],
  },
} as const

const aggregate = {
  format: 'aggregate',
  ...common,
  metric: 'gross',
  team: {
    teamSize: 4,
    bestK: 4,
    scoreSource: 'individual',
  },
} as const

const UUID_A = '5f0f6f5e-1111-4a2b-8c3d-9e8f7a6b5c4d'
const UUID_B = '5f0f6f5e-2222-4a2b-8c3d-9e8f7a6b5c4d'
const UUID_C = '5f0f6f5e-3333-4a2b-8c3d-9e8f7a6b5c4d'
const UUID_D = '5f0f6f5e-4444-4a2b-8c3d-9e8f7a6b5c4d'
const UUID_E = '5f0f6f5e-5555-4a2b-8c3d-9e8f7a6b5c4d'

const submitRequest = {
  idempotencyKey: UUID_A,
  eventId: UUID_B,
  roundId: UUID_C,
  target: { kind: 'individual', entryId: UUID_D, holeId: UUID_E },
  baseRevision: 3,
  value: { status: 'complete', grossStrokes: 5, notes: null },
  clientRecordedAt: '2026-08-09T14:03:00Z',
  clientRelease: '1.4.0',
} as const

// ── rules_json ──────────────────────────────────────────────────────────────

describe('rulesJsonSchema', () => {
  it('accepts a valid individual_stroke configuration', () => {
    const parsed = rulesJsonSchema.parse(individualStroke)
    expect(parsed.format).toBe('individual_stroke')
  })

  it('accepts a valid stableford configuration with a points map', () => {
    const parsed = rulesJsonSchema.parse(stableford)
    expect(parsed.format).toBe('stableford')
    if (parsed.format === 'stableford') {
      expect(parsed.points['2+']).toBe(0)
    }
  })

  it('accepts a valid skins configuration', () => {
    expect(rulesJsonSchema.safeParse(skins).success).toBe(true)
  })

  it('accepts a valid scramble configuration with team weights', () => {
    expect(rulesJsonSchema.safeParse(scramble).success).toBe(true)
  })

  it('rejects scramble rules without one team-ball weight per member', () => {
    expect(rulesJsonSchema.safeParse({
      ...scramble,
      team: { ...scramble.team, scoreSource: 'individual' },
    }).success).toBe(false)
    expect(rulesJsonSchema.safeParse({
      ...scramble,
      team: { ...scramble.team, weights: [0.35, 0.15] },
    }).success).toBe(false)
  })

  it('accepts explicit hole-level all-scores-count team aggregate rules', () => {
    expect(rulesJsonSchema.safeParse(aggregate).success).toBe(true)
  })

  it('accepts par_bogey with a points map and match with common fields only', () => {
    const parBogey = {
      format: 'par_bogey',
      ...common,
      metric: 'points',
      points: { '-1': 1, '0': 0, '1+': -1 },
    }
    const match = { format: 'match', ...common }
    expect(rulesJsonSchema.safeParse(parBogey).success).toBe(true)
    expect(rulesJsonSchema.safeParse(match).success).toBe(true)
  })

  it('accepts committee_custom rounding as a structured object', () => {
    const custom = {
      ...individualStroke,
      handicap: {
        ...handicap,
        profile: 'committee_custom',
        rounding: {
          kind: 'committee_custom',
          intermediatePrecision: 1,
          tieDirection: 'up',
          stepOrder: 'allowance_then_round',
        },
      },
    }
    expect(rulesJsonSchema.safeParse(custom).success).toBe(true)
  })

  it('rejects unknown top-level fields', () => {
    expect(
      rulesJsonSchema.safeParse({ ...individualStroke, mulligans: 2 }).success,
    ).toBe(false)
  })

  it('rejects irrelevant format-specific fields on other formats', () => {
    // skins config on individual_stroke: irrelevant, must be rejected.
    expect(
      rulesJsonSchema.safeParse({ ...individualStroke, skins: skins.skins })
        .success,
    ).toBe(false)
    // team config on stableford: irrelevant, must be rejected.
    expect(
      rulesJsonSchema.safeParse({ ...stableford, team: scramble.team }).success,
    ).toBe(false)
    // points map on skins: irrelevant, must be rejected.
    expect(
      rulesJsonSchema.safeParse({ ...skins, points: stableford.points }).success,
    ).toBe(false)
  })

  it('rejects unknown fields nested inside strict sub-objects', () => {
    expect(
      rulesJsonSchema.safeParse({
        ...individualStroke,
        handicap: { ...handicap, slopeOverride: 130 },
      }).success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({
        ...skins,
        skins: { ...skins.skins, jackpot: true },
      }).success,
    ).toBe(false)
  })

  it('rejects missing required format-specific fields', () => {
    const { points: _points, ...stablefordNoPoints } = stableford
    const { team: _team, ...scrambleNoTeam } = scramble
    expect(rulesJsonSchema.safeParse(stablefordNoPoints).success).toBe(false)
    expect(rulesJsonSchema.safeParse(scrambleNoTeam).success).toBe(false)
  })

  it('rejects invalid enum values', () => {
    expect(
      rulesJsonSchema.safeParse({ ...individualStroke, format: 'four_ball' })
        .success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({ ...individualStroke, metric: 'stableford' })
        .success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({ ...individualStroke, visibility: 'everyone' })
        .success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({
        ...individualStroke,
        handicap: { ...handicap, profile: 'ghin' },
      }).success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({
        ...individualStroke,
        ties: { mode: 'coin_flip', sequence: [] },
      }).success,
    ).toBe(false)
  })

  it('rejects wrong schemaVersion and out-of-range values', () => {
    expect(
      rulesJsonSchema.safeParse({ ...individualStroke, schemaVersion: 2 })
        .success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({
        ...individualStroke,
        handicap: { ...handicap, allowance: 2.5 },
      }).success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({ ...individualStroke, holeScope: [0] }).success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({ ...individualStroke, holeScope: [1.5] })
        .success,
    ).toBe(false)
  })

  it('rejects malformed points keys and empty points maps', () => {
    expect(
      rulesJsonSchema.safeParse({ ...stableford, points: { eagle: 4 } }).success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({ ...stableford, points: { '0': 2.5 } }).success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({ ...stableford, points: {} }).success,
    ).toBe(false)
  })

  it('rejects invalid skins and team configurations', () => {
    expect(
      rulesJsonSchema.safeParse({
        ...skins,
        skins: { ...skins.skins, unitsPerHole: 0 },
      }).success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({
        ...skins,
        skins: { ...skins.skins, carryMode: 'rollover' },
      }).success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({
        ...scramble,
        team: { ...scramble.team, bestK: 5 },
      }).success,
    ).toBe(false)
    expect(
      rulesJsonSchema.safeParse({
        ...aggregate,
        team: { ...aggregate.team, scoreSource: 'team_ball' },
      }).success,
    ).toBe(false)
  })
})

// ── Score value (spec §4.5) ─────────────────────────────────────────────────

describe('scoreValueSchema', () => {
  it('accepts complete with gross strokes and terminal statuses without', () => {
    expect(
      scoreValueSchema.safeParse({ status: 'complete', grossStrokes: 5, notes: null })
        .success,
    ).toBe(true)
    expect(
      scoreValueSchema.safeParse({ status: 'picked_up', notes: 'ball lost' })
        .success,
    ).toBe(true)
    expect(
      scoreValueSchema.safeParse({ status: 'no_score', notes: null }).success,
    ).toBe(true)
  })

  it('rejects grossStrokes 0 (spec: 0 is invalid)', () => {
    expect(
      scoreValueSchema.safeParse({ status: 'complete', grossStrokes: 0, notes: null })
        .success,
    ).toBe(false)
  })

  it('rejects grossStrokes above 25 and non-integers', () => {
    expect(
      scoreValueSchema.safeParse({ status: 'complete', grossStrokes: 26, notes: null })
        .success,
    ).toBe(false)
    expect(
      scoreValueSchema.safeParse({ status: 'complete', grossStrokes: 4.5, notes: null })
        .success,
    ).toBe(false)
  })

  it('rejects complete without grossStrokes', () => {
    expect(
      scoreValueSchema.safeParse({ status: 'complete', notes: null }).success,
    ).toBe(false)
  })

  it('rejects every terminal status combined with grossStrokes', () => {
    for (const status of [
      'picked_up',
      'conceded',
      'not_played',
      'no_score',
      'withdrawn',
      'disqualified',
    ]) {
      expect(
        scoreValueSchema.safeParse({ status, grossStrokes: 5, notes: null })
          .success,
      ).toBe(false)
    }
  })

  it('rejects invalid status values and unknown fields', () => {
    expect(
      scoreValueSchema.safeParse({ status: 'done', grossStrokes: 5, notes: null })
        .success,
    ).toBe(false)
    expect(
      scoreValueSchema.safeParse({
        status: 'complete',
        grossStrokes: 5,
        notes: null,
        penalty: 2,
      }).success,
    ).toBe(false)
  })
})

// ── submit-score request/response (spec §12.3) ──────────────────────────────

describe('submitScoreRequestSchema', () => {
  it('accepts a valid individual-target request', () => {
    expect(submitScoreRequestSchema.safeParse(submitRequest).success).toBe(true)
  })

  it('accepts a valid team-target request with offset timestamp', () => {
    const teamRequest = {
      ...submitRequest,
      target: { kind: 'team', teamId: UUID_D, holeId: UUID_E },
      clientRecordedAt: '2026-08-09T14:03:00.250-04:00',
      clientRelease: '1.4.0-beta.2+build.7',
    }
    expect(submitScoreRequestSchema.safeParse(teamRequest).success).toBe(true)
  })

  it('rejects unknown fields at every level', () => {
    expect(
      submitScoreRequestSchema.safeParse({ ...submitRequest, deviceId: 'abc' })
        .success,
    ).toBe(false)
    expect(
      submitScoreRequestSchema.safeParse({
        ...submitRequest,
        target: { ...submitRequest.target, teamId: UUID_A },
      }).success,
    ).toBe(false)
  })

  it('rejects target kind/id mismatches and invalid uuids', () => {
    expect(
      submitScoreRequestSchema.safeParse({
        ...submitRequest,
        target: { kind: 'team', entryId: UUID_D, holeId: UUID_E },
      }).success,
    ).toBe(false)
    expect(
      submitScoreRequestSchema.safeParse({
        ...submitRequest,
        idempotencyKey: 'not-a-uuid',
      }).success,
    ).toBe(false)
  })

  it('rejects negative or fractional baseRevision', () => {
    expect(
      submitScoreRequestSchema.safeParse({ ...submitRequest, baseRevision: -1 })
        .success,
    ).toBe(false)
    expect(
      submitScoreRequestSchema.safeParse({ ...submitRequest, baseRevision: 1.5 })
        .success,
    ).toBe(false)
  })

  it('rejects malformed timestamps and releases', () => {
    expect(
      submitScoreRequestSchema.safeParse({
        ...submitRequest,
        clientRecordedAt: 'yesterday',
      }).success,
    ).toBe(false)
    expect(
      submitScoreRequestSchema.safeParse({
        ...submitRequest,
        clientRelease: 'v1.4',
      }).success,
    ).toBe(false)
  })

  it('enforces the §4.5 value rules inside the request', () => {
    expect(
      submitScoreRequestSchema.safeParse({
        ...submitRequest,
        value: { status: 'complete', grossStrokes: 0, notes: null },
      }).success,
    ).toBe(false)
    expect(
      submitScoreRequestSchema.safeParse({
        ...submitRequest,
        value: { status: 'conceded', grossStrokes: 4, notes: null },
      }).success,
    ).toBe(false)
  })
})

describe('submitScoreResponseSchema', () => {
  const response = {
    status: 'committed',
    scoreRevision: 4,
    eventRevision: 17,
    projectionRevision: 9,
    errorCode: null,
    correlationId: 'req_01H',
  } as const

  it('accepts a committed response and a rejected response with error code', () => {
    expect(submitScoreResponseSchema.safeParse(response).success).toBe(true)
    expect(
      submitScoreResponseSchema.safeParse({
        ...response,
        status: 'rejected',
        projectionRevision: null,
        errorCode: 'BASE_REVISION_STALE',
      }).success,
    ).toBe(true)
  })

  it('rejects invalid status, invalid error codes, and unknown fields', () => {
    expect(
      submitScoreResponseSchema.safeParse({ ...response, status: 'ok' }).success,
    ).toBe(false)
    expect(
      submitScoreResponseSchema.safeParse({
        ...response,
        errorCode: 'SOMETHING_ELSE',
      }).success,
    ).toBe(false)
    expect(
      submitScoreResponseSchema.safeParse({ ...response, retryAfter: 5 }).success,
    ).toBe(false)
  })
})

describe('errorCodeSchema', () => {
  it('accepts exactly the ten §12.4 codes', () => {
    expect(ERROR_CODES).toHaveLength(10)
    for (const code of ERROR_CODES) {
      expect(errorCodeSchema.safeParse(code).success).toBe(true)
    }
    expect(errorCodeSchema.safeParse('EVENT_UNLOCKED').success).toBe(false)
  })
})
