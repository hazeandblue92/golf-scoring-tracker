/**
 * @gtt/scoring — pure golf scoring and handicap engine (spec §7).
 *
 * Imported by the web app for offline previews and by Supabase Edge Functions
 * for authoritative projections. Both consumers must pass the same
 * golden-vector suite in @gtt/test-vectors.
 */

export * from './rational.ts'
export * from './types.ts'
export * from './common.ts'
export * from './canonical.ts'
export * from './handicap/course-handicap.ts'
export * from './handicap/allocation.ts'
export * from './formats/stroke-play.ts'
export * from './formats/best-ball.ts'
export * from './formats/stableford.ts'
export * from './formats/par-bogey.ts'
export * from './formats/match-play.ts'
export * from './formats/skins.ts'
export * from './formats/team-handicap.ts'
