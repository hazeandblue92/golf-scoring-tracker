import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';

import { getSupabaseClient } from '../lib/supabase.ts';

export function Leaderboard() {
  const { eventId = '', competitionId = '' } = useParams();
  const queryClient = useQueryClient();
  // Declared above the early returns: hooks cannot sit behind a loading guard.
  const [flightFilter, setFlightFilter] = useState<string>('all');
  const query = useQuery({
    queryKey: ['leaderboard', eventId, competitionId],
    enabled: eventId !== '' && competitionId !== '',
    refetchInterval: 10_000,
    queryFn: async () => {
      const supabase = getSupabaseClient();
      const [{ data: event, error }, { data: competition }] = await Promise.all([
        supabase.from('events').select('id,name,status,scoring_revision').eq('id', eventId).single(),
        supabase.from('competitions').select('id,name,format,metric,status,final_result_hash,rules_text').eq('id', competitionId).single(),
      ]);
      if (error || !event || !competition) throw error ?? new Error('Leaderboard unavailable');
      const { data: flights } = await supabase.from('flights').select('id,name,sort_order').eq('event_id', eventId).order('sort_order');
      const { data: projection } = await supabase.from('competition_projections').select('event_revision,status,calculated_at,warnings,projection_hash').eq('competition_id', competitionId).order('event_revision', { ascending: false }).limit(1).maybeSingle();
      const revision = projection?.event_revision ?? 0;
      const { data: rows } = await supabase.from('leaderboard_rows').select('entity_id,rank,is_tied,thru,result_primary,result_secondary,display_primary,status,detail_json').eq('competition_id', competitionId).eq('event_revision', revision).order('rank', { nullsFirst: false });
      const entityIds = (rows ?? []).map((row) => row.entity_id);
      const { data: entities } = entityIds.length
        ? await supabase.from('competition_entities').select('id,event_entry_id,event_team_id').in('id', entityIds)
        : { data: [] };
      const entryIds = (entities ?? []).map((entity) => entity.event_entry_id).filter((id): id is string => Boolean(id));
      const teamIds = (entities ?? []).map((entity) => entity.event_team_id).filter((id): id is string => Boolean(id));
      const [{ data: entries }, { data: teams }] = await Promise.all([
        entryIds.length ? supabase.from('event_entries').select('id,participants(display_name)').in('id', entryIds) : Promise.resolve({ data: [] }),
        teamIds.length ? supabase.from('event_teams').select('id,name').in('id', teamIds) : Promise.resolve({ data: [] }),
      ]);
      const entityLookup = new Map((entities ?? []).map((entity) => [entity.id, entity]));
      const entryNames = new Map((entries ?? []).map((entry) => [entry.id, relationName(entry.participants)]));
      const teamNames = new Map((teams ?? []).map((team) => [team.id, team.name]));
      return {
        event,
        competition,
        projection,
        flights: flights ?? [],
        rows: (rows ?? []).map((row) => {
          const entity = entityLookup.get(row.entity_id);
          return {
            ...row,
            entryId: entity?.event_entry_id ?? null,
            teamId: entity?.event_team_id ?? null,
            name: entity?.event_entry_id
              ? entryNames.get(entity.event_entry_id) ?? 'Player'
              : teamNames.get(entity?.event_team_id ?? '') ?? 'Team',
          };
        }),
      };
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

  // Flights present on the rows themselves, so the filter only appears for a
  // competition that is actually flighted (§5.2) rather than on every board.
  const flightIdsInPlay = useMemo(() => {
    const ids = new Set<string>();
    for (const row of query.data?.rows ?? []) {
      const flightId = (row.detail_json as { flightId?: string } | null)?.flightId;
      if (flightId) ids.add(flightId);
    }
    return ids;
  }, [query.data]);

  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--rows" /></div>;
  if (!query.data) return <p className="form-message form-message--error">Leaderboard unavailable. The last saved scorecard remains authoritative.</p>;
  const { event, competition, projection, rows, flights } = query.data;
  window.localStorage.setItem('gtt.activeEventId', event.id);
  window.localStorage.setItem('gtt.activeCompetitionId', competition.id);
  const lag = event.scoring_revision - (projection?.event_revision ?? 0);
  const resultLabel = competition.metric === 'points' ? 'Points' : competition.metric === 'net' ? 'Net' : 'Gross';
  const entityLabel = ['best_k', 'aggregate', 'scramble', 'foursomes', 'greensomes', 'chapman', 'shamble'].includes(competition.format) ? 'Team' : 'Player';
  const visibleRows = flightFilter === 'all'
    ? rows
    : rows.filter((row) => (row.detail_json as { flightId?: string } | null)?.flightId === flightFilter);

  return (
    <div className="screen board-screen">
      <header className="page-header page-header--split">
        <div><Link className="back-link" to={`/events/${eventId}`}>Back to {event.name}</Link><h1>{competition.name}</h1><p>{competition.status === 'finalized' ? 'Official final results' : competition.rules_text}</p></div>
        <div className="revision-badge"><span>Revision</span><strong>{projection?.event_revision ?? 0}</strong></div>
      </header>
      {lag > 0 && <p className="form-message form-message--warning" role="status">Results are updating from {lag} newer score revision{lag === 1 ? '' : 's'}.</p>}
      {projection?.status !== 'final' && <p className="provisional-banner">Provisional until scoring is closed and every competition is finalized.</p>}

      {flightIdsInPlay.size > 0 && (
        <div className="flight-filter" role="group" aria-label="Filter by flight">
          <button
            type="button"
            className={`chip${flightFilter === 'all' ? ' chip--active' : ''}`}
            aria-pressed={flightFilter === 'all'}
            onClick={() => setFlightFilter('all')}
          >
            Overall
          </button>
          {flights
            .filter((flight) => flightIdsInPlay.has(flight.id))
            .map((flight) => (
              <button
                key={flight.id}
                type="button"
                className={`chip${flightFilter === flight.id ? ' chip--active' : ''}`}
                aria-pressed={flightFilter === flight.id}
                onClick={() => setFlightFilter(flight.id)}
              >
                {flight.name}
              </button>
            ))}
        </div>
      )}

      <div className="leaderboard" role="table" aria-label={`${competition.name} standings`}>
        <div className="leaderboard-head" role="row"><span role="columnheader">Rank</span><span role="columnheader">{entityLabel}</span><span role="columnheader">Thru</span><span role="columnheader">{resultLabel}</span></div>
        {visibleRows.length === 0 ? <div className="empty-state"><h2>Waiting for the first score</h2><p>This board refreshes automatically and also polls if live updates are interrupted.</p></div> : visibleRows.map((row) => {
          const scorecardPath = row.entryId
            ? `/events/${eventId}/scorecard/${row.entryId}`
            : row.teamId
              ? `/events/${eventId}/team-scorecard/${row.teamId}`
              : null;
          return <div className="leaderboard-row" role="row" key={row.entity_id}>
            <span role="cell" className="rank">{row.rank === null ? '—' : `${row.is_tied ? 'T' : ''}${row.rank}`}</span>
            <span role="cell">
              {scorecardPath
                ? <Link className="leaderboard-name-link" to={scorecardPath}><strong>{row.name}</strong><small>{row.status}</small></Link>
                : <><strong>{row.name}</strong><small>{row.status}</small></>}
            </span>
            <span role="cell">{row.thru ?? '—'}</span>
            <span role="cell" className="result">{row.result_primary ?? '—'}</span>
          </div>;
        })}
      </div>
      <footer className="board-footer">{projection ? `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(projection.calculated_at))}` : 'Projection pending'}{competition.final_result_hash && <code title="Final result hash">{competition.final_result_hash.slice(0, 12)}…</code>}</footer>
    </div>
  );
}

function relationName(value: { display_name: string } | { display_name: string }[] | null) {
  return (Array.isArray(value) ? value[0]?.display_name : value?.display_name) ?? 'Player';
}
