/** Phase 1 league catalog administration: seasons, players, courses/tees. */

import {
  corsPreflight,
  json,
  newCorrelationId,
  readJsonBody,
  rejected,
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
  displayName?: string
  profileId?: string | null
  handicapValue?: number | null
  location?: string | null
  timezone?: string
  layoutName?: string
  teeName?: string
  ratingCategory?: string | null
  courseRating?: number
  slopeRating?: number
  holes?: Array<{ ordinal: number; par: number; yardage: number | null; strokeIndex: number }>
}

Deno.serve(async (req: Request) => {
  const correlationId = newCorrelationId()
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return rejected(405, 'SERVICE_UNAVAILABLE', correlationId, 'Method not allowed')
  const caller = await requireUser(req, correlationId)
  if (caller instanceof Response) return caller
  const body = (await readJsonBody(req)) as CatalogRequest | null
  if (!body?.leagueId || !body.action) return rejected(400, 'SNAPSHOT_INVALID', correlationId, 'action and leagueId are required')
  const service = serviceClient()
  const { data: grant } = await service.from('role_assignments').select('id').eq('league_id', body.leagueId).eq('profile_id', caller.userId).is('revoked_at', null).in('role', ['owner', 'league_admin']).limit(1).maybeSingle()
  if (!grant) return rejected(403, 'NOT_ASSIGNED', correlationId, 'owner or league admin role required')

  try {
    let targetId = body.id ?? crypto.randomUUID()
    if (body.action === 'save-season') {
      if (!body.name?.trim() || !body.startsOn || !body.endsOn || body.endsOn < body.startsOn) throw new Error('Season name and a valid date range are required')
      const row = { id: targetId, league_id: body.leagueId, name: body.name.trim(), starts_on: body.startsOn, ends_on: body.endsOn, status: 'planned' }
      const { error } = body.id ? await service.from('seasons').update(row).eq('id', body.id).eq('league_id', body.leagueId) : await service.from('seasons').insert(row)
      if (error) throw error
    } else if (body.action === 'save-participant') {
      if (!body.displayName?.trim()) throw new Error('Player display name is required')
      const displayName = body.displayName.trim()
      const row = { id: targetId, league_id: body.leagueId, profile_id: body.profileId ?? null, display_name: displayName, sort_name: displayName.toLocaleLowerCase(), status: 'active' }
      const { error } = body.id ? await service.from('participants').update(row).eq('id', body.id).eq('league_id', body.leagueId) : await service.from('participants').insert(row)
      if (error) throw error
      if (body.handicapValue !== null && body.handicapValue !== undefined) {
        const { error: handicapError } = await service.from('participant_handicaps').insert({ participant_id: targetId, value: body.handicapValue, source: 'manual_verified', effective_from: new Date().toISOString().slice(0, 10), verified_at: new Date().toISOString(), verified_by: caller.userId })
        if (handicapError) throw handicapError
      }
    } else if (body.action === 'create-course') {
      const holes = body.holes ?? []
      if (!body.name?.trim() || !body.layoutName?.trim() || !body.teeName?.trim() || !body.timezone || !body.courseRating || !body.slopeRating || ![9, 18].includes(holes.length)) throw new Error('Complete course, tee, rating, and 9 or 18 holes are required')
      const ordinals = new Set(holes.map((hole) => hole.ordinal))
      const indexes = new Set(holes.map((hole) => hole.strokeIndex))
      if (ordinals.size !== holes.length || indexes.size !== holes.length || holes.some((hole) => hole.par < 3 || hole.par > 6 || hole.ordinal < 1 || hole.ordinal > holes.length || hole.strokeIndex < 1 || hole.strokeIndex > holes.length)) throw new Error('Hole ordinals and stroke indexes must each be a complete unique set')
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
      result = await service.from('tee_holes').insert(holes.map((hole) => ({ tee_set_id: teeId, hole_ordinal: hole.ordinal, course_hole_label: String(hole.ordinal), par: hole.par, yardage: hole.yardage, stroke_index: hole.strokeIndex })))
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
