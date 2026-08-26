/**
 * Player dashboard (spec §5.2): active event, next group time, resume
 * scorecard, sync/outbox warning, and recent/future events.
 */
export function Dashboard() {
  const { profile } = useSession();
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const supabase = getSupabaseClient();
      const [{ data: events, error }, { data: roles }] = await Promise.all([
        supabase.from('events').select('id,league_id,name,starts_at,status,visibility').order('starts_at'),
        supabase.from('role_assignments').select('league_id,event_id,role').is('revoked_at', null),
      ]);
      if (error) throw error;
      const rows = (events ?? []) as EventRow[];
      const ids = rows.map((event) => event.id);
      const { data: competitions } = ids.length
        ? await supabase.from('competitions').select('id,event_id,name,status').in('event_id', ids).order('sort_order')
        : { data: [] };
      return { events: rows, roles: roles ?? [], competitions: competitions ?? [] };
    },
  });

  if (query.isLoading) return <DashboardSkeleton />;
  if (query.error) return <p className="form-message form-message--error" role="alert">Could not load events. Check your connection and try again.</p>;
  const events = query.data?.events ?? [];
  const active = events.find((event) => event.status === 'scoring_open')
    ?? events.find((event) => ['published', 'draft'].includes(event.status));
  const competition = query.data?.competitions.find((item) => item.event_id === active?.id);
  const canOrganize = query.data?.roles.some((role) => ['owner', 'league_admin'].includes(role.role)) ?? false;
  // The league catalog screens (players, courses, seasons) are only reachable
  // by league id. Derive it from the role rows already loaded above so a fresh
  // owner never has to know or type a UUID to reach their own prerequisites.
  const organizerLeagueId = query.data?.roles.find((role) =>
    ['owner', 'league_admin'].includes(role.role) && role.league_id !== null)?.league_id ?? null;

  if (active) {
    window.localStorage.setItem('gtt.activeEventId', active.id);
    if (competition) window.localStorage.setItem('gtt.activeCompetitionId', competition.id);
  }

  return (
    <div className="screen dashboard-screen">
      <header className="page-header page-header--split">
        <div>
          <h1>Good round, {profile?.displayName.split(' ')[0] ?? 'golfer'}.</h1>
          <p>{active ? 'Your event is ready.' : 'No active event is assigned yet.'}</p>
        </div>
        {canOrganize && (
          <div className="action-row">
            {organizerLeagueId && <Link className="button button--quiet" to={`/league/${organizerLeagueId}`}>League setup</Link>}
            <Link className="button button--quiet" to="/admin/events/new/setup">Create event</Link>
          </div>
        )}
      </header>

      {active ? (
        <section className="active-event" aria-labelledby="active-event-title">
          <div className="event-status-line">
            <span className={`status-dot status-dot--${active.status}`} />
            <span>{statusLabel(active.status)}</span>
          </div>
          <h2 id="active-event-title">{active.name}</h2>
          <p>{new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(active.starts_at))}</p>
          <div className="action-row">
            {active.status === 'scoring_open' && <Link className="button button--primary" to={`/events/${active.id}/score`}>Resume scoring</Link>}
            <Link className="button button--secondary" to={`/events/${active.id}`}>Event details</Link>
            {competition && <Link className="text-link" to={`/events/${active.id}/leaderboards/${competition.id}`}>View leaderboard</Link>}
          </div>
        </section>
      ) : canOrganize && events.length === 0 ? (
        // A fresh owner has no events because nothing is set up yet, not
        // because they are caught up. An event cannot be created without a
        // season, a rated tee, and players carrying current handicaps, so say
        // that and link to the screens that create them.
        <section className="empty-state">
          <h2>Set up your league</h2>
          <p>
            Creating an event needs a season, a course with a rated tee, and players
            with current handicap values. League setup holds all three.
          </p>
          <div className="action-row">
            {organizerLeagueId && <Link className="button button--primary" to={`/league/${organizerLeagueId}`}>Open league setup</Link>}
            <Link className="button button--secondary" to="/admin/events/new/setup">Create event</Link>
          </div>
        </section>
      ) : (
        <section className="empty-state">
          <h2>You’re all caught up</h2>
          <p>Published and active league events will appear here.</p>
        </section>
      )}

      <section className="section-block" aria-labelledby="schedule-title">
        <div className="section-heading"><h2 id="schedule-title">Event schedule</h2><span>{events.length}</span></div>
        <div className="event-list">
          {events.length === 0 ? <p className="muted">No events available.</p> : events.map((event) => (
            <Link className="event-row" to={event.status === 'draft' ? `/admin/events/${event.id}/setup` : `/events/${event.id}`} key={event.id}>
              <time dateTime={event.starts_at}>
                <strong>{new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(event.starts_at))}</strong>
                <span>{new Date(event.starts_at).getDate()}</span>
              </time>
              <div><strong>{event.name}</strong><span>{statusLabel(event.status)}</span></div>
              <span aria-hidden="true">View</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function statusLabel(status: string) {
  return ({ draft: 'Draft setup', published: 'Published', scoring_open: 'Scoring open', scoring_closed: 'Scoring closed', finalized: 'Final results', archived: 'Archived' } as Record<string, string>)[status] ?? status;
}

function DashboardSkeleton() {
  return <div className="screen" aria-label="Loading dashboard"><div className="skeleton skeleton--heading" /><div className="skeleton skeleton--event" /><div className="skeleton skeleton--rows" /></div>;
}
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { useSession } from '../lib/session.tsx';
import { getSupabaseClient } from '../lib/supabase.ts';

interface EventRow {
  id: string;
  league_id: string;
  name: string;
  starts_at: string;
  status: string;
  visibility: string;
}
