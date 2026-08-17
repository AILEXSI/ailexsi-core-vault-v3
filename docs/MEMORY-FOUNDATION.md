## Freeze

**GREEN — FROZEN** at `fa0f644` — tag `v2.0.0-memory-foundation-green`.
See [MEMORY-FOUNDATION-FREEZE.md](./MEMORY-FOUNDATION-FREEZE.md).

# AILEXSI Core Vault V2 — Memory Foundation

## Status

See `npm run test:foundation` and `npm run acceptance` for executable evidence.

## Path

```text
V2 UI / Bridge / Adapter
    ↓
MemoryCommandAdapter
    ↓
Core MemoryDomain (pin 652d01eb)
    ↓
PostgresEventStore
    ↓
MemoryProjection / V2 Read Model
```

## Classification

| Class | Meaning |
|-------|---------|
| CANONICAL | Core EventStore facts |
| DERIVED | V2 display (e.g. title) |
| CACHED | disposable materialization |
| EPHEMERAL | UI/session only |

## Commands

`create` · `get` · `update` · `archive` · `restore` · `getHistory` / `list`

## Acceptance matrix

| Test | Required |
|------|----------|
| Create | YES |
| Get | YES |
| Update | YES |
| Archive | YES |
| Restore | YES |
| History | YES |
| Idempotency same payload | YES |
| Idempotency conflict (EventStore) | YES |
| Invalid command | YES |
| Concurrency conflict | YES |
| Multi-memory | YES |
| Replay / Determinism | YES |
| No canonical FS write | YES |
| Real PostgreSQL | YES |

## Database boundary

- **V2 DATABASE**: isolated dev/test (`docker compose` port 5433 or embedded-postgres)
- **CORE**: frozen package pin under `.deps/ailexsi-core` @ `652d01eb…` — never the production Core DB

## Errors

V2 surfaces: `VALIDATION` · `IDEMPOTENCY_CONFLICT` · `CONCURRENCY_CONFLICT` · `PERSISTENCE` · `PROJECTION` · `CONNECTION` · `NOT_FOUND`

## Non-goals (this milestone)

Connectome · Continuity UX · Cultivation · Migration writeback · Phase 08 Physics
