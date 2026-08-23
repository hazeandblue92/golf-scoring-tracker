import type {
  SetMatchResultRequest,
  TerminalMatchStatus,
} from '@gtt/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';

import {
  consistentMatchSummary,
  initialMatchResultState,
  matchProjectionLag,
  matchStandingProgress,
  matchStandingResult,
  resultStateAfterStatusChange,
  resultStateAfterWinnerChange,
  standingsByMatch,
  type MatchProjectionRow,
} from '../lib/match-view.ts';
import { setMatchResult } from '../lib/phase1.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

/**
 * Match play (§§4.6, 8.6): participant-visible pairings and a reasoned,
 * MFA-gated Committee result workflow. Raw match facts stay read-only in the
 * browser; terminal changes go through the audited Edge Function.
 */
export function Matches() {
  const { eventId = '', competitionId = '' } = useParams();
  const queryClient = useQueryClient();
  const [editingMatchId, setEditingMatchId] = useState<string | null>(null);
  const [busyMatchId, setBusyMatchId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['matches', eventId, competitionId],
    enabled: eventId !== '' && competitionId !== '',
    refetchInterval: 10_000,
    queryFn: async () => {
      const supabase = getSupabaseClient();
      const [
        { data: event, error: eventError },
        { data: competition, error: competitionError },
        { data: pairings, error: pairingError },
        { data: entities, error: entityError },
        { data: rounds },
        { data: roles },
        { data: projection },
      ] = await Promise.all([
        supabase.from('events')
          .select('id,league_id,name,status,scoring_revision')
          .eq('id', eventId)
          .single(),
        supabase.from('competitions')
          .select('id,event_id,name,format,status,rules_text,final_result_hash')
          .eq('id', competitionId)
          .eq('event_id', eventId)
          .single(),
        supabase.from('matches')
          .select('id,round_id,side_a_entity_id,side_b_entity_id,bracket_position,status,winner_entity_id,result_summary,concession_reason,updated_at')
          .eq('competition_id', competitionId)
          .order('bracket_position', { nullsFirst: false })
          .order('created_at'),
        supabase.from('competition_entities')
          .select('id,event_entry_id,event_team_id')
          .eq('competition_id', competitionId),
        supabase.from('rounds')
          .select('id,name,round_number')
          .eq('event_id', eventId)
          .order('round_number'),
        supabase.from('role_assignments')
          .select('role,league_id,event_id')
          .is('revoked_at', null),
        supabase.from('competition_projections')
          .select('event_revision,status,calculated_at,warnings')
          .eq('competition_id', competitionId)
          .order('event_revision', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (eventError || !event) throw eventError ?? new Error('Event unavailable');
      if (competitionError || !competition || competition.format !== 'match') {
        throw competitionError ?? new Error('Match competition unavailable');
      }
      if (pairingError) throw pairingError;
      if (entityError) throw entityError;

      const entityRows = entities ?? [];
      const entryIds = entityRows
        .map((entity) => entity.event_entry_id)
        .filter((id): id is string => id !== null);
      const teamIds = entityRows
        .map((entity) => entity.event_team_id)
        .filter((id): id is string => id !== null);
      const revision = projection?.event_revision ?? 0;
      const [
        { data: entries },
        { data: teams },
        { data: projectionRows },
      ] = await Promise.all([
        entryIds.length
          ? supabase.from('event_entries')
              .select('id,participants(display_name)')
              .in('id', entryIds)
          : Promise.resolve({ data: [] }),
        teamIds.length
          ? supabase.from('event_teams').select('id,name').in('id', teamIds)
          : Promise.resolve({ data: [] }),
        projection
          ? supabase.from('leaderboard_rows')
              .select('entity_id,thru,display_primary,status,detail_json')
              .eq('competition_id', competitionId)
              .eq('event_revision', revision)
          : Promise.resolve({ data: [] }),
      ]);

      const entryNames = new Map((entries ?? []).map((entry) => [
        entry.id,
        relationName(entry.participants),
      ]));
      const teamNames = new Map((teams ?? []).map((team) => [team.id, team.name]));
      const names = new Map(entityRows.map((entity) => [
        entity.id,
        entity.event_entry_id
          ? entryNames.get(entity.event_entry_id) ?? 'Player'
          : teamNames.get(entity.event_team_id ?? '') ?? 'Team',
      ]));
      const roundNames = new Map((rounds ?? []).map((round) => [
        round.id,
        round.name ?? `Round ${round.round_number}`,
      ]));
      const standings = standingsByMatch(
        (projectionRows ?? []) as MatchProjectionRow[],
      );

      return {
        event,
        competition,
        pairings: pairings ?? [],
        projection,
        names,
        roundNames,
        standings,
        canOrganize: (roles ?? []).some((role) =>
          (['owner', 'league_admin'].includes(role.role) && role.league_id === event.league_id)
          || (role.role === 'event_director' && role.event_id === event.id)),
      };
    },
  });

  useEffect(() => {
    if (!eventId) return;
    const supabase = getSupabaseClient();
    const channel = supabase.channel(`match-revision-${eventId}`).on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'event_revision_feed',
        filter: `event_id=eq.${eventId}`,
      },
      () => void queryClient.invalidateQueries({
        queryKey: ['matches', eventId, competitionId],
      }),
    ).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [competitionId, eventId, queryClient]);

  const matchCounts = useMemo(() => {
    const pairings = query.data?.pairings ?? [];
    const terminal = pairings.filter((match) => isTerminal(match.status)).length;
    return { terminal, open: pairings.length - terminal, total: pairings.length };
  }, [query.data]);

  if (query.isLoading) {
    return <div className="screen"><div className="skeleton skeleton--rows" /></div>;
  }
  if (!query.data) {
    return (
      <p className="form-message form-message--error" role="alert">
        Match standings are unavailable. The saved match facts remain authoritative.
      </p>
    );
  }

  const {
    event,
    competition,
    pairings,
    projection,
    names,
    roundNames,
    standings,
    canOrganize,
  } = query.data;
  const lag = matchProjectionLag(
    event.scoring_revision,
    projection?.event_revision ?? 0,
    competition.status,
  );
  const canEdit = canOrganize
    && competition.status !== 'finalized'
    && ['scoring_open', 'scoring_closed'].includes(competition.status)
    && ['scoring_open', 'scoring_closed'].includes(event.status);

  async function saveResult(request: SetMatchResultRequest) {
    setBusyMatchId(request.matchId);
    setError(null);
    setMessage(null);
    try {
      const result = await setMatchResult(request);
      setEditingMatchId(null);
      setMessage(result.status === 'queued_projection'
        ? 'Match result recorded. Standings are queued for recalculation.'
        : 'Match result recorded and standings recalculated.');
      await query.refetch();
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : 'The match result could not be recorded.');
    } finally {
      setBusyMatchId(null);
    }
  }

  return (
    <div className="screen matches-screen">
      <header className="page-header page-header--split">
        <div>
          <Link className="back-link" to={`/events/${eventId}`}>Back to {event.name}</Link>
          <h1>{competition.name}</h1>
          <p>{competition.status === 'finalized'
            ? 'Official match results are sealed.'
            : competition.rules_text || 'Live match-play pairings and Committee results.'}</p>
        </div>
        <div className="revision-badge">
          <span>Revision</span>
          <strong>{projection?.event_revision ?? 0}</strong>
        </div>
      </header>

      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      {message && <p className="form-message form-message--success" role="status">{message}</p>}
      {lag > 0 && (
        <p className="form-message form-message--warning" role="status">
          Match standings are updating from {lag} newer scoring revision{lag === 1 ? '' : 's'}.
        </p>
      )}

      <section className="match-progress" aria-labelledby="match-progress-title">
        <div>
          <h2 id="match-progress-title">Match status</h2>
          <strong>{matchCounts.terminal} of {matchCounts.total} decided</strong>
        </div>
        <p>{matchCounts.open === 0
          ? 'Every declared pairing has a terminal Committee result.'
          : `${matchCounts.open} pairing${matchCounts.open === 1 ? '' : 's'} still need a terminal result before this competition can be finalized.`}</p>
      </section>

      {competition.status !== 'finalized' && (
        <p className="provisional-banner">
          Provisional until every match is decided and the competition is finalized.
        </p>
      )}

      <section className="match-ledger" aria-label={`${competition.name} pairings`}>
        {pairings.length === 0 ? (
          <div className="empty-state">
            <h2>No pairings published</h2>
            <p>The Committee must publish match pairings before standings can be calculated.</p>
          </div>
        ) : pairings.map((match, index) => {
          const sideAName = match.side_a_entity_id
            ? names.get(match.side_a_entity_id) ?? 'Side A'
            : 'Open bracket slot';
          const sideBName = match.side_b_entity_id
            ? names.get(match.side_b_entity_id) ?? 'Side B'
            : 'Open bracket slot';
          const standing = standings.get(match.id);
          const resultText = consistentMatchSummary(
            match.result_summary,
            match.winner_entity_id,
          )
            ?? (standing ? matchStandingResult(standing, names) : null)
            ?? (match.winner_entity_id
              ? `${names.get(match.winner_entity_id) ?? 'Winning side'} won`
              : null)
            ?? statusLabel(match.status);
          const editorOpen = editingMatchId === match.id;
          return (
            <article className="match-row" key={match.id}>
              <header>
                <div>
                  <span>{roundNames.get(match.round_id) ?? 'Round'}</span>
                  <h2>Match {match.bracket_position ?? index + 1}</h2>
                </div>
                <span className="status-badge">{statusLabel(match.status)}</span>
              </header>

              <div className="match-sides" aria-label={`${sideAName} versus ${sideBName}`}>
                <MatchSide
                  name={sideAName}
                  open={match.side_a_entity_id === null}
                  winner={match.side_a_entity_id !== null
                    && match.winner_entity_id === match.side_a_entity_id}
                />
                <span aria-hidden="true">vs</span>
                <MatchSide
                  name={sideBName}
                  open={match.side_b_entity_id === null}
                  winner={match.side_b_entity_id !== null
                    && match.winner_entity_id === match.side_b_entity_id}
                />
              </div>

              <div className="match-result-line">
                <strong>{resultText}</strong>
                <span>{standing
                  ? matchStandingProgress(standing)
                  : 'Awaiting scores'}</span>
              </div>

              {match.concession_reason && (
                <p className="match-note">Committee note: {match.concession_reason}</p>
              )}

              {canEdit && !editorOpen && (
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={busyMatchId !== null}
                  onClick={() => {
                    setError(null);
                    setEditingMatchId(match.id);
                  }}
                >
                  {isTerminal(match.status) ? 'Correct result' : 'Record result'}
                </button>
              )}
              {canEdit && editorOpen && (
                <MatchResultEditor
                  key={`${match.id}:${match.updated_at}`}
                  match={match}
                  sideAName={sideAName}
                  sideBName={sideBName}
                  busy={busyMatchId !== null}
                  onCancel={() => setEditingMatchId(null)}
                  onSave={saveResult}
                />
              )}
            </article>
          );
        })}
      </section>

      {canOrganize && !canEdit && (
        <p className="match-locked-note">
          {competition.status === 'finalized'
            ? 'Results are locked. Reopen this competition from the scoring control room before correcting a match.'
            : 'Result controls become available while scoring is open or closed.'}
        </p>
      )}
      <footer className="board-footer">
        {projection
          ? `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(projection.calculated_at))}`
          : 'Projection pending'}
        {competition.final_result_hash && (
          <code title="Final result hash">{competition.final_result_hash.slice(0, 12)}…</code>
        )}
      </footer>
    </div>
  );
}

