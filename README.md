# AILEXSI Core Vault V3

This repository is **AILEXSI Core Vault V3**.

It is the successor of the verified **V2** baseline (`AILEXSI/ailexsi-core-vault-v2` @ `d684aa4a3c292c1d1f1587a68371589437b68055`). Product version is declared in [`config/version.json`](config/version.json). The bootstrap tag `v3.0.0-v2-baseline` is historical identity, not that product version.

It uses **AILEXSI Core** as the canonical Cortex foundation.

The original Core, Vault V1, and Vault V2 repositories remain independent reference baselines.

---

## Baselines (frozen)

| Role | Repository | SHA |
|------|------------|-----|
| **CORE BASELINE** (canonical Cortex) | `AILEXSI/ailexsi-core` | `652d01eb06dd0841c3b475023883675af6dcd698` |
| **VAULT REFERENCE** (capability reference) | `AILEXSI/ailexsi-core-vault` | `061e444389090c54e431b0e8243e82764f2c198e` |

These are **dependencies/references**, not files to copy into V3.

```text
CORE = READ ONLY
CURRENT VAULT = READ ONLY
V2 = HISTORICAL SOURCE BASELINE (READ ONLY)
V3 = ONLY WRITE TARGET
```

Do **not** modify Core, do **not** modify the current Vault, do **not** implement Core Phase 08 here.

---

## Architectural principle

> **The Core is authoritative for canonical facts. This vault (V3, inherited from V2) is authoritative for derived cognition, presentation, cultivation, retrieval and user interaction.**

See:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/SOURCE-OF-TRUTH.md](docs/SOURCE-OF-TRUTH.md)
- [docs/CORE-INTEGRATION.md](docs/CORE-INTEGRATION.md)
- [docs/CONTINUITY.md](docs/CONTINUITY.md)
- [docs/MIGRATION.md](docs/MIGRATION.md)
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)

---

## Repository layout

```text
ailexsi-core-vault-v3/
  apps/desktop/          Tauri 2 + React + TypeScript foundation
  packages/
    command-adapter/     V2 → Core MemoryDomain command path
    read-models/         Classified V2 read models (rebuildable)
    cultivation/         AI proposals + acceptance writeback
    continuity/          Derived portable Continuity artifacts
    migration/           Read-only scan/parse/validate/report
    connectome/          Presentation graph (no Core Relation domain)
    test-kit/            In-memory EventStore double for tests
  tests/
    unit/
    integration/
    migration/
    acceptance/
  docs/
  config/
  scripts/
```

---

## Quick start

```bash
# 1) Install deps
npm install

# 2) Fetch pinned Core (and optional Vault reference) into .deps/ (gitignored)
npm run setup:core

# 3) Run tests
npm test

# 4) Acceptance gate
npm run acceptance

# 5) Desktop UI (web mode)
npm run desktop:dev
```

### Environment

Copy `config/env.example` → `.env`:

- `CORE_DATABASE_URL` — Core EventStore DB for this V3 environment only  
- `V2_DATABASE_URL` — optional derived/index DB (**DERIVED / REBUILDABLE / NON-CANONICAL**; historical env name preserved)

Never connect V3 development to production Core databases.

---

## Foundation milestone status labels

Statuses below are **evidence-based**. Foundation **GREEN** requires live PostgreSQL
proof via `npm run acceptance` (Core `PostgresEventStore`). Mock-only suites are
not sufficient for GREEN.

| Capability | Status |
|------------|--------|
| Memory command path (mock EventStore unit/integration) | VERIFIED (tests) |
| Memory command path (live Postgres + Core EventStore) | VERIFIED (`PostgresEventStore` via docker URL or embedded-postgres) |
| Read models (classified, rebuildable) | VERIFIED (tests) |
| Continuity package foundation | VERIFIED (tests) |
| Cultivation + AI writeback safety | VERIFIED (tests) |
| Migration scanner + dry-run (no production write) | VERIFIED (tests) |
| Dual-write guard | VERIFIED (static + tests) |
| Connectome MVP presentation | PARTIAL |
| Desktop Tauri shell | PARTIAL (foundation UI) |
| Physics / Knowledge / Reflection / Learning / Trust / Scheduler | PLANNED (Core) |
| Full Connectome ontology | PLANNED |
| Production vault migration writeback | NOT STARTED (foundation tooling only) |

