import type {
  FinalizeCompetitionRequest,
  PublishEventRequest,
  ResolveScoreConflictRequest,
  SaveEventDraftRequest,
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
  invokePhase1<{ eventId: string; status: string; snapshotHash: string }>(
    'publish-event',
    body,
  );

export const finalizeCompetition = (body: FinalizeCompetitionRequest) =>
  invokePhase1<{
    status: 'finalized' | 'blocked';
    finalResultHash?: string;
    missingScores?: number;
    openConflicts?: number;
  }>('finalize-competition', body);

export const resolveScoreConflict = (body: ResolveScoreConflictRequest) =>
  invokePhase1<{ status: string }>('resolve-score-conflict', body);

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
