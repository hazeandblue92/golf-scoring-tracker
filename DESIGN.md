---
name: Golf Tournament Tracker
description: A warm paper-and-turf control surface for dependable scoring on the course.
colors:
  ink: "#17221d"
  muted-ink: "#5b6962"
  turf: "#0c513d"
  turf-dark: "#073d2e"
  turf-pale: "#e1eee8"
  cream: "#f4f3ed"
  paper: "#fffef9"
  white: "#ffffff"
  rule: "#d6d9d2"
  warning: "#8b4b08"
  warning-bg: "#fff1d8"
  error: "#a02920"
  error-bg: "#fde9e6"
  success: "#11623f"
  success-bg: "#e3f3e9"
  focus: "#1169af"
typography:
  display:
    fontFamily: "Avenir Next, Avenir, Segoe UI, ui-sans-serif, sans-serif"
    fontSize: "3.2rem"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Avenir Next, Avenir, Segoe UI, ui-sans-serif, sans-serif"
    fontSize: "2rem"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Avenir Next, Avenir, Segoe UI, ui-sans-serif, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Avenir Next, Avenir, Segoe UI, ui-sans-serif, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Avenir Next, Avenir, Segoe UI, ui-sans-serif, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 800
    lineHeight: 1.2
rounded:
  field: "10px"
  control: "12px"
  panel: "14px"
  feature: "16px"
  pill: "999px"
  circle: "50%"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.5rem"
  2xl: "2rem"
  3xl: "2.5rem"
  4xl: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.turf}"
    textColor: "{colors.white}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.7rem 1rem"
  button-primary-hover:
    backgroundColor: "{colors.turf-dark}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.turf-dark}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.7rem 1rem"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.turf-dark}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.7rem 1rem"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "0.65rem 0.75rem"
  status-badge:
    backgroundColor: "{colors.turf-pale}"
    textColor: "{colors.turf-dark}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.35rem 0.65rem"
  score-stepper:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.turf-dark}"
    rounded: "{rounded.control}"
    size: "54px"
---

# Design System: Golf Tournament Tracker

## Overview

**Creative North Star: "The Course-Day Scorecard"**

The product should feel like a well-kept paper scorecard set on a clubhouse counter: warm, direct, and immediately legible, with turf green supplying authority. It is an **Operate** interface built for one-handed use in sunlight. Scores, hole context, event state, and the next safe action outrank decoration.

Cream is the continuous canvas, paper marks working surfaces, and dark turf slabs anchor the active event, current hole, and live operations. Thin rules organize dense facts more often than nested cards. The system is confident but restrained: no gradients, remote assets, ornamental imagery, or ambient decoration.

**Key Characteristics:**

- Warm paper and dark turf-green contrast
- Large, obvious scoring actions and numeric readouts
- Exact local, offline, sync, projection, and finalization states
- Flat lists and rule lines, with only a few anchored panels
- System typography and compact inline SVG icons
- Mobile-first structure that becomes a desktop control rail

## Colors

The palette resembles sunlit paper, ink, and a deep green course sign. Use turf as the sole brand accent; reserve amber, red, green, and blue for operational meaning.

### Primary

- **Turf** (`turf`): Primary actions, initials, step markers, links, and active navigation.
- **Clubhouse Green** (`turf-dark`): Feature mastheads, active-event panels, progress panels, desktop navigation, and high-emphasis totals.
- **Cut Grass** (`turf-pale`): Hover fills, badges, revision chips, and low-emphasis selected surfaces.

### Neutral

- **Scorecard Ink** (`ink`): Default text and numeric data.
- **Weathered Ink** (`muted-ink`): Supporting copy, metadata, timestamps, and inactive navigation.
- **Warm Cream** (`cream`): Application canvas.
- **Fresh Paper** (`paper`): Inputs, navigation, facts, footers, and contained working surfaces.
- **Rule Line** (`rule`): Dividers and structural borders.
- **White** (`white`): Text on dark turf surfaces; do not use it as the page canvas.

### Semantic

- **Warning** (`warning`, `warning-bg`): Unsynced, offline, provisional, lagging, or action-needed states.
- **Error** (`error`, `error-bg`): Rejections, conflicts, blockers, and failed operations.
- **Success** (`success`, `success-bg`): Confirmed completion and current server-derived state.
- **Focus Blue** (`focus`): Keyboard focus only. Its difference from turf makes focus unmistakable.

**The One Turf Rule.** Turf green carries both brand and primary action. Do not introduce a second decorative accent.

