/**
 * Stroke allocation by stroke index (spec §9.5).
 *
 * For N competition holes and signed integer Playing Handicap H:
 *
 * Receiving (H > 0):
 *   base = floor(H / N); remainder = H mod N
 *   strokes_received(hole) = base + (stroke_index <= remainder ? 1 : 0)
 *
 * Giving (H < 0, plus player):
 *   magnitude = |H|; base = floor(magnitude / N); remainder = magnitude mod N
 *   extra_given = stroke_index > N - remainder ? 1 : 0
 *   strokes_received(hole) = -(base + extra_given)
 *
 * A plus-2 player over 18 holes therefore gives strokes at indexes 18 and 17.
 * Handicaps larger than N allocate multiple full cycles via `base`.
 */

import type { HoleSnapshot } from '../types.ts'

export function strokesReceivedOnHole(
  playingHandicap: number,
  holeCount: number,
  strokeIndex: number,
): number {
  if (!Number.isInteger(playingHandicap)) {
    throw new RangeError(`playing handicap must be a signed integer, got ${playingHandicap}`)
  }
  if (holeCount < 1 || strokeIndex < 1 || strokeIndex > holeCount) {
    throw new RangeError(
      `stroke index ${strokeIndex} out of range for ${holeCount} holes`,
    )
  }
  if (playingHandicap === 0) return 0
  if (playingHandicap > 0) {
    const base = Math.floor(playingHandicap / holeCount)
    const remainder = playingHandicap % holeCount
    return base + (strokeIndex <= remainder ? 1 : 0)
  }
  const magnitude = -playingHandicap
  const base = Math.floor(magnitude / holeCount)
  const remainder = magnitude % holeCount
  const extraGiven = strokeIndex > holeCount - remainder ? 1 : 0
  const given = base + extraGiven
  return given === 0 ? 0 : -given
}

/**
 * Allocate a Playing Handicap across the competition holes. The hole set must
 * carry a stroke-index permutation of 1..N for this allocation set; a
 * competition subset uses its own purpose-built allocation (spec §9.5) and is
 * validated before it reaches the engine.
 */
export function allocateStrokes(
  playingHandicap: number,
  holes: readonly HoleSnapshot[],
): Map<string, number> {
  assertStrokeIndexPermutation(holes)
  const result = new Map<string, number>()
  for (const hole of holes) {
    result.set(
      hole.id,
      strokesReceivedOnHole(playingHandicap, holes.length, hole.strokeIndex),
    )
  }
  return result
}

/** Spec §4.3/§6.3: stroke indexes must be a permutation of 1..N. */
export function assertStrokeIndexPermutation(
  holes: readonly HoleSnapshot[],
): void {
  const seen = new Set<number>()
  for (const hole of holes) {
    if (
      !Number.isInteger(hole.strokeIndex) ||
      hole.strokeIndex < 1 ||
      hole.strokeIndex > holes.length ||
      seen.has(hole.strokeIndex)
    ) {
      throw new RangeError(
        `stroke indexes must be a permutation of 1..${holes.length}; ` +
          `offending hole ${hole.id} with index ${hole.strokeIndex}`,
      )
    }
    seen.add(hole.strokeIndex)
  }
}
