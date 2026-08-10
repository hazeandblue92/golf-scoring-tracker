/** Save an individual, two-person, or Phase 3 scramble event draft (spec §5.2). */

import { saveEventDraftRequestSchema } from '../../../packages/contracts/src/index.ts'
import {
  corsPreflight,
  json,
  newCorrelationId,
  readJsonBody,
  rejected,
  requireUser,
  serviceClient,
} from '../_shared/http.ts'

Deno.serve(async (req: Request) => {
  const correlationId = newCorrelationId()
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') {
    return rejected(405, 'SERVICE_UNAVAILABLE', correlationId, 'Method not allowed')
  }
  const caller = await requireUser(req, correlationId)
  if (caller instanceof Response) return caller

  const parsed = saveEventDraftRequestSchema.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    return rejected(400, 'SNAPSHOT_INVALID', correlationId,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }
  const body = parsed.data
  const scramblePreset = body.competitionPreset === 'three_player_scramble'
    || body.competitionPreset === 'four_player_scramble'
  const rpcName = scramblePreset
    ? 'save_phase3_scramble_event_draft'
    : 'save_phase2_event_draft'
  const { data, error } = await serviceClient().rpc(rpcName, {
    p_actor: caller.userId,
    p_event_id: body.eventId ?? null,
    p_league_id: body.leagueId,
    p_season_id: body.seasonId,
    p_name: body.name,
    p_timezone: body.timezone,
    p_starts_at: body.startsAt,
    p_ends_at: body.endsAt,
    p_visibility: body.visibility,
    p_tee_set_id: body.teeSetId,
    p_participant_ids: body.participantIds,
    p_scorer_profile_ids: body.scorerProfileIds,
    p_competition_preset: body.competitionPreset,
    p_teams: body.teams,
  })
  if (error) {
    const denied = error.code === '42501'
    return rejected(denied ? 403 : 409, denied ? 'NOT_ASSIGNED' : 'SNAPSHOT_INVALID',
      correlationId, error.message)
  }
  return json(200, { ...(data as Record<string, unknown>), correlationId })
})
