/**
 * Skins (spec §8.7; edge cases §21.1; golden vectors §20.2).
 *
 * Skins operate on a defined population and a hole metric computed upstream
 * (gross, individual net, or team result): each `SkinsEntryHole.score` is the
 * already-resolved metric value for that entity on that hole. Skins values
 * are UNITS, never money — the engine never calculates wagers or settles
 * funds.
 *
 * Holes are processed strictly in published competition order (ordinal). On
 * each hole the pool is the carried-in units plus `rules.unitsPerHole`.
 *
 *  - Entries with `eligible === false` are excluded entirely under the frozen
 *    rule; they never win, never block completeness, and never appear in
 *    totals.
 *  - A hole with `terminal === true` (pickup / no-score under the frozen
 *    rule) is resolved but can never win the hole, even if a numeric score
 *    was recorded for it.
 *  - A hole where any eligible entity has `score === null` with
 *    `terminal === false` is incomplete: it is 'provisional', nothing is
 *    awarded, and every subsequent hole is also 'provisional' because the
 *    pool state downstream is unknowable (spec §21.1 "skins participant
 *    incomplete"). The first provisional hole records the real carried-in
 *    pool; later provisional holes report `poolCarriedIn` 0 because no
 *    resolved carried value exists for them.
 *  - Unique low among the non-terminal eligible entities wins the whole pool
 *    ('won'). A tied low — or a hole with no winnable score at all — applies
 *    `rules.carryMode`:
 *      carry_forward (default): pool moves to the next hole ('carried');
 *      no_carry: pool expires into `unawardedUnits` ('expired');
 *      split_tied: the pool is divided equally ONLY when
 *        `rules.fractionalUnits` is enabled AND the pool divides into whole
 *        units among the tied entities — only integer unit amounts are ever
 *        represented ('split', `unitsAwarded` is the per-winner amount,
 *        `winnerId` null because there are multiple winners); otherwise the
 *        pool expires with warning SKINS_SPLIT_UNAVAILABLE.
 *
 * A pool still carried after the last resolved hole follows the frozen
 * `rules.finalCarry` policy — never a guess (spec §21.1):
 *  - expire (default): pool stays visible in `unawardedUnits`;
 *  - award_last_unique_winner: the most recent 'won' hole's winner collects
 *    the pool (appended to that winner's total; hole outcomes are not
 *    rewritten); with no unique winner all round, the pool expires with
 *    warning SKINS_NO_UNIQUE_WINNER;
 *  - split_final_tied: the pool splits among the final hole's tied lows
 *    under the same integer-division constraint (whole units each);
 *    otherwise it expires with warning SKINS_SPLIT_UNAVAILABLE;
 *  - sudden_death: the pool stays in `unawardedUnits` with warning
 *    SKINS_SUDDEN_DEATH_PENDING for manual Committee resolution.
 * The frozen policy determines the end state as soon as every hole has
 * resolved, so it applies in both phases; a provisional cascade suppresses
 * it because the surviving pool is unknowable. In the 'final' phase a
 * provisional cascade additionally emits SKINS_FINAL_INCOMPLETE, since
 * finalization must not proceed with missing required scores (spec AC-009).
 */

import type { EngineWarning, HoleSnapshot, SkinsRules } from '../types.ts'

export interface SkinsEntryHole {
  holeId: string
  /** Upstream hole metric score (gross or net); null when not yet known. */
  score: number | null
  /** Resolved under the frozen rule (pickup/no-score); cannot win the hole. */
  terminal: boolean
}

export interface SkinsEntry {
  entityId: string
  /** false: excluded entirely under the frozen rule (withdrawn/ineligible). */
  eligible: boolean
  holeScores: SkinsEntryHole[]
}

export interface SkinsInput {
  holes: HoleSnapshot[]
  entries: SkinsEntry[]
  rules: SkinsRules
  phase: 'live' | 'final'
}

export interface SkinsHoleOutcome {
  holeId: string
  status: 'won' | 'carried' | 'expired' | 'split' | 'provisional'
  /** Set only for 'won'; a 'split' has multiple winners, so null. */
  winnerId: string | null
  /** Whole pool for 'won'; per-winner units for 'split'; otherwise 0. */
  unitsAwarded: number
  /** Units carried into this hole (excludes this hole's own increment). */
  poolCarriedIn: number
}

export interface SkinsResult {
  holeOutcomes: SkinsHoleOutcome[]
  /** One row per eligible entry, in input order. Units, never money. */
  totals: Array<{ entityId: string; units: number }>
  /** Expired pools plus any pool pending sudden-death resolution. */
  unawardedUnits: number
  warnings: EngineWarning[]
  provisional: boolean
}

interface HoleField {
  /** Entities able to win the hole (eligible, non-terminal, numeric score). */
  candidates: Array<{ entityId: string; score: number }>
  /** True when an eligible entity's required score is still missing. */
  incomplete: boolean
}

