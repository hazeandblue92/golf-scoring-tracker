/**
 * League catalog administration: seasons, players, handicaps, courses/tees.
 *
 * Player identity lives in `account-admin`, not here. A CSV import deliberately
 * does NOT create sign-in accounts: §3.1 delivers each temporary password out
 * of band, exactly once, and twenty of them in one response is a
 * credential-handling problem rather than a feature. An import links a row to
 * an account that already exists by username, and reports the rest so the
 * organizer creates them one at a time from the roster.
 */

import {
  reviewParticipantCsv,
  type CsvIssue,
  type ParticipantImportRow,
} from '../../../packages/contracts/src/index.ts'
import {
  corsPreflight,
  json,
  newCorrelationId,
  readJsonBody,
  rejected,
  requireMfa,
  requireUser,
  serviceClient,
} from '../_shared/http.ts'

interface CatalogRequest {
  action?: string
  leagueId?: string
  id?: string
  name?: string
  startsOn?: string
  endsOn?: string
  status?: string
  displayName?: string
  profileId?: string | null
  handicapValue?: number | null
  handicapSource?: string
  handicapEffectiveFrom?: string | null
  csv?: string
  mode?: string
  location?: string | null
  timezone?: string
  layoutName?: string
  teeName?: string
  ratingCategory?: string | null
  courseRating?: number
  slopeRating?: number
  courseLayoutId?: string
  holes?: Array<{ ordinal: number; par: number; yardage: number | null; strokeIndex: number }>
}

type HoleRow = { ordinal: number; par: number; yardage: number | null; strokeIndex: number }

const SEASON_STATUSES = ['planned', 'active', 'completed', 'archived']
const PARTICIPANT_STATUSES = ['active', 'inactive', 'archived']

type Service = ReturnType<typeof serviceClient>

/**
 * A handicap revision closes the interval it supersedes, which the exclusion
 * constraint on participant_handicaps makes a single-statement job — hence the
 * RPC (migration 39) rather than an insert here. The actor is passed
 * explicitly because this client holds the service role and auth.uid() is NULL.
 */
async function recordHandicap(
  service: Service,
  actorId: string,
  participantId: string,
  handicap: { value: number; source: string; effectiveFrom: string | null },
): Promise<void> {
  const { data, error } = await service.rpc('record_participant_handicap', {
    p_actor: actorId,
    p_participant_id: participantId,
    p_value: handicap.value,
    p_source: handicap.source,
    p_effective_from: handicap.effectiveFrom,
    p_source_reference: null,
  })
  if (error) throw new Error(error.message)
  const result = data as { status?: string; detail?: string; error_code?: string } | null
  if (result?.status !== 'recorded' && result?.status !== 'corrected') {
    throw new Error(result?.detail ?? result?.error_code ?? 'The handicap could not be recorded')
  }
}

interface ImportPlanRow {
  displayName: string
  action: 'create' | 'update'
  handicap: number | null
  status: string
  /** 'linked' | 'no_account' | 'unknown_username' */
  account: string
}

/**
 * Match every CSV row against the existing roster, produce the plan the
 * organizer sees, and — only when applying — write it.
 *
 * Rows are matched on display name, case-insensitively, because that is the
 * only column §4.2 requires. A league with two players of the same name must
 * disambiguate before importing; the report says so rather than guessing which
 * of them a row means.
 */
