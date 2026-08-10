import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { getSupabaseClient } from '../lib/supabase.ts';

export function Scorecard() {
  const { eventId = '', entryId = '' } = useParams();
  const query = useQuery({
    queryKey: ['scorecard', eventId, entryId],
    queryFn: async () => {
      const supabase = getSupabaseClient();
      const [{ data: event }, { data: entry, error }, { data: rounds }] = await Promise.all([
        supabase.from('events').select('name,status').eq('id', eventId).single(),
        supabase.from('event_entries').select('id,playing_handicap,participants(display_name)').eq('id', entryId).single(),
        supabase.from('rounds').select('id').eq('event_id', eventId).order('round_number'),
      ]);
      if (error || !entry) throw error ?? new Error('Scorecard unavailable');
      const roundIds = (rounds ?? []).map((round) => round.id);
      const [{ data: holes }, { data: scores }] = await Promise.all([
        supabase.from('event_holes').select('id,hole_ordinal,par,stroke_index').in('round_id', roundIds).order('hole_ordinal'),
        supabase.from('individual_hole_scores').select('event_hole_id,gross_strokes,score_status,revision').eq('event_entry_id', entryId),
      ]);
      return { event, entry, holes: holes ?? [], scores: scores ?? [] };
    },
  });
  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--rows" /></div>;
  if (!query.data) return <p className="form-message form-message--error">Scorecard unavailable.</p>;
  const { event, entry, holes, scores } = query.data;
  const byHole = new Map(scores.map((score) => [score.event_hole_id, score]));
  const out = holes.slice(0, 9).reduce((sum, hole) => sum + (byHole.get(hole.id)?.gross_strokes ?? 0), 0);
  const inward = holes.slice(9).reduce((sum, hole) => sum + (byHole.get(hole.id)?.gross_strokes ?? 0), 0);
  const participantRelation = entry.participants as unknown as
    | { display_name: string }
    | { display_name: string }[]
    | null;
  const participantName = Array.isArray(participantRelation)
    ? participantRelation[0]?.display_name
    : participantRelation?.display_name;
  return (
    <div className="screen scorecard-screen">
      <header className="page-header"><Link className="back-link" to={`/events/${eventId}`}>Back to {event?.name ?? 'event'}</Link><h1>{participantName ?? 'Player'}’s scorecard</h1><p>Playing handicap {entry.playing_handicap ?? '—'} · {event?.status === 'finalized' ? 'Final' : 'Provisional'}</p></header>
      <div className="scorecard-table" role="table" aria-label="Hole-by-hole scorecard">
        <div role="row" className="scorecard-head"><span>Hole</span><span>Par</span><span>SI</span><span>Gross</span></div>
        {holes.map((hole) => { const score = byHole.get(hole.id); return <div role="row" className="scorecard-row" key={hole.id}><span>{hole.hole_ordinal}</span><span>{hole.par}</span><span>{hole.stroke_index}</span><strong>{score?.gross_strokes ?? statusShort(score?.score_status)}</strong></div>; })}
        <div className="scorecard-total"><span>Out</span><strong>{out || '—'}</strong><span>In</span><strong>{inward || '—'}</strong><span>Total</span><strong>{out + inward || '—'}</strong></div>
      </div>
    </div>
  );
}

function statusShort(status?: string) {
  if (!status) return '—';
  return ({ picked_up: 'PU', no_score: 'NS', withdrawn: 'WD', disqualified: 'DQ', not_played: 'NP', conceded: 'C' } as Record<string, string>)[status] ?? '—';
}
