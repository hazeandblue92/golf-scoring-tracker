/**
 * Event builder (spec §5.2, /admin/events/:eventId/setup/*): step sequence
 * — basics, course/tees, participants, teams/flights/groups,
 * competitions/rules, handicaps, permissions, review/preflight, publish.
 * The splat segment addresses individual steps.
 */
export function AdminEventSetup() {
  return (
    <>
      <h1>Event setup</h1>
      <p>
        Step-by-step event builder: basics, course, participants, formats,
        handicaps, permissions, preflight, and publish.
      </p>
    </>
  );
}
