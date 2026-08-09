import { Link } from 'react-router';

/**
 * Not-found route: catch-all for URLs outside the §5.1 route families.
 */
export function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p>
        That page does not exist. <Link to="/dashboard">Go to the dashboard</Link>.
      </p>
    </>
  );
}
