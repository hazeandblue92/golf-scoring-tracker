import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useBlocker, useParams } from 'react-router';

import type { HoleScoreStatus } from '@gtt/contracts';

import { db } from '../lib/offline/db.ts';
import type { ScoreDraftRow } from '../lib/offline/db.ts';
import { enqueueScoreMutation, syncOutbox } from '../lib/offline/outbox.ts';
import { useSession } from '../lib/session.tsx';
import { getSupabaseClient } from '../lib/supabase.ts';
import { useOnlineStatus } from '../lib/useOnlineStatus.ts';

interface HoleRow { id: string; hole_ordinal: number; label: string | null; par: number; stroke_index: number; yardage: number | null }
interface EntryRow { id: string; participant_id: string; playing_handicap: number | null; participants: { display_name: string; profile_id: string | null } | null }
interface ScoreRow { event_entry_id: string; event_hole_id: string; gross_strokes: number | null; score_status: HoleScoreStatus; revision: number }
interface TeamRow { id: string; name: string; playing_handicap: number | null; participantIds: string[]; profileIds: string[] }
interface TeamScoreRow { event_team_id: string; event_hole_id: string; gross_strokes: number | null; score_status: HoleScoreStatus; revision: number }
interface EditorValue { status: HoleScoreStatus; gross: number | null }
interface ScoreEntrySnapshot {
  event: { id: string; league_id: string; name: string; status: string; scoring_revision: number };
  round: { id: string; hole_count: number };
  holes: HoleRow[];
  entries: EntryRow[];
  scores: ScoreRow[];
  scoringMode?: 'individual' | 'team';
  teams?: TeamRow[];
  teamScores?: TeamScoreRow[];
}
interface ScoreEntryData extends ScoreEntrySnapshot {
  drafts: ScoreDraftRow[];
  dataSource: 'server' | 'cache';
  cachedAt: number;
}