async function applyParticipantImport(
  service: Service,
  actorId: string,
  leagueId: string,
  rows: readonly ParticipantImportRow[],
  issues: readonly CsvIssue[],
  write: boolean,
): Promise<{ applied: number; plan: ImportPlanRow[]; issues: CsvIssue[] }> {
  const reported: CsvIssue[] = [...issues]
  const plan: ImportPlanRow[] = []
  if (rows.length === 0) return { applied: 0, plan, issues: reported }

  const { data: existing, error: rosterError } = await service
    .from('participants')
    .select('id, display_name, profile_id, status')
    .eq('league_id', leagueId)
  if (rosterError) throw rosterError

  const byName = new Map<string, Array<{ id: string; profile_id: string | null }>>()
  for (const participant of existing ?? []) {
    const key = String(participant.display_name).toLocaleLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), participant])
  }

  const usernames = rows.map((row) => row.username).filter((name): name is string => name !== null)
  const profileByUsername = new Map<string, string>()
  if (usernames.length > 0) {
    const { data: profiles, error: profileError } = await service
      .from('profiles')
      .select('id, username')
      .in('username', usernames)
    if (profileError) throw profileError
    for (const profile of profiles ?? []) {
      profileByUsername.set(String(profile.username).toLowerCase(), profile.id as string)
    }
  }

  let applied = 0
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1
    const matches = byName.get(row.displayName.toLocaleLowerCase()) ?? []
    if (matches.length > 1) {
      reported.push({
        row: rowNumber,
        column: 'display_name',
        code: 'duplicate_key',
        message:
          `The roster already has ${matches.length} players named '${row.displayName}'. ` +
          'This row was skipped: rename them or edit the player directly.',
        warning: true,
      })
      continue
    }
    const match = matches[0]
    const profileId = row.username === null
      ? match?.profile_id ?? null
      : profileByUsername.get(row.username) ?? null
    const account = row.username === null
      ? (profileId === null ? 'no_account' : 'linked')
      : (profileId === null ? 'unknown_username' : 'linked')
    if (account === 'unknown_username') {
      reported.push({
        row: rowNumber,
        column: 'username',
        code: 'required',
        message:
          `No account exists for '${row.username}'. The player was imported as a guest; ` +
          'create the account from the roster to give them sign-in access.',
        warning: true,
      })
    }

    plan.push({
      displayName: row.displayName,
      action: match ? 'update' : 'create',
      handicap: row.handicapValue,
      status: row.status,
      account,
    })
    if (!write) continue

    const participantId = match?.id ?? crypto.randomUUID()
    const record = {
      id: participantId,
      league_id: leagueId,
      profile_id: profileId,
      display_name: row.displayName,
      sort_name: row.displayName.toLocaleLowerCase(),
      status: row.status,
    }
    const { error } = match
      ? await service.from('participants').update(record).eq('id', participantId).eq('league_id', leagueId)
      : await service.from('participants').insert(record)
    if (error) throw error
    if (row.handicapValue !== null) {
      await recordHandicap(service, actorId, participantId, {
        value: row.handicapValue,
        source: row.handicapSource,
        effectiveFrom: row.effectiveFrom,
      })
    }
    applied += 1
  }

  return { applied, plan, issues: reported }
}



/**
 * Ordinals and stroke indexes must each be a complete 1..N set.
 *
 * This is not a formality: `allocateStrokes` in the scoring engine throws
 * unless stroke indexes are a permutation of 1..N, because that permutation is
 * exactly what converts a Playing Handicap into strokes on specific holes. A
 * tee saved with a duplicate or missing index produces an event that cannot be
 * scored at all.
 */
function assertHoleSet(holes: HoleRow[]): void {
  const ordinals = new Set(holes.map((hole) => hole.ordinal))
  const indexes = new Set(holes.map((hole) => hole.strokeIndex))
  if (
    ordinals.size !== holes.length ||
    indexes.size !== holes.length ||
    holes.some((hole) =>
      hole.par < 3 || hole.par > 6 ||
      hole.ordinal < 1 || hole.ordinal > holes.length ||
      hole.strokeIndex < 1 || hole.strokeIndex > holes.length)
  ) {
    throw new Error('Hole ordinals and stroke indexes must each be a complete unique set')
  }
}

function teeHoleRows(teeId: string, holes: HoleRow[]) {
  return holes.map((hole) => ({
    tee_set_id: teeId,
    hole_ordinal: hole.ordinal,
    course_hole_label: String(hole.ordinal),
    par: hole.par,
    yardage: hole.yardage,
    stroke_index: hole.strokeIndex,
  }))
}

/** PostgREST returns an embedded relation as an object or a single-item array. */
function relationRow<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

