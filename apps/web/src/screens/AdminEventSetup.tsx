import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { publishEvent, saveEventDraft } from '../lib/phase1.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

type CompetitionPreset =
  | 'individual_gross'
  | 'two_person_throwdown'
  | 'three_player_scramble'
  | 'four_player_scramble';
type TeamDraft = { name: string; participantIds: string[] };
/** A division within the event (§5.2). Membership is by participant id. */
type FlightDraft = { id?: string; name: string; participantIds: string[] };
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
  const [draftEventId, setDraftEventId] = useState(routeEventId === 'new' ? null : routeEventId);
  const [isDirty, setIsDirty] = useState(routeEventId === 'new');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [preset, setPreset] = useState<CompetitionPreset | null>(null);
  const [teamDrafts, setTeamDrafts] = useState<TeamDraft[] | null>(null);
  const [selectedTeeSetId, setSelectedTeeSetId] = useState<string | null>(null);
  const [flightDrafts, setFlightDrafts] = useState<FlightDraft[] | null>(null);
  const [selectedStartsAt, setSelectedStartsAt] = useState<string | null>(null);

  useEffect(() => {
    setDraftEventId(routeEventId === 'new' ? null : routeEventId);
    setIsDirty(routeEventId === 'new');
    setSelectedIds(null);
    setPreset(null);
    setTeamDrafts(null);
    setSelectedTeeSetId(null);
    setFlightDrafts(null);
    setSelectedStartsAt(null);
    setMessage(null);
    setError(null);
  }, [routeEventId]);

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
      let existingFlights: FlightDraft[] = [];
      let existingScorerProfileIds: string[] = [];
      let legacyScorerCount = 0;
      if (routeEventId !== 'new') {
        const [roundResult, entryResult, teamResult, flightResult, markerResult] = await Promise.all([
          supabase.from('rounds').select('id,source_tee_set_id').eq('event_id', routeEventId).order('round_number'),
          supabase.from('event_entries').select('participant_id,flight_id').eq('event_id', routeEventId),
          supabase.from('event_teams').select('id,name,event_team_members(position,event_entries(participant_id))').eq('event_id', routeEventId).order('created_at'),
          supabase.from('flights').select('id,name,sort_order').eq('event_id', routeEventId).order('sort_order'),
          supabase.from('scoring_permissions').select('scorer_profile_id,grant_origin').eq('event_id', routeEventId).eq('permission_type', 'marker').is('valid_to', null),
        ]);
        const setupError = roundResult.error ?? entryResult.error ?? teamResult.error ?? flightResult.error ?? markerResult.error;
        if (setupError) throw setupError;
        const rounds = roundResult.data;
        const entries = entryResult.data;
        const teams = teamResult.data;
        const flights = flightResult.data;
        round = rounds?.[0] ?? null;
        entryParticipantIds = (entries ?? []).map((entry) => entry.participant_id);
        existingTeams = ((teams ?? []) as unknown as Array<{
          name: string;
          event_team_members: Array<{ position: number; event_entries: { participant_id: string } | { participant_id: string }[] | null }>;
        }>).map((team) => ({
          name: team.name,
          participantIds: team.event_team_members
            .toSorted((a, b) => a.position - b.position)
            .map((member) => relationValue(member.event_entries)?.participant_id ?? ''),
        })).filter((team) => team.participantIds.length >= 2 && team.participantIds.length <= 4 && team.participantIds.every(Boolean));
        existingFlights = (flights ?? []).map((flight) => ({
          id: flight.id,
          name: flight.name,
          participantIds: (entries ?? [])
            .filter((entry) => entry.flight_id === flight.id)
            .map((entry) => entry.participant_id),
        }));
        // Only grants an organizer explicitly chose for the whole field come
        // back into the marker control. Reloading tee-group derived grants
        // here and resaving would promote every group scorer to a field-wide
        // marker, widening access a little more on each edit (§migration 37).
        existingScorerProfileIds = [...new Set(
          (markerResult.data ?? [])
            .filter((permission) => permission.grant_origin === 'explicit_field')
            .map((permission) => permission.scorer_profile_id),
        )];
        legacyScorerCount = new Set(
          (markerResult.data ?? [])
            .filter((permission) => permission.grant_origin === 'legacy')
            .map((permission) => permission.scorer_profile_id),
        ).size;
      }
      const teeSets = (courses ?? []).flatMap((course) => course.course_layouts.flatMap((layout) => layout.tee_sets.filter((tee) => tee.status === 'active').map((tee) => ({ ...tee, label: `${course.name} · ${layout.name} · ${tee.name}` }))));
      return { leagueId, league: leagues?.find((league) => league.id === leagueId), seasons: seasons ?? [], participants: participants ?? [], teeSets, existing, round, entryParticipantIds, existingTeams, existingFlights, existingScorerProfileIds, legacyScorerCount };
    },
  });

  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--form" /></div>;
  if (query.isError) return (
    <div className="screen">
      <p className="form-message form-message--error" role="alert">Event setup could not be loaded. Your saved draft was not changed.</p>
      <button className="button button--secondary" type="button" onClick={() => void query.refetch()}>Try again</button>
    </div>
  );
  if (!query.data) return <p className="form-message form-message--error">Organizer access is required to build an event.</p>;
  const data = query.data;
  const existing = data.existing;
  const initialIds = data.entryParticipantIds.length ? data.entryParticipantIds : data.participants.map((participant) => participant.id);
  const activeIds = selectedIds ?? initialIds;
  const activePreset = preset ?? inferExistingPreset(data.existingTeams)
    ?? (routeEventId === 'new' ? 'two_person_throwdown' : 'individual_gross');
  const teamSize = teamSizeForPreset(activePreset);
  const effectiveTeamSize = teamSize ?? 2;
  const isTeamEvent = teamSize !== null;
  const isScramble = activePreset === 'three_player_scramble' || activePreset === 'four_player_scramble';
  const activeTeams = teamDrafts ?? (data.existingTeams.length
    ? data.existingTeams
    : groupParticipants(activeIds, effectiveTeamSize));
  const activeFlightDrafts = flightDrafts ?? data.existingFlights;
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
  const weights = scrambleWeights(activePreset);
  const scrambleTeamReview = weights === null ? [] : activeTeams.map((team) => {
    const courseHandicaps = team.participantIds.map((participantId) =>
      handicapReview.find((row) => row.participantId === participantId)?.courseHandicap ?? null);
    const valid = courseHandicaps.every((value): value is number => value !== null);
    const unrounded = valid
      ? courseHandicaps.toSorted((left, right) => left - right)
          .reduce((sum, value, index) => sum + value * (weights[index] ?? 0), 0)
      : null;
    return {
      name: team.name,
      unrounded,
      playingHandicap: unrounded === null ? null : roundPlayingHandicap(unrounded, 1),
    };
  });
  const teamsComplete = !isTeamEvent || activeTeams.every((team) =>
    team.name.trim() !== ''
    && team.participantIds.length === effectiveTeamSize
    && team.participantIds.every(Boolean));
  const assignments = activeTeams.flatMap((team) => team.participantIds);
  const assignmentsUnique = new Set(assignments).size === assignments.length
    && assignments.length === activeIds.length;
  const pairingsValid = !isTeamEvent || (
    activeTeams.length >= 2
    && teamsComplete
    && assignmentsUnique
    && (activePreset !== 'two_person_throwdown'
      ? activeIds.length % effectiveTeamSize === 0
      : activeIds.length % 4 === 0 && activeTeams.length % 2 === 0)
  );
  const handicapsValid = !isTeamEvent || handicapReview.every((row) => row.handicap !== null);
  const flightValidationError = validateFlightDrafts(
    activeFlightDrafts,
    activeIds,
    isTeamEvent ? activeTeams : [],
  );

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
    setTeamDrafts(groupParticipants(next, effectiveTeamSize));
    setFlightDrafts(activeFlightDrafts.map((flight) => ({
      ...flight,
      participantIds: flight.participantIds.filter((id) => nextSet.has(id)),
    })));
    markDirty();
  }

  function updateTeamMember(teamIndex: number, slot: number, participantId: string) {
    const next = activeTeams.map((team) => ({ ...team, participantIds: [...team.participantIds] }));
    const previous = next[teamIndex]?.participantIds[slot] ?? '';
    for (const team of next) {
      const otherSlot = team.participantIds.indexOf(participantId);
      if (otherSlot >= 0) team.participantIds[otherSlot] = previous;
    }
    const targetTeam = next[teamIndex];
    if (!targetTeam) return;
    targetTeam.participantIds[slot] = participantId;
    setTeamDrafts(next);
    markDirty();
  }

  function markDirty() {
    setIsDirty(true);
    setError(null);
    setMessage(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null); setMessage(null);
    const normalizedFlights = activeFlightDrafts.map((flight) => ({
      ...flight,
      name: flight.name.trim(),
    }));
    const invalidFlights = validateFlightDrafts(
      normalizedFlights,
      activeIds,
      isTeamEvent ? activeTeams : [],
    );
    if (invalidFlights) {
      setError(invalidFlights);
      return;
    }

    setIsDirty(true);
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const startsAt = new Date(String(form.get('startsAt'))).toISOString();
      const endsValue = String(form.get('endsAt') ?? '');
      const result = await saveEventDraft({
        ...(draftEventId ? { eventId: draftEventId } : {}),
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
        teams: isTeamEvent ? activeTeams : [],
      });
      // Keep the event identity as soon as the first transaction succeeds. If
      // the flight transaction fails, retry updates this draft instead of
      // creating another event.
      setDraftEventId(result.eventId);
      const { data: flightResult, error: flightError } = await getSupabaseClient().rpc(
        'set_event_flights',
        { p_event_id: result.eventId, p_flights: normalizedFlights },
      );
      const response = flightResult as {
        status?: string;
        detail?: string;
        flights?: unknown;
      } | null;
      if (flightError || response?.status !== 'saved') {
        throw new Error(
          response?.detail
            ?? flightError?.message
            ?? 'Flights could not be saved.',
        );
      }
      const savedFlights = parseSavedFlights(response.flights);
      if (!savedFlights) {
        throw new Error('The draft saved, but its flight identities could not be confirmed. Save again before publishing.');
      }
      setFlightDrafts(savedFlights);
      setIsDirty(false);
      setMessage('Draft saved. Server preflight passed and the event is ready to publish.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the event.');
    } finally { setSubmitting(false); }
  }

  async function publish() {
    if (!draftEventId || isDirty) return;
    setSubmitting(true); setError(null); setMessage(null);
    try {
      const published = await publishEvent({ eventId: draftEventId, openScoring: true });
      // Publishing and building the first projection are separate transactions.
      // When the second fails the event IS published and scoring IS open, so
      // route to the event and say results are still building — never report a
      // publish failure for an event players can already score.
      navigate(`/events/${draftEventId}`, published.projectionPending === true
        ? { state: { notice: 'Event published and scoring is open. Live results are still building — reload in a moment, or rebuild them from Operations.' } }
        : undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Publish failed. Review preflight and try again.');
    } finally { setSubmitting(false); }
  }

  // An event cannot be saved without a season, an active rated tee, and
  // players. Each of those lives on a league catalog screen that is only
  // reachable by league id, so name what is missing and link straight to it
  // rather than presenting an empty required <select> with no way forward.
  const prerequisites = [
    data.seasons.length === 0
      ? { key: 'seasons', need: 'a season', cta: 'Add a season', to: `/league/${data.leagueId}/seasons` }
      : null,
    data.teeSets.length === 0
      ? { key: 'tees', need: 'a course with an active rated tee', cta: 'Add a course and tee', to: `/league/${data.leagueId}/courses` }
      : null,
    data.participants.length === 0
      ? { key: 'players', need: 'active players with handicaps', cta: 'Add players', to: `/league/${data.leagueId}/players` }
      : null,
  ].filter((item) => item !== null);

  return (
    <div className="screen builder-screen">
      <header className="page-header page-header--split">
        <div>
          <Link className="back-link" to="/dashboard">Back to dashboard</Link>
          <h1>{existing ? `Set up ${existing.name}` : 'Create an event'}</h1>
          <p>Choose the format first, then review the score source and handicap authority before publishing.</p>
        </div>
        {existing?.status && <span className="status-badge">{existing.status.replaceAll('_', ' ')}</span>}
      </header>
      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      {message && <p className="form-message form-message--success" role="status">{message}</p>}
      {data.legacyScorerCount > 0 && (
        <p className="form-message form-message--warning" role="status">
          {data.legacyScorerCount} scorer grant{data.legacyScorerCount === 1 ? '' : 's'} on this
          draft predate origin tracking, so {data.legacyScorerCount === 1 ? 'it is' : 'they are'} not
          pre-selected below. Re-select anyone who should mark the whole field before saving;
          same-group marking still applies automatically and needs no selection.
        </p>
      )}
      {prerequisites.length > 0 && (
        <section className="form-message form-message--warning" role="status">
          <p>
            This league still needs {listPhrase(prerequisites.map((item) => item.need))} before an
            event can be saved.
          </p>
          <div className="action-row">
            {prerequisites.map((item) => (
              <Link className="button button--secondary" key={item.key} to={item.to}>{item.cta}</Link>
            ))}
          </div>
        </section>
      )}
      <form className="builder-form" key={routeEventId} onChange={markDirty} onSubmit={(event) => void save(event)}>
        <section>
          <div className="builder-step">
            <span>1</span>
            <div><h2>Event basics</h2><p>Name the day and set the scoring window.</p></div>
          </div>
          <div className="form-grid">
            <div className="field field--wide"><label htmlFor="event-name">Event name</label><input id="event-name" name="name" defaultValue={existing?.name ?? ''} required minLength={3} maxLength={100} /></div>
            <div className="field">
              <label htmlFor="season">Season</label>
              <select id="season" name="seasonId" defaultValue={data.seasons.find((season) => season.status === 'active')?.id ?? data.seasons[0]?.id} required>{data.seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}</select>
              {data.seasons.length === 0 && <small>No seasons yet. <Link to={`/league/${data.leagueId}/seasons`}>Add a season</Link> first.</small>}
            </div>
            <div className="field"><label htmlFor="visibility">Visibility</label><select id="visibility" name="visibility" defaultValue={existing?.visibility ?? 'league'}><option value="league">League members</option><option value="public">Public</option><option value="organizers">Organizers only</option></select></div>
            <div className="field"><label htmlFor="starts-at">Starts</label><input id="starts-at" name="startsAt" type="datetime-local" value={activeStartsAt} onChange={(event) => setSelectedStartsAt(event.target.value)} required /></div>
            <div className="field"><label htmlFor="ends-at">Ends (optional)</label><input id="ends-at" name="endsAt" type="datetime-local" defaultValue={existing?.ends_at ? localDateTime(existing.ends_at) : ''} /></div>
            <div className="field field--wide"><label htmlFor="timezone">Venue timezone</label><input id="timezone" name="timezone" defaultValue={existing?.timezone ?? data.league?.timezone ?? 'America/Detroit'} required /></div>
          </div>
        </section>

        <section>
          <div className="builder-step">
            <span>2</span>
            <div><h2>Course and tee</h2><p>Publishing freezes this exact hole and handicap data.</p></div>
          </div>
          <div className="field">
            <label htmlFor="tee-set">Tee set</label>
            <select id="tee-set" name="teeSetId" value={activeTeeSetId} onChange={(event) => setSelectedTeeSetId(event.target.value)} required>
              {data.teeSets.map((tee) => <option key={tee.id} value={tee.id}>{tee.label} · Par {tee.par} · {tee.course_rating}/{tee.slope_rating}</option>)}
            </select>
            {data.teeSets.length === 0 && <small>No active rated tees yet. <Link to={`/league/${data.leagueId}/courses`}>Add a course and tee</Link> first.</small>}
          </div>
        </section>

        <section>
          <div className="builder-step">
            <span>3</span>
            <div><h2>Field and format</h2><p>Select the players, then confirm how the day competes.</p></div>
          </div>
          <div className="field competition-preset">
            <label htmlFor="competition-preset">Competition preset</label>
            <select id="competition-preset" value={activePreset} onChange={(event) => {
              const nextPreset = event.target.value as CompetitionPreset;
              setPreset(nextPreset);
              setTeamDrafts(groupParticipants(activeIds, teamSizeForPreset(nextPreset) ?? 2));
            }}>
              <option value="two_person_throwdown">Two-person throwdown · six competitions</option>
              <option value="three_player_scramble">Three-player scramble · gross and net</option>
              <option value="four_player_scramble">Four-player scramble · gross and net</option>
              <option value="individual_gross">Individual gross · one competition</option>
            </select>
            <small>{presetDescription(activePreset)}</small>
          </div>

          <fieldset className="choice-list">
            <legend>Event field</legend>
            {data.participants.map((participant) => (
              <label key={participant.id}>
                <input type="checkbox" name="participantIds" value={participant.id} checked={activeIds.includes(participant.id)} onChange={(event) => toggleParticipant(participant.id, event.target.checked)} />
                <span><strong>{participant.display_name}</strong><small>{participant.profile_id ? 'Account linked' : 'Guest player'}</small></span>
              </label>
            ))}
          </fieldset>

          {isTeamEvent && (
            <div className="handicap-review" aria-labelledby="handicap-review-title">
              <div className="section-heading">
                <div>
                  <h3 id="handicap-review-title">Handicap review</h3>
                  <p>{isScramble ? 'The team Playing Handicap uses the reviewed low-to-high weight preset.' : 'Course Handicap stays unrounded; each competition rounds its own allowance.'}</p>
                </div>
                <span>{activeTeeSet?.name ?? 'Selected tee'}</span>
              </div>
              <p className="table-scroll-hint">Swipe horizontally for source and Course Handicap.</p>
              <div className="handicap-review-table" tabIndex={0} aria-label="Handicap review table, scroll horizontally for all columns">
                <table>
                  <thead><tr><th scope="col">Player</th><th scope="col">Source / index</th><th scope="col">Course Handicap</th>{!isScramble && <><th scope="col">PH 100%</th><th scope="col">PH 85%</th></>}</tr></thead>
                  <tbody>{handicapReview.map((row) => <tr key={row.participantId}><th scope="row">{row.name}</th><td>{row.handicap ? `${sourceLabel(row.handicap.source)} · ${formatHandicapIndex(Number(row.handicap.value))}` : <strong className="state-warning">Missing</strong>}</td><td>{row.courseHandicap === null ? '—' : row.courseHandicap.toFixed(6)}</td>{!isScramble && <><td>{row.fullPlayingHandicap ?? '—'}</td><td>{row.bestBallPlayingHandicap ?? '—'}</td></>}</tr>)}</tbody>
                </table>
              </div>
              {!handicapsValid && <p className="form-message form-message--warning">Add a current handicap record for every selected player before saving a net event.</p>}

              {isScramble && (
                <div className="scramble-handicap-summary">
                  <p><strong>Frozen preset:</strong> {weights?.map((weight) => `${Math.round(weight * 100)}%`).join(' + ')} from the lowest Course Handicap upward.</p>
                  <p className="table-scroll-hint">Swipe horizontally for the unrounded handicap and Team PH.</p>
                  <div className="handicap-review-table" tabIndex={0} aria-label="Calculated scramble team handicaps">
                    <table>
                      <thead><tr><th scope="col">Team</th><th scope="col">Unrounded team handicap</th><th scope="col">Team PH</th></tr></thead>
                      <tbody>{scrambleTeamReview.map((team, index) => <tr key={`${team.name}-${index}`}><th scope="row">{team.name}</th><td>{team.unrounded?.toFixed(6) ?? '—'}</td><td>{team.playingHandicap ?? '—'}</td></tr>)}</tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {isTeamEvent && (
            <div className="team-pairings" aria-labelledby="team-pairings-title">
              <div className="section-heading">
                <div>
                  <h3 id="team-pairings-title">{effectiveTeamSize}-player teams</h3>
                  <p>{activePreset === 'two_person_throwdown' ? 'Each selected player appears once; every group contains exactly two teams.' : 'Each selected player appears once; each team receives one shared scorecard.'}</p>
                </div>
                <span>{activeTeams.length} teams</span>
              </div>
              {!pairingsValid && <p className="form-message form-message--warning">{pairingMessage(activePreset)}</p>}
              {activeTeams.map((team, teamIndex) => (
                <div className={`team-pairing team-pairing--${effectiveTeamSize}`} key={`${teamIndex}-${team.participantIds.join('-')}`}>
                  <label className="field team-pairing__name"><span>Team name</span><input value={team.name} maxLength={80} onChange={(event) => { const next = [...activeTeams]; next[teamIndex] = { ...team, name: event.target.value }; setTeamDrafts(next); }} required /></label>
                  {Array.from({ length: effectiveTeamSize }, (_, slot) => (
                    <label className="field" key={slot}>
                      <span>Player {slot + 1}</span>
                      <select value={team.participantIds[slot] ?? ''} onChange={(event) => updateTeamMember(teamIndex, slot, event.target.value)} required>
                        <option value="">Select player</option>
                        {activeIds.map((participantId) => <option key={participantId} value={participantId}>{data.participants.find((participant) => participant.id === participantId)?.display_name ?? 'Player'}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}

          <fieldset className="choice-list choice-list--compact">
            <legend>Marker access (optional)</legend>
            {data.participants.filter((participant) => participant.profile_id).map((participant) => (
              <label key={participant.id}>
                <input type="checkbox" name="scorerProfileIds" value={participant.profile_id!} defaultChecked={data.existingScorerProfileIds.includes(participant.profile_id!)} />
                <span><strong>{participant.display_name}</strong><small>Can score the entire field</small></span>
              </label>
            ))}
          </fieldset>
        </section>

        <section>
          <div className="builder-step">
            <span>4</span>
            <div>
              <h2>Flights and divisions</h2>
              <p>Optional. If you add flights, assign every selected player exactly once. Each flight receives its own ranking and skins pool.</p>
            </div>
          </div>
          <div className="flight-builder">
            {flightValidationError && <p id="flight-validation" className="form-message form-message--warning">{flightValidationError}</p>}
            {activeFlightDrafts.length === 0
              ? <p className="muted">No flights: the whole field is ranked together.</p>
              : activeFlightDrafts.map((flight, flightIndex) => (
                <article key={flight.id ?? `draft-${flightIndex}`} className="flight-draft">
                  <div className="flight-draft__head">
                    <label className="field">
                      <span>Flight name</span>
                      <input
                        value={flight.name}
                        maxLength={60}
                        placeholder="A Flight"
                        aria-describedby={flightValidationError ? 'flight-validation' : undefined}
                        required
                        onChange={(event) => {
                          const next = [...activeFlightDrafts];
                          next[flightIndex] = { ...flight, name: event.target.value };
                          setFlightDrafts(next);
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="button button--quiet button--small"
                      aria-label={`Remove ${flight.name.trim() || `flight ${flightIndex + 1}`}`}
                      onClick={() => {
                        setFlightDrafts(activeFlightDrafts.filter((_, i) => i !== flightIndex));
                        markDirty();
                      }}
                    >
                      Remove
                    </button>
                  </div>
                  <fieldset className="flight-draft__members">
                    <legend>Players in this flight</legend>
                    {data.participants
                      .filter((participant) => activeIds.includes(participant.id))
                      .map((participant) => {
                        // A player belongs to at most one flight, so selecting
                        // them here takes them out of any other.
                        const checked = flight.participantIds.includes(participant.id);
                        return (
                          <label key={participant.id} className="selectable-row">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                const next = activeFlightDrafts.map((candidate, i) => ({
                                  ...candidate,
                                  participantIds: i === flightIndex
                                    ? (checked
                                        ? candidate.participantIds.filter((id) => id !== participant.id)
                                        : [...candidate.participantIds, participant.id])
                                    : candidate.participantIds.filter((id) => id !== participant.id),
                                }));
                                setFlightDrafts(next);
                              }}
                            />
                            <span><strong>{participant.display_name}</strong></span>
                          </label>
                        );
                      })}
                  </fieldset>
                </article>
              ))}
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setFlightDrafts([...activeFlightDrafts, { name: '', participantIds: [] }]);
                markDirty();
              }}
            >
              Add flight
            </button>
          </div>
        </section>

        <section className="preflight">
          <div className="builder-step">
            <span>5</span>
            <div><h2>Preflight and publish</h2><p>These checks are repeated in one server transaction.</p></div>
          </div>
          <ul>
            {activePreset === 'two_person_throwdown' && <><li>Every tee group contains two complete two-person teams</li><li>Every net player has a reviewed handicap source, Course Handicap, and competition Playing Handicap</li><li>Six simultaneous competitions use the same individual scorecards</li><li>Best-ball net applies 85% before choosing each hole’s contributor</li></>}
            {isScramble && <><li>Every team contains exactly {effectiveTeamSize} players and receives one team scorecard</li><li>Gross and net competitions use the same team hole scores; no individual scores are fabricated</li><li>The {weights?.map((weight) => `${Math.round(weight * 100)}%`).join('/')} weight preset and calculated team Playing Handicap will be frozen</li></>}
            <li>Tee par, rating, slope, and stroke indexes are complete</li>
            <li>Course Handicap and immutable roster snapshots will be frozen</li>
          </ul>
          <p id="draft-save-state" className="muted" role="status">
            {isDirty
              ? draftEventId
                ? 'Unsaved changes. Save the draft again before publishing.'
                : 'Save this draft before publishing.'
              : 'All setup changes are saved and ready for publication.'}
          </p>
          <div className="builder-actions">
            <button className="button button--secondary" type="submit" disabled={submitting || activeIds.length === 0 || !pairingsValid || !handicapsValid || flightValidationError !== null}>{submitting ? 'Saving…' : 'Save draft'}</button>
            <button className="button button--primary" type="button" aria-describedby="draft-save-state" onClick={() => void publish()} disabled={!draftEventId || isDirty || submitting}>Publish and open scoring</button>
          </div>
        </section>
      </form>
    </div>
  );
}

function validateFlightDrafts(
  flights: FlightDraft[],
  activeParticipantIds: string[],
  teams: TeamDraft[],
): string | null {
  if (flights.length === 0) return null;

  const activeIds = new Set(activeParticipantIds);
  const seenNames = new Set<string>();
  const flightByParticipant = new Map<string, number>();
  for (const [flightIndex, flight] of flights.entries()) {
    const name = flight.name.trim();
    if (name === '') return `Flight ${flightIndex + 1} needs a name.`;
    const nameKey = name.toLocaleLowerCase('en-US');
    if (seenNames.has(nameKey)) return `Flight names must be unique. “${name}” appears more than once.`;
    seenNames.add(nameKey);
    if (flight.participantIds.length === 0) return `${name} needs at least one player.`;

    for (const participantId of flight.participantIds) {
      if (!activeIds.has(participantId)) {
        return `${name} includes a player who is no longer in the event field.`;
      }
      if (flightByParticipant.has(participantId)) {
        return 'Each selected player can belong to only one flight.';
      }
      flightByParticipant.set(participantId, flightIndex);
    }
  }

  if (flightByParticipant.size !== activeIds.size) {
    return 'Assign every selected player to exactly one flight, or remove all flights to rank the field together.';
  }

  for (const team of teams) {
    const teamFlights = new Set(team.participantIds.map((id) => flightByParticipant.get(id)));
    if (teamFlights.size !== 1 || teamFlights.has(undefined)) {
      return `${team.name.trim() || 'Each team'} must stay together in one flight.`;
    }
  }
  return null;
}

function parseSavedFlights(value: unknown): FlightDraft[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: FlightDraft[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null;
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.id !== 'string'
      || typeof row.name !== 'string'
      || !Array.isArray(row.participantIds)
      || !row.participantIds.every((id) => typeof id === 'string')
    ) {
      return null;
    }
    parsed.push({
      id: row.id,
      name: row.name,
      participantIds: row.participantIds as string[],
    });
  }
  return parsed;
}

/** "a season", "a season and players", "a season, a tee, and players". */
function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function groupParticipants(participantIds: string[], teamSize: number): TeamDraft[] {
  const teams: TeamDraft[] = [];
  for (let index = 0; index < participantIds.length; index += teamSize) {
    teams.push({
      name: `Team ${teams.length + 1}`,
      participantIds: Array.from(
        { length: teamSize },
        (_, offset) => participantIds[index + offset] ?? '',
      ),
    });
  }
  return teams;
}

function teamSizeForPreset(preset: CompetitionPreset): 2 | 3 | 4 | null {
  if (preset === 'two_person_throwdown') return 2;
  if (preset === 'three_player_scramble') return 3;
  if (preset === 'four_player_scramble') return 4;
  return null;
}

function inferExistingPreset(teams: TeamDraft[]): CompetitionPreset | null {
  const size = teams[0]?.participantIds.length;
  if (size === 2) return 'two_person_throwdown';
  if (size === 3) return 'three_player_scramble';
  if (size === 4) return 'four_player_scramble';
  return null;
}

function scrambleWeights(preset: CompetitionPreset): number[] | null {
  if (preset === 'three_player_scramble') return [0.3, 0.2, 0.1];
  if (preset === 'four_player_scramble') return [0.25, 0.2, 0.15, 0.1];
  return null;
}

function presetDescription(preset: CompetitionPreset) {
  if (preset === 'two_person_throwdown') {
    return 'Gross and net individual, best ball, and skins share every submitted score.';
  }
  if (preset === 'three_player_scramble') {
    return 'Each three-player team records one team score per hole; 30/20/10 weights produce the frozen team Playing Handicap.';
  }
  if (preset === 'four_player_scramble') {
    return 'Each four-player team records one team score per hole; 25/20/15/10 weights produce the frozen team Playing Handicap.';
  }
  return 'A simple gross stroke-play event.';
}

function pairingMessage(preset: CompetitionPreset) {
  if (preset === 'two_person_throwdown') {
    return 'Select players in groups of four so every tee group has two complete teams.';
  }
  const teamSize = teamSizeForPreset(preset) ?? 2;
  return `Select enough players for at least two complete ${teamSize}-player teams, with each player assigned once.`;
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
