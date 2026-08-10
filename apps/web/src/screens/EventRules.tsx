/**
 * Event rules (spec §5.1 /events/:eventId/rules): the published Terms of
 * Competition — generated rules text with the structured form as the
 * authority (spec §6.1).
 */
export function EventRules() {
  const { eventId = '' } = useParams();
  const query = useQuery({ queryKey: ['rules', eventId], queryFn: async () => {
    const supabase = getSupabaseClient();
    const [{ data: event }, { data: competitions, error }] = await Promise.all([
      supabase.from('events').select('name,published_snapshot_version').eq('id', eventId).single(),
      supabase.from('competitions').select('id,name,rules_text,rules_json').eq('event_id', eventId).order('sort_order'),
    ]);
    if (error) throw error;
    return { event, competitions: competitions ?? [] };
  }});
  return (
    <div className="screen narrow-screen"><header className="page-header"><Link className="back-link" to={`/events/${eventId}`}>Back to {query.data?.event?.name ?? 'event'}</Link><h1>Terms of competition</h1><p>Snapshot version {query.data?.event?.published_snapshot_version ?? 'draft'}</p></header>{query.isLoading ? <div className="skeleton skeleton--rows" /> : query.data?.competitions.map((competition) => <section className="rules-section" key={competition.id}><h2>{competition.name}</h2><p>{competition.rules_text}</p><dl><dt>Format</dt><dd>Individual stroke play</dd><dt>Metric</dt><dd>Gross strokes</dd><dt>Incomplete cards</dt><dd>Provisional live; no return at final</dd><dt>Ties</dt><dd>Tied rank</dd></dl></section>)}</div>
  );
}
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { getSupabaseClient } from '../lib/supabase.ts';
