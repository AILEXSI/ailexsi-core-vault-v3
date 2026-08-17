# Phase 2 — Query + Read-Model Foundation

## Classification

| Class | Meaning |
|-------|---------|
| **CANONICAL** | Core EventStore / Core-owned aggregate state |
| **DERIVED** | V2 MemoryReadModel, display titles, list pages |
| **EPHEMERAL** | UI selection, form fields, session caches |

V2 read model is **always DERIVED** and fully rebuildable from Core.

## Read path

```text
PostgresEventStore / Core Projection
        ↓
MemoryDomain projection (adapter)
        ↓
V2 MemoryReadModel (DERIVED)
        ↓
MemoryQueryService
        ↓
Desktop UI / Bridge
```

Write path (frozen Foundation) is unchanged:

```text
UI → Command Adapter → MemoryDomain → EventStore
```

## Query contract

| Operation | Behavior |
|-----------|----------|
| `getMemory(id)` | Core-backed detail view or `null` |
| `listMemories({ pageSize, afterCursor?, includeArchived? })` | Deterministic page |
| `listAll({ includeArchived? })` | Full deterministic list |
| `getMemoryHistory(id)` | Core stream order + event types |
| `rebuildFromCore()` | CLEAR projections → rebuild **all** events |

Queries **never** append events or write files.

## Pagination

- Order: `confirmedAt ASC`, then `id ASC`
- Cursor: keyset `updatedAt\tid` (exclusive)
- `pageSize`: integer **1..100**
- Gap-safe continuation if cursor missing

Not a search engine — no embeddings, ranking, or semantic query.

## Replay

```text
snapshot A → CLEAR → rebuildAll / rebuildFromCore → snapshot B
A === B
```

No new UUIDs, no generated timestamps in projection.

## UI boundary

Desktop Memory panel reads via DesktopHost → `MemoryQueryService`.  
UI state is EPHEMERAL. Mutations remain command path only.

## Core pin

`652d01eb06dd0841c3b475023883675af6dcd698` (READ ONLY)

## Baseline

Memory Foundation tag: `v2.0.0-memory-foundation-green`
