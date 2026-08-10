import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { publishEvent, saveEventDraft } from '../lib/phase1.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

type CompetitionPreset = 'individual_gross' | 'two_person_throwdown';
type TeamDraft = { name: string; participantIds: [string, string] };
type HandicapRecord = {
  id: string;
  value: number;
  source: string;
  effective_from: string;
  effective_to: string | null;
};

export function AdminEventSetup() {
  const { eventId: routeEventId = 'new' } = useParams();
  const navigate = useNavigate();
  const [savedEventId, setSavedEventId] = useState(routeEventId === 'new' ? null : routeEventId);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [preset, setPreset] = useState<CompetitionPreset | null>(null);
  const [teamDrafts, setTeamDrafts] = useState<TeamDraft[] | null>(null);
  const [selectedTeeSetId, setSelectedTeeSetId] = useState<string | null>(null);
  const [selectedStartsAt, setSelectedStartsAt] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['event-builder', routeEventId],
    queryFn: async () => {
      const supabase = getSupabaseClient();
      const [{ data: roles }, { data: leagues }] = await Promise.all([
        supabase.from('role_assignments').select('league_id,role,event_id').is('revoked_at', null),
        supabase.from('leagues').select('id,name,timezone'),
      ]);
      const organizerLeagueIds = (roles ?? [])
        .filter((role) => ['owner', 'league_admin'].includes(role.role) || role.event_id === routeEventId)
        .map((role) => role.league_id);
      const leagueId = organizerLeagueIds[0] ?? leagues?.[0]?.id;
      if (!leagueId) throw new Error('Organizer access is required.');
      const [{ data: seasons }, { data: participants }, { data: courses }, { data: existing }] = await Promise.all([
        supabase.from('seasons').select('id,name,status,starts_on,ends_on').eq('league_id', leagueId).order('starts_on', { ascending: false }),
        supabase.from('participants').select('id,display_name,status,profile_id,participant_handicaps(id,value,source,effective_from,effective_to)').eq('league_id', leagueId).eq('status', 'active').order('sort_name'),
        supabase.from('courses').select('id,name,course_layouts(id,name,tee_sets(id,name,par,course_rating,slope_rating,status))').eq('league_id', leagueId),
        routeEventId === 'new' ? Promise.resolve({ data: null }) : supabase.from('events').select('id,name,timezone,starts_at,ends_at,visibility,status').eq('id', routeEventId).single(),
      ]);
      let round = null;
      let entryParticipantIds: string[] = [];
      let existingTeams: TeamDraft[] = [];
      if (routeEventId !== 'new') {
        const [{ data: rounds }, { data: entries }, { data: teams }] = await Promise.all([
          supabase.from('rounds').select('id,source_tee_set_id').eq('event_id', routeEventId).order('round_number'),
          supabase.from('event_entries').select('participant_id').eq('event_id', routeEventId),
          supabase.from('event_teams').select('id,name,event_team_members(position,event_entries(participant_id))').eq('event_id', routeEventId).order('created_at'),
        ]);
        round = rounds?.[0] ?? null;
        entryParticipantIds = (entries ?? []).map((entry) => entry.participant_id);
        existingTeams = ((teams ?? []) as unknown as Array<{
          name: string;
          event_team_members: Array<{ position: number; event_entries: { participant_id: string } | { participant_id: string }[] | null }>;
        }>).map((team) => ({
          name: team.name,
          participantIds: team.event_team_members
            .toSorted((a, b) => a.position - b.position)
            .map((member) => relationValue(member.event_entries)?.participant_id ?? '') as [string, string],
        })).filter((team) => team.participantIds.length === 2 && team.participantIds.every(Boolean));
      }
      const teeSets = (courses ?? []).flatMap((course) => course.course_layouts.flatMap((layout) => layout.tee_sets.filter((tee) => tee.status === 'active').map((tee) => ({ ...tee, label: `${course.name} · ${layout.name} · ${tee.name}` }))));
      return { leagueId, league: leagues?.find((league) => league.id === leagueId), seasons: seasons ?? [], participants: participants ?? [], teeSets, existing, round, entryParticipantIds, existingTeams };
    },
  });

  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--form" /></div>;
  if (!query.data) return <p className="form-message form-message--error">Organizer access is required to build an event.</p>;
  const data = query.data;
  const existing = data.existing;
  const initialIds = data.entryParticipantIds.length ? data.entryParticipantIds : data.participants.map((participant) => participant.id);
  const activeIds = selectedIds ?? initialIds;
  const activePreset = preset ?? (data.existingTeams.length > 0 || routeEventId === 'new' ? 'two_person_throwdown' : 'individual_gross');
  const activeTeams = teamDrafts ?? (data.existingTeams.length ? data.existingTeams : pairParticipants(activeIds));
  const defaultStart = existing?.starts_at ? localDateTime(existing.starts_at) : localDateTime(new Date(Date.now() + 7 * 86400000).toISOString());
  const activeStartsAt = selectedStartsAt ?? defaultStart;
  const activeTeeSetId = selectedTeeSetId ?? data.round?.source_tee_set_id ?? data.teeSets[0]?.id ?? '';
  const activeTeeSet = data.teeSets.find((tee) => tee.id === activeTeeSetId);
  const handicapReview = activeIds.map((participantId) => {
    const participant = data.participants.find((candidate) => candidate.id === participantId);
    const handicap = participant ? effectiveHandicap(participant.participant_handicaps, activeStartsAt.slice(0, 10)) : null;
    const courseHandicap = handicap && activeTeeSet
      ? Number(handicap.value) * Number(activeTeeSet.slope_rating) / 113
        + (Number(activeTeeSet.course_rating) - Number(activeTeeSet.par))
      : null;
    return {
      participantId,
      name: participant?.display_name ?? 'Player',
      handicap,
      courseHandicap,
      fullPlayingHandicap: courseHandicap === null ? null : roundPlayingHandicap(courseHandicap, 1),
      bestBallPlayingHandicap: courseHandicap === null ? null : roundPlayingHandicap(courseHandicap, 0.85),
    };
  });
  const pairingsValid = activePreset === 'individual_gross' || (
    activeIds.length >= 4
    && activeIds.length % 4 === 0
    && activeTeams.length % 2 === 0
    && activeTeams.every((team) => team.name.trim() !== '' && team.participantIds.every(Boolean))
  );
  const handicapsValid = activePreset === 'individual_gross' || handicapReview.every((row) => row.handicap !== null);

  if (existing && existing.status !== 'draft') {
    return (
      <div className="screen builder-screen">
        <header className="page-header page-header--split"><div><Link className="back-link" to="/dashboard">Back to dashboard</Link><h1>{existing.name}</h1><p>The published setup is preserved as the scoring authority.</p></div><span className="status-badge">{existing.status.replaceAll('_', ' ')}</span></header>
        <section className="section-block frozen-setup" aria-labelledby="frozen-setup-title"><h2 id="frozen-setup-title">Setup is frozen</h2><p>Course, tee, players, teams, competition rules, and handicaps cannot be edited after publication. Use the control room for live scoring operations.</p><div className="builder-actions"><Link className="button button--secondary" to={`/events/${existing.id}`}>View event</Link><Link className="button button--primary" to={`/admin/events/${existing.id}/scoring`}>Open control room</Link></div></section>
      </div>
    );
  }

  function toggleParticipant(participantId: string, checked: boolean) {
    const nextSet = new Set(activeIds);
    if (checked) nextSet.add(participantId); else nextSet.delete(participantId);
    const next = data.participants.filter((participant) => nextSet.has(participant.id)).map((participant) => participant.id);
    setSelectedIds(next);
    setTeamDrafts(pairParticipants(next));
    setSavedEventId(null);
  }

  function updateTeamMember(teamIndex: number, slot: 0 | 1, participantId: string) {
    const next = activeTeams.map((team) => ({ ...team, participantIds: [...team.participantIds] as [string, string] }));
    const previous = next[teamIndex]?.participantIds[slot] ?? '';
    for (const team of next) {
      const otherSlot = team.participantIds.indexOf(participantId);
      if (otherSlot >= 0) team.participantIds[otherSlot] = previous;
    }
    const targetTeam = next[teamIndex];
    if (!targetTeam) return;
    targetTeam.participantIds[slot] = participantId;
    setTeamDrafts(next);
    setSavedEventId(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true); setError(null); setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      const startsAt = new Date(String(form.get('startsAt'))).toISOString();
      const endsValue = String(form.get('endsAt') ?? '');
      const result = await saveEventDraft({
        ...(savedEventId ? { eventId: savedEventId } : {}),
        leagueId: data.leagueId,
        seasonId: String(form.get('seasonId')),
        name: String(form.get('name')),
        timezone: String(form.get('timezone')),
        startsAt,
        endsAt: endsValue ? new Date(endsValue).toISOString() : null,
        visibility: String(form.get('visibility')) as 'league' | 'public' | 'organizers',
        teeSetId: String(form.get('teeSetId')),
        participantIds: activeIds,
        scorerProfileIds: form.getAll('scorerProfileIds').map(String),
        competitionPreset: activePreset,
        teams: activePreset === 'two_person_throwdown' ? activeTeams : [],
      });
      setSavedEventId(result.eventId);
      setMessage('Draft saved. Server preflight passed and the event is ready to publish.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the event.');
    } finally { setSubmitting(false); }
  }

  async function publish() {
    if (!savedEventId) return;
    setSubmitting(true); setError(null);
    try {
      await publishEvent({ eventId: savedEventId, openScoring: true });
      navigate(`/events/${savedEventId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Publish failed. Review preflight and try again.');
    } finally { setSubmitting(false); }
  }

  return (
    <div className="screen builder-screen">
      <header className="page-header page-header--split"><div><Link className="back-link" to="/dashboard">Back to dashboard</Link><h1>{existing ? `Set up ${existing.name}` : 'Create an event'}</h1><p>Build one shared scorecard into individual, best-ball, and skins results.</p></div>{existing?.status && <span className="status-badge">{existing.status.replaceAll('_', ' ')}</span>}</header>
      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      {message && <p className="form-message form-message--success" role="status">{message}</p>}
      <form className="builder-form" onSubmit={(event) => void save(event)}>
        <section><div className="builder-step"><span>1</span><div><h2>Event basics</h2><p>Name the day and set the scoring window.</p></div></div><div className="form-grid"><div className="field field--wide"><label htmlFor="event-name">Event name</label><input id="event-name" name="name" defaultValue={existing?.name ?? ''} required minLength={3} maxLength={100} /></div><div className="field"><label htmlFor="season">Season</label><select id="season" name="seasonId" defaultValue={data.seasons.find((season) => season.status === 'active')?.id ?? data.seasons[0]?.id} required>{data.seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}</select></div><div className="field"><label htmlFor="visibility">Visibility</label><select id="visibility" name="visibility" defaultValue={existing?.visibility ?? 'league'}><option value="league">League members</option><option value="public">Public</option><option value="organizers">Organizers only</option></select></div><div className="field"><label htmlFor="starts-at">Starts</label><input id="starts-at" name="startsAt" type="datetime-local" value={activeStartsAt} onChange={(event) => { setSelectedStartsAt(event.target.value); setSavedEventId(null); }} required /></div><div className="field"><label htmlFor="ends-at">Ends (optional)</label><input id="ends-at" name="endsAt" type="datetime-local" defaultValue={existing?.ends_at ? localDateTime(existing.ends_at) : ''} /></div><div className="field field--wide"><label htmlFor="timezone">Venue timezone</label><input id="timezone" name="timezone" defaultValue={existing?.timezone ?? data.league?.timezone ?? 'America/Detroit'} required /></div></div></section>
        <section><div className="builder-step"><span>2</span><div><h2>Course and tee</h2><p>Publishing freezes this exact hole and handicap data.</p></div></div><div className="field"><label htmlFor="tee-set">Tee set</label><select id="tee-set" name="teeSetId" value={activeTeeSetId} onChange={(event) => { setSelectedTeeSetId(event.target.value); setSavedEventId(null); }} required>{data.teeSets.map((tee) => <option key={tee.id} value={tee.id}>{tee.label} · Par {tee.par} · {tee.course_rating}/{tee.slope_rating}</option>)}</select></div></section>
        <section><div className="builder-step"><span>3</span><div><h2>Field and format</h2><p>Select the players, then confirm how the day competes.</p></div></div><div className="field competition-preset"><label htmlFor="competition-preset">Competition preset</label><select id="competition-preset" value={activePreset} onChange={(event) => { setPreset(event.target.value as CompetitionPreset); setSavedEventId(null); }}><option value="two_person_throwdown">Two-person throwdown · six competitions</option><option value="individual_gross">Individual gross · one competition</option></select><small>{activePreset === 'two_person_throwdown' ? 'Gross and net individual, best ball, and skins share every submitted score.' : 'A simple gross stroke-play event.'}</small></div><fieldset className="choice-list"><legend>Event field</legend>{data.participants.map((participant) => <label key={participant.id}><input type="checkbox" name="participantIds" value={participant.id} checked={activeIds.includes(participant.id)} onChange={(event) => toggleParticipant(participant.id, event.target.checked)} /><span><strong>{participant.display_name}</strong><small>{participant.profile_id ? 'Account linked' : 'Guest player'}</small></span></label>)}</fieldset>
          {activePreset === 'two_person_throwdown' && <div className="handicap-review" aria-labelledby="handicap-review-title"><div className="section-heading"><div><h3 id="handicap-review-title">Handicap review</h3><p>Course Handicap stays unrounded; each competition rounds its own allowance.</p></div><span>{activeTeeSet?.name ?? 'Selected tee'}</span></div><div className="handicap-review-table" tabIndex={0} aria-label="Handicap review table, scroll horizontally for all columns"><table><thead><tr><th scope="col">Player</th><th scope="col">Source / index</th><th scope="col">Course Handicap</th><th scope="col">PH 100%</th><th scope="col">PH 85%</th></tr></thead><tbody>{handicapReview.map((row) => <tr key={row.participantId}><th scope="row">{row.name}</th><td>{row.handicap ? `${sourceLabel(row.handicap.source)} · ${formatHandicapIndex(Number(row.handicap.value))}` : <strong className="state-warning">Missing</strong>}</td><td>{row.courseHandicap === null ? '—' : row.courseHandicap.toFixed(6)}</td><td>{row.fullPlayingHandicap ?? '—'}</td><td>{row.bestBallPlayingHandicap ?? '—'}</td></tr>)}</tbody></table></div>{!handicapsValid && <p className="form-message form-message--warning">Add a current handicap record for every selected player before saving a net event.</p>}</div>}
          {activePreset === 'two_person_throwdown' && <div className="team-pairings" aria-labelledby="team-pairings-title"><div className="section-heading"><div><h3 id="team-pairings-title">Two-person teams</h3><p>Each selected player appears once; every group contains exactly two teams.</p></div><span>{activeTeams.length} teams</span></div>{activeIds.length % 4 !== 0 && <p className="form-message form-message--warning">Select players in groups of four so every tee group has two complete teams.</p>}{activeTeams.map((team, teamIndex) => <div className="team-pairing" key={`${teamIndex}-${team.participantIds.join('-')}`}><label className="field"><span>Team name</span><input value={team.name} maxLength={80} onChange={(event) => { const next = [...activeTeams]; next[teamIndex] = { ...team, name: event.target.value }; setTeamDrafts(next); setSavedEventId(null); }} required /></label>{([0, 1] as const).map((slot) => <label className="field" key={slot}><span>Player {slot + 1}</span><select value={team.participantIds[slot]} onChange={(event) => updateTeamMember(teamIndex, slot, event.target.value)} required><option value="">Select player</option>{activeIds.map((participantId) => <option key={participantId} value={participantId}>{data.participants.find((participant) => participant.id === participantId)?.display_name ?? 'Player'}</option>)}</select></label>)}</div>)}</div>}
          <fieldset className="choice-list choice-list--compact"><legend>Marker access (optional)</legend>{data.participants.filter((participant) => participant.profile_id).map((participant) => <label key={participant.id}><input type="checkbox" name="scorerProfileIds" value={participant.profile_id!} /><span><strong>{participant.display_name}</strong><small>Can score the entire field</small></span></label>)}</fieldset></section>
        <section className="preflight"><div className="builder-step"><span>4</span><div><h2>Preflight and publish</h2><p>These checks are repeated in one server transaction.</p></div></div><ul>{activePreset === 'two_person_throwdown' && <><li>Every tee group contains two complete two-person teams</li><li>Every net player has a reviewed handicap source, Course Handicap, and competition Playing Handicap</li><li>Six simultaneous competitions use the same individual scorecards</li><li>Best-ball net applies 85% before choosing each hole’s contributor</li></>}<li>Tee par, rating, slope, and stroke indexes are complete</li><li>Course Handicap and immutable roster snapshots will be frozen</li></ul><div className="builder-actions"><button className="button button--secondary" type="submit" disabled={submitting || activeIds.length === 0 || !pairingsValid || !handicapsValid}>{submitting ? 'Working…' : 'Save draft'}</button><button className="button button--primary" type="button" onClick={() => void publish()} disabled={!savedEventId || submitting}>Publish and open scoring</button></div></section>
      </form>
    </div>
  );
}

function pairParticipants(participantIds: string[]): TeamDraft[] {
  const teams: TeamDraft[] = [];
  for (let index = 0; index < participantIds.length; index += 2) {
    teams.push({
      name: `Team ${teams.length + 1}`,
      participantIds: [participantIds[index] ?? '', participantIds[index + 1] ?? ''],
    });
  }
  return teams;
}

function relationValue<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function localDateTime(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function effectiveHandicap(records: HandicapRecord[] | null, eventDate: string) {
  return (records ?? [])
    .filter((record) => record.effective_from <= eventDate
      && (record.effective_to === null || record.effective_to > eventDate))
    .toSorted((left, right) => right.effective_from.localeCompare(left.effective_from))[0] ?? null;
}

function roundPlayingHandicap(courseHandicap: number, allowance: number) {
  return Math.floor(courseHandicap * allowance + 0.5);
}

function formatHandicapIndex(value: number) {
  return value < 0 ? `+${Math.abs(value).toFixed(1)}` : value.toFixed(1);
}

function sourceLabel(source: string) {
  return source.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
