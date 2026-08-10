# ADR 0004: Nassau automatic presses are out of scope

## Status

Accepted (2026-08-10)

## Context

Spec §8.13 models a Nassau as three linked competitions — front nine, back
nine, and full eighteen — each of which may be match or stroke based. It then
places automatic presses in Phase 3, but deliberately declines to specify them:

> Automatic presses are Phase 3 because their trigger and settlement rules
> vary; base Nassau is supported through the generic competition model.

That leaves no rule to implement against. A press is a new wager opened
mid-round when a side falls a defined number of holes down, and both the
trigger (2 down? 3 down? owner's option?) and the settlement (does the press
run to the segment end, or its own closing hole? does it compound?) differ
between groups. Building any of it would mean inventing product policy the
specification explicitly refuses to fix, and encoding a guess in a scoring
engine whose whole premise is that results are reproducible from frozen rules.

The owner was asked directly what the league's press rules are (2026-08-10)
and answered that they play **pre-fixed formats with no live changes during a
round**.

## Decision

Automatic presses are **not implemented**, and this is a scope decision rather
than deferred work.

A press is by definition a live mid-round change to the wager structure. A
league that fixes its formats before play and makes no in-round changes has no
press to record, so the feature has no user. Building a configurable press
engine for a use case that does not exist would add a scoring path nobody
exercises — the most dangerous kind of code in a results system, because it
stays untested until the one day it silently decides a result.

Base Nassau remains fully supported through the generic competition model:
three linked competitions over holes 1-9, 10-18, and 1-18, each independently
match or stroke based, each with its own frozen rules and its own leaderboard.
Nothing about that path depends on presses.

## Consequences

- §8.13's Nassau requirement is satisfied by the existing competition model; no
  engine, schema, or UI work is outstanding for it.
- The `deferredVectors` list stays empty. Presses are not a deferred §20.2
  golden vector, because there is no agreed behaviour to write a vector against.
- If the league later adopts presses, this ADR must be superseded by one that
  states the trigger and settlement rules explicitly, and the implementation
  lands with golden vectors covering compounding and segment settlement before
  any of it is reachable from the UI.
- Any future automatic-press work is a change in product scope requiring owner
  approval, consistent with the spec's rule that MUST departures need sign-off.
