import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { strokesReceivedOnHole } from '@gtt/scoring';

import { attestScorecard } from '../lib/phase1.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

export function Scorecard() {
  const { eventId = '', entryId = '' } = useParams();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['scorecard', eventId, entryId],
    queryFn: async () => {
      const supabase = getSupabaseClient();
      const [{ data: event }, { data: entry, error }, { data: rounds }, { data: session }] = await Promise.all([
        supabase.from('events').select('name,status').eq('id', eventId).single(),
        supabase.from('event_entries').select('id,playing_handicap,participants(display_name,profile_id)').eq('id', entryId).single(),
        supabase.from('rounds').select('id').eq('event_id', eventId).order('round_number'),
        supabase.auth.getSession(),
      ]);
      if (error || !entry) throw error ?? new Error('Scorecard unavailable');
      const round = rounds?.[0];
      const [{ data: holes }, { data: scores }, { data: attestations }] = await Promise.all([
        round ? supabase.from('event_holes').select('id,hole_ordinal,par,stroke_index').eq('round_id', round.id).order('hole_ordinal') : Promise.resolve({ data: [] }),
        supabase.from('individual_hole_scores').select('event_hole_id,gross_strokes,score_status,revision').eq('event_entry_id', entryId),
        round ? supabase.from('scorecard_attestations').select('id,profile_id,attestation_type,score_revision,attested_at').eq('round_id', round.id).eq('event_entry_id', entryId).order('attested_at', { ascending: false }) : Promise.resolve({ data: [] }),
      ]);
      return { event, entry, round, holes: holes ?? [], scores: scores ?? [], attestations: attestations ?? [], viewerId: session.session?.user.id ?? null };
    },
  });

  async function attest() {
    if (!query.data?.round) return;
    setBusy(true); setErrorMessage(null); setMessage(null);
    try {
      const participant = relationValue(query.data.entry.participants);
      const attestationType = participant?.profile_id === query.data.viewerId ? 'player' : 'marker';
      const result = await attestScorecard({
        roundId: query.data.round.id,
        targetKind: 'individual',
        targetId: entryId,
        attestationType,
        reason: null,
      });
      setMessage(result.status === 'duplicate' ? 'This scorecard revision is already attested.' : 'Current scorecard revision attested.');
      await query.refetch();
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Could not attest this scorecard.');
    } finally { setBusy(false); }
  }

  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--rows" /></div>;
  if (!query.data) return <p className="form-message form-message--error">Scorecard unavailable.</p>;
  const { event, entry, holes, scores, attestations } = query.data;
  const byHole = new Map(scores.map((score) => [score.event_hole_id, score]));
  const playingHandicap = entry.playing_handicap ?? 0;
  const holeRows = holes.map((hole) => {
    const score = byHole.get(hole.id);
    const strokes = strokesReceivedOnHole(playingHandicap, holes.length, hole.stroke_index);
    return { ...hole, score, strokes, net: score?.gross_strokes === null || score?.gross_strokes === undefined ? null : score.gross_strokes - strokes };
  });
  const completed = holeRows.filter((hole) => hole.score?.gross_strokes !== null && hole.score?.gross_strokes !== undefined);
  const grossTotal = completed.reduce((sum, hole) => sum + (hole.score?.gross_strokes ?? 0), 0);
  const netTotal = completed.reduce((sum, hole) => sum + (hole.net ?? 0), 0);
  const cardRevision = scores.reduce((sum, score) => sum + score.revision, 0);
  const currentAttestation = attestations.find((attestation) => Number(attestation.score_revision) === cardRevision);
  const participant = relationValue(entry.participants);

  return (
    <div className="screen scorecard-screen">
      <header className="page-header"><Link className="back-link" to={`/events/${eventId}`}>Back to {event?.name ?? 'event'}</Link><h1>{participant?.display_name ?? 'Player'}’s scorecard</h1><p>Playing Handicap {playingHandicap} · {completed.length} thru · {event?.status === 'finalized' ? 'Final' : 'Provisional'}</p></header>
      {errorMessage && <p className="form-message form-message--error" role="alert">{errorMessage}</p>}
      {message && <p className="form-message form-message--success" role="status">{message}</p>}
      <div className="scorecard-table" role="table" aria-label="Hole-by-hole gross and net scorecard">
        <div role="rowgroup"><div role="row" className="scorecard-head"><span role="columnheader">Hole</span><span role="columnheader">Par</span><span role="columnheader">SI</span><span role="columnheader">Gross</span><span role="columnheader">Strokes</span><span role="columnheader">Net</span></div></div>
        <div role="rowgroup">{holeRows.map((hole) => <div role="row" className="scorecard-row" key={hole.id}><span role="cell">{hole.hole_ordinal}</span><span role="cell">{hole.par}</span><span role="cell">{hole.stroke_index}</span><strong role="cell">{hole.score?.gross_strokes ?? statusShort(hole.score?.score_status)}</strong><span role="cell">{signedStrokes(hole.strokes)}</span><strong role="cell">{hole.net ?? '—'}</strong></div>)}</div>
        <div role="rowgroup"><div role="row" className="scorecard-total"><span role="cell">Thru</span><strong role="cell">{completed.length || '—'}</strong><span role="cell">Gross</span><strong role="cell">{completed.length ? grossTotal : '—'}</strong><span role="cell">Net</span><strong role="cell">{completed.length ? netTotal : '—'}</strong></div></div>
      </div>
      <section className="attestation-panel" aria-labelledby="attestation-title"><div><h2 id="attestation-title">Scorecard attestation</h2><p>{currentAttestation ? `Current revision signed as ${currentAttestation.attestation_type.replaceAll('_', ' ')}.` : attestations.length ? 'The card changed after its last attestation. Review and sign the current revision.' : 'Confirm that the current hole scores match the card.'}</p></div><button className="button button--primary" type="button" disabled={busy || Boolean(currentAttestation)} onClick={() => void attest()}>{busy ? 'Attesting…' : currentAttestation ? 'Current revision attested' : 'Attest scorecard'}</button></section>
    </div>
  );
}

function signedStrokes(strokes: number) {
  if (strokes === 0) return '—';
  return strokes > 0 ? `−${strokes}` : `+${Math.abs(strokes)}`;
}

function relationValue<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function statusShort(status?: string) {
  if (!status) return '—';
  return ({ picked_up: 'PU', no_score: 'NS', withdrawn: 'WD', disqualified: 'DQ', not_played: 'NP', conceded: 'C' } as Record<string, string>)[status] ?? '—';
}
