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
      const flightId = flightIdFrom(row.detail_json);
      if (flightId) ids.add(flightId);
    }
    return ids;
  }, [query.data]);
  const selectableFlightIds = useMemo(() => new Set(
    (query.data?.flights ?? [])
      .filter((flight) => flightIdsInPlay.has(flight.id))
      .map((flight) => flight.id),
  ), [flightIdsInPlay, query.data]);

  useEffect(() => {
    setFlightFilter('all');
  }, [competitionId, eventId]);

  useEffect(() => {
    setFlightFilter((current) =>
      current === 'all' || selectableFlightIds.has(current) ? current : 'all');
  }, [selectableFlightIds]);

  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--rows" /></div>;
  if (!query.data) return <p className="form-message form-message--error">Leaderboard unavailable. The last saved scorecard remains authoritative.</p>;
  const { event, competition, projection, rows, flights } = query.data;
  window.localStorage.setItem('gtt.activeEventId', event.id);
  window.localStorage.setItem('gtt.activeCompetitionId', competition.id);
  const lag = event.scoring_revision - (projection?.event_revision ?? 0);
  const resultLabel = competition.metric === 'points' ? 'Points' : competition.metric === 'net' ? 'Net' : 'Gross';
  const entityLabel = ['best_k', 'aggregate', 'scramble', 'foursomes', 'greensomes', 'chapman', 'shamble'].includes(competition.format) ? 'Team' : 'Player';
  const visibleRows = rowsForDisplay(rows, flightFilter, competition.metric, competition.format);
  const selectedFlightName = flights.find((flight) => flight.id === flightFilter)?.name;

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

      <div className="leaderboard" role="table" aria-label={`${competition.name} ${selectedFlightName ?? 'overall'} standings`}>
        <div className="leaderboard-head" role="row"><span role="columnheader">Rank</span><span role="columnheader">{entityLabel}</span><span role="columnheader">Thru</span><span role="columnheader">{resultLabel}</span></div>
        {visibleRows.length === 0 ? <div className="empty-state"><h2>Waiting for the first score</h2><p>This board refreshes automatically and also polls if live updates are interrupted.</p></div> : visibleRows.map((row) => {
          const scorecardPath = row.entryId
            ? `/events/${eventId}/scorecard/${row.entryId}`
            : row.teamId
              ? `/events/${eventId}/team-scorecard/${row.teamId}`
              : null;
          return <div className="leaderboard-row" role="row" key={row.entity_id}>
            <span role="cell" className="rank">{row.displayRank === null ? '—' : `${row.displayIsTied ? 'T' : ''}${row.displayRank}`}</span>
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

interface BoardRow {
  entity_id: string;
  rank: number | null;
  is_tied: boolean;
  thru: number | null;
  result_primary: number | null;
  status: string;
  detail_json: unknown;
  entryId: string | null;
  teamId: string | null;
  name: string;
}

interface Placement {
  rank: number | null;
  isTied: boolean;
}

const displayNameCollator = new Intl.Collator('en-US', {
  numeric: true,
  sensitivity: 'base',
});

function flightIdFrom(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const flightId = (detail as Record<string, unknown>).flightId;
  return typeof flightId === 'string' ? flightId : null;
}

function rowsForDisplay(
  rows: readonly BoardRow[],
  flightFilter: string,
  metric: string,
  format: string,
) {
  const filtered = flightFilter === 'all'
    ? [...rows]
    : rows.filter((row) => flightIdFrom(row.detail_json) === flightFilter);
  const fallback = overallPlacements(
    rows,
    metric === 'points' || format === 'stableford' || format === 'par_bogey'
      ? 'desc'
      : 'asc',
  );

  return filtered.map((row) => {
    if (flightFilter !== 'all') {
      return { ...row, displayRank: row.rank, displayIsTied: row.is_tied };
    }
    const detailRank = overallRankFrom(row.detail_json);
    const detailTied = overallIsTiedFrom(row.detail_json);
    const fallbackPlacement = fallback.get(row.entity_id) ?? { rank: null, isTied: false };
    return {
      ...row,
      displayRank: detailRank === undefined ? fallbackPlacement.rank : detailRank,
      displayIsTied: detailTied ?? fallbackPlacement.isTied,
    };
  }).sort((left, right) => {
    if (left.displayRank === null && right.displayRank !== null) return 1;
    if (left.displayRank !== null && right.displayRank === null) return -1;
    if (left.displayRank !== right.displayRank) {
      return (left.displayRank as number) - (right.displayRank as number);
    }
    const byName = displayNameCollator.compare(left.name, right.name);
    return byName !== 0 ? byName : left.entity_id.localeCompare(right.entity_id);
  });
}

function overallPlacements(
  rows: readonly BoardRow[],
  direction: 'asc' | 'desc',
): Map<string, Placement> {
  const ranked = rows
    .filter((row) => row.rank !== null && row.result_primary !== null)
    .toSorted((left, right) => {
      const byResult = direction === 'asc'
        ? (left.result_primary as number) - (right.result_primary as number)
        : (right.result_primary as number) - (left.result_primary as number);
      return byResult !== 0 ? byResult : left.entity_id.localeCompare(right.entity_id);
    });
  const resultCounts = new Map<number, number>();
  for (const row of ranked) {
    const result = row.result_primary as number;
    resultCounts.set(result, (resultCounts.get(result) ?? 0) + 1);
  }

  const placements = new Map<string, Placement>();
  let previousResult: number | undefined;
  let previousRank = 1;
  for (const [index, row] of ranked.entries()) {
    const result = row.result_primary as number;
    const rank = result === previousResult ? previousRank : index + 1;
    placements.set(row.entity_id, {
      rank,
      isTied: (resultCounts.get(result) ?? 0) > 1,
    });
    previousResult = result;
    previousRank = rank;
  }
  for (const row of rows) {
    if (!placements.has(row.entity_id)) {
      placements.set(row.entity_id, { rank: null, isTied: false });
    }
  }
  return placements;
}

function overallRankFrom(detail: unknown): number | null | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const record = detail as Record<string, unknown>;
  if (!Object.hasOwn(record, 'overallRank')) return undefined;
  if (record.overallRank === null) return null;
  return typeof record.overallRank === 'number'
    && Number.isInteger(record.overallRank)
    && record.overallRank > 0
    ? record.overallRank
    : undefined;
}

function overallIsTiedFrom(detail: unknown): boolean | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const value = (detail as Record<string, unknown>).overallIsTied;
  return typeof value === 'boolean' ? value : undefined;
}
