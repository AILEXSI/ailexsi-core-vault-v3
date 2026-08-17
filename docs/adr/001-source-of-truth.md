# ADR-001: Source of Truth boundary (Core vs Vault V2)

## Status

Accepted (foundation). **V3 inherits this ADR unchanged** (historical V2 decision).

## Context

AILEXSI has a verified Core EventStore/MemoryDomain (Phase 07) and a legacy
Markdown Vault. Vault V2 must not become a second canonical store.

## Decision

1. **Core owns** entity identity, append-only events, canonical memory facts,
   projections, and AAS-54 replay.
2. **Vault V2 owns** UI, cultivation UX, continuity packaging (derived),
   rebuildable read-models/search indexes, and migration tooling *from* legacy Vault.
3. **AI writeback path** is fixed:
   `proposal → accept → Core command → EventStore`
   Never: `proposal → canonical FS write`.
4. **No dual-write**: filesystem may hold exports/snapshots/import sources only.

## Consequences

- Command adapter must depend on Core packages at the frozen Core SHA.
- In-memory EventStore doubles are test-only.
- Live PostgreSQL + `PostgresEventStore` is required for foundation GREEN.
- Continuity snapshots are not an event-log substitute.
