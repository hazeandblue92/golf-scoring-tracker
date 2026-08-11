/**
 * The one definition of the production response policy (spec §13, §23.3).
 *
 * Two gates read this: `check-security-headers.mjs` proves the source and
 * built `_headers` files declare it, and `check-deployed-headers.mjs` proves
 * the host actually delivers it. Keeping both on one list is the point — a
 * policy that is declared but not served, or served but not declared, is the
 * failure mode a second hand-maintained copy would hide.
 */

/** `value` omitted means the header must be present; its value is not fixed. */
export const REQUIRED_HEADERS = [
  { name: 'Content-Security-Policy' },
  { name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { name: 'Permissions-Policy' },
  { name: 'Referrer-Policy', value: 'no-referrer' },
  { name: 'Strict-Transport-Security' },
  { name: 'X-Content-Type-Options', value: 'nosniff' },
  { name: 'X-Frame-Options', value: 'DENY' },
];

export const REQUIRED_CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
];

export const FORBIDDEN_CSP_ALLOWANCES = [
  "script-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-eval'",
];

/**
 * The deployment policy is host-delivered and applies ONLY to the built site.
 * A loopback or plaintext origin buys no local convenience — Vite's dev server
 * never applies `_headers` — and only widens what the production page may
 * talk to.
 */
export const FORBIDDEN_CSP_ORIGINS = [
  ['loopback origin', /(?:127\.0\.0\.1|\[?::1\]?|localhost)/],
  ['plaintext http origin', /(?:^|\s)http:\/\//],
  ['plaintext websocket origin', /(?:^|\s)ws:\/\//],
];

/** The `_headers` file form of one requirement, e.g. `Referrer-Policy: no-referrer`. */
export function headerExpectation({ name, value }) {
  return value === undefined ? `${name}:` : `${name}: ${value}`;
}
