/**
 * Event home (spec §5.2): status, course/tees, group, notices, terms
 * summary, score action, leaderboards, format tabs, and offline
 * availability.
 */
export function EventHome() {
  const { eventId = '' } = useParams();
  const query = useQuery({
    queryKey: ['event-home', eventId],
    enabled: eventId !== '',
    queryFn: async () => {
      const supabase = getSupabaseClient();
      const { data: event, error } = await supabase.from('events').select('id,league_id,name,starts_at,status,scoring_revision').eq('id', eventId).single();
      if (error) throw error;
      const { data: rounds } = await supabase.from('rounds').select('id,name,status,event_tee_snapshots(course_name,layout_name,tee_name,par)').eq('event_id', eventId).order('round_number');
      const { data: competitions } = await supabase.from('competitions').select('id,name,rules_text,status,metric').eq('event_id', eventId).order('sort_order');
      const [{ data: groups }, { data: roles }] = await Promise.all([
        supabase.from('groups').select('id,label,starts_at,start_hole_ordinal').in('round_id', (rounds ?? []).map((row) => row.id)),
        supabase.from('role_assignments').select('role,league_id,event_id').is('revoked_at', null),
      ]);
      return { event, rounds: rounds ?? [], competitions: competitions ?? [], groups: groups ?? [], roles: roles ?? [] };
    },
  });
  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--event" /></div>;
  if (!query.data) return <p className="form-message form-message--error">This event is unavailable.</p>;
  const { event, rounds, competitions, groups } = query.data;
  const round = rounds[0];
  const snapshot = Array.isArray(round?.event_tee_snapshots) ? round.event_tee_snapshots[0] : round?.event_tee_snapshots;
  const competition = competitions[0];
  const canOrganize = query.data.roles.some((role) =>
    (['owner', 'league_admin'].includes(role.role) && role.league_id === event.league_id)
    || (role.role === 'event_director' && role.event_id === event.id));
  window.localStorage.setItem('gtt.activeEventId', event.id);
  if (competition) window.localStorage.setItem('gtt.activeCompetitionId', competition.id);

  return (
    <div className="screen event-screen">
      <header className="event-masthead">
        <div className="event-status-line"><span className={`status-dot status-dot--${event.status}`} />{event.status.replaceAll('_', ' ')}</div>
        <h1>{event.name}</h1>
        <p>{new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(event.starts_at))}</p>
      </header>

      <div className="event-facts" aria-label="Event facts">
        <div><span>Course</span><strong>{snapshot?.course_name ?? 'Set at publish'}</strong></div>
        <div><span>Tee</span><strong>{snapshot?.tee_name ?? 'Not published'}</strong></div>
        <div><span>Format</span><strong>Individual gross</strong></div>
        <div><span>Group</span><strong>{groups[0]?.label ?? 'Field'}</strong></div>
      </div>

      <div className="event-primary-actions">
        {event.status === 'scoring_open' && <Link className="button button--primary button--large" to={`/events/${event.id}/score`}>Enter scores</Link>}
        {competition && <Link className="button button--secondary button--large" to={`/events/${event.id}/leaderboards/${competition.id}`}>Live leaderboard</Link>}
        {canOrganize && <Link className="button button--quiet button--large" to={event.status === 'draft' ? `/admin/events/${event.id}/setup` : `/admin/events/${event.id}/scoring`}>{event.status === 'draft' ? 'Continue setup' : 'Control room'}</Link>}
      </div>

      <section className="section-block" aria-labelledby="terms-title">
        <div className="section-heading"><h2 id="terms-title">Terms of competition</h2><Link to={`/events/${event.id}/rules`}>Full rules</Link></div>
        <p>{competition?.rules_text ?? 'Rules will be frozen when the event is published.'}</p>
        <dl className="revision-line"><dt>Scoring revision</dt><dd>{event.scoring_revision}</dd></dl>
      </section>
    </div>
  );
}
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { getSupabaseClient } from '../lib/supabase.ts';
