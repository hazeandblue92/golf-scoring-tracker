import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import {
  downloadEventExport,
  finalizeCompetition,
  reopenCompetition,
  resolveScoreConflict,
  substituteEventEntry,
} from '../lib/phase1.ts';
import { relationName } from '../lib/row-display.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

export function AdminEventScoring() {
  const { eventId = '' } = useParams();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [pendingFinalizationId, setPendingFinalizationId] = useState<string | null>(null);
  const [pendingReopenId, setPendingReopenId] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [outgoingEntryId, setOutgoingEntryId] = useState('');
  const [incomingParticipantId, setIncomingParticipantId] = useState('');
  const [effectiveRoundId, setEffectiveRoundId] = useState('');
  const [substitutionReason, setSubstitutionReason] = useState('');
  const query = useQuery({ queryKey: ['control-room', eventId], refetchInterval: 10_000, queryFn: async () => {
    const supabase = getSupabaseClient();
    const { data: event, error } = await supabase.from('events').select('id,league_id,name,status,scoring_revision').eq('id', eventId).single();
    if (error || !event) throw error;
    const [
      { data: rounds },
      { data: entries },
      { data: teams },
      { data: competitions },
      { data: conflicts },
      { data: scores },
      { data: teamScores },
      { data: participants },
      { data: teamMembers },
    ] = await Promise.all([
      supabase.from('rounds').select('id,name,round_number,hole_count,status').eq('event_id', eventId).order('round_number'),
      supabase.from('event_entries').select('id,participant_id,status,effective_from_round_id,replaces_entry_id,participants(display_name)').eq('event_id', eventId),
      supabase.from('event_teams').select('id,name').eq('event_id', eventId).eq('status', 'active'),
      supabase.from('competitions').select('id,name,format,metric,status,final_result_hash').eq('event_id', eventId).order('sort_order'),
      supabase.from('score_conflicts').select('id,target_kind,local_payload,server_payload,created_at,event_entry_id,event_team_id').eq('event_id', eventId).eq('status', 'open').order('created_at'),
      supabase.from('individual_hole_scores').select('round_id,event_entry_id,event_hole_id,score_status,revision').eq('event_id', eventId),
      supabase.from('team_hole_scores').select('round_id,event_team_id,event_hole_id,score_status,revision').eq('event_id', eventId),
      supabase.from('participants').select('id,display_name').eq('league_id', event.league_id).eq('status', 'active').order('sort_name'),
      supabase.from('event_team_members').select('event_entry_id,event_teams!inner(event_id)').eq('event_teams.event_id', eventId),
    ]);
    const roundIds = (rounds ?? []).map((round) => round.id);
    const { data: attestations } = roundIds.length
      ? await supabase.from('scorecard_attestations').select('round_id,event_entry_id,event_team_id,score_revision').in('round_id', roundIds)
      : { data: [] };
    const competitionIds = (competitions ?? []).map((competition) => competition.id);
    const { data: projections } = competitionIds.length
      ? await supabase.from('competition_projections').select('competition_id,event_revision,status,calculated_at').in('competition_id', competitionIds).order('event_revision', { ascending: false })
      : { data: [] };
    const currentProjection = new Map<string, { competition_id: string; event_revision: number; status: string; calculated_at: string }>();
    for (const projection of projections ?? []) if (!currentProjection.has(projection.competition_id)) currentProjection.set(projection.competition_id, projection);
    return { event, rounds: rounds ?? [], entries: entries ?? [], teams: teams ?? [], competitions: competitions ?? [], conflicts: conflicts ?? [], scores: scores ?? [], teamScores: teamScores ?? [], participants: participants ?? [], teamMembers: teamMembers ?? [], attestations: attestations ?? [], currentProjection };
  }});
  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--rows" /></div>;
  if (!query.data) return <p className="form-message form-message--error">Control room unavailable.</p>;
  const { event, rounds, entries, teams, competitions, conflicts, scores, teamScores, participants, teamMembers, attestations, currentProjection } = query.data;
  const teamBall = competitions.some((competition) =>
    ['scramble', 'foursomes', 'greensomes', 'chapman'].includes(competition.format));
  const replacedEntryIds = new Set(entries
    .map((entry) => entry.replaces_entry_id)
    .filter((entryId): entryId is string => entryId !== null));
  const rootEntryCount = entries.filter((entry) => entry.replaces_entry_id === null).length;
  const cardCount = teamBall ? teams.length : rootEntryCount;
  const activeScores = teamBall ? teamScores : scores;
  const required = rounds.reduce((total, round) => total + round.hole_count, 0) * cardCount;
  const received = activeScores.filter((score) => score.score_status !== 'not_started').length;
  const progress = required ? Math.round(received / required * 100) : 0;
  const unfinalized = competitions.filter((competition) => competition.status !== 'finalized');
  const lagging = competitions.filter((competition) =>
    competition.status !== 'finalized'
      && event.scoring_revision - (currentProjection.get(competition.id)?.event_revision ?? 0) > 0);
  const cardRevisions = new Map<string, number>();
  for (const score of activeScores) {
    const targetId = 'event_team_id' in score ? score.event_team_id : score.event_entry_id;
    const key = `${score.round_id}:${targetId}`;
    cardRevisions.set(key, (cardRevisions.get(key) ?? 0) + score.revision);
  }
  const attestedCards = new Set(attestations
    .filter((attestation) => {
      const targetId = teamBall ? attestation.event_team_id : attestation.event_entry_id;
      const key = `${attestation.round_id}:${targetId ?? ''}`;
      return targetId && Number(attestation.score_revision) === (cardRevisions.get(key) ?? 0);
    })
    .map((attestation) => `${attestation.round_id}:${teamBall ? attestation.event_team_id : attestation.event_entry_id}`)).size;
  const totalCards = cardCount * rounds.length;
  const teamMemberEntryIds = new Set(teamMembers.map((member) => member.event_entry_id));
  const outgoingEntries = entries.filter((entry) =>
    entry.status === 'active'
      && !replacedEntryIds.has(entry.id)
      && !teamMemberEntryIds.has(entry.id));
  const enteredParticipantIds = new Set(entries.map((entry) => entry.participant_id));
  const incomingParticipants = participants.filter((participant) =>
    !enteredParticipantIds.has(participant.id));
  const eligibleRounds = rounds.filter((candidate) =>
    candidate.status === 'scheduled' || candidate.status === 'in_progress');

  async function resolve(conflictId: string, choice: 'local' | 'server') {
    setBusy(true); setError(null);
    try { await resolveScoreConflict({ conflictId, choice, reason: `Director selected ${choice} value in control room` }); setMessage('Conflict resolved and result repair requested.'); await query.refetch(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Conflict resolution failed.'); }
    finally { setBusy(false); }
  }

  async function substitutePlayer() {
    if (!outgoingEntryId || !incomingParticipantId || !effectiveRoundId) return;
    const reason = substitutionReason.trim();
    if (!reason) {
      setError('Enter the committee reason for this substitution.');
      return;
    }
    setBusy(true); setError(null); setMessage(null);
    try {
      await substituteEventEntry({
        eventId,
        outgoingEntryId,
        incomingParticipantId,
        effectiveRoundId,
        reason,
      });
      setOutgoingEntryId('');
      setIncomingParticipantId('');
      setEffectiveRoundId('');
      setSubstitutionReason('');
      setMessage('Substitution saved. Earlier scorecards remain attributed to the original player.');
      await query.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The substitution could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function finalizeOne(competitionId: string, competitionName: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await finalizeCompetition({
        competitionId,
        overrideReason: overrideReason.trim() || null,
      });
      const hash = result.finalResultHash ?? '';
      setPendingFinalizationId(null);
      setOverrideReason('');
      setMessage(`${competitionName} finalized. Result hash ${hash.slice(0, 16)}…`);
      await query.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Finalization failed.'); }
    finally { setBusy(false); }
  }

  async function reopenOne(competitionId: string, competitionName: string) {
    const reason = reopenReason.trim();
    if (reason.length < 3) {
      setError('Enter the committee reason for reopening this result.');
      return;
    }
    setBusy(true); setError(null); setMessage(null);
    try {
      await reopenCompetition({ competitionId, reason });
      setPendingReopenId(null);
      setReopenReason('');
      setMessage(`${competitionName} reopened for audited corrections. Other finalized results remain locked.`);
      await query.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Reopening failed.'); }
    finally { setBusy(false); }
  }

  return <div className="screen control-screen">
    <header className="page-header page-header--split"><div><Link className="back-link" to={`/events/${eventId}`}>Back to {event.name}</Link><h1>Scoring control room</h1><p>One operational view for every competition using the field’s scorecards.</p></div><span className="status-badge">{event.status.replaceAll('_', ' ')}</span></header>
    {error && <p className="form-message form-message--error" role="alert">{error}</p>}{message && <p className="form-message form-message--success" role="status">{message}</p>}
    <section className="progress-panel"><div><h2>Field progress</h2><strong>{received} / {required}</strong></div><progress className="progress-track" aria-label="Field score completion" value={progress} max={100}>{progress}%</progress><p>{progress}% received · {Math.max(0, required - received)} missing · {attestedCards}/{totalCards} {teamBall ? 'team ' : ''}{rounds.length > 1 ? 'round-cards' : 'cards'} attested</p></section>
    <div className="control-grid"><section><div className="section-heading"><h2>Projection health</h2><span className={lagging.length ? 'state-warning' : 'state-success'}>{lagging.length ? `${lagging.length} updating` : 'All current'}</span></div><div className="competition-health">{competitions.map((competition) => { const projection = currentProjection.get(competition.id); const lag = event.scoring_revision - (projection?.event_revision ?? 0); const sealed = competition.status === 'finalized'; return <div key={competition.id}><span><strong>{competition.name}</strong><small>{competition.metric} · {competition.status.replaceAll('_', ' ')}</small></span><b className={!sealed && lag ? 'state-warning' : 'state-success'}>{sealed ? 'Sealed' : lag ? `${lag} behind` : `r${projection?.event_revision ?? 0}`}</b></div>; })}</div></section><section><div className="section-heading"><h2>Finalization</h2><span>{unfinalized.length} remaining</span></div><label className="field"><span>Committee override reason</span><textarea value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} rows={3} placeholder="For missing scores, conflicts, or attestations only" /></label><small>Unfinished matches and unresolved skins carries must be completed before finalization.</small>{pendingFinalizationId && <p className="form-message" role="status">Finalizing {competitions.find((competition) => competition.id === pendingFinalizationId)?.name} seals its result hash. Reopening later requires an audited organizer action.</p>}{pendingReopenId && <div className="form-grid"><p className="form-message field--wide" role="status">Reopening {competitions.find((competition) => competition.id === pendingReopenId)?.name} unlocks it for audited score corrections. Other finalized results stay sealed.</p><label className="field field--wide"><span>Reason for reopening</span><textarea value={reopenReason} onChange={(change) => setReopenReason(change.target.value)} rows={3} maxLength={500} placeholder="Committee decision and correction needed" /></label></div>}<div className="competition-health">{competitions.map((competition) => <div key={competition.id}><span><strong>{competition.name}</strong><small>{competition.status === 'finalized' ? 'Result locked' : 'Finalize independently when ready'}</small></span>{competition.status === 'finalized' ? pendingReopenId === competition.id ? <div className="action-row" role="group" aria-label={`Confirm reopening for ${competition.name}`}><button className="button button--quiet" type="button" disabled={busy} onClick={() => { setPendingReopenId(null); setReopenReason(''); }}>Cancel</button><button className="button button--primary" type="button" disabled={busy || reopenReason.trim().length < 3} onClick={() => void reopenOne(competition.id, competition.name)}>{busy ? 'Working…' : 'Confirm reopen'}</button></div> : <button className="button button--quiet" type="button" disabled={busy} onClick={() => { setPendingFinalizationId(null); setPendingReopenId(competition.id); }}>Reopen</button> : pendingFinalizationId === competition.id ? <div className="action-row" role="group" aria-label={`Confirm finalization for ${competition.name}`}><button className="button button--quiet" type="button" disabled={busy} onClick={() => setPendingFinalizationId(null)}>Cancel</button><button className="button button--primary" type="button" disabled={busy} onClick={() => void finalizeOne(competition.id, competition.name)}>{busy ? 'Working…' : 'Confirm finalization'}</button></div> : <button className="button button--primary" type="button" disabled={busy} onClick={() => { setPendingReopenId(null); setPendingFinalizationId(competition.id); }}>Finalize</button>}</div>)}</div></section></div>
    <section className="section-block" aria-labelledby="substitution-heading">
      <div className="section-heading"><div><h2 id="substitution-heading">Player substitution</h2><p>Choose the first round the replacement may score. Prior scorecards and attribution stay unchanged.</p></div><span>Individual entries</span></div>
      {eligibleRounds.length === 0 ? <p className="empty-inline">There are no scheduled or in-progress rounds available for a substitution.</p> : incomingParticipants.length === 0 ? <p className="empty-inline">Every active league player is already entered in this event.</p> : outgoingEntries.length === 0 ? <p className="empty-inline">No eligible individual entry is available. Team roster changes need an effective-dated team workflow.</p> : <div className="form-grid">
        <label className="field"><span>Player leaving</span><select value={outgoingEntryId} onChange={(change) => setOutgoingEntryId(change.target.value)}><option value="">Select player</option>{outgoingEntries.map((entry) => <option key={entry.id} value={entry.id}>{relationName(entry.participants)}</option>)}</select></label>
        <label className="field"><span>Replacement player</span><select value={incomingParticipantId} onChange={(change) => setIncomingParticipantId(change.target.value)}><option value="">Select player</option>{incomingParticipants.map((participant) => <option key={participant.id} value={participant.id}>{participant.display_name}</option>)}</select></label>
        <label className="field"><span>Effective round</span><select value={effectiveRoundId} onChange={(change) => setEffectiveRoundId(change.target.value)}><option value="">Select round</option>{eligibleRounds.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name ?? `Round ${candidate.round_number}`}</option>)}</select></label>
        <label className="field"><span>Committee reason</span><textarea maxLength={500} rows={3} value={substitutionReason} onChange={(change) => setSubstitutionReason(change.target.value)} placeholder="Why the player is being replaced" /></label>
        <div className="field--wide"><button className="button button--secondary" type="button" disabled={busy || !outgoingEntryId || !incomingParticipantId || !effectiveRoundId || !substitutionReason.trim()} onClick={() => void substitutePlayer()}>{busy ? 'Saving…' : 'Save substitution'}</button></div>
      </div>}
    </section>
    <section className="section-block"><div className="section-heading"><h2>Open conflicts</h2><span>{conflicts.length}</span></div>{conflicts.length === 0 ? <p className="empty-inline">No score conflicts need review.</p> : <div className="conflict-list">{conflicts.map((conflict) => <article key={conflict.id}><div><strong>Score conflict</strong><span>{new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(conflict.created_at))}</span></div><p>Local: {formatScore(conflict.local_payload)} · Server: {formatScore(conflict.server_payload)}</p><div className="action-row"><button className="button button--secondary" disabled={busy} onClick={() => void resolve(conflict.id, 'local')}>Use local</button><button className="button button--quiet" disabled={busy} onClick={() => void resolve(conflict.id, 'server')}>Keep server</button></div></article>)}</div>}</section>
    <footer className="control-footer"><Link className="button button--quiet" to={`/admin/events/${eventId}/audit`}>View audit trail</Link><button className="button button--quiet" type="button" onClick={() => void downloadEventExport(event.league_id, event.id)}>Export event</button></footer>
  </div>;
}

function formatScore(value: unknown) { const score = value as { grossStrokes?: number | null; status?: string }; return score.grossStrokes ?? score.status ?? 'empty'; }

