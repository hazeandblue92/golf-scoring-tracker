import type { TerminalMatchStatus } from '@gtt/contracts';

export interface MatchProjectionRow {
  entity_id: string;
  thru: number | null;
  display_primary: string | null;
  status: string;
  detail_json: unknown;
}

export interface MatchStanding {
  display: string | null;
  thru: number | null;
  status: string;
  matchStatus: string | null;
  leaderEntityId: string | null;
  holesUp: number | null;
  holesRemaining: number | null;
}

interface MatchDetailCandidate {
  matchId: string;
  standing: MatchStanding;
  nested: boolean;
  entityId: string;
}

/**
 * Normalize both single-round rows and per-round details nested inside a
 * multi-round aggregate. Aggregate totals must never be presented as one
 * match's live result.
 */
export function standingsByMatch(
  projectionRows: readonly MatchProjectionRow[],
): Map<string, MatchStanding> {
  const candidates = projectionRows
    .flatMap((row) => candidatesFromRow(row))
    .sort((left, right) => Number(left.nested) - Number(right.nested)
      || left.entityId.localeCompare(right.entityId)
      || left.matchId.localeCompare(right.matchId));
  const standings = new Map<string, MatchStanding>();
  for (const candidate of candidates) {
    if (!standings.has(candidate.matchId)) {
      standings.set(candidate.matchId, candidate.standing);
    }
  }
  return standings;
}

export function matchStandingResult(
  standing: MatchStanding,
  names: ReadonlyMap<string, string>,
): string {
  if (standing.matchStatus === 'halved') return 'Halved';
  const leader = standing.leaderEntityId === null
    ? null
    : names.get(standing.leaderEntityId) ?? 'Leading side';
  if (standing.matchStatus === 'won' && leader !== null) {
    if ((standing.holesUp ?? 0) > 0 && standing.holesRemaining !== null) {
      return `${leader} won ${standing.holesUp} & ${standing.holesRemaining}`;
    }
    return `${leader} won`;
  }
  if (standing.holesUp === 0) return 'All square';
  if (leader !== null && standing.holesUp !== null) {
    return `${leader} ${standing.holesUp} up`;
  }
  return standing.display ?? matchStatusLabel(standing.matchStatus);
}

export function matchStandingProgress(standing: MatchStanding): string {
  if (standing.thru !== null) {
    return `Thru ${standing.thru} · ${standing.status}`;
  }
  if (standing.matchStatus === 'in_progress' && standing.holesRemaining !== null) {
    return `${standing.holesRemaining} hole${standing.holesRemaining === 1 ? '' : 's'} remaining · ${standing.status}`;
  }
  return standing.status;
}

/** Do not let a legacy contradictory summary hide an authoritative winner. */
export function consistentMatchSummary(
  resultSummary: string | null,
  winnerEntityId: string | null,
): string | null {
  if (resultSummary === null) return null;
  return winnerEntityId !== null && isHalvedSummary(resultSummary)
    ? null
    : resultSummary;
}

export function matchProjectionLag(
  eventRevision: number,
  projectionRevision: number,
  competitionStatus: string,
): number {
  return competitionStatus === 'finalized'
    ? 0
    : Math.max(0, eventRevision - projectionRevision);
}

export interface MatchResultEditorState {
  status: TerminalMatchStatus;
  winnerEntityId: string;
  resultSummary: string;
}

export function initialMatchResultState(match: {
  status: string;
  winnerEntityId: string | null;
  resultSummary: string | null;
  sideAEntityId: string | null;
  sideBEntityId: string | null;
}): MatchResultEditorState {
  const oneSided = match.sideAEntityId === null || match.sideBEntityId === null;
  const presentSideId = match.sideAEntityId ?? match.sideBEntityId ?? '';
  const status: TerminalMatchStatus = oneSided
    ? 'walkover'
    : isTerminalMatchStatus(match.status)
      ? match.status
      : 'complete';
  const winnerEntityId = match.winnerEntityId ?? (oneSided ? presentSideId : '');
  const suppliedSummary = match.resultSummary
    ?? (oneSided ? 'Walkover' : winnerEntityId === '' ? 'Halved' : '');
  return {
    status,
    winnerEntityId,
    resultSummary: status === 'complete'
      && winnerEntityId !== ''
      && isHalvedSummary(suppliedSummary)
      ? ''
      : suppliedSummary,
  };
}