**The State Has Words Rule.** Semantic color always travels with specific text, an icon, or a numeric state; color is never the only signal.

**Sunlight mode (amended).** Scoring in direct sun is a core scenario, and the default warm-paper canvas can wash out on a phone held at arm's length on a bright green. Sunlight mode is a per-device toggle that raises contrast on the scoring surfaces: pure white canvas, near-black ink, heavier rules, and stronger borders on the stepper targets. It is a contrast adjustment, not a second theme — the palette roles, the One Turf Rule, and every semantic meaning are unchanged, and no new accent is introduced. Both modes must independently meet the 4.5:1 text requirement, and the toggle is a device preference that never travels with the account or affects any stored score.

## Typography

**Display and body font:** Avenir Next when locally available, followed by Avenir, Segoe UI, and the native sans-serif stack. Do not load a remote font.

The type system is compact, sturdy, and numerical. Tight tracking gives large event and hole headings authority; ordinary body copy stays open and readable. Weight creates most of the hierarchy.

### Hierarchy

- **Display** (800, up to `3.2rem`, `1.05`): Active-event names and event mastheads on wide screens. Mobile feature headings begin around `2.35rem`–`2.5rem`.
- **Headline** (800, `2rem`, `1.08`): Default page titles. Keep them balanced and concise.
- **Title** (800, `1.25rem`, `1.2`): Section titles and operational panel headings.
- **Body** (400, `1rem`, `1.55`): Instructions and explanatory text, capped at `72ch`.
- **Label** (750–850, `0.72rem`–`0.85rem`): Field labels, metadata, table headers, facts, and navigation.
- **Score numeral** (900, `1.2rem`–`2.7rem`): Entered scores, leaderboard results, hole numbers, revisions, and totals.

Use uppercase only for very short structural labels such as `PAR`, `SI`, leaderboard columns, and month abbreviations. Status copy remains sentence case or natural text.

**The Numbers Win Rule.** In scoring and standings, numeric values are the strongest element after the page or hole title.

## Layout

The interface starts at a supported width of `320px`. Content sits in a centered container capped at `1120px`; reading-heavy and form-heavy narrow surfaces cap at `720px`. Mobile screens use `1rem` horizontal padding and generous vertical separation: sections typically begin `2.5rem` apart, while related controls use `0.5rem`–`1rem` gaps.

- **Mobile, below `680px`:** fixed `60px` top bar, fixed `72px` four-item bottom navigation, single-column forms, two-column event facts, and full-width primary action stacks. Honor the bottom safe-area inset.
- **Wide mobile/tablet, `680px` and above:** screen gutters grow to `2rem`; forms, operations, and score rows may become two columns; event facts become four columns; primary actions can size to content.
- **Desktop, `960px` and above:** navigation becomes a fixed `220px` dark left rail; the top bar and score footer begin after the rail; feature headings expand, but content keeps its maximum width.

Sticky and fixed scoring surfaces are intentional. The current-hole header stays below the top bar, the save footer stays above mobile navigation, and score lists include enough bottom padding to remain fully reachable. Never allow these layers to obscure input controls or status text.

Prefer full-width divided lists, definition lists, and tables for comparable data. Use cards only for a true contained task, empty state, or feature panel. At 200% zoom and `320px` CSS width, preserve a single readable page flow without horizontal scrolling. Dense two-dimensional evidence tables are the exception: keep them inside a clearly labeled, keyboard-focusable horizontal scroller while the page itself remains fixed to the viewport.

## Elevation & Depth

The system is flat by default. Cream, paper, dark turf, and `1px` rule lines create hierarchy. Shadows are reserved for three anchored surfaces: the active-event feature (`0 14px 32px rgba(7, 61, 46, 0.22)`), the sign-in form (`0 16px 40px rgba(2, 24, 17, 0.28)`), and the fixed score footer (`0 -10px 28px rgba(23, 34, 29, 0.08)`).

**The Anchored Shadow Rule.** A shadow must explain why a surface floats or remains fixed. Ordinary rows, forms, status messages, and admin sections stay flat.

## Shapes

Corners are gently rounded, never bubbly. Inputs use `10px`; buttons and compact controls use `12px`; panels use `14px`; major feature surfaces use `16px`. Pills (`999px`) are reserved for terse statuses and progress tracks. Circles are reserved for initials, status dots, numbered builder steps, and the sign-in mark.

Borders are quiet but structural: inputs use a darker neutral stroke for visibility, while lists and sections use the shared rule line. Avoid decorative outlines or mixed corner systems.

## Components

### Navigation and identity

