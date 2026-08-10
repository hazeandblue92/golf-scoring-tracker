import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { downloadEventExport, finalizeCompetition, resolveScoreConflict } from '../lib/phase1.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

export function AdminEventScoring() {
  const { eventId = '' } = useParams();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const query = useQuery({ queryKey: ['control-room', eventId], refetchInterval: 10_000, queryFn: async () => {
    const supabase = getSupabaseClient();
    const { data: event, error } = await supabase.from('events').select('id,league_id,name,status,scoring_revision').eq('id', eventId).single();
    if (error || !event) throw error;
    const [{ data: rounds }, { data: entries }, { data: competitions }, { data: conflicts }, { data: scores }] = await Promise.all([
      supabase.from('rounds').select('id,hole_count,status').eq('event_id', eventId),
      supabase.from('event_entries').select('id,participants(display_name)').eq('event_id', eventId),
      supabase.from('competitions').select('id,name,status,final_result_hash').eq('event_id', eventId).order('sort_order'),
      supabase.from('score_conflicts').select('id,target_kind,local_payload,server_payload,created_at,event_entry_id').eq('event_id', eventId).eq('status', 'open').order('created_at'),
      supabase.from('individual_hole_scores').select('event_entry_id,event_hole_id,score_status').eq('event_id', eventId),
    ]);
    const competition = competitions?.[0];
    const { data: projection } = competition ? await supabase.from('competition_projections').select('event_revision,status,calculated_at').eq('competition_id', competition.id).order('event_revision', { ascending: false }).limit(1).maybeSingle() : { data: null };
    return { event, round: rounds?.[0], entries: entries ?? [], competition, conflicts: conflicts ?? [], scores: scores ?? [], projection };
  }});
  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--rows" /></div>;
  if (!query.data) return <p className="form-message form-message--error">Control room unavailable.</p>;
  const { event, round, entries, competition, conflicts, scores, projection } = query.data;
  const required = (round?.hole_count ?? 0) * entries.length;
  const received = scores.filter((score) => score.score_status !== 'not_started').length;
  const progress = required ? Math.round(received / required * 100) : 0;
  const projectionLag = event.scoring_revision - (projection?.event_revision ?? 0);

  async function resolve(conflictId: string, choice: 'local' | 'server') {
    setBusy(true); setError(null);
    try { await resolveScoreConflict({ conflictId, choice, reason: `Director selected ${choice} value in control room` }); setMessage('Conflict resolved and leaderboard repair requested.'); await query.refetch(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Conflict resolution failed.'); }
    finally { setBusy(false); }
  }

  async function finalize() {
    if (!competition) return;
    setBusy(true); setError(null);
    try {
      const result = await finalizeCompetition({ competitionId: competition.id, overrideReason: overrideReason.trim() || null });
      if (result.status === 'blocked') setError(`Finalization blocked: ${result.missingScores ?? 0} missing scores and ${result.openConflicts ?? 0} open conflicts. Resolve them or record an override reason.`);
      else setMessage(`Finalized. Result hash ${result.finalResultHash?.slice(0, 16)}…`);
      await query.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Finalization failed.'); }
    finally { setBusy(false); }
  }

  return <div className="screen control-screen"><header className="page-header page-header--split"><div><Link className="back-link" to={`/events/${eventId}`}>Back to {event.name}</Link><h1>Scoring control room</h1><p>Live operational state for the field.</p></div><span className="status-badge">{event.status.replaceAll('_', ' ')}</span></header>{error && <p className="form-message form-message--error" role="alert">{error}</p>}{message && <p className="form-message form-message--success" role="status">{message}</p>}<section className="progress-panel"><div><h2>Field progress</h2><strong>{received} / {required}</strong></div><div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div><p>{progress}% received · {Math.max(0, required - received)} missing</p></section><div className="control-grid"><section><div className="section-heading"><h2>Projection health</h2><span className={projectionLag ? 'state-warning' : 'state-success'}>{projectionLag ? `${projectionLag} behind` : 'Current'}</span></div><dl className="fact-list"><dt>Score revision</dt><dd>{event.scoring_revision}</dd><dt>Projection revision</dt><dd>{projection?.event_revision ?? 'Pending'}</dd><dt>Open conflicts</dt><dd>{conflicts.length}</dd></dl></section><section><div className="section-heading"><h2>Finalization</h2><span>{competition?.status}</span></div><label className="field"><span>Override reason (required only with blockers)</span><textarea value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} rows={3} placeholder="Committee decision and reason" /></label><button className="button button--primary" type="button" disabled={busy || competition?.status === 'finalized'} onClick={() => void finalize()}>{busy ? 'Working…' : 'Close and finalize'}</button></section></div><section className="section-block"><div className="section-heading"><h2>Open conflicts</h2><span>{conflicts.length}</span></div>{conflicts.length === 0 ? <p className="empty-inline">No score conflicts need review.</p> : <div className="conflict-list">{conflicts.map((conflict) => <article key={conflict.id}><div><strong>Score conflict</strong><span>{new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(conflict.created_at))}</span></div><p>Local: {formatScore(conflict.local_payload)} · Server: {formatScore(conflict.server_payload)}</p><div className="action-row"><button className="button button--secondary" disabled={busy} onClick={() => void resolve(conflict.id, 'local')}>Use local</button><button className="button button--quiet" disabled={busy} onClick={() => void resolve(conflict.id, 'server')}>Keep server</button></div></article>)}</div>}</section><footer className="control-footer"><Link className="button button--quiet" to={`/admin/events/${eventId}/audit`}>View audit trail</Link><button className="button button--quiet" type="button" onClick={() => void downloadEventExport(event.league_id, event.id)}>Export event</button></footer></div>;
}

function formatScore(value: unknown) { const score = value as { grossStrokes?: number | null; status?: string }; return score.grossStrokes ?? score.status ?? 'empty'; }