export function ScoreEntry() {
  const { eventId = '' } = useParams();
  const { session } = useSession();
  const online = useOnlineStatus();
  const [holeIndex, setHoleIndex] = useState(0);
  const [values, setValues] = useState<Record<string, EditorValue>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [locallyCommitted, setLocallyCommitted] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  const query = useQuery({
    queryKey: ['score-entry', eventId, session?.user.id],
    enabled: eventId !== '' && session !== null,
    queryFn: async () => {
      const drafts = await db.scoreDrafts.where('eventId').equals(eventId).toArray();
      try {
        const supabase = getSupabaseClient();
        const { data: event, error } = await supabase.from('events').select('id,league_id,name,status,scoring_revision').eq('id', eventId).single();
        if (error) throw error;
        const { data: rounds } = await supabase.from('rounds').select('id,hole_count').eq('event_id', eventId).order('round_number');
        const round = rounds?.[0];
        if (!round) throw new Error('No scoring round is configured.');
        const [
          { data: holes },
          { data: entries },
          { data: scores },
          { data: permissions },
          { data: roles },
          { data: competitions },
          { data: teams },
          { data: teamScores },
        ] = await Promise.all([
          supabase.from('event_holes').select('id,hole_ordinal,label,par,stroke_index,yardage').eq('round_id', round.id).order('hole_ordinal'),
          supabase.from('event_entries').select('id,participant_id,playing_handicap,participants(display_name,profile_id)').eq('event_id', eventId).eq('status', 'active'),
          supabase.from('individual_hole_scores').select('event_entry_id,event_hole_id,gross_strokes,score_status,revision').eq('event_id', eventId),
          supabase.from('scoring_permissions').select('participant_id,permission_type').eq('event_id', eventId).eq('round_id', round.id),
          supabase.from('role_assignments').select('role,event_id,league_id').is('revoked_at', null),
          supabase.from('competitions').select('format').eq('event_id', eventId),
          supabase.from('event_teams').select('id,name,playing_handicap,event_team_members(event_entries(participant_id,participants(profile_id)))').eq('event_id', eventId).eq('status', 'active'),
          supabase.from('team_hole_scores').select('event_team_id,event_hole_id,gross_strokes,score_status,revision').eq('event_id', eventId),
        ]);
        const director = (roles ?? []).some((role) =>
          ['owner', 'league_admin'].includes(role.role) || (role.role === 'event_director' && role.event_id === eventId));
        const allowedParticipants = new Set((permissions ?? []).map((row) => row.participant_id));
        const normalizedEntries = (entries ?? []).map((entry) => ({
          ...entry,
          participants: Array.isArray(entry.participants) ? entry.participants[0] ?? null : entry.participants,
        })) as EntryRow[];
        const visibleEntries = normalizedEntries.filter((entry) =>
          director || allowedParticipants.has(entry.participant_id) || entry.participants?.profile_id === session?.user.id);
        const normalizedTeams = ((teams ?? []) as unknown as Array<{
          id: string;
          name: string;
          playing_handicap: number | null;
          event_team_members: Array<{
            event_entries: {
              participant_id: string;
              participants: { profile_id: string | null } | Array<{ profile_id: string | null }> | null;
            } | Array<{
              participant_id: string;
              participants: { profile_id: string | null } | Array<{ profile_id: string | null }> | null;
            }> | null;
          }>;
        }>).map((team) => {
          const members = team.event_team_members.map((member) => relationValue(member.event_entries)).filter((entry) => entry !== null);
          return {
            id: team.id,
            name: team.name,
            playing_handicap: team.playing_handicap,
            participantIds: members.map((member) => member.participant_id),
            profileIds: members.map((member) => relationValue(member.participants)?.profile_id).filter((profileId): profileId is string => profileId !== null && profileId !== undefined),
          };
        });
        const visibleTeams = normalizedTeams.filter((team) =>
          director
          || team.participantIds.some((participantId) => allowedParticipants.has(participantId))
          || team.profileIds.includes(session!.user.id));
        const scoringMode = (competitions ?? []).some((competition) =>
          ['scramble', 'foursomes', 'greensomes', 'chapman'].includes(competition.format))
          ? 'team'
          : 'individual';
        const snapshot: ScoreEntrySnapshot = {
          event,
          round,
          holes: (holes ?? []) as HoleRow[],
          entries: visibleEntries,
          scores: (scores ?? []) as ScoreRow[],
          scoringMode,
          teams: visibleTeams,
          teamScores: (teamScores ?? []) as TeamScoreRow[],
        };
        const cachedAt = Date.now();
        await db.eventSnapshots.put({
          eventId,
          snapshotRevision: event.scoring_revision,
          payload: snapshot,
          cachedAt,
          userId: session!.user.id,
        });
        return { ...snapshot, drafts, dataSource: 'server', cachedAt } satisfies ScoreEntryData;
      } catch (error) {
        const snapshots = await db.eventSnapshots.where('eventId').equals(eventId).sortBy('snapshotRevision');
        const cached = snapshots.filter((row) => row.userId === session?.user.id).at(-1);
        if (!cached || !isScoreEntrySnapshot(cached.payload)) throw error;
        return { ...cached.payload, drafts, dataSource: 'cache', cachedAt: cached.cachedAt } satisfies ScoreEntryData;
      }
    },
  });

  const currentHole = query.data?.holes[holeIndex];
  const scoringMode = query.data?.scoringMode ?? 'individual';
  const entities = useMemo(() => scoringMode === 'team'
    ? (query.data?.teams ?? []).map((team) => ({ id: team.id, name: team.name, playingHandicap: team.playing_handicap }))
    : (query.data?.entries ?? []).map((entry) => ({ id: entry.id, name: entry.participants?.display_name ?? 'Player', playingHandicap: entry.playing_handicap })), [query.data?.entries, query.data?.teams, scoringMode]);
  const serverScores = useMemo(() => {
    if (scoringMode === 'team') {
      return new Map((query.data?.teamScores ?? []).map((score) => [`${score.event_team_id}:${score.event_hole_id}`, score]));
    }
    return new Map((query.data?.scores ?? []).map((score) => [`${score.event_entry_id}:${score.event_hole_id}`, score]));
  }, [query.data?.scores, query.data?.teamScores, scoringMode]);
  const pendingDefaultIds = useMemo(() => {
    if (!query.data || !currentHole) return [];
    return entities.map((entity) => entity.id).filter((entityId) => {
      const key = `${entityId}:${currentHole.id}`;
      const draft = query.data.drafts.some((row) => row.entityId === entityId && row.holeId === currentHole.id);
      return !draft && !serverScores.has(key) && !locallyCommitted.has(key);
    });
  }, [currentHole, entities, locallyCommitted, query.data, serverScores]);

  useEffect(() => {
    if (!query.data || !currentHole) return;
    // React Query can refresh the snapshot while a group is being entered.
    // Never let that background refresh erase unsaved edits on the hole.
    if (dirty.size > 0) return;
    const next: Record<string, EditorValue> = {};
    for (const entity of entities) {
      const draft = query.data.drafts.find((row) => row.entityId === entity.id && row.holeId === currentHole.id);
      const server = serverScores.get(`${entity.id}:${currentHole.id}`);
      next[entity.id] = draft
        ? { status: draft.status as HoleScoreStatus, gross: draft.value }
        : server
          ? { status: server.score_status, gross: server.gross_strokes }
          : { status: 'complete', gross: currentHole.par };
    }
    setValues(next);
    setDirty(new Set());
  }, [currentHole, dirty.size, entities, query.data, serverScores]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.size > 0) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty.size]);

  const blocker = useBlocker(dirty.size > 0);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('This hole has unsaved changes. Leave and discard them?')) blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  if (query.isLoading) return <div className="screen"><div className="skeleton skeleton--score" /></div>;
  if (!query.data || !currentHole) return <p className="form-message form-message--error" role="alert">Scoring is not available for this event.</p>;
  const hole = currentHole;
  const { event, round, holes } = query.data;
  window.localStorage.setItem('gtt.activeEventId', event.id);

  function change(entityId: string, next: EditorValue) {
    setValues((current) => ({ ...current, [entityId]: next }));
    setDirty((current) => new Set(current).add(entityId));
    setSaveMessage('Unsaved changes');
  }

  async function saveHole() {
    const targetIds = new Set([...dirty, ...pendingDefaultIds]);
    if (targetIds.size === 0) return;
    setSaving(true);
    setSaveMessage('Saving on this device…');
    try {
      for (const entityId of targetIds) {
        const value = values[entityId];
        if (value === undefined) continue;
        const server = serverScores.get(`${entityId}:${hole.id}`);
        await enqueueScoreMutation({
          eventId,
          roundId: round.id,
          target: scoringMode === 'team'
            ? { kind: 'team', teamId: entityId, holeId: hole.id }
            : { kind: 'individual', entryId: entityId, holeId: hole.id },
          baseRevision: server?.revision ?? 0,
          value: {
            status: value.status,
            ...(value.status === 'complete' && value.gross !== null ? { grossStrokes: value.gross } : {}),
            notes: null,
          },
        });
      }
      setLocallyCommitted((current) => {
        const next = new Set(current);
        for (const entityId of targetIds) next.add(`${entityId}:${hole.id}`);
        return next;
      });
      setDirty(new Set());
      setSaveMessage('Saved on this device');
      if (navigator.onLine) {
        const result = await syncOutbox();
        if (result.conflict > 0) setSaveMessage('Conflict needs organizer review');
        else if (result.rejected > 0) setSaveMessage('Score rejected — review event access');
        else if (result.synced > 0) setSaveMessage('Saved to server · leaderboard updated');
        await query.refetch();
      }
    } catch {
      setSaveMessage('Saved locally; server sync will retry');
    } finally {
      setSaving(false);
    }
  }

  async function move(delta: number) {
    if (dirty.size > 0) await saveHole();
    setHoleIndex((index) => Math.min(holes.length - 1, Math.max(0, index + delta)));
  }

  const completed = entities.reduce((count, entity) => count + holes.filter((candidate) => {
    const score = serverScores.get(`${entity.id}:${candidate.id}`);
    return score !== undefined && score.score_status !== 'not_started';
  }).length, 0);
  const totalRequired = holes.length * entities.length;

  return (
    <div className="score-screen">
      <header className="hole-header">
        <div>
          <Link className="back-link" to={`/events/${eventId}`}>Back to {event.name}</Link>
          <h1>Hole {currentHole.hole_ordinal}</h1>
        </div>
        <div className="hole-facts">
          <span><small>Par</small><strong>{currentHole.par}</strong></span>
          <span><small>SI</small><strong>{currentHole.stroke_index}</strong></span>
          {currentHole.yardage && <span><small>Yards</small><strong>{currentHole.yardage}</strong></span>}
        </div>
      </header>

      {(query.data.dataSource === 'cache' || !online) && (
        <p className="form-message form-message--warning score-cache-notice" role="status">
          {online ? 'Saved' : 'Offline'} copy from {new Date(query.data.cachedAt).toLocaleString()}. New scores stay on this device until server sync is available.
        </p>
      )}

      <nav className="hole-nav" aria-label="Hole navigation">
        <button className="button button--quiet" type="button" onClick={() => void move(-1)} disabled={holeIndex === 0 || saving}>Previous</button>
        <span>{holeIndex + 1} of {holes.length}</span>
        <button className="button button--quiet" type="button" onClick={() => void move(1)} disabled={holeIndex === holes.length - 1 || saving}>Next</button>
      </nav>

      <section className="score-list" aria-label={`Scores for hole ${currentHole.hole_ordinal}`}>
        {entities.length === 0 ? (
          <div className="empty-state"><h2>No scoring assignment</h2><p>An organizer must assign you this {scoringMode === 'team' ? 'team' : 'group'} before you can enter scores.</p></div>
        ) : entities.map((entity) => {
          const value = values[entity.id] ?? { status: 'complete' as const, gross: currentHole.par };
          const server = serverScores.get(`${entity.id}:${currentHole.id}`);
          return (
            <article className="score-row" key={entity.id}>
              <div className="score-person">
                <div className="initials" aria-hidden="true">{initials(entity.name)}</div>
                <div><h2>{entity.name}</h2><span>{scoringMode === 'team' ? 'Team playing handicap' : 'Playing handicap'} {entity.playingHandicap ?? '—'} · {server ? `rev ${server.revision}` : 'not entered'}</span></div>
              </div>
              <div className="score-controls">
                <button type="button" aria-label={`Decrease ${entity.name} score`} onClick={() => change(entity.id, { status: 'complete', gross: Math.max(1, (value.gross ?? currentHole.par) - 1) })} disabled={value.status !== 'complete'}>−</button>
                <input aria-label={`${entity.name} gross score`} inputMode="numeric" type="number" min="1" max="25" value={value.gross ?? ''} disabled={value.status !== 'complete'} onChange={(event) => change(entity.id, { status: 'complete', gross: event.target.value === '' ? null : Math.min(25, Math.max(1, Number(event.target.value))) })} />
                <button type="button" aria-label={`Increase ${entity.name} score`} onClick={() => change(entity.id, { status: 'complete', gross: Math.min(25, (value.gross ?? currentHole.par) + 1) })} disabled={value.status !== 'complete'}>+</button>
              </div>
              <label className="compact-select">Result
                <select value={value.status} onChange={(event) => {
                  const status = event.target.value as HoleScoreStatus;
                  change(entity.id, { status, gross: status === 'complete' ? value.gross ?? currentHole.par : null });
                }}>
                  <option value="complete">Completed</option>
                  <option value="picked_up">Picked up</option>
                  <option value="no_score">No score</option>
                  <option value="withdrawn">Withdrawn</option>
                </select>
              </label>
            </article>
          );
        })}
      </section>

      <footer className="score-footer">
        <div><span>{completed} of {totalRequired} scores received</span><strong role="status" aria-live="polite">{saveMessage}</strong></div>
        <button className="button button--primary" type="button" onClick={() => void saveHole()} disabled={(dirty.size === 0 && pendingDefaultIds.length === 0) || saving || entities.length === 0}>{saving ? 'Saving…' : `Save hole ${currentHole.hole_ordinal}`}</button>
      </footer>
    </div>
  );
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}

function relationValue<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function isScoreEntrySnapshot(value: unknown): value is ScoreEntrySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ScoreEntrySnapshot>;
  return typeof candidate.event?.id === 'string'
    && typeof candidate.round?.id === 'string'
    && Array.isArray(candidate.holes)
    && Array.isArray(candidate.entries)
    && Array.isArray(candidate.scores);
}
