/**
 * Provisional, device-local projections (spec §7.1 shared engine).
 *
 * The scoring engine in `@gtt/scoring` is the same code the Edge Functions
 * project with, so the browser can compute a leaderboard from a cached
 * snapshot plus unsent local drafts and show a player where they stand while
 * offline. These results are PROVISIONAL by construction and are always
 * replaced by the authoritative server projection on reconnect — raw facts are
 * truth, projections are replaceable.
 *
 * The mapping mirrors `individualScoresFor` in the server's
 * projection-orchestrator exactly, including its use of the ENTRY id as the
 * engine's `participantId`, so a local total and a server total for the same
 * facts are the same number rather than merely similar.
 */

import {
  calculateBestBall,
  calculateStrokePlay,
  type BestBallResult,
  type HoleSnapshot,
  type HoleScoreStatus,
  type IndividualHoleScore,
  type StrokePlayResult,
} from '@gtt/scoring';

export interface LocalHole {
  id: string;
  hole_ordinal: number;
  par: number;
  stroke_index: number;
}

export interface LocalEntry {
  id: string;
  playingHandicap: number | null;
}

export interface LocalScore {
  event_entry_id: string;
  event_hole_id: string;
  gross_strokes: number | null;
  score_status: string;
  revision: number;
}

export interface LocalTeam {
  id: string;
  entryIds: string[];
}

export interface LocalDraftScore {
  entityId: string;
  holeId: string;
  value: number | null;
  status: string;
  baseRevision: number;
}

function toHoleSnapshots(holes: readonly LocalHole[]): HoleSnapshot[] {
  return holes
    .map((hole) => ({
      id: hole.id,
      ordinal: hole.hole_ordinal,
      par: hole.par,
      strokeIndex: hole.stroke_index,
    }))
    .toSorted((a, b) => a.ordinal - b.ordinal);
}

/**
 * Server facts with unsent local drafts laid over them.
 *
 * A draft is what this device believes and has not yet had accepted, so it
 * wins over the server value for the same fact — that is the whole point of
 * showing a local projection. Nothing here is written back anywhere.
 */
export function overlayScores(
  entryId: string,
  holeIds: ReadonlySet<string>,
  scores: readonly LocalScore[],
  drafts: readonly LocalDraftScore[],
): IndividualHoleScore[] {
  const byHole = new Map<string, IndividualHoleScore>();
  for (const score of scores) {
    if (score.event_entry_id !== entryId || !holeIds.has(score.event_hole_id)) continue;
    byHole.set(score.event_hole_id, {
      participantId: entryId,
      holeId: score.event_hole_id,
      ...(score.gross_strokes === null ? {} : { grossStrokes: score.gross_strokes }),
      status: score.score_status as HoleScoreStatus,
      revision: score.revision,
    });
  }
  for (const draft of drafts) {
    if (draft.entityId !== entryId || !holeIds.has(draft.holeId)) continue;
    // 'not_started' is a device UI state, never a submitted fact (§4.5): it
    // must not displace a real server score.
    if (draft.status === 'not_started') continue;
    byHole.set(draft.holeId, {
      participantId: entryId,
      holeId: draft.holeId,
      ...(draft.value === null ? {} : { grossStrokes: draft.value }),
      status: draft.status as HoleScoreStatus,
      revision: draft.baseRevision,
    });
  }
  return [...byHole.values()];
}

export interface LocalProjectionInput {
  holes: readonly LocalHole[];
  entries: readonly LocalEntry[];
  scores: readonly LocalScore[];
  drafts: readonly LocalDraftScore[];
  metric: 'gross' | 'net';
}

/** Provisional individual stroke-play standings for the cached event. */
export function localStrokePlay(input: LocalProjectionInput): StrokePlayResult {
  const holes = toHoleSnapshots(input.holes);
  const holeIds = new Set(holes.map((hole) => hole.id));
  return calculateStrokePlay({
    holes,
    metric: input.metric,
    // Always 'live': a device projection can never be a final result.
    phase: 'live',
    entries: input.entries.map((entry) => ({
      entryId: entry.id,
      entityStatus: 'active',
      playingHandicap: entry.playingHandicap,
      scores: overlayScores(entry.id, holeIds, input.scores, input.drafts),
    })),
  });
}

export interface LocalBestBallInput extends LocalProjectionInput {
  teams: readonly LocalTeam[];
  /** Counting scores per hole; the Throwdown four-ball is 1. */
  bestK: number;
}

/** Provisional best-ball standings for the cached event. */
export function localBestBall(input: LocalBestBallInput): BestBallResult {
  const holes = toHoleSnapshots(input.holes);
  const holeIds = new Set(holes.map((hole) => hole.id));
  const handicapOf = new Map(input.entries.map((entry) => [entry.id, entry.playingHandicap]));
  return calculateBestBall({
    holes,
    metric: input.metric,
    bestK: input.bestK,
    phase: 'live',
    teams: input.teams.map((team) => ({
      teamId: team.id,
      entityStatus: 'active',
      members: team.entryIds.map((entryId) => ({
        participantId: entryId,
        playingHandicap: handicapOf.get(entryId) ?? null,
        scores: overlayScores(entryId, holeIds, input.scores, input.drafts),
      })),
    })),
  });
}
