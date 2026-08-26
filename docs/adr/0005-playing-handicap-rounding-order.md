# ADR 0005: Playing Handicap uses the USGA round-then-allowance order

## Status

Accepted (2026-08-25)

## Context

Spec §9.3-9.4 defines the Playing Handicap as a single named rounding step
applied to the full-precision product:

```
course_handicap_unrounded = handicap_index * (slope_rating / 113)
                            + (course_rating - par)
playing_handicap_unrounded = course_handicap_unrounded * allowance
playing_handicap           = round_profile(playing_handicap_unrounded)
```

Common USGA WHS 2024 published practice does something different. It treats the
Course Handicap as a whole number in its own right — rounded, displayed, and
handed to the player — and then applies the allowance to that rounded value,
rounding a second time:

```
course_handicap = round(handicap_index * (slope_rating / 113)
                        + (course_rating - par))
playing_handicap = round(course_handicap * allowance)
```

The two orders are not equivalent. For a player with Handicap Index 10.4 on a
tee with Slope 130, Course Rating 71.3, and par 72, at the 85% four-ball
allowance the league uses:

| | Spec §9.3-9.4 order | USGA order |
| --- | --- | --- |
| Course Handicap | 12729/1130 (~11.2646), kept exact | 11 |
| x 85% | 216393/22600 (~9.5749) | 187/20 (= 9.35) |
| **Playing Handicap** | **10** | **9** |

One stroke, for that player, on every hole allocation, for as long as the
frozen snapshot stands. The divergence was found while comparing this
implementation against an independently generated build of the same
specification, which had implemented the USGA order.

Neither order is a defect. The single-step order is more arithmetically
faithful — it never discards precision it has — and the spec chose it
deliberately. But a Playing Handicap is a number players check against what
their handicap service tells them, and a league whose app disagrees by a stroke
with the number on the player's phone will be arguing about the app instead of
the golf.

The owner was asked directly (2026-08-25) and chose the USGA order.

## Decision

The Two-Person Throwdown preset freezes the **round-then-allowance** order.

This is a rules change, not an engine change. `packages/scoring` already
implements both orders: `playingHandicap()` applies an intermediate rounding
step when the frozen profile is `committee_custom` with
`stepOrder: 'round_then_allowance'`. Migration
`20260825000035_usga_playing_handicap_rounding.sql` changes only the handicap
objects the preset writes into `rules_json`.

The `usga_whs_2024` profile token deliberately **keeps** its single-round
meaning. It was tempting to redefine the token so its name matched USGA
practice, and that was rejected for two reasons:

1. **Frozen snapshots must not change meaning retroactively.** A published
   `rules_json` already says `usga_whs_2024`. Redefining the token would move
   the results of an already-sealed competition without altering a single
   stored byte, which is precisely the failure mode the immutable-snapshot and
   result-hash design exists to prevent.
2. **Match play depends on the single-step order.** §8.6 normalizes strokes
   from the *unrounded* Course Handicap difference, and
   `packages/scoring/src/formats/match-play.ts` calls `playingHandicap()` with
   the `usga_whs_2024` token to do it. Redefining the token would silently
   insert a rounding step into match-play normalization — a different rule, in
   a different format, changed by accident.

## Consequences

- **Only Two-Person Best Ball Net moves.** At the 100% allowance used by
  Individual Net and Net Skins the two orders agree, because rounding a value
  and then multiplying it by one and rounding again is the same as rounding it
  once. The frozen 100% `playing_handicap` on `event_entries`
  (`floor(course_handicap + 0.5)`) is likewise unchanged, so the roster value
  and the projection value still agree.
- Both full-allowance and four-ball rules adopt the new profile even though the
  100% case is numerically identical, so one event describes **one** committee
  policy rather than two that happen to coincide.
- `event_entries.handicap_profile` stays `'usga_whs_2024'`. That column records
  how the entry's Course Handicap was derived, which is still the WHS step; the
  allowance policy is a per-competition decision and lives in `rules_json`.
- Golden vectors `ch-unrounded-before-85-allowance` and
  `ch-usga-round-then-85-allowance` now run the **same input** through the two
  profiles and assert 10 and 9 respectively. That pair is the executable record
  of this decision, and neither profile may silently stand in for the other.
- This is a departure from a spec MUST and required owner approval, which was
  given. The specification's §9.3-9.4 record should be amended to describe the
  single-step formula as the `usga_whs_2024` profile's behaviour rather than as
  the only permitted behaviour.
- Events published before this migration keep the order frozen into their own
  `rules_json`. Nothing has been deployed, so no such event exists today; if
  one ever does, it stays correct on its own terms and must not be
  retroactively "fixed".
