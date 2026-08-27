/**
 * Multiple tees on one course layout (catalog `add-tee`).
 *
 * A real course has several tees and an event plays exactly one of them,
 * chosen at setup. `create-course` always inserts a NEW courses row, so before
 * `add-tee` existed every tee arrived as a duplicate course with the same
 * name. The schema always modelled this correctly — courses -> course_layouts
 * -> tee_sets is one-to-many — only the write path was missing.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { createAccount, LEAGUE_ID } from '../helpers/fixture.ts'
import { callFunction, serviceClient, stackIsUp } from '../helpers/stack.ts'

/** A valid 18-hole set: ordinals 1..18, stroke indexes a 1..18 permutation. */
function holeSet(yardageBase: number) {
  return Array.from({ length: 18 }, (_, index) => ({
    ordinal: index + 1,
    par: 4,
    yardage: yardageBase + index,
    strokeIndex: index + 1,
  }))
}

describe('multiple tees on one course layout', () => {
  const service = serviceClient()
  let owner: Awaited<ReturnType<typeof createAccount>>
  let courseName: string

  beforeAll(async () => {
    expect(await stackIsUp(), 'local Supabase stack must be running').toBe(true)
    owner = await createAccount(service, { displayName: 'Tee Owner', withMfa: true })
    const membership = await service.from('league_memberships').insert({
      league_id: LEAGUE_ID, profile_id: owner.profileId, member_status: 'active',
    })
    if (membership.error) throw membership.error
    const role = await service.from('role_assignments').insert({
      league_id: LEAGUE_ID, profile_id: owner.profileId, role: 'owner',
    })
    if (role.error) throw role.error

    courseName = `Tee Test Course ${randomUUID().slice(0, 8)}`
    const created = await callFunction<{ status: string; id: string }>('catalog-admin', {
      action: 'create-course',
      leagueId: LEAGUE_ID,
      name: courseName,
      location: 'Allendale',
      timezone: 'America/Detroit',
      layoutName: 'Championship 18',
      teeName: 'Blue',
      ratingCategory: 'standard',
      courseRating: 71.5,
      slopeRating: 132,
      holes: holeSet(300),
    }, owner.accessToken)
    expect(created.status, JSON.stringify(created.body)).toBe(200)
  }, 240_000)

  it('attaches a second tee to the same layout instead of a new course', async () => {
    const layouts = await service.from('course_layouts')
      .select('id,courses!inner(name)')
      .eq('courses.name', courseName)
    if (layouts.error) throw layouts.error
    expect(layouts.data).toHaveLength(1)
    const layoutId = layouts.data![0]!.id

    const added = await callFunction<{ status: string; id: string }>('catalog-admin', {
      action: 'add-tee',
      leagueId: LEAGUE_ID,
      courseLayoutId: layoutId,
      teeName: 'White',
      ratingCategory: 'standard',
      courseRating: 69.3,
      slopeRating: 128,
      holes: holeSet(250),
    }, owner.accessToken)
    expect(added.status, JSON.stringify(added.body)).toBe(200)

    // Still ONE course, and both tees hang off its single layout.
    const courses = await service.from('courses').select('id').eq('name', courseName)
    if (courses.error) throw courses.error
    expect(courses.data, 'a new tee must not create a second course').toHaveLength(1)

    const tees = await service.from('tee_sets')
      .select('name,course_rating,slope_rating,par')
      .eq('course_layout_id', layoutId)
      .order('name')
    if (tees.error) throw tees.error
    expect(tees.data?.map((tee) => tee.name)).toEqual(['Blue', 'White'])
    // Each tee keeps its own rating and slope: that is the whole point, since
    // Course Handicap scales by slope and the two tees must differ.
    expect(tees.data?.find((tee) => tee.name === 'White')?.slope_rating).toBe(128)
    expect(tees.data?.find((tee) => tee.name === 'Blue')?.slope_rating).toBe(132)
    // Par is derived from the submitted holes, not trusted from the caller.
    expect(tees.data?.every((tee) => tee.par === 72)).toBe(true)

    const holes = await service.from('tee_holes')
      .select('tee_set_id')
      .in('tee_set_id', (await service.from('tee_sets').select('id').eq('course_layout_id', layoutId)).data!.map((row) => row.id))
    if (holes.error) throw holes.error
    expect(holes.data).toHaveLength(36)
  }, 120_000)

  it('rejects a stroke-index set that is not a complete permutation', async () => {
    const layouts = await service.from('course_layouts')
      .select('id,courses!inner(name)').eq('courses.name', courseName)
    if (layouts.error) throw layouts.error
    const broken = holeSet(200)
    broken[5]!.strokeIndex = broken[4]!.strokeIndex // duplicate index

    const rejected = await callFunction<{ detail: string }>('catalog-admin', {
      action: 'add-tee',
      leagueId: LEAGUE_ID,
      courseLayoutId: layouts.data![0]!.id,
      teeName: 'Broken',
      courseRating: 70,
      slopeRating: 120,
      holes: broken,
    }, owner.accessToken)
    // allocateStrokes throws unless indexes are a 1..N permutation, so a tee
    // saved like this would produce an event that cannot be scored at all.
    expect(rejected.status).toBe(409)
    expect(rejected.body.detail).toContain('complete unique set')
  }, 120_000)

  it('refuses a layout belonging to another league', async () => {
    const otherLeague = await service.from('leagues').select('id').neq('id', LEAGUE_ID).limit(1).maybeSingle()
    if (otherLeague.error) throw otherLeague.error
    if (!otherLeague.data) return // single-league deployment; nothing to prove

    const courseId = randomUUID()
    const layoutId = randomUUID()
    const foreign = await service.from('courses').insert({
      id: courseId, league_id: otherLeague.data.id, name: `Foreign course ${courseId.slice(0, 8)}`,
      timezone: 'America/Detroit', status: 'active',
    })
    if (foreign.error) throw foreign.error
    const layout = await service.from('course_layouts').insert({
      id: layoutId, course_id: courseId, name: 'Championship 18', hole_count: 18,
      version: 1, effective_from: new Date().toISOString().slice(0, 10),
    })
    if (layout.error) throw layout.error

    // The role grant proves league admin for LEAGUE_ID; it says nothing about
    // this layout. Without the ownership check an admin of one league could
    // attach tees to another league's courses.
    const denied = await callFunction<{ detail: string }>('catalog-admin', {
      action: 'add-tee',
      leagueId: LEAGUE_ID,
      courseLayoutId: layoutId,
      teeName: 'Trespass',
      courseRating: 70,
      slopeRating: 120,
      holes: holeSet(300),
    }, owner.accessToken)
    expect(denied.status).toBe(409)
    expect(denied.body.detail).toContain('does not belong to this league')
  }, 120_000)
})