- The top bar holds the flag wordmark and a truncated profile label. It remains `60px` high.
- Primary navigation has four fixed destinations: Home, Score, Leaderboard, More. Mobile targets are at least `64px` high; desktop rows are `54px` high.
- Icons are inline, single-color SVG strokes at `24px`, using `currentColor`, rounded caps, and no external sprite or icon font. Labels remain visible.
- Active state uses turf on paper or white on the dark desktop rail. Hover adds a pale-green or lighter-turf surface; selection never relies on icon shape alone.
- When one event produces several competitions, place a full-bleed horizontal competition strip after the event actions. Each paper segment keeps the competition name dominant and its metric and state secondary; preserve a useful minimum width and scroll the strip instead of squeezing or wrapping it into a card grid.

### Buttons and links

- All normal buttons are bold, rounded `12px`, and at least `44px` high. Scoring and event calls to action may be `52px` high.
- **Primary:** turf fill with white text; hover deepens to clubhouse green.
- **Secondary:** paper fill, green text, and a visible green-neutral border; hover becomes pale green.
- **Quiet:** transparent fill with a rule-line border; use for low-risk navigation and tertiary operations.
- Hover lifts a button by only `1px`; active returns it to rest. Disabled controls use reduced opacity and a non-action cursor.
- The `38px` small variant is reserved for compact, secondary utilities such as sync retry. Never use it for on-course scoring or the main event action.

### Inputs and choices

- Inputs and selects use paper, dark ink, a visible neutral border, `10px` corners, and a minimum height of `46px`.
- Labels sit above fields in dark muted green at strong weight. Helper text names consequences or constraints.
- Checkboxes and radios are native, `20px`, turf-accented, and paired with a full-width label row of at least `44px`.
- Error, warning, and success messages use paired foreground/background semantic colors and explicit language. Do not rely on placeholder text as a label.

### Event setup and frozen authority

- Composite format presets name the full consequence before detailed choices: which competitions will exist, which scores they share, and which handicap allowances apply.
- Put computed handicap evidence immediately before team construction. The compact review table exposes source/index, unrounded Course Handicap, and each competition's rounded Playing Handicap; missing authority is written as `Missing` and paired with a blocking warning.
- When a team handicap is derived from several players, follow the player evidence with a second ruled summary naming the frozen weight preset, unrounded team value, and rounded team Playing Handicap.
- Team construction uses rule-separated rows with one team name and two to four labeled player slots. Stack every field on mobile; at wider widths keep the name full-width until all player slots fit in one comparison row. Every selected player appears exactly once, and incomplete groups explain the required correction.
- Publication replaces the editor with a dedicated frozen state rather than a disabled form. Name what is immutable, show the event state, and offer only safe next destinations such as the event view and scoring control room.

### Score entry

- The hole header is a dark turf slab containing a large hole number and compact Par, SI, and Yards facts.
- Above it, a hole strip lists every hole in the round as a compact target, marking which are fully entered. It answers "where am I and what is left" without leaving the screen. Targets stay at least `44px`, the strip scrolls horizontally rather than wrapping, and it is fully keyboard operable.
- Each scoring-entity row begins with initials, name, handicap, and server revision. Shared-ball formats make the named team the entity, label its handicap as `Team playing handicap`, and collect one team score per hole; never fabricate individual scores from a shared card. Use initials rather than avatars or uploaded photos.
- **Strokes received on this hole are shown on the row**, as a count with dots, derived from the frozen Playing Handicap and the hole's stroke index. This is the single most consulted fact during entry — a player should never have to do the allocation arithmetic themselves. A plus player's given-back stroke reads as a negative, never as a blank.
- The decrement, input, and increment control is a three-column unit with `54px` targets. The score input is the dominant center element; direct numeric input remains available.
- Beneath the stepper, show the resulting net for this hole and its relation to par, updating as the value changes. It is a passive readout, **not** a live region: it must not be announced on every keystroke (§18 restrained announcements).
- Where the event has teams, a compact strip shows each team's best gross and best net **for the current hole only**, updating as scores are entered. Label it as a live in-hole view so it is never mistaken for the authoritative leaderboard.
- Result status is an explicit select (`Completed`, `Picked up`, `No score`, `Withdrawn`). Missing or exceptional results are never silently converted to zero.
- The fixed footer combines progress, a polite live save message, and the hole's save actions.

**Two save actions (amended).** The footer previously carried one unambiguous `Save hole N` action. It now carries two: `Save hole N` and `Save and next`. The second is the overwhelmingly common path — a group finishes a hole and walks to the next tee — and forcing a separate navigation tap after every save was friction with no safety benefit, since both actions commit identically. `Save hole N` remains first and visually primary so the plain save is never harder to reach than the compound one.