### Live Postgres (required for GREEN)

```bash
docker compose up -d
# CORE_DATABASE_URL defaults to docker-compose credentials on :5433
npm run test:live
npm run acceptance
```

---

## Safety rules

1. **No canonical V2 fact may be persisted outside the Core event path.**
2. Filesystem may hold exports, snapshots, imports, logs, UI artifacts — never as authoritative canonical store.
3. AI proposals are never auto-canonical; only accepted mutations enter Core commands.
4. Continuity is a **derived portable artifact**, not EventStore replacement.

---

## License

MIT — AILEXSI

## Slice A — Desktop command path

Long-lived process host:

```text
Desktop startup → createCoreRuntime() once
memory.create|get|update|archive|restore|history via invokeDesktopCommand
→ MemoryCommandAdapter → PostgresEventStore → Projection → V2 Read Model
Desktop shutdown → runtime.close()
```

Proof: `npm run test:desktop` (live PostgreSQL / embedded-postgres).
Acceptance: `npm run acceptance` requires desktop suite + foundation live suite.

## Bridge + Memory UI

Long-lived host (required for UI / Tauri):

```bash
export CORE_DATABASE_URL=postgres://...
npm run setup:core
npm run desktop:host
```

In another terminal:

```bash
npm run desktop:dev
```

Open Memory in the sidebar → Create / List / Get.

Path:

```text
UI → HTTP bridge (or Tauri invoke → Rust proxy)
  → DesktopHost → MemoryCommandAdapter → PostgresEventStore
  → Projection → V2 Read Model
```

Proof: `npm run test:bridge` and `npm run acceptance`.

## Memory UI (Slice B)

In **Memory**:

- Create / List / Get / **Update** / **Archive** / **Restore** / **History**
- Tags + project on create
- **Acceptance-Evidence speichern** → Core Memory with tags `evidence`, `acceptance` (no side files)

All mutations: Bridge → DesktopHost → PostgresEventStore only.

## Desktop (one terminal)

```bash
git pull
npm run desktop
```

Starts **DesktopHost + Vite UI**. Open http://localhost:1420

Database (automatic):
1. `CORE_DATABASE_URL` if set **and reachable**
2. else **embedded-postgres** (no Docker required; data is ephemeral)

Optional persistent DB:
```bash
docker compose up -d
$env:CORE_DATABASE_URL="postgres://ailexsi_v2:ailexsi_v2_dev@127.0.0.1:5433/ailexsi_v2_core"
npm run desktop
```

Stop with Ctrl+C.

## Memory Foundation Gate

```bash
npm run test:foundation
npm run acceptance
```

See [docs/MEMORY-FOUNDATION.md](docs/MEMORY-FOUNDATION.md).

## Frozen baseline — Memory Foundation

Tag: **`v2.0.0-memory-foundation-green`**  
SHA: `fa0f644d22ec075798c7d873d7cee7c7e3f334f1`  
Evidence: [docs/MEMORY-FOUNDATION-FREEZE.md](docs/MEMORY-FOUNDATION-FREEZE.md)

## Phase 2 — Query + Read Model

```bash
npm run test:query
npm run acceptance
```

See [docs/QUERY-READ-MODEL.md](docs/QUERY-READ-MODEL.md).

## Phase 3 — Desktop Memory E2E

```bash
npm run test:desktop-e2e
```

See [docs/DESKTOP-MEMORY-E2E.md](docs/DESKTOP-MEMORY-E2E.md).

**Freeze:** tag `v2.1.0-desktop-memory-green` @ `9795374…` — see [docs/PHASE3-DESKTOP-MEMORY-FREEZE.md](docs/PHASE3-DESKTOP-MEMORY-FREEZE.md).

## Phase 4 — Retrieval + Context

```bash
npm run test:retrieval
```

See [docs/PHASE4-RETRIEVAL.md](docs/PHASE4-RETRIEVAL.md).

