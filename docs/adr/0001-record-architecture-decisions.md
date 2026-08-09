# ADR 0001: Record architecture decisions

Date: 2026-08-09
Status: Accepted

## Context

The technical specification (v1.0, verified 2026-08-09) is the implementation
authority. Ordinary engineering choices that do not change externally visible
behavior, security boundaries, scoring results, data portability, or the
zero-cost guardrails are the developer's to make — but they must be traceable.

## Decision

Every such choice is recorded as a numbered ADR in `docs/adr/`. Any departure
from a requirement labeled MUST additionally requires written product-owner
approval and a spec update before implementation.

## Consequences

Reviewers can distinguish spec requirements from engineering discretion; the
spec remains the single authority for externally visible behavior.
