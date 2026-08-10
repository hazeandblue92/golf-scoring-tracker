/** Portable, integrity-checked Phase 1 export (spec §§12.2, 18.2, 22). */

import { exportLeagueRequestSchema } from '../../../packages/contracts/src/index.ts'
import {
  CORS_HEADERS,
  corsPreflight,
  newCorrelationId,
  readJsonBody,
  rejected,
  requireUser,
  serviceClient,
  sha256Hex,
} from '../_shared/http.ts'

type Row = Record<string, unknown>

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const object = value as Row
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`
}

function sorted(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => stable(a).localeCompare(stable(b)))
}

Deno.serve(async (req: Request) => {
  const correlationId = newCorrelationId()
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') {
    return rejected(405, 'SERVICE_UNAVAILABLE', correlationId, 'Method not allowed')
  }
  const caller = await requireUser(req, correlationId)
  if (caller instanceof Response) return caller
  const parsed = exportLeagueRequestSchema.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    return rejected(400, 'SNAPSHOT_INVALID', correlationId,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }

  const { leagueId, eventId } = parsed.data
  const service = serviceClient()
  const { data: grants } = await service
    .from('role_assignments')
    .select('role, event_id')
    .eq('profile_id', caller.userId)
    .eq('league_id', leagueId)
    .is('revoked_at', null)
  const authorized = (grants ?? []).some((grant: { role: string; event_id: string | null }) =>
    grant.role === 'owner' || grant.role === 'league_admin' ||
    (eventId !== undefined && grant.role === 'event_director' && grant.event_id === eventId))
  if (!authorized) {
    return rejected(403, 'NOT_ASSIGNED', correlationId, 'organizer role required')
  }

  async function select(table: string, build: (query: any) => any): Promise<Row[]> {
    const { data, error } = await build(service.from(table).select('*'))
    if (error) throw new Error(`${table}: ${error.message}`)
    return sorted((data ?? []) as Row[])
  }

  try {
    const events = await select('events', (q) => {
      const scoped = q.eq('league_id', leagueId)
      return eventId === undefined ? scoped : scoped.eq('id', eventId)
    })
    if (eventId !== undefined && events.length !== 1) {
      return rejected(404, 'SNAPSHOT_INVALID', correlationId, 'event not found in league')
    }
    const eventIds = events.map((row) => row.id as string)
    const rounds = eventIds.length
      ? await select('rounds', (q) => q.in('event_id', eventIds)) : []
    const roundIds = rounds.map((row) => row.id as string)
    const entries = eventIds.length
      ? await select('event_entries', (q) => q.in('event_id', eventIds)) : []
    const entryIds = entries.map((row) => row.id as string)
    const participantIds = entries.map((row) => row.participant_id as string)
    const competitions = eventIds.length
      ? await select('competitions', (q) => q.in('event_id', eventIds)) : []
    const competitionIds = competitions.map((row) => row.id as string)
    const entities = competitionIds.length
      ? await select('competition_entities', (q) => q.in('competition_id', competitionIds)) : []
    const entityIds = entities.map((row) => row.id as string)

    const tables: Record<string, Row[]> = {
      leagues: await select('leagues', (q) => q.eq('id', leagueId)),
      seasons: await select('seasons', (q) => q.eq('league_id', leagueId)),
      participants: participantIds.length
        ? (await select('participants', (q) => q.in('id', participantIds))).map((row) => ({
            ...row, profile_id: null, organizer_notes: null,
          })) : [],
      participant_handicaps: participantIds.length
        ? (await select('participant_handicaps', (q) => q.in('participant_id', participantIds))).map((row) => ({
            ...row, verified_by: null,
          })) : [],
      courses: await select('courses', (q) => q.eq('league_id', leagueId)),
      course_layouts: [],
      tee_sets: [],
      tee_holes: [],
      events: events.map((row) => ({ ...row, created_by: null })),
      rounds,
      event_tee_snapshots: roundIds.length
        ? await select('event_tee_snapshots', (q) => q.in('round_id', roundIds)) : [],
      event_holes: roundIds.length
        ? await select('event_holes', (q) => q.in('round_id', roundIds)) : [],
      event_entries: entries,
      flights: eventIds.length ? await select('flights', (q) => q.in('event_id', eventIds)) : [],
      groups: roundIds.length ? await select('groups', (q) => q.in('round_id', roundIds)) : [],
      group_members: [],
      competitions: competitions.map((row) => ({ ...row, finalized_by: null })),
      competition_rounds: competitionIds.length
        ? await select('competition_rounds', (q) => q.in('competition_id', competitionIds)) : [],
      competition_entities: entities,
      individual_hole_scores: eventIds.length
        ? (await select('individual_hole_scores', (q) => q.in('event_id', eventIds))).map((row) => ({
            ...row, entered_by: null,
          })) : [],
      score_conflicts: [],
      competition_projections: competitionIds.length
        ? await select('competition_projections', (q) => q.in('competition_id', competitionIds)) : [],
      leaderboard_rows: competitionIds.length
        ? await select('leaderboard_rows', (q) => q.in('competition_id', competitionIds)) : [],
      hole_results: competitionIds.length
        ? await select('hole_results', (q) => q.in('competition_id', competitionIds)) : [],
    }

    const courseIds = tables.courses.map((row) => row.id as string)
    tables.course_layouts = courseIds.length
      ? await select('course_layouts', (q) => q.in('course_id', courseIds)) : []
    const layoutIds = tables.course_layouts.map((row) => row.id as string)
    tables.tee_sets = layoutIds.length
      ? await select('tee_sets', (q) => q.in('course_layout_id', layoutIds)) : []
    const teeIds = tables.tee_sets.map((row) => row.id as string)
    tables.tee_holes = teeIds.length
      ? await select('tee_holes', (q) => q.in('tee_set_id', teeIds)) : []
    const groupIds = tables.groups.map((row) => row.id as string)
    tables.group_members = groupIds.length
      ? await select('group_members', (q) => q.in('group_id', groupIds)) : []

    // Keep only event entries in relationship tables and sanitize auth-linked
    // fields. Identity provisioning is intentionally not portable.
    tables.group_members = tables.group_members.filter((row) =>
      row.event_entry_id === null || entryIds.includes(row.event_entry_id as string))
    tables.leaderboard_rows = tables.leaderboard_rows.filter((row) =>
      entityIds.includes(row.entity_id as string))

    const core = {
      format: 'gtt-portable-export',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      scope: { leagueId, eventId: eventId ?? null },
      finalResultHashes: competitions
        .filter((row) => row.final_result_hash !== null)
        .map((row) => ({ competitionId: row.id, hash: row.final_result_hash })),
      tables,
    }
    const integrityHash = await sha256Hex(stable(core))
    const payload = { ...core, integrityHash, correlationId }
    const filename = `gtt-${eventId ?? leagueId}-${core.exportedAt.slice(0, 10)}.json`
    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    return rejected(500, 'SERVICE_UNAVAILABLE', correlationId, String(error))
  }
})
