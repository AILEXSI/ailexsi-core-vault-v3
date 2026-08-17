# AILEXSI Core Vault V2 — Memory Foundation FREEZE

## Status

**GREEN — FROZEN BASELINE**

## Exact commit

```text
fa0f644d22ec075798c7d873d7cee7c7e3f334f1
```

Annotated tag:

```text
v2.0.0-memory-foundation-green
```

## Baselines (READ ONLY)

| Dependency | SHA | Role |
|------------|-----|------|
| AILEXSI/ailexsi-core | `652d01eb06dd0841c3b475023883675af6dcd698` | Cortex pin — untouched |
| AILEXSI/ailexsi-core-vault | `061e444389090c54e431b0e8243e82764f2c198e` | Capability reference — untouched |

## Live acceptance evidence (Windows)

Recorded by operator after clean checkout of the freeze SHA:

| Gate | Result |
|------|--------|
| MEMORY FOUNDATION GATE | **13/13 PASS** |
| MEMORY FOUNDATION FS AUDIT | **2/2 PASS** |
| FAILURES | **0** |
| SKIPPED | **0** |
| LIVE POSTGRES | **YES** (embedded mode, PostgreSQL 18.x, DB `ailexsi_v2_core`) |
| DESKTOP PATH | **YES** |
| PHASE 08 CODE PRESENT | **NO** |

## Proven matrix

| Capability | Result |
|------------|--------|
| Create / Get / Update / Archive / Restore / History | PASS |
| Idempotency (same payload) | PASS |
| Idempotency conflict (EventStore) | PASS |
| Invalid input → VALIDATION, no event | PASS |
| Concurrency conflict | PASS |
| Multi-memory isolated CLEAR → REBUILD → IDENTICAL | PASS |
| No canonical filesystem write | PASS |

## Path

```text
V2 UI → Bridge → DesktopHost → MemoryCommandAdapter
  → Core MemoryDomain → PostgresEventStore
  → Projection → V2 Read Model
```

## Explicit non-goals frozen out

- Phase 08 / Physics
- Connectome product implementation
- Continuity product implementation
- Cultivation product implementation
- Migration writeback / cutover
- New Core domains

Scaffold packages under `packages/*` that pre-exist as placeholders are **not** authorized product milestones until their own GREEN gates.

## Re-verify

```bash
git checkout v2.0.0-memory-foundation-green
npm run setup:core
npm run test:foundation
npm run acceptance
```

## Next work

Only after explicit authorization. Do not treat this freeze as license to start Connectome, Cultivation, Migration, or Phase 08.
