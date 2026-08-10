import { functionUrl, getSupabaseEnv } from './supabase.ts';

export async function reportClientError(
  errorCode: string,
  correlationId: string,
  severity: 'warning' | 'error' | 'critical' = 'error',
) {
  const { publishableKey } = getSupabaseEnv();
  await fetch(functionUrl('report-error'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: publishableKey },
    body: JSON.stringify({
      errorCode,
      routeFamily: routeFamily(window.location.pathname),
      correlationId,
      severity,
    }),
  }).catch(() => undefined);
}

function routeFamily(pathname: string) {
  const routes: Array<[RegExp, string]> = [
    [/^\/$/, '/'],
    [/^\/sign-in$/, '/sign-in'],
    [/^\/privacy$/, '/privacy'],
    [/^\/activate$/, '/activate'],
    [/^\/dashboard$/, '/dashboard'],
    [/^\/events\/[^/]+\/score$/, '/events/:eventId/score'],
    [/^\/events\/[^/]+\/leaderboards\/[^/]+$/, '/events/:eventId/leaderboards/:competitionId'],
    [/^\/events\/[^/]+\/skins\/[^/]+$/, '/events/:eventId/skins/:competitionId'],
    [/^\/events\/[^/]+\/matches\/[^/]+$/, '/events/:eventId/matches/:competitionId'],
    [/^\/events\/[^/]+\/(?:team-)?scorecard\/[^/]+$/, '/events/:eventId/scorecard/:entityId'],
    [/^\/events\/[^/]+\/rules$/, '/events/:eventId/rules'],
    [/^\/events\/[^/]+$/, '/events/:eventId'],
    [/^\/admin\/events\/[^/]+\/setup(?:\/.*)?$/, '/admin/events/:eventId/setup'],
    [/^\/admin\/events\/[^/]+\/scoring$/, '/admin/events/:eventId/scoring'],
    [/^\/admin\/events\/[^/]+\/audit$/, '/admin/events/:eventId/audit'],
    [/^\/admin\/operations$/, '/admin/operations'],
    [/^\/league\/[^/]+\/players$/, '/league/:leagueId/players'],
    [/^\/league\/[^/]+\/courses$/, '/league/:leagueId/courses'],
    [/^\/league\/[^/]+\/seasons$/, '/league/:leagueId/seasons'],
    [/^\/league\/[^/]+$/, '/league/:leagueId'],
    [/^\/settings$/, '/settings'],
    [/^\/offline$/, '/offline'],
  ];
  return routes.find(([pattern]) => pattern.test(pathname))?.[1] ?? '/unknown';
}
