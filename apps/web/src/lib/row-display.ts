/**
 * Helpers for turning Supabase rows into display values.
 *
 * PostgREST returns an embedded relation as either a single object or an
 * array depending on how it infers cardinality, and the shape can differ
 * between two queries that select the same relation. Every screen that reads
 * one therefore has to normalize it, and each had grown its own private copy
 * of the same two functions — four of `relationValue` and four of
 * `relationName`, in two spellings with identical behaviour.
 */

/** First row of an embedded relation, whether it arrived boxed in an array or not. */
export function relationValue<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

/**
 * Display name from an embedded participant relation.
 *
 * Falls back to 'Player' rather than an empty string: a nameless row in a
 * leaderboard or scorecard is a data problem, and a blank cell hides it.
 */
export function relationName(
  value: { display_name: string } | { display_name: string }[] | null | undefined,
): string {
  return relationValue(value)?.display_name ?? 'Player';
}

/** Up to two initials for the avatar-free identity marks the design system uses. */
export function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}
