# Architecture — AILEXSI Core Vault V3

## Evolution

```text
CURRENT CORE (Phase 07 ACCEPTED)
     │
     │ verified baseline SHA
     ▼
CANONICAL CORTEX
     │
     ▼
CORE VAULT V2 (historical source @ d684aa4)
     │
     ▼
CORE VAULT V3 (this repository; functionally equivalent bootstrap)
     │
     ├── Memory (CORE-BACKED)
     ├── Connectome (V2 presentation; PARTIAL)
     ├── Continuity (V2 derived artifact)
     ├── Cultivation (V2 + Core writeback on accept)
     ├── Retrieval / read models (V2)
     └── AI interaction (V2 proposals)
```

## Boundaries

| Repository | Role |
|------------|------|
| `ailexsi-core` | Verified Cortex baseline — **READ ONLY** for V3 work |
| `ailexsi-core-vault` | Capability reference baseline — **READ ONLY** |
| `ailexsi-core-vault-v2` | Historical source baseline — **READ ONLY** |
| `ailexsi-core-vault-v3` | Active successor — **only write target** |

## Package map

```text
V2 UI / Cultivation / Continuity / Connectome
              │
              ▼
     command-adapter  ──validate──► Core MemoryDomain
              │                            │
              │                            ▼
              │                       EventStore
              │                            │
              ▼                            ▼
        read-models ◄──────── Core MemoryProjection
```

### packages/command-adapter

Explicit boundary into Core library APIs (`MemoryDomain` + `EventStore`).  
No invented HTTP API. No Core source copy.

### packages/read-models

Classifies every field as `CANONICAL | DERIVED | CACHED | EPHEMERAL`.  
UI consumes read models, not raw persistence.

### packages/cultivation

LLM → proposal → human acceptance → Core command.  
Rejected/deferred proposals leave EventStore unchanged.

### packages/continuity

Serializes a classified portable snapshot. Canonical content is reconstructible via Core replay; ephemeral chat/UI is not claimed as fully replayable.

### packages/migration

Tooling only: `scan → parse → validate → report`.  
No production Core event writeback in foundation.

### packages/connectome

Graph presentation from Memory `relationRefs` and provenance parents.  
**Does not** introduce a Core Relation aggregate (PLANNED future).

### apps/desktop

Tauri 2 + React + TypeScript foundation. Web-mode UI for foundation verification without requiring a full native build in CI.

## Domain classification (honesty)

| Domain | Classification |
|--------|----------------|
| Memory | **CORE-BACKED** (Phase 06/07) |
| Insights / Decisions / Questions / Tensions / Projects | **V2-LOCAL** presentation labels over Memory or future Core domains — **not** pretend Core aggregates |
| Connectome | **V2-DERIVED** presentation; Core Relation aggregate = **PLANNED** |
| Continuity | **V2-DERIVED** artifact |
| Cultivation chat | **V2-EPHEMERAL** until acceptance → Core command |
| Physics / Knowledge / Reflection / Learning / Trust / Scheduler | **PLANNED** (not in Core Phase 07 surface for V2 to consume as domains) |

## Database policy

- Canonical persistence: **Core EventStore** (via Core packages).
- Optional V2 DB: indexes/search only — **DERIVED / REBUILDABLE / NON-CANONICAL**.
- Separate URLs: `CORE_DATABASE_URL`, `V2_DATABASE_URL`.
- Never share production Core credentials with V2 dev.

## Filesystem policy

```text
Filesystem ≠ canonical fact store
```

Allowed: exports, snapshots, migration inputs, logs, local UI artifacts.  
Forbidden: dual-write of canonical identity outside EventStore.

## Core integration mechanism

Core packages are private monorepo packages (not published npm).

V2 consumes them via **local development dependency** on a pinned checkout:

```text
.deps/ailexsi-core @ 652d01eb06dd0841c3b475023883675af6dcd698
```

Resolved by Vitest/TS path aliases (`@ailexsi/memory`, `@ailexsi/contracts`, …).  
Checkout is **gitignored** and produced by `npm run setup:core`.

See [CORE-INTEGRATION.md](./CORE-INTEGRATION.md).
