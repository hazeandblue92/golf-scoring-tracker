# ADR 0002: Node 24 LTS baseline, newer local Node tolerated

Date: 2026-08-09
Status: Accepted

## Context

Spec §13.2 sets Node.js 24 LTS as the runtime baseline. The initial development
machine runs Node 26.3.0.

## Decision

`engines.node` is `>=24.0.0`. CI runs on Node 24 LTS so the baseline is what
gates releases; newer local Node versions are tolerated for development. No
Node-version-specific APIs beyond the 24 LTS feature set may be used.

## Consequences

CI remains the authority for runtime compatibility; developers are not forced
to downgrade local toolchains.
