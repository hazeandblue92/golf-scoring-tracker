import type {
  AttestScorecardRequest,
  FinalizeCompetitionRequest,
  PublishEventRequest,
  ReopenCompetitionRequest,
  ResolveScoreConflictRequest,
  SaveEventDraftRequest,
  SetMatchResultRequest,
  SetMatchResultResponse,
} from '@gtt/contracts';

import { functionUrl, getSupabaseClient, getSupabaseEnv } from './supabase.ts';

export async function invokePhase1<T>(name: string, body: unknown): Promise<T> {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (accessToken === undefined) throw new Error('Your session has expired. Sign in again.');
  const { publishableKey } = getSupabaseEnv();
  const response = await fetch(functionUrl(name), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: publishableKey,
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | ({ detail?: string; message?: string; errorCode?: string } & T)
    | null;
  if (!response.ok || payload === null) {
    throw new Error(payload?.detail ?? payload?.message ?? 'The request could not be completed. Try again.');
  }
  return payload;
}

export const saveCatalogItem = (body: Record<string, unknown>) =>
  invokePhase1<{ status: string; id: string }>('catalog-admin', body);

export const saveEventDraft = (body: SaveEventDraftRequest) =>
  invokePhase1<{ eventId: string; roundId: string; competitionId: string }>(
    'save-event-draft',
    body,
  );

export const publishEvent = (body: PublishEventRequest) =>
  invokePhase1<{
    eventId: string;
    status: string;
    snapshotHash?: string;
    /** 'pending' when the event published but its first projection did not. */
    projectionStatus?: string;
    projectionPending?: boolean;
    projectionDetail?: string;
    /** The event was already published; this call repaired projections only. */
    replayed?: boolean;
  }>('publish-event', body);

export const finalizeCompetition = (body: FinalizeCompetitionRequest) =>
  invokePhase1<{
    status: 'finalized' | 'blocked';
    finalResultHash?: string;
    missingScores?: number;
    openConflicts?: number;
    unattestedCards?: number;
  }>('finalize-competition', body);

export const reopenCompetition = (body: ReopenCompetitionRequest) =>
  invokePhase1<{
    status: 'reopened';
    eventId: string;
    competitionId: string;
  }>('reopen-competition', body);

export const setMatchResult = (body: SetMatchResultRequest) =>
  invokePhase1<SetMatchResultResponse>('set-match-result', body);

export const resolveScoreConflict = (body: ResolveScoreConflictRequest) =>
  invokePhase1<{ status: string }>('resolve-score-conflict', body);

export interface SubstituteEventEntryRequest {
  eventId: string;
  outgoingEntryId: string;
  incomingParticipantId: string;
  effectiveRoundId: string;
  reason: string;
}

export async function substituteEventEntry(body: SubstituteEventEntryRequest) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('substitute_event_entry', {
    p_event_id: body.eventId,
    p_outgoing_entry_id: body.outgoingEntryId,
    p_incoming_participant_id: body.incomingParticipantId,
    p_effective_round_id: body.effectiveRoundId,
    p_reason: body.reason,
  });
  if (error) throw new Error(error.message);
  const result = data as {
    status?: 'saved' | 'rejected';
    eventEntryId?: string;
    effectiveRoundId?: string;
    detail?: string;
    error_code?: string;
  } | null;
  if (result?.status !== 'saved' || result.eventEntryId === undefined) {
    throw new Error(result?.detail ?? 'The substitution could not be saved.');
  }
  return {
    eventEntryId: result.eventEntryId,
    effectiveRoundId: result.effectiveRoundId ?? body.effectiveRoundId,
  };
}

export const attestScorecard = (body: AttestScorecardRequest) =>
  invokePhase1<{ status: 'attested' | 'duplicate'; scoreRevision: number }>(
    'attest-scorecard',
    body,
  );

export async function downloadEventExport(leagueId: string, eventId: string) {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (accessToken === undefined) throw new Error('Your session has expired. Sign in again.');
  const { publishableKey } = getSupabaseEnv();
  const response = await fetch(functionUrl('export-league'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: publishableKey,
    },
    body: JSON.stringify({ leagueId, eventId }),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(error?.detail ?? 'Export failed. Try again.');
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `gtt-${eventId}.json`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
