/**
 * Score-entry screen skeleton (spec §5.2): sticky hole header, previous/next
 * hole controls, per-entity score region, and a screen-reader live region
 * for save status. Empty semantic regions only — steppers, numeric input,
 * net-stroke badge, outbox status, and running totals are wired later.
 */
export function ScoreEntry() {
  return (
    <>
      <header aria-label="Current hole">
        {/* Sticky hole header placeholder: hole number, par, stroke index. */}
        <h1>Score entry</h1>
        <p>Enter hole-by-hole scores for the players in your group.</p>
      </header>
      <nav aria-label="Hole navigation">
        <button type="button">Previous hole</button>
        <button type="button">Next hole</button>
      </nav>
      <section aria-label="Scores for this hole">
        {/* Per-entity score stepper and direct numeric input placeholder. */}
      </section>
      {/* Live region for save status: device saved / server saved /
          leaderboard updating (spec §10.6). Polite so announcements never
          interrupt score entry. */}
      <p role="status" aria-live="polite" />
    </>
  );
}