**Bulk set to par (amended).** A `Par all` control sets every entity on the hole to the hole's par in one tap. This is an explicit, visible bulk edit, never a silent default: it writes the values into the visible controls, every value stays individually editable afterwards, nothing is committed until a save action, and the change is announced once politely. The spec's prohibition is on silently converting missing or exceptional results into numbers — this is the opposite, an organizer deliberately stating a common outcome and then correcting the exceptions.

- Scorecard review places Hole, Par, SI, Gross, allocated Strokes, and Net in one ruled comparison, ending in a dark-turf total band. Attestation is a separate bordered panel tied to the exact score revision; if scores change afterward, say that the prior attestation is stale and require a fresh review.

### Status, sync, and feedback

- The sync banner appears only when offline, unsynced, rejected, or conflicted. It uses an icon, a strong summary, exact secondary text, and an optional retry action.
- Distinguish **saved on this device**, **waiting to send**, **saved to server**, **rejected**, and **conflict needs review**. Never collapse them into a generic “Saved.”
- Leaderboards show their projection revision and a written provisional or lag message. Final results may be called official only after finalization.
- Multi-competition health compares every competition projection with the event scoring revision. Use a flat ruled ledger with name and metric/state on the left, exact revision or numeric lag on the right, and a written aggregate summary such as `All current` or `2 updating` above it.
- Status dots, badges, progress bars, and state colors supplement visible text; they never replace it.

### Lists, tables, and operational panels

- Event schedules, leaderboards, facts, conflicts, and audit items use full-width rows with rule-line separation.
- Leaderboard rows support both player and team scorecards. Preserve table-row semantics and make the entity name the explicit scorecard link instead of wrapping the whole row.
- Table headers use a slightly darker neutral surface and compact uppercase labels. Right-align score results and numeric totals when it improves comparison.
- Skins results use one dark-turf totals panel above a chronological, rule-separated hole ledger. Every hole states winner and units, `Tied · carries forward`, or `Provisional` in words, with carried-in units kept as secondary evidence; label totals as units, never money.
- Empty states are calm paper panels with one heading and one sentence. Error states explain the recovery action when one exists.
- The active event, event masthead, progress panel, and scorecard total are the recurring dark-turf anchors. Limit each view to the few anchors needed for orientation.

### Accessibility and motion

- Every on-course interactive target is at least `44×44px`; score steppers are `54px`. All flows work with keyboard and direct input and require no dragging.
- Keyboard focus uses a `3px` focus-blue outline with `2px` offset on links, buttons, and fields.
- Maintain at least WCAG 2.2 AA contrast, preserve visible labels, and test at 200% zoom from `320px` width.
- Save and sync changes use restrained `aria-live="polite"`; blocking errors use alert semantics. Avoid repeated announcements during background polling.
- Standard state transitions are `180ms ease-out`; progress width is `220ms ease-out`. Skeletons may sweep for `1.4s` only while loading.
- Under `prefers-reduced-motion: reduce`, animations and transitions effectively stop. Do not add parallax, auto-scrolling, or decorative motion.

## Do's and Don'ts

### Do:

- **Do** make the current hole, entered score, sync authority, and next action obvious at a glance in sunlight.
- **Do** use warm cream for the canvas, paper for work surfaces, and dark turf for a small number of operational anchors.
- **Do** preserve exact source-of-truth language for local saves, server sync, revision lag, conflicts, provisional results, and final results.
- **Do** distinguish editable setup, computed review, frozen authority, live projection health, and final results as explicit interface states.
- **Do** prefer dividers and whitespace over wrapping every row in a card.
- **Do** preserve fixed scoring controls, safe-area spacing, keyboard focus, live-region behavior, and reduced-motion support.
- **Do** use inline SVG icons and player initials so the application remains self-contained and fast offline.

### Don't:

- **Don't** add gradients, remote fonts, remote assets, stock golf photography, textured backgrounds, or decorative course motifs.
- **Don't** introduce extra accent colors, glass effects, oversized shadows, excessive pills, or a dashboard mosaic of floating cards.
- **Don't** use color alone for rank, score relation, sync state, validation, progress, or event status.
- **Don't** imply that a local save reached the server or that a provisional projection is official.
- **Don't** shrink on-course targets below `44px`, hide numeric input behind gesture-only controls, or let fixed chrome cover content.
- **Don't** trade the restrained system font hierarchy for display typography or ornamental branding.
