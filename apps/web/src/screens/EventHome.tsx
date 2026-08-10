import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { useSession } from '../lib/session.tsx';
import { getSupabaseClient } from '../lib/supabase.ts';

/**
 * Event home (spec §5.2): status, course/tees, viewer-aware group, terms,
 * score action, and all simultaneous competition results.
 */
export function EventHome() {
  const { eventId = '' } = useParams();
  const { session } = useSession();
  const viewerId = session?.user.id ?? null;
  const query = useQuery({
    queryKey: ['event-home', eventId, viewerId],
    enabled: eventId !== '',
    queryFn: async () => {
      const supabase = getSupabaseClient();
      const { data: event, error } = await supabase.from('events').select('id,league_id,name,starts_at,status,scoring_revision').eq('id', eventId).single();
      if (error) throw error;
      const { data: rounds } = await supabase.from('rounds').select('id,name,status,event_tee_snapshots(course_name,layout_name,tee_name,par)').eq('event_id', eventId).order('round_number');
      const { data: competitions } = await supabase.from('competitions').select('id,name,rules_text,status,metric,format').eq('event_id', eventId).order('sort_order');
      const roundIds = (rounds ?? []).map((row) => row.id);
      const [{ data: groups }, { data: roles }, { data: viewerEntry }] = await Promise.all([
        roundIds.length
          ? supabase.from('groups').select('id,label,starts_at,start_hole_ordinal,sort_order').in('round_id', roundIds).order('sort_order')
          : Promise.resolve({ data: [] }),
        supabase.from('role_assignments').select('role,league_id,event_id').is('revoked_at', null),
        viewerId
          ? supabase.from('event_entries').select('id,participants!inner(profile_id)').eq('event_id', eventId).eq('participants.profile_id', viewerId).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      const groupIds = (groups ?? []).map((group) => group.id);
      const [{ data: groupMembers }, { data: viewerTeams }] = await Promise.all([
        groupIds.length
          ? supabase.from('group_members').select('group_id,event_entry_id,event_team_id').in('group_id', groupIds)
          : Promise.resolve({ data: [] }),
        viewerEntry
          ? supabase.from('event_team_members').select('event_team_id').eq('event_entry_id', viewerEntry.id)
          : Promise.resolve({ data: [] }),
      ]);
      return {
        event,
        rounds: rounds ?? [],
        competitions: competitions ?? [],
        groups: groups ?? [],
        roles: roles ?? [],
        viewerEntryId: viewerEntry?.id ?? null,
        viewerTeamIds: new Set((viewerTeams ?? []).map((team) => team.event_team_id)),
        groupMembers: groupMembers ?? [],
      };
    },
  });
  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--event" /></div>;
  if (!query.data) return <p className="form-message form-message--error">This event is unavailable.</p>;
  const { event, rounds, competitions, groups, viewerEntryId, viewerTeamIds, groupMembers } = query.data;
  const round = rounds[0];
  const snapshot = Array.isArray(round?.event_tee_snapshots) ? round.event_tee_snapshots[0] : round?.event_tee_snapshots;
  const competition = competitions[0];
  const canOrganize = query.data.roles.some((role) =>
    (['owner', 'league_admin'].includes(role.role) && role.league_id === event.league_id)
    || (role.role === 'event_director' && role.event_id === event.id));
  const viewerGroup = groups.find((group) => groupMembers.some((member) =>
    member.group_id === group.id
    && (member.event_entry_id === viewerEntryId
      || (member.event_team_id !== null && viewerTeamIds.has(member.event_team_id)))));
  const groupSummary = canOrganize
    ? `${groups.length} group${groups.length === 1 ? '' : 's'}`
    : viewerGroup?.label ?? 'Not assigned';
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
        <div><span>Competitions</span><strong>{competitions.length || 'Not configured'}</strong></div>
        <div><span>{canOrganize ? 'Groups' : 'Your group'}</span><strong>{groupSummary}</strong></div>
      </div>

      <div className="event-primary-actions">
        {event.status === 'scoring_open' && <Link className="button button--primary button--large" to={`/events/${event.id}/score`}>Enter scores</Link>}
        {competition && <Link className="button button--secondary button--large" to={competitionPath(event.id, competition)}>Live results</Link>}
        {canOrganize && <Link className="button button--quiet button--large" to={event.status === 'draft' ? `/admin/events/${event.id}/setup` : `/admin/events/${event.id}/scoring`}>{event.status === 'draft' ? 'Continue setup' : 'Control room'}</Link>}
      </div>

      {competitions.length > 0 && <nav className="competition-switcher" aria-label="Event competitions">
        {competitions.map((item) => <Link key={item.id} to={competitionPath(event.id, item)}><strong>{item.name}</strong><span>{item.metric} · {item.status.replaceAll('_', ' ')}</span></Link>)}
      </nav>}

      <section className="section-block" aria-labelledby="terms-title">
        <div className="section-heading"><h2 id="terms-title">Terms of competition</h2><Link to={`/events/${event.id}/rules`}>Full rules</Link></div>
        <p>{competitions.length > 1 ? `${competitions.length} competitions calculate independently from the same submitted hole scores.` : competition?.rules_text ?? 'Rules will be frozen when the event is published.'}</p>
        <dl className="revision-line"><dt>Scoring revision</dt><dd>{event.scoring_revision}</dd></dl>
      </section>
    </div>
  );
}

function competitionPath(eventId: string, competition: { id: string; format: string }) {
  return competition.format === 'skins'
    ? `/events/${eventId}/skins/${competition.id}`
    : competition.format === 'match'
      ? `/events/${eventId}/matches/${competition.id}`
      : `/events/${eventId}/leaderboards/${competition.id}`;
}
