import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router';

import { relationName } from '../lib/row-display.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

export function Skins() {
  const { eventId = '', competitionId = '' } = useParams();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['skins', eventId, competitionId],
    enabled: Boolean(eventId && competitionId),
    refetchInterval: 10_000,
    queryFn: async () => {
      const supabase = getSupabaseClient();
      const [{ data: event }, { data: competition, error }] = await Promise.all([
        supabase.from('events').select('id,name,scoring_revision,status').eq('id', eventId).single(),
        supabase.from('competitions').select('id,name,status,rules_text').eq('id', competitionId).single(),
      ]);
      if (error || !event || !competition) throw error ?? new Error('Skins unavailable');
      const { data: projection } = await supabase.from('competition_projections').select('event_revision,status,calculated_at').eq('competition_id', competitionId).order('event_revision', { ascending: false }).limit(1).maybeSingle();
      const revision = projection?.event_revision ?? 0;
      const [{ data: outcomes }, { data: totals }] = await Promise.all([
        supabase.from('hole_results').select('entity_id,event_hole_id,skin_units,skin_carried_units,skin_winner,provisional,detail_json').eq('competition_id', competitionId).eq('event_revision', revision),
        supabase.from('leaderboard_rows').select('entity_id,result_primary').eq('competition_id', competitionId).eq('event_revision', revision).order('result_primary', { ascending: false }),
      ]);
      const entityIds = [...new Set([...(outcomes ?? []).map((row) => row.entity_id), ...(totals ?? []).map((row) => row.entity_id)])];
      const holeIds = (outcomes ?? []).map((row) => row.event_hole_id);
      const [{ data: entities }, { data: holes }] = await Promise.all([
        entityIds.length ? supabase.from('competition_entities').select('id,event_entry_id,event_team_id').in('id', entityIds) : Promise.resolve({ data: [] }),
        holeIds.length ? supabase.from('event_holes').select('id,hole_ordinal,par').in('id', holeIds) : Promise.resolve({ data: [] }),
      ]);
      const entryIds = (entities ?? []).map((entity) => entity.event_entry_id).filter((id): id is string => Boolean(id));
      const teamIds = (entities ?? []).map((entity) => entity.event_team_id).filter((id): id is string => Boolean(id));
      const [{ data: entries }, { data: teams }] = await Promise.all([
        entryIds.length ? supabase.from('event_entries').select('id,participants(display_name)').in('id', entryIds) : Promise.resolve({ data: [] }),
        teamIds.length ? supabase.from('event_teams').select('id,name').in('id', teamIds) : Promise.resolve({ data: [] }),
      ]);
      const entryNames = new Map((entries ?? []).map((entry) => [entry.id, relationName(entry.participants)]));
      const teamNames = new Map((teams ?? []).map((team) => [team.id, team.name]));
      const entityNames = new Map((entities ?? []).map((entity) => [entity.id, entity.event_entry_id ? entryNames.get(entity.event_entry_id) : teamNames.get(entity.event_team_id ?? '')]));
      const holeLookup = new Map((holes ?? []).map((hole) => [hole.id, hole]));
      return {
        event,
        competition,
        projection,
        outcomes: (outcomes ?? []).map((outcome) => ({ ...outcome, hole: holeLookup.get(outcome.event_hole_id), winnerName: outcome.skin_winner ? entityNames.get(outcome.entity_id) : null })).toSorted((a, b) => (a.hole?.hole_ordinal ?? 0) - (b.hole?.hole_ordinal ?? 0)),
        totals: (totals ?? []).map((total) => ({ ...total, name: entityNames.get(total.entity_id) ?? 'Player' })),
      };
    },
  });

  // Skins previously relied on the 10-second poll alone. The revision feed is
  // the same signal the Leaderboard already subscribes to; without it a skins
  // board can sit up to ten seconds behind a committed score.
  useEffect(() => {
    if (!eventId) return;
    const supabase = getSupabaseClient();
    const channel = supabase.channel(`skins-revision-${eventId}`).on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'event_revision_feed', filter: `event_id=eq.${eventId}` },
      () => void queryClient.invalidateQueries({ queryKey: ['skins', eventId, competitionId] }),
    ).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [competitionId, eventId, queryClient]);

  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--rows" /></div>;
  if (!query.data) return <p className="form-message form-message--error">Skins results are unavailable.</p>;
  const { event, competition, projection, outcomes, totals } = query.data;
  const lag = event.scoring_revision - (projection?.event_revision ?? 0);
  // Skins recorded no active state at all, so the bottom-nav result tab kept
  // pointing at whatever leaderboard was last opened — and RootLayout built a
  // /leaderboards/ path even when the active competition was this skins game.
  window.localStorage.setItem('gtt.activeEventId', event.id);
  window.localStorage.setItem('gtt.activeCompetitionId', competition.id);
  window.localStorage.setItem('gtt.activeResultPath', `/events/${eventId}/skins/${competition.id}`);

  return <div className="screen skins-screen">
    <header className="page-header page-header--split"><div><Link className="back-link" to={`/events/${eventId}`}>Back to {event.name}</Link><h1>{competition.name}</h1><p>{competition.rules_text}</p></div><div className="revision-badge"><span>Revision</span><strong>{projection?.event_revision ?? 0}</strong></div></header>
    {lag > 0 && <p className="form-message form-message--warning" role="status">Skins are updating from {lag} newer score revision{lag === 1 ? '' : 's'}.</p>}
    <section className="skins-totals" aria-labelledby="skins-totals-title"><div className="section-heading"><h2 id="skins-totals-title">Units won</h2><span>Units, not money</span></div>{totals.length === 0 ? <p className="empty-inline">No completed holes yet.</p> : <ol>{totals.map((total) => <li key={total.entity_id}><span>{total.name}</span><strong>{total.result_primary ?? 0}</strong></li>)}</ol>}</section>
    <section className="section-block" aria-labelledby="skins-holes-title"><div className="section-heading"><h2 id="skins-holes-title">Hole outcomes</h2><span>{outcomes.length} holes</span></div>{outcomes.length === 0 ? <div className="empty-state"><h2>Waiting for the first completed hole</h2><p>Ties carry the unit pool forward to the next hole.</p></div> : <div className="skins-holes">{outcomes.map((outcome) => <article key={outcome.event_hole_id}><div><strong>Hole {outcome.hole?.hole_ordinal ?? '—'}</strong><span>Par {outcome.hole?.par ?? '—'}</span></div><p>{outcome.skin_winner ? `${outcome.winnerName ?? 'Winner'} won ${outcome.skin_units ?? 0} unit${outcome.skin_units === 1 ? '' : 's'}` : outcome.provisional ? 'Provisional' : 'Tied · carries forward'}</p><small>{outcome.skin_carried_units ? `${outcome.skin_carried_units} carried in` : 'Fresh unit'}</small></article>)}</div>}</section>
    <footer className="board-footer">{projection ? `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(projection.calculated_at))}` : 'Projection pending'}</footer>
  </div>;
}

