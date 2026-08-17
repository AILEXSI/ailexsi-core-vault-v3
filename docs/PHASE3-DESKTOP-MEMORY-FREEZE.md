# AILEXSI Core Vault V2 — Phase 3 Desktop Memory E2E FREEZE

## Status

**GREEN — FROZEN BASELINE**

## TESTED CODE SHA (implementation under acceptance)

```text
979537472b1f8c1b265659294377b275dc5d0019
```

Annotated tag:

```text
v2.1.0-desktop-memory-green
```

→ points **exactly** at the tested code SHA above.

Any later documentation-only commits are **not** the tested implementation SHA.

## Baselines (READ ONLY)

| Dependency | SHA |
|------------|-----|
| ailexsi-core | `652d01eb06dd0841c3b475023883675af6dcd698` |
| ailexsi-core-vault | `061e444389090c54e431b0e8243e82764f2c198e` |
| Memory Foundation freeze | `v2.0.0-memory-foundation-green` → `fa0f644…` |

## Authoritative execution environment

Windows host (operator PowerShell), **live PostgreSQL** (env or embedded via test-kit).

Commands executed successfully:

```text
npm run test:desktop-e2e
npm run test:foundation
npm run test:query
npm run acceptance
```

## Suite inventory (exact `it(` counts on tested SHA)

| Suite | File | Tests |
|-------|------|------:|
| Desktop E2E | `tests/integration/desktop-memory-e2e-gate.test.ts` | **8** |
| Foundation | `tests/integration/memory-foundation-gate.test.ts` | **13** |
| Query / Read-model | `tests/integration/memory-query-read-model-gate.test.ts` | **9** |
| FS audit | `tests/acceptance/no-canonical-fs-write.test.ts` | **2** |

### Desktop E2E cases (8)

1. long-lived CoreRuntime + PostgresEventStore only  
2. start is idempotent — same runtime identity  
3. A–F) CREATE → GET → UPDATE → HISTORY → ARCHIVE → RESTORE via Desktop IPC  
4. G) LIST + pagination via Desktop IPC  
5. REPLAY: CLEAR → rebuildFromCore → IDENTICAL via Desktop host  
6. NO-APPEND: GET LIST HISTORY REBUILD do not append events  
7. missing memory GET returns null  
8. classification: content CANONICAL, title DERIVED  

## Path

```text
Desktop UI
  → invokeDesktopCommand / bridge
  → long-lived DesktopHost
  → CoreRuntime
  → MemoryCommandAdapter (write) | MemoryQueryService (read)
  → PostgresEventStore
  → LIVE PostgreSQL
  → Core projection
  → MemoryReadModel (DERIVED)
  → Desktop read path
```

## Explicit non-goals

Phase 08 · Connectome · Continuity · Cultivation · Migration writeback · Ollama E2E

## Re-verify

```bash
git checkout v2.1.0-desktop-memory-green
npm run setup:core
npm run test:desktop-e2e
npm run test:foundation
npm run test:query
npm run acceptance
```