export function calculateSkins(input: SkinsInput): SkinsResult {
  validateRules(input.rules)
  const holes = orderedHoles(input.holes)
  const eligible = input.entries.filter((entry) => entry.eligible)
  const scoresByEntity = indexScores(eligible)

  const totals = new Map<string, number>(
    eligible.map((entry) => [entry.entityId, 0]),
  )
  const warnings: EngineWarning[] = []
  const holeOutcomes: SkinsHoleOutcome[] = []
  let carry = 0
  let unawardedUnits = 0
  let cascading = false
  let suddenDeathPending = false
  /** Winner of the most recent 'won' hole (for award_last_unique_winner). */
  let lastUniqueWinnerId: string | null = null
  /** Tied lows of the most recent 'carried' hole (for split_final_tied). */
  let carriedTiedLowIds: string[] = []

  for (const hole of holes) {
    if (cascading) {
      // Pool state downstream of an incomplete hole is unknowable.
      holeOutcomes.push(provisionalOutcome(hole.id, 0))
      continue
    }
    const poolCarriedIn = carry
    const field = fieldForHole(hole, eligible, scoresByEntity)
    if (field.incomplete) {
      cascading = true
      holeOutcomes.push(provisionalOutcome(hole.id, poolCarriedIn))
      continue
    }
    const pool = carry + input.rules.unitsPerHole
    const tiedLowIds = lowestScorers(field.candidates)
    if (tiedLowIds.length === 1) {
      const winnerId = tiedLowIds[0]
      if (winnerId === undefined) throw new RangeError('unreachable')
      addUnits(totals, winnerId, pool)
      carry = 0
      lastUniqueWinnerId = winnerId
      holeOutcomes.push({
        holeId: hole.id,
        status: 'won',
        winnerId,
        unitsAwarded: pool,
        poolCarriedIn,
      })
      continue
    }
    // Tied low — or no winnable score at all — under the frozen carry mode.
    switch (input.rules.carryMode) {
      case 'carry_forward':
        carry = pool
        carriedTiedLowIds = tiedLowIds
        holeOutcomes.push({
          holeId: hole.id,
          status: 'carried',
          winnerId: null,
          unitsAwarded: 0,
          poolCarriedIn,
        })
        break
      case 'no_carry':
        carry = 0
        unawardedUnits += pool
        holeOutcomes.push({
          holeId: hole.id,
          status: 'expired',
          winnerId: null,
          unitsAwarded: 0,
          poolCarriedIn,
        })
        break
      case 'split_tied': {
        carry = 0
        if (input.rules.fractionalUnits && dividesEvenly(pool, tiedLowIds)) {
          const perWinner = pool / tiedLowIds.length
          for (const entityId of tiedLowIds) {
            addUnits(totals, entityId, perWinner)
          }
          holeOutcomes.push({
            holeId: hole.id,
            status: 'split',
            winnerId: null,
            unitsAwarded: perWinner,
            poolCarriedIn,
          })
        } else {
          warnings.push(splitUnavailable(hole.id, pool, tiedLowIds.length))
          unawardedUnits += pool
          holeOutcomes.push({
            holeId: hole.id,
            status: 'expired',
            winnerId: null,
            unitsAwarded: 0,
            poolCarriedIn,
          })
        }
        break
      }
    }
  }

  if (cascading && input.phase === 'final') {
    warnings.push({
      code: 'SKINS_FINAL_INCOMPLETE',
      message:
        'finalized skins competition still has missing required scores; ' +
        'results remain provisional',
    })
  }

  if (!cascading && carry > 0) {
    suddenDeathPending = input.rules.finalCarry === 'sudden_death'
    unawardedUnits += resolveFinalCarry(
      carry,
      input.rules,
      totals,
      lastUniqueWinnerId,
      carriedTiedLowIds,
      warnings,
    )
  }

  return {
    holeOutcomes,
    totals: eligible.map((entry) => ({
      entityId: entry.entityId,
      units: totals.get(entry.entityId) ?? 0,
    })),
    unawardedUnits,
    warnings,
    provisional: cascading || suddenDeathPending,
  }
}

/**
 * Resolve a pool still carried after the last resolved hole per the frozen
 * finalCarry rule. Returns the units that remain unawarded.
 */
function resolveFinalCarry(
  carry: number,
  rules: SkinsRules,
  totals: Map<string, number>,
  lastUniqueWinnerId: string | null,
  finalHoleTiedLowIds: string[],
  warnings: EngineWarning[],
): number {
  switch (rules.finalCarry) {
    case 'expire':
      // Default: the pool stays visible as unawarded units.
      return carry
    case 'sudden_death':
      warnings.push({
        code: 'SKINS_SUDDEN_DEATH_PENDING',
        message:
          `final carried pool of ${carry} units awaits sudden-death ` +
          'resolution recorded manually by the Committee',
        context: { units: carry },
      })
      return carry
    case 'award_last_unique_winner': {
      if (lastUniqueWinnerId !== null) {
        addUnits(totals, lastUniqueWinnerId, carry)
        return 0
      }
      warnings.push({
        code: 'SKINS_NO_UNIQUE_WINNER',
        message:
          `no hole produced a unique winner; final carried pool of ${carry} ` +
          'units expires',
        context: { units: carry },
      })
      return carry
    }
    case 'split_final_tied': {
      // A surviving carry means the final hole was 'carried', so the tied
      // lows recorded for it are the final hole's tied lows.
      if (dividesEvenly(carry, finalHoleTiedLowIds)) {
        const perWinner = carry / finalHoleTiedLowIds.length
        for (const entityId of finalHoleTiedLowIds) {
          addUnits(totals, entityId, perWinner)
        }
        return 0
      }
      warnings.push(splitUnavailable(null, carry, finalHoleTiedLowIds.length))
      return carry
    }
  }
}

