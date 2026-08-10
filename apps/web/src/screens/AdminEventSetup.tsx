import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { publishEvent, saveEventDraft } from '../lib/phase1.ts';
import { getSupabaseClient } from '../lib/supabase.ts';

export function AdminEventSetup() {
  const { eventId: routeEventId = 'new' } = useParams();
  const navigate = useNavigate();
  const [savedEventId, setSavedEventId] = useState(routeEventId === 'new' ? null : routeEventId);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['event-builder', routeEventId],
    queryFn: async () => {
      const supabase = getSupabaseClient();
      const [{ data: roles }, { data: leagues }] = await Promise.all([
        supabase.from('role_assignments').select('league_id,role,event_id').is('revoked_at', null),
        supabase.from('leagues').select('id,name,timezone'),
      ]);
      const organizerLeagueIds = (roles ?? []).filter((role) => ['owner', 'league_admin'].includes(role.role) || role.event_id === routeEventId).map((role) => role.league_id);
      const leagueId = organizerLeagueIds[0] ?? leagues?.[0]?.id;
      if (!leagueId) throw new Error('Organizer access is required.');
      const [{ data: seasons }, { data: participants }, { data: courses }, { data: existing }] = await Promise.all([
        supabase.from('seasons').select('id,name,status,starts_on,ends_on').eq('league_id', leagueId).order('starts_on', { ascending: false }),
        supabase.from('participants').select('id,display_name,status,profile_id').eq('league_id', leagueId).eq('status', 'active').order('sort_name'),
        supabase.from('courses').select('id,name,course_layouts(id,name,tee_sets(id,name,par,course_rating,slope_rating,status))').eq('league_id', leagueId),
        routeEventId === 'new' ? Promise.resolve({ data: null }) : supabase.from('events').select('id,name,timezone,starts_at,ends_at,visibility,status').eq('id', routeEventId).single(),
      ]);
      let round = null;
      let entryParticipantIds: string[] = [];
      if (routeEventId !== 'new') {
        const [{ data: rounds }, { data: entries }] = await Promise.all([
          supabase.from('rounds').select('id,source_tee_set_id').eq('event_id', routeEventId).order('round_number'),
          supabase.from('event_entries').select('participant_id').eq('event_id', routeEventId),
        ]);
        round = rounds?.[0] ?? null;
        entryParticipantIds = (entries ?? []).map((entry) => entry.participant_id);
      }
      const teeSets = (courses ?? []).flatMap((course) => course.course_layouts.flatMap((layout) => layout.tee_sets.filter((tee) => tee.status === 'active').map((tee) => ({ ...tee, label: `${course.name} · ${layout.name} · ${tee.name}` }))));
      return { leagueId, league: leagues?.find((league) => league.id === leagueId), seasons: seasons ?? [], participants: participants ?? [], teeSets, existing, round, entryParticipantIds };
    },
  });

  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--form" /></div>;
  if (!query.data) return <p className="form-message form-message--error">Organizer access is required to build an event.</p>;
  const data = query.data;
  const existing = data.existing;
  const defaultStart = existing?.starts_at ? localDateTime(existing.starts_at) : localDateTime(new Date(Date.now() + 7 * 86400000).toISOString());

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
        participantIds: form.getAll('participantIds').map(String),
        scorerProfileIds: form.getAll('scorerProfileIds').map(String),
      });
      setSavedEventId(result.eventId);
      setMessage('Draft saved. Preflight passed and is ready to publish.');
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

  const selected = new Set(data.entryParticipantIds);
  return (
    <div className="screen builder-screen">
      <header className="page-header page-header--split"><div><Link className="back-link" to="/dashboard">Back to dashboard</Link><h1>{existing ? `Set up ${existing.name}` : 'Create an event'}</h1><p>Phase 1 launch format: one individual gross round.</p></div>{existing?.status && <span className="status-badge">{existing.status}</span>}</header>
      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      {message && <p className="form-message form-message--success" role="status">{message}</p>}
      <form className="builder-form" onSubmit={(event) => void save(event)}>
        <section><div className="builder-step"><span>1</span><div><h2>Event basics</h2><p>Name the day and set the scoring window.</p></div></div><div className="form-grid"><div className="field field--wide"><label htmlFor="event-name">Event name</label><input id="event-name" name="name" defaultValue={existing?.name ?? ''} required minLength={3} maxLength={100} /></div><div className="field"><label htmlFor="season">Season</label><select id="season" name="seasonId" defaultValue={data.seasons.find((season) => season.status === 'active')?.id ?? data.seasons[0]?.id} required>{data.seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}</select></div><div className="field"><label htmlFor="visibility">Visibility</label><select id="visibility" name="visibility" defaultValue={existing?.visibility ?? 'league'}><option value="league">League members</option><option value="public">Public</option><option value="organizers">Organizers only</option></select></div><div className="field"><label htmlFor="starts-at">Starts</label><input id="starts-at" name="startsAt" type="datetime-local" defaultValue={defaultStart} required /></div><div className="field"><label htmlFor="ends-at">Ends (optional)</label><input id="ends-at" name="endsAt" type="datetime-local" defaultValue={existing?.ends_at ? localDateTime(existing.ends_at) : ''} /></div><div className="field field--wide"><label htmlFor="timezone">Venue timezone</label><input id="timezone" name="timezone" defaultValue={existing?.timezone ?? data.league?.timezone ?? 'America/Detroit'} required /></div></div></section>
        <section><div className="builder-step"><span>2</span><div><h2>Course and tee</h2><p>Publishing freezes this exact hole data.</p></div></div><div className="field"><label htmlFor="tee-set">Tee set</label><select id="tee-set" name="teeSetId" defaultValue={data.round?.source_tee_set_id ?? data.teeSets[0]?.id} required>{data.teeSets.map((tee) => <option key={tee.id} value={tee.id}>{tee.label} · Par {tee.par} · {tee.course_rating}/{tee.slope_rating}</option>)}</select></div></section>
        <section><div className="builder-step"><span>3</span><div><h2>Players and scorers</h2><p>Choose the field. Linked players can enter their own scores.</p></div></div><fieldset className="choice-list"><legend>Event field</legend>{data.participants.map((participant) => <label key={participant.id}><input type="checkbox" name="participantIds" value={participant.id} defaultChecked={selected.size ? selected.has(participant.id) : true} /><span><strong>{participant.display_name}</strong><small>{participant.profile_id ? 'Account linked' : 'Guest player'}</small></span></label>)}</fieldset><fieldset className="choice-list choice-list--compact"><legend>Marker access (optional)</legend>{data.participants.filter((participant) => participant.profile_id).map((participant) => <label key={participant.id}><input type="checkbox" name="scorerProfileIds" value={participant.profile_id!} /><span><strong>{participant.display_name}</strong><small>Can score the entire field</small></span></label>)}</fieldset></section>
        <section className="preflight"><div className="builder-step"><span>4</span><div><h2>Preflight and publish</h2><p>These checks are repeated on the server.</p></div></div><ul><li>Individual gross competition and full field will be created</li><li>Tee has a complete 9- or 18-hole par and stroke-index set</li><li>Handicap source and calculated values will be frozen</li><li>Published snapshots cannot be edited by the browser</li></ul><div className="builder-actions"><button className="button button--secondary" type="submit" disabled={submitting}>{submitting ? 'Working…' : 'Save draft'}</button><button className="button button--primary" type="button" onClick={() => void publish()} disabled={!savedEventId || submitting || existing?.status !== 'draft' && routeEventId !== 'new'}>Publish and open scoring</button></div></section>
      </form>
    </div>
  );
}

function localDateTime(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
