import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useBlocker, useParams } from 'react-router';

import type { HoleScoreStatus } from '@gtt/contracts';
import { strokesReceivedOnHole } from '@gtt/scoring';

import { db } from '../lib/offline/db.ts';
import type { ScoreDraftRow } from '../lib/offline/db.ts';
import { localStrokePlay } from '../lib/offline/local-projections.ts';
import { enqueueScoreMutation, nextBaseRevision, syncOutbox } from '../lib/offline/outbox.ts';
import { initials, relationValue } from '../lib/row-display.ts';
import { useSession } from '../lib/session.tsx';
import { getSupabaseClient } from '../lib/supabase.ts';
import { useOnlineStatus } from '../lib/useOnlineStatus.ts';

interface HoleRow { id: string; hole_ordinal: number; label: string | null; par: number; stroke_index: number; yardage: number | null }
interface EntryRow { id: string; participant_id: string; playing_handicap: number | null; participants: { display_name: string; profile_id: string | null } | null }
interface ScoreRow { event_entry_id: string; event_hole_id: string; gross_strokes: number | null; score_status: HoleScoreStatus; revision: number }
interface TeamRow { id: string; name: string; playing_handicap: number | null; entryIds: string[]; participantIds: string[]; profileIds: string[] }
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
  const queryClient = useQueryClient();
  const queryKey = ['score-entry', eventId, session?.user.id, online] as const;
  const [holeIndex, setHoleIndex] = useState(0);
  const [values, setValues] = useState<Record<string, EditorValue>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [locallyCommitted, setLocallyCommitted] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  // Sunlight is a per-device contrast preference: it never travels with the
  // account and never touches a stored score (DESIGN.md §Colors, amended).
  const [sunlight, setSunlight] = useState(
    () => window.localStorage.getItem('gtt.sunlight') === '1');

  useEffect(() => {
    window.localStorage.setItem('gtt.sunlight', sunlight ? '1' : '0');
  }, [sunlight]);

  const query = useQuery({
    queryKey,
    enabled: eventId !== '' && session !== null,
    // This query owns an IndexedDB fallback. It must be allowed to execute
    // while offline; TanStack's default network mode would pause it before
    // the cache branch below can run.
    networkMode: 'always',
    queryFn: async () => {
      const drafts = await db.scoreDrafts.where('eventId').equals(eventId).toArray();
      const readCached = async (fallbackError: unknown): Promise<ScoreEntryData> => {
        const snapshots = await db.eventSnapshots.where('eventId').equals(eventId).sortBy('snapshotRevision');
        const cached = snapshots.filter((row) => row.userId === session?.user.id).at(-1);
        if (!cached || !isScoreEntrySnapshot(cached.payload)) throw fallbackError;
        return { ...cached.payload, drafts, dataSource: 'cache', cachedAt: cached.cachedAt };
      };

      if (!online) {
        return readCached(new Error('No saved offline scorecard is available for this event.'));
      }

      try {
        const supabase = getSupabaseClient();
        const { data: event, error } = await supabase.from('events').select('id,league_id,name,status,scoring_revision').eq('id', eventId).single();
        if (error) throw error;
        const { data: rounds } = await supabase.from('rounds').select('id,hole_count').eq('event_id', eventId).order('round_number');
        const round = rounds?.[0];
        if (!round) throw new Error('No scoring round is configured.');
        const [
          holesResult,
          entriesResult,
          scoresResult,
          permissionsResult,
          rolesResult,
          competitionsResult,
          teamsResult,
          teamScoresResult,
        ] = await Promise.all([
          supabase.from('event_holes').select('id,hole_ordinal,label,par,stroke_index,yardage').eq('round_id', round.id).order('hole_ordinal'),
          supabase.from('event_entries').select('id,participant_id,playing_handicap,participants(display_name,profile_id)').eq('event_id', eventId).eq('status', 'active'),
          supabase.from('individual_hole_scores').select('event_entry_id,event_hole_id,gross_strokes,score_status,revision').eq('event_id', eventId),
          supabase.from('scoring_permissions').select('participant_id,permission_type').eq('event_id', eventId).eq('round_id', round.id),
          supabase.from('role_assignments').select('role,event_id,league_id').is('revoked_at', null),
          supabase.from('competitions').select('format').eq('event_id', eventId),
          supabase.from('event_teams').select('id,name,playing_handicap,event_team_members(event_entries(id,participant_id,participants(profile_id)))').eq('event_id', eventId).eq('status', 'active'),
          supabase.from('team_hole_scores').select('event_team_id,event_hole_id,gross_strokes,score_status,revision').eq('event_id', eventId),
        ]);
        // Every secondary read must succeed before this snapshot is allowed to
        // replace the cached one. Previously only `error` on the event query
        // was checked, so a failed holes/entries/scores/permissions read wrote
        // a snapshot with empty arrays at the SAME revision as a good one —
        // silently replacing a usable offline scorecard with an unusable one.
        const secondaryError = holesResult.error
          ?? entriesResult.error
          ?? scoresResult.error
          ?? permissionsResult.error
          ?? rolesResult.error
          ?? competitionsResult.error
          ?? teamsResult.error
          ?? teamScoresResult.error;
        if (secondaryError) throw secondaryError;
        const holes = holesResult.data;
        const entries = entriesResult.data;
        const scores = scoresResult.data;
        const permissions = permissionsResult.data;
        const roles = rolesResult.data;
        const competitions = competitionsResult.data;
        const teams = teamsResult.data;
        const teamScores = teamScoresResult.data;

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
              id: string;
              participant_id: string;
              participants: { profile_id: string | null } | Array<{ profile_id: string | null }> | null;
            } | Array<{
              id: string;
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
            entryIds: members.map((member) => member.id),
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
        return readCached(error);
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

  /**
   * Strokes this entity receives on THIS hole, from the frozen Playing
   * Handicap and the hole's stroke index — the same engine allocation the
   * server projects with, so the number on the row is the number that counts.
   * A plus player's given-back stroke is negative, never blank.
   */
  function strokesOnHole(playingHandicap: number | null): number | null {
    if (playingHandicap === null || !Number.isInteger(playingHandicap)) return null;
    try {
      return strokesReceivedOnHole(playingHandicap, holes.length, hole.stroke_index);
    } catch {
      // A hole set whose stroke indexes are not a 1..N permutation is a setup
      // defect, not a scoring one: show nothing rather than a wrong number.
      return null;
    }
  }

  /** A hole is entered when every visible entity has a resolved value. */
  function holeIsEntered(candidate: HoleRow): boolean {
    if (entities.length === 0 || query.data === undefined) return false;
    return entities.every((entity) => {
      const draft = query.data!.drafts.find(
        (row) => row.entityId === entity.id && row.holeId === candidate.id);
      const server = serverScores.get(`${entity.id}:${candidate.id}`);
      const status = draft?.status ?? server?.score_status;
      return status !== undefined && status !== 'not_started';
    });
  }

  const resolvedForEntity = (entityId: string) => {
    const value = values[entityId];
    const server = serverScores.get(`${entityId}:${hole.id}`);
    const status = value?.status ?? server?.score_status;
    if (status !== 'complete') return null;
    return value?.gross ?? server?.gross_strokes ?? null;
  };

  /**
   * Best gross and best net for each team on THIS hole only, from the values
   * on screen. It is an in-hole preview, never the authoritative board: net
   * uses each player's frozen full Playing Handicap, so a competition running
   * a reduced allowance will differ.
   */
  const teamPreviews = scoringMode === 'individual'
    ? (query.data.teams ?? []).map((team) => {
      const grosses: number[] = [];
      const nets: number[] = [];
      for (const entryId of team.entryIds) {
        const gross = resolvedForEntity(entryId);
        if (gross === null) continue;
        grosses.push(gross);
        const entity = entities.find((candidate) => candidate.id === entryId);
        const strokes = strokesOnHole(entity?.playingHandicap ?? null);
        if (strokes !== null) nets.push(gross - strokes);
      }
      return {
        id: team.id,
        name: team.name,
        bestGross: grosses.length > 0 ? Math.min(...grosses) : null,
        bestNet: nets.length > 0 ? Math.min(...nets) : null,
      };
    })
    : [];

  /**
   * Provisional standings computed on this device with the SAME engine the
   * server projects with, over the cached snapshot plus unsent drafts. It
   * exists so a group can see where they stand with no signal; it is always
   * replaced by the authoritative projection once online, and it covers only
   * the entries this snapshot was permitted to cache.
   */
  const localStandings = scoringMode === 'individual' && query.data.entries.length > 0
    ? ((): Array<{
      entryId: string;
      name: string;
      thru: number;
      gross: number | null;
      net: number | null;
      rank: number | null;
    }> => {
      try {
      const entries = query.data.entries.map((entry) => ({
        id: entry.id,
        playingHandicap: entry.playing_handicap,
      }));
      const drafts = query.data.drafts.map((row) => ({
        entityId: row.entityId,
        holeId: row.holeId,
        value: row.value,
        status: row.status,
        baseRevision: row.baseRevision,
      }));
      const shared = { holes, entries, scores: query.data.scores, drafts };
      const gross = localStrokePlay({ ...shared, metric: 'gross' });
      const net = localStrokePlay({ ...shared, metric: 'net' });
      const nameOf = (entryId: string) => query.data!.entries
        .find((entry) => entry.id === entryId)?.participants?.display_name ?? 'Player';
      return gross.rows
        .map((row) => ({
          entryId: row.entryId,
          name: nameOf(row.entryId),
          thru: row.thru,
          gross: row.grossTotal,
          net: net.rows.find((candidate) => candidate.entryId === row.entryId)?.netTotal ?? null,
          rank: row.rank,
        }))
        .filter((row) => row.thru > 0)
        .toSorted((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
      } catch {
        // The engine validates its inputs and throws on a malformed hole set
        // (for example stroke indexes that are not a 1..N permutation, which a
        // partial cached snapshot can produce). This panel is a convenience;
        // score ENTRY is the job of this screen and must survive without it.
        return [];
      }
    })()
    : [];

  function parAll() {
    const next: Record<string, EditorValue> = { ...values };
    for (const entity of entities) {
      next[entity.id] = { status: 'complete', gross: hole.par };
    }
    setValues(next);
    setDirty(new Set(entities.map((entity) => entity.id)));
    // Announced through the footer's existing polite status region, not a
    // second one: the screen must keep exactly one announcement channel
    // (§18 restrained cadence), and a bulk edit is a save-state change.
    setSaveMessage(
      `Set ${entities.length} score${entities.length === 1 ? '' : 's'} to par ${hole.par} — not saved yet`,
    );
  }

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
        // A background sync may have committed this hole and advanced the
        // draft since the snapshot was read; take whichever revision is newer
        // so a second edit does not claim a base the server has moved past.
        const draft = query.data?.drafts.find((row) =>
          row.entityId === entityId && row.holeId === hole.id);
        await enqueueScoreMutation({
          eventId,
          roundId: round.id,
          target: scoringMode === 'team'
            ? { kind: 'team', teamId: entityId, holeId: hole.id }
            : { kind: 'individual', entryId: entityId, holeId: hole.id },
          baseRevision: nextBaseRevision(server?.revision, draft?.baseRevision),
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
      // Queueing commits each draft to IndexedDB before returning. Refresh the
      // active query cache from that durable copy before clearing `dirty`, so
      // the hydration effect cannot restore stale server values while offline.
      const persistedDrafts = await db.scoreDrafts
        .where('eventId')
        .equals(eventId)
        .toArray();
      queryClient.setQueryData<ScoreEntryData>(queryKey, (current) => current
        ? { ...current, drafts: persistedDrafts }
        : current);
      setDirty(new Set());
      setSaveMessage('Saved on this device');
      if (online) {
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

  async function saveAndNext() {
    await saveHole();
    setHoleIndex((index) => Math.min(holes.length - 1, index + 1));
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
    <div className={`score-screen${sunlight ? ' score-screen--sunlight' : ''}`}>
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

      <nav className="hole-strip" aria-label="Holes in this round">
        {holes.map((candidate, index) => {
          const entered = holeIsEntered(candidate);
          const isCurrent = index === holeIndex;
          return (
            <button
              key={candidate.id}
              type="button"
              className={`hole-chip${isCurrent ? ' hole-chip--current' : ''}${entered ? ' hole-chip--entered' : ''}`}
              aria-current={isCurrent ? 'true' : undefined}
              aria-label={`Hole ${candidate.hole_ordinal}${entered ? ', entered' : ', not entered'}`}
              disabled={saving}
              onClick={() => { if (dirty.size > 0) { void saveHole(); } setHoleIndex(index); }}
            >
              <span aria-hidden="true">{candidate.hole_ordinal}</span>
              {entered && <span className="hole-chip__mark" aria-hidden="true">✓</span>}
            </button>
          );
        })}
      </nav>

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

      {teamPreviews.length >= 2 && (
        <section className="team-preview" aria-label={`Team standing on hole ${currentHole.hole_ordinal}`}>
          <div className="team-preview__head">
            <h2>This hole</h2>
            <small>Preview · net at full handicap</small>
          </div>
          <div className="team-preview__rows">
            {teamPreviews.map((team) => (
              <div key={team.id}>
                <strong>{team.name}</strong>
                <span>Gross <b>{team.bestGross ?? '—'}</b></span>
                <span>Net <b>{team.bestNet ?? '—'}</b></span>
              </div>
            ))}
          </div>
        </section>
      )}

      {entities.length > 0 && (
        <div className="hole-actions">
          <button className="button button--quiet" type="button" onClick={parAll} disabled={saving}>
            Par all ({currentHole.par})
          </button>
          <button
            className="button button--quiet"
            type="button"
            aria-pressed={sunlight}
            onClick={() => setSunlight((current) => !current)}
          >
            Sunlight {sunlight ? 'on' : 'off'}
          </button>
        </div>
      )}

      <section className="score-list" aria-label={`Scores for hole ${currentHole.hole_ordinal}`}>
        {entities.length === 0 ? (
          <div className="empty-state"><h2>No scoring assignment</h2><p>An organizer must assign you this {scoringMode === 'team' ? 'team' : 'group'} before you can enter scores.</p></div>
        ) : entities.map((entity) => {
          const value = values[entity.id] ?? { status: 'complete' as const, gross: currentHole.par };
          const server = serverScores.get(`${entity.id}:${currentHole.id}`);
          const strokes = strokesOnHole(entity.playingHandicap);
          const net = value.status === 'complete' && value.gross !== null && strokes !== null
            ? value.gross - strokes
            : null;
          const toPar = net === null ? null : net - currentHole.par;
          return (
            <article className="score-row" key={entity.id}>
              <div className="score-person">
                <div className="initials" aria-hidden="true">{initials(entity.name)}</div>
                <div><h2>{entity.name}</h2><span>{scoringMode === 'team' ? 'Team playing handicap' : 'Playing handicap'} {entity.playingHandicap ?? '—'} · {server ? `rev ${server.revision}` : 'not entered'}</span></div>
                {strokes !== null && (
                  <span className={`hole-strokes${strokes < 0 ? ' hole-strokes--gives' : ''}`}>
                    <small>Strokes</small>
                    <strong>
                      {strokes > 0 && <span className="hole-strokes__dots" aria-hidden="true">{'•'.repeat(Math.min(strokes, 4))}</span>}
                      {strokes > 0 ? `+${strokes}` : strokes === 0 ? 'None' : String(strokes)}
                    </strong>
                  </span>
                )}
              </div>
              <div className="score-controls">
                <button type="button" aria-label={`Decrease ${entity.name} score`} onClick={() => change(entity.id, { status: 'complete', gross: Math.max(1, (value.gross ?? currentHole.par) - 1) })} disabled={value.status !== 'complete'}>−</button>
                <input aria-label={`${entity.name} gross score`} inputMode="numeric" type="number" min="1" max="25" value={value.gross ?? ''} disabled={value.status !== 'complete'} onChange={(event) => change(entity.id, { status: 'complete', gross: event.target.value === '' ? null : Math.min(25, Math.max(1, Number(event.target.value))) })} />
                <button type="button" aria-label={`Increase ${entity.name} score`} onClick={() => change(entity.id, { status: 'complete', gross: Math.min(25, (value.gross ?? currentHole.par) + 1) })} disabled={value.status !== 'complete'}>+</button>
              </div>
              {net !== null && (
                <p className="net-preview">
                  Net <strong>{net}</strong>
                  <span>{toPar === 0 ? 'level par' : toPar! > 0 ? `${toPar} over par` : `${Math.abs(toPar!)} under par`}</span>
                </p>
              )}
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

      {localStandings.length > 0 && (
        <section className="local-standings" aria-labelledby="local-standings-title">
          <div className="section-heading">
            <h2 id="local-standings-title">Standings on this device</h2>
            <span>Provisional</span>
          </div>
          <p className="muted">
            Calculated here from saved scores, including any not yet sent. The published
            leaderboard replaces this once the device syncs.
          </p>
          <ol className="local-standings__rows">
            {localStandings.map((row) => (
              <li key={row.entryId}>
                <span className="local-standings__name">{row.name}</span>
                <span>Thru {row.thru}</span>
                <span>Gross <b>{row.gross ?? '—'}</b></span>
                <span>Net <b>{row.net ?? '—'}</b></span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <footer className="score-footer">
        <div><span>{completed} of {totalRequired} scores received</span><strong role="status" aria-live="polite">{saveMessage}</strong></div>
        <div className="score-footer__actions">
          <button className="button button--primary" type="button" onClick={() => void saveHole()} disabled={(dirty.size === 0 && pendingDefaultIds.length === 0) || saving || entities.length === 0}>{saving ? 'Saving…' : `Save hole ${currentHole.hole_ordinal}`}</button>
          <button className="button button--secondary" type="button" onClick={() => void saveAndNext()} disabled={saving || entities.length === 0 || holeIndex === holes.length - 1}>Save and next</button>
        </div>
      </footer>
    </div>
  );
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
