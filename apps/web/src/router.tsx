import { createBrowserRouter, redirect } from 'react-router';

import { Activate } from './screens/Activate.tsx';
import { AdminEventAudit } from './screens/AdminEventAudit.tsx';
import { AdminEventScoring } from './screens/AdminEventScoring.tsx';
import { AdminEventSetup } from './screens/AdminEventSetup.tsx';
import { AdminOperations } from './screens/AdminOperations.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { EventHome } from './screens/EventHome.tsx';
import { EventRules } from './screens/EventRules.tsx';
import { Leaderboard } from './screens/Leaderboard.tsx';
import { LeagueCourses } from './screens/LeagueCourses.tsx';
import { LeagueHome } from './screens/LeagueHome.tsx';
import { LeaguePlayers } from './screens/LeaguePlayers.tsx';
import { LeagueSeasons } from './screens/LeagueSeasons.tsx';
import { Matches } from './screens/Matches.tsx';
import { NotFound } from './screens/NotFound.tsx';
import { Offline } from './screens/Offline.tsx';
import { Privacy } from './screens/Privacy.tsx';
import { RootLayout } from './screens/RootLayout.tsx';
import { Scorecard } from './screens/Scorecard.tsx';
import { ScoreEntry } from './screens/ScoreEntry.tsx';
import { Settings } from './screens/Settings.tsx';
import { SignIn } from './screens/SignIn.tsx';
import { Skins } from './screens/Skins.tsx';

/**
 * Route map — the EXACT stable route families of spec §5.1, served in React
 * Router library mode. Deep links MUST survive deployment and refresh (the
 * static host serves the SPA fallback; see workbox navigateFallback).
 */
export const router = createBrowserRouter([
  {
    path: '/',
    Component: RootLayout,
    children: [
      { index: true, loader: () => redirect('/dashboard') },
      { path: 'sign-in', Component: SignIn },
      { path: 'activate', Component: Activate },
      { path: 'dashboard', Component: Dashboard },
      { path: 'league/:leagueId', Component: LeagueHome },
      { path: 'league/:leagueId/players', Component: LeaguePlayers },
      { path: 'league/:leagueId/courses', Component: LeagueCourses },
      { path: 'league/:leagueId/seasons', Component: LeagueSeasons },
      { path: 'events/:eventId', Component: EventHome },
      { path: 'events/:eventId/rules', Component: EventRules },
      { path: 'events/:eventId/score', Component: ScoreEntry },
      { path: 'events/:eventId/scorecard/:entryId', Component: Scorecard },
      {
        path: 'events/:eventId/leaderboards/:competitionId',
        Component: Leaderboard,
      },
      { path: 'events/:eventId/skins/:competitionId', Component: Skins },
      { path: 'events/:eventId/matches/:competitionId', Component: Matches },
      { path: 'admin/events/:eventId/setup/*', Component: AdminEventSetup },
      { path: 'admin/events/:eventId/scoring', Component: AdminEventScoring },
      { path: 'admin/events/:eventId/audit', Component: AdminEventAudit },
      { path: 'admin/operations', Component: AdminOperations },
      { path: 'settings', Component: Settings },
      { path: 'privacy', Component: Privacy },
      { path: 'offline', Component: Offline },
      { path: '*', Component: NotFound },
    ],
  },
]);
