# Accessibility Audit Record

Target: WCAG 2.2 AA for the scoring and operator workflows. Automated axe checks
are necessary but do not replace assistive-technology and field testing.

## Automated scope

The Playwright suite runs `@axe-core/playwright` against primary signed-out and
scoring flows in Chromium, Firefox, WebKit, and Pixel 7 emulation. CI also
builds with a strict CSP. Record the workflow URL and date here at release:

- Workflow/date: local release candidate, 2026-08-10
- Result: 20/20 Playwright scenarios passed across Chromium, Firefox, WebKit,
  and Pixel 7 emulation; automated axe checks reported no violations
- Exceptions: none accepted without an issue, owner, and expiry date

## Manual release record

| Check | Required surface | Status | Evidence |
| --- | --- | --- | --- |
| Keyboard-only navigation and visible focus | Desktop scoring/operator paths | Due | — |
| VoiceOver labels, order, status announcements | macOS Safari and iPhone Safari | Due | — |
| TalkBack labels, order, status announcements | Android Chrome | Due | — |
| 200% zoom and 320 CSS px reflow | All primary workflows | Due | — |
| Text/control contrast in normal and error states | All primary workflows | Due | — |
| Direct sunlight readability and 44 px targets | Physical phones outdoors | Due | — |
| Offline entry, reconnect, conflict recovery | Physical scoring phone | Due | — |

For each pass, replace **Due** with date, tester, OS/browser/device, and an
evidence or issue link. Block season launch for any scoring-path failure that
can lose input, hide sync state, trap focus, or prevent score confirmation.