function fieldForHole(
  hole: HoleSnapshot,
  eligible: readonly SkinsEntry[],
  scoresByEntity: Map<string, Map<string, SkinsEntryHole>>,
): HoleField {
  const candidates: Array<{ entityId: string; score: number }> = []
  let incomplete = false
  for (const entry of eligible) {
    const holeScore = scoresByEntity.get(entry.entityId)?.get(hole.id)
    // A hole with no recorded fact is missing data, never coerced to zero.
    if (holeScore === undefined) {
      incomplete = true
      continue
    }
    // Terminal holes are resolved but cannot win, whatever was recorded.
    if (holeScore.terminal) continue
    if (holeScore.score === null) {
      incomplete = true
      continue
    }
    candidates.push({ entityId: entry.entityId, score: holeScore.score })
  }
  return { candidates, incomplete }
}

/** Entity ids sharing the lowest score; empty when no one can win the hole. */
function lowestScorers(
  candidates: ReadonlyArray<{ entityId: string; score: number }>,
): string[] {
  let low: number | null = null
  for (const candidate of candidates) {
    if (low === null || candidate.score < low) low = candidate.score
  }
  const lowest = low
  if (lowest === null) return []
  return candidates
    .filter((candidate) => candidate.score === lowest)
    .map((candidate) => candidate.entityId)
}

function provisionalOutcome(
  holeId: string,
  poolCarriedIn: number,
): SkinsHoleOutcome {
  return {
    holeId,
    status: 'provisional',
    winnerId: null,
    unitsAwarded: 0,
    poolCarriedIn,
  }
}

/** True when the pool divides into whole units among the tied entities. */
function dividesEvenly(pool: number, tiedIds: readonly string[]): boolean {
  return tiedIds.length > 0 && pool % tiedIds.length === 0
}

function splitUnavailable(
  holeId: string | null,
  pool: number,
  tiedCount: number,
): EngineWarning {
  const where = holeId === null ? 'final carried pool' : `hole ${holeId}`
  const warning: EngineWarning = {
    code: 'SKINS_SPLIT_UNAVAILABLE',
    message:
      `${where} of ${pool} units cannot split into whole units among ` +
      `${tiedCount} tied entities; the pool expires`,
    context: { units: pool, tied: tiedCount },
  }
  if (holeId !== null) {
    warning.context = { ...warning.context, holeId }
  }
  return warning
}

function addUnits(
  totals: Map<string, number>,
  entityId: string,
  units: number,
): void {
  totals.set(entityId, (totals.get(entityId) ?? 0) + units)
}

/** Published competition order; duplicate hole ids are a snapshot defect. */
function orderedHoles(holes: readonly HoleSnapshot[]): HoleSnapshot[] {
  const seen = new Set<string>()
  for (const hole of holes) {
    if (seen.has(hole.id)) {
      throw new RangeError(`duplicate hole id '${hole.id}' in snapshot`)
    }
    seen.add(hole.id)
  }
  return [...holes].sort((a, b) => a.ordinal - b.ordinal)
}

/**
 * Index each eligible entry's hole scores by hole id. A repeated holeId
 * within one entry keeps the last fact (earlier rows are superseded).
 */
function indexScores(
  eligible: readonly SkinsEntry[],
): Map<string, Map<string, SkinsEntryHole>> {
  const byEntity = new Map<string, Map<string, SkinsEntryHole>>()
  for (const entry of eligible) {
    if (byEntity.has(entry.entityId)) {
      throw new RangeError(`duplicate eligible entity '${entry.entityId}'`)
    }
    const byHole = new Map<string, SkinsEntryHole>()
    for (const holeScore of entry.holeScores) {
      if (
        holeScore.score !== null &&
        !Number.isInteger(holeScore.score)
      ) {
        throw new RangeError(
          `entity ${entry.entityId} hole ${holeScore.holeId} score ` +
            `${holeScore.score} is not an integer`,
        )
      }
      byHole.set(holeScore.holeId, holeScore)
    }
    byEntity.set(entry.entityId, byHole)
  }
  return byEntity
}

function validateRules(rules: SkinsRules): void {
  if (!Number.isInteger(rules.unitsPerHole) || rules.unitsPerHole < 1) {
    throw new RangeError(
      `unitsPerHole must be a positive integer, got ${rules.unitsPerHole}`,
    )
  }
}
