/** Portable, integrity-checked event export (spec §§12.2, 18.2, 22). */

import { exportLeagueRequestSchema } from '../../../packages/contracts/src/index.ts'
import {
  CORS_HEADERS,
  corsPreflight,
  newCorrelationId,
  readJsonBody,
  rejected,
  requireMfa,
  requireUser,
  serviceClient,
  sha256Hex,
} from '../_shared/http.ts'

type Row = Record<string, unknown>

interface PortableSnapshot {
  authorized: boolean
  tables: Record<string, Row[]>
  attestationRecords: Row[]
  scoreMutationRecords: Row[]
  auditRecords: Row[]
  finalResultHashes: Array<{ competitionId: string; hash: string }>
  missingSealedCompetitionIds: string[]
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const object = value as Row
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`
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
  const mfaGate = requireMfa(caller, correlationId)
  if (mfaGate) return mfaGate
  const parsed = exportLeagueRequestSchema.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    return rejected(400, 'SNAPSHOT_INVALID', correlationId,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }

  const { leagueId, eventId } = parsed.data
  const service = serviceClient()

  try {
    // The database returns one JSON value assembled by one STABLE SQL
    // statement. That gives every table the same MVCC snapshot and avoids
    // PostgREST's row cap without offset pagination races.
    const { data, error } = await service.rpc('export_portable_snapshot', {
      p_actor: caller.userId,
      p_league_id: leagueId,
      p_event_id: eventId ?? null,
    })
    if (error) throw new Error(`portable snapshot: ${error.message}`)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('portable snapshot returned an invalid document')
    }

    const snapshot = data as unknown as PortableSnapshot
    if (typeof snapshot.authorized !== 'boolean' ||
      snapshot.tables === null || typeof snapshot.tables !== 'object' ||
      !Array.isArray(snapshot.tables.events) ||
      !Array.isArray(snapshot.tables.participants) ||
      !Array.isArray(snapshot.tables.teams) ||
      !Array.isArray(snapshot.tables.team_members) ||
      !Array.isArray(snapshot.attestationRecords) ||
      !Array.isArray(snapshot.scoreMutationRecords) ||
      !Array.isArray(snapshot.auditRecords) ||
      !Array.isArray(snapshot.finalResultHashes) ||
      !Array.isArray(snapshot.missingSealedCompetitionIds)) {
      throw new Error('portable snapshot returned an invalid document')
    }
    if (!snapshot.authorized) {
      return rejected(403, 'NOT_ASSIGNED', correlationId, 'organizer role required')
    }

    const events = snapshot.tables.events
    if (eventId !== undefined && events.length !== 1) {
      return rejected(404, 'SNAPSHOT_INVALID', correlationId, 'event not found in league')
    }
    if (snapshot.missingSealedCompetitionIds.length > 0) {
      throw new Error(
        `finalized competition ${snapshot.missingSealedCompetitionIds[0]} has no sealed projection`,
      )
    }

    const core = {
      format: 'gtt-portable-export',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      scope: { leagueId, eventId: eventId ?? null },
      finalResultHashes: snapshot.finalResultHashes,
      // Attestations are portable evidence, but their identity-linked profile
      // foreign key is deliberately excluded and is not restored as authority.
      attestationRecords: snapshot.attestationRecords,
      // Append-only ledgers are retained as sanitized evidence. They are not
      // replayed into identity-linked authority on a fresh deployment.
      scoreMutationRecords: snapshot.scoreMutationRecords,
      auditRecords: snapshot.auditRecords,
      tables: snapshot.tables,
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