Deno.serve(async (req: Request) => {
  const correlationId = newCorrelationId()
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return rejected(405, 'SERVICE_UNAVAILABLE', correlationId, 'Method not allowed')
  const caller = await requireUser(req, correlationId)
  if (caller instanceof Response) return caller
  const mfaGate = requireMfa(caller, correlationId)
  if (mfaGate) return mfaGate
  const body = (await readJsonBody(req)) as CatalogRequest | null
  if (!body?.leagueId || !body.action) return rejected(400, 'SNAPSHOT_INVALID', correlationId, 'action and leagueId are required')
  const service = serviceClient()
  const { data: grant } = await service.from('role_assignments').select('id').eq('league_id', body.leagueId).eq('profile_id', caller.userId).is('revoked_at', null).in('role', ['owner', 'league_admin']).limit(1).maybeSingle()
  if (!grant) return rejected(403, 'NOT_ASSIGNED', correlationId, 'owner or league admin role required')

  try {
    let targetId = body.id ?? crypto.randomUUID()
    if (body.action === 'save-season') {
      if (!body.name?.trim() || !body.startsOn || !body.endsOn || body.endsOn < body.startsOn) throw new Error('Season name and a valid date range are required')
      // A season moves planned -> active -> completed -> archived (§4.2). An
      // existing season keeps its current status unless one is supplied, so
      // renaming an active season cannot silently reset it to planned — which
      // is what the unconditional 'planned' here used to do.
      const status = body.status ?? (body.id ? undefined : 'planned')
      if (status !== undefined && !SEASON_STATUSES.includes(status)) {
        throw new Error(`Season status must be one of: ${SEASON_STATUSES.join(', ')}`)
      }
      const row = {
        id: targetId, league_id: body.leagueId, name: body.name.trim(),
        starts_on: body.startsOn, ends_on: body.endsOn,
        ...(status === undefined ? {} : { status }),
      }
      const { error } = body.id ? await service.from('seasons').update(row).eq('id', body.id).eq('league_id', body.leagueId) : await service.from('seasons').insert(row)
      if (error) throw error
    } else if (body.action === 'save-participant') {
      if (!body.displayName?.trim()) throw new Error('Player display name is required')
      const displayName = body.displayName.trim()
      const status = body.status ?? (body.id ? undefined : 'active')
      if (status !== undefined && !PARTICIPANT_STATUSES.includes(status)) {
        throw new Error(`Player status must be one of: ${PARTICIPANT_STATUSES.join(', ')}`)
      }
      const row = {
        id: targetId, league_id: body.leagueId,
        profile_id: body.profileId ?? null,
        display_name: displayName, sort_name: displayName.toLocaleLowerCase(),
        ...(status === undefined ? {} : { status }),
      }
      const { error } = body.id ? await service.from('participants').update(row).eq('id', body.id).eq('league_id', body.leagueId) : await service.from('participants').insert(row)
      if (error) throw error
      if (body.handicapValue !== null && body.handicapValue !== undefined) {
        await recordHandicap(service, caller.userId, targetId, {
          value: body.handicapValue,
          source: body.handicapSource ?? 'manual_verified',
          effectiveFrom: body.handicapEffectiveFrom ?? null,
        })
      }
    } else if (body.action === 'import-participants') {
      // Preview and apply run the SAME validator over the SAME text, so what
      // the organizer approved in the dry run is what gets written (§4.2). The
      // client's own report is a convenience; this one is the authority.
      if (typeof body.csv !== 'string') throw new Error('csv text is required')
      if (body.mode !== 'preview' && body.mode !== 'apply') throw new Error("mode must be 'preview' or 'apply'")
      const report = reviewParticipantCsv(body.csv)
      const summary = await applyParticipantImport(
        service, caller.userId, body.leagueId, report.rows, report.issues,
        body.mode === 'apply' && report.ok,
      )
      await service.from('audit_events').insert({
        actor_profile_id: caller.userId,
        action: `catalog.import-participants.${body.mode}`,
        scope_league_id: body.leagueId,
        target_type: 'participant',
        target_id: null,
        after_json: { rowsRead: report.rowsRead, applied: summary.applied },
      })
      return json(200, {
        status: body.mode === 'apply' && report.ok ? 'imported' : 'previewed',
        applied: summary.applied,
        rowsRead: report.rowsRead,
        ok: report.ok,
        issues: summary.issues,
        plan: summary.plan,
        correlationId,
      })
    } else if (body.action === 'create-course') {
      const holes = body.holes ?? []
      if (!body.name?.trim() || !body.layoutName?.trim() || !body.teeName?.trim() || !body.timezone || !body.courseRating || !body.slopeRating || ![9, 18].includes(holes.length)) throw new Error('Complete course, tee, rating, and 9 or 18 holes are required')
      assertHoleSet(holes)
      const courseId = targetId
      const layoutId = crypto.randomUUID()
      const teeId = crypto.randomUUID()
      const par = holes.reduce((sum, hole) => sum + hole.par, 0)
      let result = await service.from('courses').insert({ id: courseId, league_id: body.leagueId, name: body.name.trim(), location_text: body.location ?? null, timezone: body.timezone, status: 'active' })
      if (result.error) throw result.error
      result = await service.from('course_layouts').insert({ id: layoutId, course_id: courseId, name: body.layoutName.trim(), hole_count: holes.length, version: 1, effective_from: new Date().toISOString().slice(0, 10) })
      if (result.error) throw result.error
      result = await service.from('tee_sets').insert({ id: teeId, course_layout_id: layoutId, name: body.teeName.trim(), rating_category: body.ratingCategory ?? null, course_rating: body.courseRating, slope_rating: body.slopeRating, par, version: 1, status: 'active' })
      if (result.error) throw result.error
      result = await service.from('tee_holes').insert(teeHoleRows(teeId, holes))
      if (result.error) throw result.error
    } else if (body.action === 'add-tee') {
      // A course legitimately has several tees; the schema has always modelled
      // that (courses -> course_layouts -> tee_sets is one-to-many). Only the
      // write path was missing, so every tee arrived as a duplicate course.
      const holes = body.holes ?? []
      if (!body.courseLayoutId || !body.teeName?.trim() || !body.courseRating || !body.slopeRating || ![9, 18].includes(holes.length)) {
        throw new Error('Layout, tee name, rating, slope, and 9 or 18 holes are required')
      }
      assertHoleSet(holes)

      // The grant above proves league admin for body.leagueId. It does NOT
      // prove this layout belongs to that league, so without this check an
      // admin of one league could attach a tee to another league's course.
      const { data: layout, error: layoutError } = await service
        .from('course_layouts')
        .select('id,hole_count,courses!inner(league_id)')
        .eq('id', body.courseLayoutId)
        .maybeSingle()
      if (layoutError) throw layoutError
      const owner = relationRow(layout?.courses as { league_id: string } | { league_id: string }[] | null)
      if (!layout || owner?.league_id !== body.leagueId) {
        throw new Error('Course layout does not belong to this league')
      }
      if (layout.hole_count !== holes.length) {
        throw new Error(`Layout has ${layout.hole_count} holes; received ${holes.length}`)
      }

      const teeId = crypto.randomUUID()
      targetId = teeId
      const par = holes.reduce((sum, hole) => sum + hole.par, 0)
      let result = await service.from('tee_sets').insert({ id: teeId, course_layout_id: body.courseLayoutId, name: body.teeName.trim(), rating_category: body.ratingCategory ?? null, course_rating: body.courseRating, slope_rating: body.slopeRating, par, version: 1, status: 'active' })
      if (result.error) throw result.error
      result = await service.from('tee_holes').insert(teeHoleRows(teeId, holes))
      if (result.error) throw result.error
    } else {
      return rejected(400, 'SNAPSHOT_INVALID', correlationId, 'Unknown catalog action')
    }

    await service.from('audit_events').insert({ actor_profile_id: caller.userId, action: `catalog.${body.action}`, scope_league_id: body.leagueId, target_type: body.action.replace(/^.*-/, ''), target_id: targetId })
    return json(200, { status: 'saved', id: targetId, correlationId })
  } catch (error) {
    return rejected(409, 'SNAPSHOT_INVALID', correlationId, error instanceof Error ? error.message : String(error))
  }
})
