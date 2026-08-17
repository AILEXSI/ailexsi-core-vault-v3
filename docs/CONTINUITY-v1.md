# Continuity Foundation v1

## Baseline

Built on `v2.2.1-evidence-green` (`1c9cf4c…`).

Core pin / Vault pin frozen (READ ONLY).

## Purpose

Portable **operational package** of a co-creation moment:

```text
pins + selection policy + ordered Core memory IDs
  → export (DERIVED)
  → new runtime
  → rehydrate-verify against Core (READ ONLY)
  → same identities / same retrieve+context under same params
```

**Not** a second source of truth. **Not** EventStore import. **Not** Cultivation.

## Classification

| Layer | Class |
|-------|--------|
| Package shell | V2-DERIVED |
| `orderedMemoryIds` | CORE-CANONICAL references |
| Optional cell inspection snapshot | CORE-CANONICAL (copy for inspect; Core remains authority) |
| Selection / retrieve / context params | V2-DERIVED |
| `auditOnly.generatedAt` | audit metadata only (not identity) |

## Package fields (v1)

```text
schemaVersion: "continuity-v1"
kind: "continuity-package"
coreBaselineSha
vaultReferenceSha
selection: { mode: "ids" | "retrieve", memoryIds?, retrieve?, context? }
orderedMemoryIds: UUID[]   // deterministic order
classifications: { package, ids, selection, inspection }
inspection?: { memories: compact list items from read model }
auditOnly?: { generatedAt }
```

## Operations

| Op | Behavior |
|----|----------|
| export | Build package from CoreRuntime queries; no EventStore append |
| inspect | Parse + summarize; no Core mutation |
| rehydrateVerify | New/same EventStore data → get each id from Core; optional re-run retrieve/context; compare |

## Determinism

Same Core state + same selection → identical **identity snapshot** (package without `auditOnly`).

## Non-goals

Embeddings, Connectome, Cultivation primary, migration writeback, Phase 08, second DB.