export function resultStateAfterStatusChange(
  state: MatchResultEditorState,
  nextStatus: TerminalMatchStatus,
  oneSided: boolean,
  presentSideId: string | null,
): MatchResultEditorState {
  if (nextStatus === 'walkover') {
    return {
      status: nextStatus,
      winnerEntityId: oneSided && presentSideId !== null
        ? presentSideId
        : state.winnerEntityId,
      resultSummary: 'Walkover',
    };
  }
  if (nextStatus === 'conceded') {
    return { ...state, status: nextStatus, resultSummary: 'Conceded' };
  }
  return {
    ...state,
    status: nextStatus,
    resultSummary: state.winnerEntityId === '' ? 'Halved' : '',
  };
}

export function resultStateAfterWinnerChange(
  state: MatchResultEditorState,
  nextWinnerEntityId: string,
): MatchResultEditorState {
  if (state.status === 'complete') {
    return {
      ...state,
      winnerEntityId: nextWinnerEntityId,
      resultSummary: nextWinnerEntityId === ''
        ? 'Halved'
        : isHalvedSummary(state.resultSummary)
          ? ''
          : state.resultSummary,
    };
  }
  return { ...state, winnerEntityId: nextWinnerEntityId };
}

function candidatesFromRow(row: MatchProjectionRow): MatchDetailCandidate[] {
  const root = asRecord(row.detail_json);
  if (root === null) return [];
  const candidates: MatchDetailCandidate[] = [];
  const direct = candidateFromDetail(row, root, false);
  if (direct !== null) candidates.push(direct);
  const rounds = root.rounds;
  if (!Array.isArray(rounds)) return candidates;
  for (const round of rounds) {
    const roundObject = asRecord(round);
    const detail = asRecord(roundObject?.detail);
    if (detail === null) continue;
    const candidate = candidateFromDetail(row, detail, true);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}

function candidateFromDetail(
  row: MatchProjectionRow,
  detail: Record<string, unknown>,
  nested: boolean,
): MatchDetailCandidate | null {
  if (typeof detail.matchId !== 'string') return null;
  const opponentEntityId = typeof detail.opponentEntityId === 'string'
    ? detail.opponentEntityId
    : null;
  const holesUpFromPerspective = finiteNumber(detail.holesUp);
  const holesRemaining = finiteNumber(detail.holesRemaining);
  const matchStatus = typeof detail.matchStatus === 'string'
    ? detail.matchStatus
    : null;
  const outcome = typeof detail.outcome === 'string' ? detail.outcome : null;
  const leaderEntityId = outcome === 'won'
    ? row.entity_id
    : outcome === 'lost'
      ? opponentEntityId
      : holesUpFromPerspective !== null && holesUpFromPerspective > 0
        ? row.entity_id
        : holesUpFromPerspective !== null && holesUpFromPerspective < 0
          ? opponentEntityId
          : null;
  return {
    matchId: detail.matchId,
    nested,
    entityId: row.entity_id,
    standing: {
      // Outer display/thru values describe the entity aggregate when the
      // detail is nested, not this individual match.
      display: nested ? null : row.display_primary,
      thru: nested ? null : row.thru,
      status: nested
        ? matchStatus === 'in_progress' ? 'provisional' : 'complete'
        : row.status,
      matchStatus,
      leaderEntityId,
      holesUp: holesUpFromPerspective === null
        ? null
        : Math.abs(holesUpFromPerspective),
      holesRemaining,
    },
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function matchStatusLabel(status: string | null): string {
  return status === null
    ? 'Awaiting scores'
    : status.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
}

function isTerminalMatchStatus(status: string): status is TerminalMatchStatus {
  return status === 'complete' || status === 'conceded' || status === 'walkover';
}

function isHalvedSummary(summary: string): boolean {
  return summary.trim().toLocaleLowerCase() === 'halved';
}
