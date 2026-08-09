/**
 * Event audit (spec §5.1 /admin/events/:eventId/audit): the audit trail of
 * score changes, corrections, republishes, and privileged actions.
 */
export function AdminEventAudit() {
  return (
    <>
      <h1>Audit</h1>
      <p>The audit trail of scoring and administrative actions for this event.</p>
    </>
  );
}