function MatchSide({ name, open, winner }: {
  name: string;
  open: boolean;
  winner: boolean;
}) {
  return (
    <div className={`match-side${winner ? ' match-side--winner' : ''}`}>
      <strong>{name}</strong>
      <span>{open ? 'No side assigned' : winner ? 'Winner' : 'Side'}</span>
    </div>
  );
}

function MatchResultEditor({
  match,
  sideAName,
  sideBName,
  busy,
  onCancel,
  onSave,
}: {
  match: MatchRow;
  sideAName: string;
  sideBName: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (request: SetMatchResultRequest) => Promise<void>;
}) {
  const oneSided = match.side_a_entity_id === null || match.side_b_entity_id === null;
  const presentSideId = match.side_a_entity_id ?? match.side_b_entity_id;
  const [resultState, setResultState] = useState(() => initialMatchResultState({
    status: match.status,
    winnerEntityId: match.winner_entity_id,
    resultSummary: match.result_summary,
    sideAEntityId: match.side_a_entity_id,
    sideBEntityId: match.side_b_entity_id,
  }));
  const [reason, setReason] = useState(match.concession_reason ?? '');
  const { status, winnerEntityId, resultSummary } = resultState;
  const winnerRequired = status === 'conceded' || status === 'walkover';
  const summaryHelpId = `match-${match.id}-summary-help`;
  const reasonHelpId = `match-${match.id}-reason-help`;
  const summaryRef = useRef<HTMLInputElement>(null);

  function changeStatus(next: TerminalMatchStatus) {
    summaryRef.current?.setCustomValidity('');
    setResultState((current) => resultStateAfterStatusChange(
      current,
      next,
      oneSided,
      presentSideId,
    ));
  }

  return (
    <form
      className="match-result-form"
      aria-label="Record Committee match result"
      onSubmit={(event) => {
        event.preventDefault();
        const summaryControl = event.currentTarget.elements.namedItem('resultSummary');
        const reasonControl = event.currentTarget.elements.namedItem('reason');
        const summaryInvalid = resultSummary.trim().length === 0
          || (status === 'complete'
            && winnerEntityId !== ''
            && resultSummary.trim().toLocaleLowerCase() === 'halved');
        if (summaryControl instanceof HTMLInputElement) {
          summaryControl.setCustomValidity(summaryInvalid
            ? 'Enter a winning margin when a winning side is selected.'
            : '');
        }
        if (reasonControl instanceof HTMLTextAreaElement) {
          reasonControl.setCustomValidity(reason.trim().length < 3
            ? 'Enter at least 3 non-space characters describing how the result was confirmed.'
            : '');
        }
        if (!event.currentTarget.reportValidity()) return;
        void onSave({
          matchId: match.id,
          status,
          winnerEntityId: winnerEntityId || null,
          resultSummary: resultSummary.trim(),
          reason: reason.trim(),
        });
      }}
    >
      <p>This audited Committee fact recalculates standings. It can be corrected until the competition is finalized.</p>
      <div className="form-grid">
        <label className="field">
          <span>Terminal status</span>
          <select
            value={status}
            disabled={busy || oneSided}
            onChange={(event) => changeStatus(event.target.value as TerminalMatchStatus)}
          >
            <option value="complete">Completed</option>
            <option value="conceded">Conceded</option>
            <option value="walkover">Walkover</option>
          </select>
          {oneSided && <small>A one-sided bracket can only be recorded as a walkover.</small>}
        </label>
        <label className="field">
          <span>{winnerRequired ? 'Winning side' : 'Winning side (optional)'}</span>
          <select
            value={winnerEntityId}
            required={winnerRequired}
            disabled={busy}
            onChange={(event) => {
              summaryRef.current?.setCustomValidity('');
              setResultState((current) =>
                resultStateAfterWinnerChange(current, event.target.value));
            }}
          >
            {!winnerRequired && <option value="">Halved · no winner</option>}
            {winnerRequired && <option value="">Select winner</option>}
            {match.side_a_entity_id && (
              <option value={match.side_a_entity_id}>{sideAName}</option>
            )}
            {match.side_b_entity_id && (
              <option value={match.side_b_entity_id}>{sideBName}</option>
            )}
          </select>
        </label>
        <label className="field">
          <span>Result summary</span>
          <input
            ref={summaryRef}
            name="resultSummary"
            value={resultSummary}
            required
            maxLength={80}
            disabled={busy}
            aria-describedby={summaryHelpId}
            onChange={(event) => {
              event.currentTarget.setCustomValidity('');
              setResultState((current) => ({
                ...current,
                resultSummary: event.target.value,
              }));
            }}
            placeholder="For example, 3 & 2 or Halved"
          />
          <small id={summaryHelpId}>Required. Use “Halved” only when no winning side is selected.</small>
        </label>
        <label className="field">
          <span>Committee reason</span>
          <textarea
            name="reason"
            value={reason}
            required
            minLength={3}
            maxLength={500}
            rows={3}
            disabled={busy}
            aria-describedby={reasonHelpId}
            onChange={(event) => {
              event.currentTarget.setCustomValidity('');
              setReason(event.target.value);
            }}
            placeholder="How the result was confirmed"
          />
          <small id={reasonHelpId}>Required; at least 3 characters. Describe how the Committee confirmed it.</small>
        </label>
      </div>
      <div className="action-row">
        <button className="button button--quiet" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="button button--primary" type="submit" disabled={busy}>
          {busy ? 'Recording…' : 'Record match result'}
        </button>
      </div>
    </form>
  );
}

interface MatchRow {
  id: string;
  round_id: string;
  side_a_entity_id: string | null;
  side_b_entity_id: string | null;
  bracket_position: number | null;
  status: string;
  winner_entity_id: string | null;
  result_summary: string | null;
  concession_reason: string | null;
  updated_at: string;
}

function isTerminal(status: string): status is TerminalMatchStatus {
  return status === 'complete' || status === 'conceded' || status === 'walkover';
}

function statusLabel(status: string) {
  return status === 'complete'
    ? 'Complete'
    : status === 'conceded'
      ? 'Conceded'
      : status === 'walkover'
        ? 'Walkover'
        : status === 'in_progress'
          ? 'In progress'
          : status === 'cancelled'
            ? 'Cancelled'
            : 'Scheduled';
}

function relationName(value: { display_name: string } | Array<{ display_name: string }> | null) {
  return (Array.isArray(value) ? value[0] : value)?.display_name ?? 'Player';
}
