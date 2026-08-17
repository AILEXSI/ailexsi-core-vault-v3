# Phase 3 — Desktop Memory E2E

## Path

```text
Desktop UI / invokeDesktopCommand
  → long-lived DesktopHost
  → CoreRuntime (single PostgresEventStore)
  → WRITE: MemoryCommandAdapter
  → READ:  MemoryQueryService → MemoryReadModel (DERIVED)
```

## Operations

create · get · list ( + pagination ) · update · archive · restore · history

## Gates

```bash
npm run test:desktop-e2e
npm run acceptance
```

Requires live PostgreSQL (env URL or embedded).

## Non-goals

Phase 08 · Connectome · Cultivation · Migration writeback · Ollama E2E

**Freeze:** tag `v2.1.0-desktop-memory-green` @ `9795374…` — see [docs/PHASE3-DESKTOP-MEMORY-FREEZE.md](docs/PHASE3-DESKTOP-MEMORY-FREEZE.md).
