# Source of Truth Contract — Vault V3 (V2 contract, inherited)

## Owner table

| Concern | Owner |
| ------- | ----- |
| Entity identity | Core |
| Canonical events | Core |
| Event history | Core |
| Canonical facts | Core |
| Memory aggregate | Core |
| Replay | Core |
| Deterministic reconstruction | Core |
| Search index | V2 |
| Embeddings | V2 / future provider |
| Connectome presentation | V2 |
| AI context | V2 |
| AI proposals | V2 |
| Canonical AI writeback | Core command |
| Continuity package | V2 derived artifact |
| UI state | V2 |

## Hard rule

> **No canonical V2 fact may be persisted outside the Core event path.**

```text
User / AI
    ↓
V2 Command
    ↓
Validation
    ↓
IdempotencyKey
    ↓
Core MemoryDomain
    ↓
EventStore
    ↓
Core Projection
    ↓
V2 Read Model
```

## Filesystem / Markdown / JSON

May exist as:

- export
- cache
- snapshot
- import source
- human-readable artifact

Must **never** be the authoritative canonical store.

No hidden dual-write architecture.

## Read-model classes

| Class | Meaning |
|-------|---------|
| CANONICAL | Mirrors Core projection; rebuildable from EventStore |
| DERIVED | V2 computation over canonical data |
| CACHED | Disposable performance materialization |
| EPHEMERAL | Session/UI only |

## Continuity field classes

| Class | Meaning |
|-------|---------|
| CORE-CANONICAL | Reconstructible via Core replay |
| V2-DERIVED | V2 packaging / presentation |
| V2-EPHEMERAL | Not claimed fully replayable |

## AI rule

AI output is **never** automatically canonical merely because a model produced it.

Proposal outcomes: `accepted | rejected | edited | deferred`.  
Only accepted (or edited-then-accepted) canonical mutations enter Core.
