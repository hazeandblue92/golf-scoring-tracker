import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router';

import { getSupabaseClient } from '../lib/supabase.ts';

export function Leaderboard() {
  const { eventId = '', competitionId = '' } = useParams();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['leaderboard', eventId, competitionId],
    enabled: eventId !== '' && competitionId !== '',
    refetchInterval: 10_000,
    queryFn: async () => {
      const supabase = getSupabaseClient();
      const [{ data: event, error }, { data: competition }] = await Promise.all([
        supabase.from('events').select('id,name,status,scoring_revision').eq('id', eventId).single(),
        supabase.from('competitions').select('id,name,metric,status,final_result_hash').eq('id', competitionId).single(),
      ]);
      if (error || !event || !competition) throw error ?? new Error('Leaderboard unavailable');
      const { data: projection } = await supabase.from('competition_projections').select('event_revision,status,calculated_at,warnings,projection_hash').eq('competition_id', competitionId).order('event_revision', { ascending: false }).limit(1).maybeSingle();
      const revision = projection?.event_revision ?? 0;
      const { data: rows } = await supabase.from('leaderboard_rows').select('entity_id,rank,is_tied,thru,result_primary,result_secondary,display_primary,status,detail_json').eq('competition_id', competitionId).eq('event_revision', revision).order('rank', { nullsFirst: false });
      const entityIds = (rows ?? []).map((row) => row.entity_id);
      const { data: entities } = entityIds.length
        ? await supabase.from('competition_entities').select('id,event_entry_id').in('id', entityIds)
        : { data: [] };
      const entryIds = (entities ?? []).map((entity) => entity.event_entry_id).filter(Boolean);
      const { data: entries } = entryIds.length
        ? await supabase.from('event_entries').select('id,participants(display_name)').in('id', entryIds)
        : { data: [] };
      const entityToEntry = new Map((entities ?? []).map((entity) => [entity.id, entity.event_entry_id]));
      const entryToName = new Map((entries ?? []).map((entry) => [entry.id, relationName(entry.participants)]));
      return { event, competition, projection, rows: (rows ?? []).map((row) => ({ ...row, entryId: entityToEntry.get(row.entity_id), name: entryToName.get(entityToEntry.get(row.entity_id) ?? '') ?? 'Player' })) };
    },
  });

  useEffect(() => {
    if (!eventId) return;
    const supabase = getSupabaseClient();
    const channel = supabase.channel(`event-revision-${eventId}`).on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'event_revision_feed', filter: `event_id=eq.${eventId}` },
      () => void queryClient.invalidateQueries({ queryKey: ['leaderboard', eventId, competitionId] }),
    ).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [competitionId, eventId, queryClient]);

  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--rows" /></div>;
  if (!query.data) return <p className="form-message form-message--error">Leaderboard unavailable. The last saved scorecard remains authoritative.</p>;
  const { event, competition, projection, rows } = query.data;
  window.localStorage.setItem('gtt.activeEventId', event.id);
  window.localStorage.setItem('gtt.activeCompetitionId', competition.id);
  const lag = event.scoring_revision - (projection?.event_revision ?? 0);

  return (
    <div className="screen board-screen">
      <header className="page-header page-header--split">
        <div><Link className="back-link" to={`/events/${eventId}`}>Back to {event.name}</Link><h1>{competition.name}</h1><p>{competition.status === 'finalized' ? 'Official final results' : 'Live individual gross standings'}</p></div>
        <div className="revision-badge"><span>Revision</span><strong>{projection?.event_revision ?? 0}</strong></div>
      </header>
      {lag > 0 && <p className="form-message form-message--warning" role="status">Leaderboard is updating from {lag} newer score revision{lag === 1 ? '' : 's'}.</p>}
      {projection?.status !== 'final' && <p className="provisional-banner">Provisional until scoring is closed and finalized.</p>}

      <div className="leaderboard" role="table" aria-label={`${competition.name} standings`}>
        <div className="leaderboard-head" role="row"><span role="columnheader">Rank</span><span role="columnheader">Player</span><span role="columnheader">Thru</span><span role="columnheader">Gross</span></div>
        {rows.length === 0 ? <div className="empty-state"><h2>Waiting for the first score</h2><p>This board refreshes automatically and also polls if live updates are interrupted.</p></div> : rows.map((row) => (
          <Link className="leaderboard-row" role="row" key={row.entity_id} to={`/events/${eventId}/scorecard/${row.entryId}`}>
            <span role="cell" className="rank">{row.rank === null ? '—' : `${row.is_tied ? 'T' : ''}${row.rank}`}</span>
            <span role="cell"><strong>{row.name}</strong><small>{row.status}</small></span>
            <span role="cell">{row.thru ?? '—'}</span>
            <span role="cell" className="result">{row.result_primary ?? '—'}</span>
          </Link>
        ))}
      </div>
      <footer className="board-footer">{projection ? `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(projection.calculated_at))}` : 'Projection pending'}{competition.final_result_hash && <code title="Final result hash">{competition.final_result_hash.slice(0, 12)}…</code>}</footer>
    </div>
  );
}

function relationName(value: { display_name: string } | { display_name: string }[] | null) { return (Array.isArray(value) ? value[0]?.display_name : value?.display_name) ?? 'Player'; }
