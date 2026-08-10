import { createBrowserRouter, redirect } from 'react-router';
import { lazy } from 'react';

import { RequireActivation, RequireAuth } from './lib/session.tsx';

import { RootLayout } from './screens/RootLayout.tsx';

const Activate = lazy(async () => ({ default: (await import('./screens/Activate.tsx')).Activate }));
const AdminEventAudit = lazy(async () => ({ default: (await import('./screens/AdminEventAudit.tsx')).AdminEventAudit }));
const AdminEventScoring = lazy(async () => ({ default: (await import('./screens/AdminEventScoring.tsx')).AdminEventScoring }));
const AdminEventSetup = lazy(async () => ({ default: (await import('./screens/AdminEventSetup.tsx')).AdminEventSetup }));
const AdminOperations = lazy(async () => ({ default: (await import('./screens/AdminOperations.tsx')).AdminOperations }));
const Dashboard = lazy(async () => ({ default: (await import('./screens/Dashboard.tsx')).Dashboard }));
const EventHome = lazy(async () => ({ default: (await import('./screens/EventHome.tsx')).EventHome }));
const EventRules = lazy(async () => ({ default: (await import('./screens/EventRules.tsx')).EventRules }));
const Leaderboard = lazy(async () => ({ default: (await import('./screens/Leaderboard.tsx')).Leaderboard }));
const LeagueCourses = lazy(async () => ({ default: (await import('./screens/LeagueCourses.tsx')).LeagueCourses }));
const LeagueHome = lazy(async () => ({ default: (await import('./screens/LeagueHome.tsx')).LeagueHome }));
const LeaguePlayers = lazy(async () => ({ default: (await import('./screens/LeaguePlayers.tsx')).LeaguePlayers }));
const LeagueSeasons = lazy(async () => ({ default: (await import('./screens/LeagueSeasons.tsx')).LeagueSeasons }));
const Matches = lazy(async () => ({ default: (await import('./screens/Matches.tsx')).Matches }));
const NotFound = lazy(async () => ({ default: (await import('./screens/NotFound.tsx')).NotFound }));
const Offline = lazy(async () => ({ default: (await import('./screens/Offline.tsx')).Offline }));
const Privacy = lazy(async () => ({ default: (await import('./screens/Privacy.tsx')).Privacy }));
const Scorecard = lazy(async () => ({ default: (await import('./screens/Scorecard.tsx')).Scorecard }));
const ScoreEntry = lazy(async () => ({ default: (await import('./screens/ScoreEntry.tsx')).ScoreEntry }));
const Settings = lazy(async () => ({ default: (await import('./screens/Settings.tsx')).Settings }));
const SignIn = lazy(async () => ({ default: (await import('./screens/SignIn.tsx')).SignIn }));
const Skins = lazy(async () => ({ default: (await import('./screens/Skins.tsx')).Skins }));

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
      { path: 'privacy', Component: Privacy },
      {
        Component: RequireAuth,
        children: [
          { path: 'activate', Component: Activate },
          {
            Component: RequireActivation,
            children: [
              { path: 'dashboard', Component: Dashboard },
              { path: 'league/:leagueId', Component: LeagueHome },
              { path: 'league/:leagueId/players', Component: LeaguePlayers },
              { path: 'league/:leagueId/courses', Component: LeagueCourses },
              { path: 'league/:leagueId/seasons', Component: LeagueSeasons },
              { path: 'events/:eventId', Component: EventHome },
              { path: 'events/:eventId/rules', Component: EventRules },
              { path: 'events/:eventId/score', Component: ScoreEntry },
              { path: 'events/:eventId/scorecard/:entryId', Component: Scorecard },
              { path: 'events/:eventId/team-scorecard/:teamId', Component: Scorecard },
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
              { path: 'offline', Component: Offline },
            ],
          },
        ],
      },
      { path: '*', Component: NotFound },
    ],
  },
]);
