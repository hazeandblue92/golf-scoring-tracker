import { Link, Outlet } from 'react-router';

/**
 * Root layout: main content outlet plus the bottom navigation landmark of
 * spec §5.3 — Home, Score, Leaderboard, More. Structure only; presentation
 * (bottom bar on narrow screens, left rail on desktop) arrives with the
 * design system.
 */
export function RootLayout() {
  return (
    <>
      <main>
        <Outlet />
      </main>
      <nav aria-label="Primary">
        <ul>
          <li>
            <Link to="/dashboard">Home</Link>
          </li>
          {/* Score and Leaderboard resolve to the signed-in user's active
              event (/events/:eventId/score and
              /events/:eventId/leaderboards/:competitionId) once event
              context is wired; the dashboard is the interim target. */}
          <li>
            <Link to="/dashboard">Score</Link>
          </li>
          <li>
            <Link to="/dashboard">Leaderboard</Link>
          </li>
          <li>
            <Link to="/settings">More</Link>
          </li>
        </ul>
      </nav>
    </>
  );
}
