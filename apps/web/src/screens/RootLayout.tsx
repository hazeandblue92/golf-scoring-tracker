import { NavLink, Outlet, useLocation } from 'react-router';

import { AppIcon } from '../components/AppIcon.tsx';
import { SyncBanner } from '../components/SyncBanner.tsx';
import { useSession } from '../lib/session.tsx';

/**
 * Root layout: main content outlet plus the bottom navigation landmark of
 * spec §5.3 — Home, Score, Leaderboard, More. Structure only; presentation
 * (bottom bar on narrow screens, left rail on desktop) arrives with the
 * design system.
 */
export function RootLayout() {
  const location = useLocation();
  const { session, profile } = useSession();
  const routeEvent = /^\/events\/([^/]+)/.exec(location.pathname)?.[1];
  const activeEventId = routeEvent ?? window.localStorage.getItem('gtt.activeEventId');
  const activeCompetitionId = window.localStorage.getItem('gtt.activeCompetitionId');
  const publicRoute = location.pathname === '/sign-in' || location.pathname === '/privacy';
  const scoreTarget = activeEventId ? `/events/${activeEventId}/score` : '/dashboard';
  const boardTarget = activeEventId && activeCompetitionId
    ? `/events/${activeEventId}/leaderboards/${activeCompetitionId}`
    : '/dashboard';

  return (
    <div className={publicRoute ? 'app-shell app-shell--public' : 'app-shell'}>
      {!publicRoute && (
        <header className="topbar">
          <NavLink className="wordmark" to="/dashboard" aria-label="Golf Tournament Tracker home">
            <AppIcon name="flag" />
            <span>Golf Tracker</span>
          </NavLink>
          <span className="profile-chip">{profile?.displayName ?? session?.user.email ?? 'Player'}</span>
        </header>
      )}
      {!publicRoute && (activeEventId ? <SyncBanner eventId={activeEventId} /> : <SyncBanner />)}
      <main className="main-content" id="main-content">
        <Outlet />
      </main>
      {!publicRoute && (
        <nav className="primary-nav" aria-label="Primary">
          <NavLink to="/dashboard"><AppIcon name="home" /><span>Home</span></NavLink>
          <NavLink to={scoreTarget}><AppIcon name="score" /><span>Score</span></NavLink>
          <NavLink to={boardTarget}><AppIcon name="board" /><span>Leaderboard</span></NavLink>
          <NavLink to="/settings"><AppIcon name="more" /><span>More</span></NavLink>
        </nav>
      )}
    </div>
  );
}
