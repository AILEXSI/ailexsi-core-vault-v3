# Core Integration — Vault V3 (V2 contract, inherited)

## Baseline

```text
CORE BASELINE:
652d01eb06dd0841c3b475023883675af6dcd698

Repository: AILEXSI/ailexsi-core
Status: PHASE 07 = ACCEPTED / GREEN
```

## What Core exposes (Phase 07)

Library packages (not an HTTP API):

| Package | Role |
|---------|------|
| `@ailexsi/contracts` | DomainEvent, Memory models, errors |
| `@ailexsi/memory` | `MemoryDomain` — create/get/update/archive/restore/getHistory |
| `@ailexsi/eventstore` | `EventStore` interface + `PostgresEventStore` |
| `@ailexsi/projections` | `MemoryProjection` (AAS-54 rebuildable) |
| `@ailexsi/persistence` | Postgres schema / migrate helpers |

## Boundary diagram

```text
V2
 │
 ▼
Command Adapter  (@ailexsi/v2-command-adapter)
 │
 ▼
Core Domain/API  (MemoryDomain)
 │
 ▼
EventStore
```

## Dependency mechanism

Core packages are `private` workspace packages (not published to npm).

V2 uses an **explicit local development dependency**:

1. `npm run setup:core` clones Core at the pinned SHA into `.deps/ailexsi-core` (gitignored).
2. Vitest/TS aliases resolve `@ailexsi/*` to that checkout’s `src` trees.
3. V2 **never** copies Core source into the V2 git history.
4. V2 **never** forks or redefines Core Phase 08.

### Production path factory

```ts
import { createCoreRuntime } from "@ailexsi/v2-command-adapter";

const runtime = await createCoreRuntime(); // requires CORE_DATABASE_URL
// runtime.adapter.create / update / archive / restore
// runtime.store is Core PostgresEventStore
// runtime.rebuildAll() → ProjectionEngine + V2 read model (AAS-54)
```

`InMemoryEventStore` (`@ailexsi/v2-test-kit`) is **test-only**.  
`createCoreRuntime` **refuses** to start without a real Postgres URL.

If a required capability is missing from Core Phase 07, V2 must **STOP and report the boundary** — not silently patch Core.

## Memory API used by V2

```ts
const adapter = new MemoryCommandAdapter({ store, environment: "test" });
await adapter.create({ content, provenance, idempotencyKey });
await adapter.get(id);
await adapter.update({ memoryId, content, idempotencyKey });
await adapter.archive({ memoryId, idempotencyKey });
await adapter.restore({ memoryId, idempotencyKey });
await adapter.getHistory(id);
```

## Domains NOT available as Core aggregates (do not pretend)

- Knowledge domain
- Reflection domain
- Learning domain
- Trust domain
- Physics (CognitiveStateVector is zero placeholder only)
- Scheduler
- Relation aggregate (Memory has `relationRefs` only)

## Idempotency

Core EventStore rules:

- same key + identical payload → return original, no new event
- same key + different payload → `IdempotencyConflictError`

V2 requires `idempotencyKey` on every canonical command.

## Databases

```text
CORE_DATABASE_URL  → Core EventStore (canonical)
V2_DATABASE_URL    → optional derived indexes only
```

Use a **separate** V2 Core database — never production Core.
