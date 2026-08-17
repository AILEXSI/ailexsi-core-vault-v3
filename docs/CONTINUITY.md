# Continuity — Vault V3 (V2 contract, inherited)

## Definition

Continuity is a **DERIVED PORTABLE ARTIFACT**.

It is **not**:

- a replacement for Core event history
- a canonical fact store
- a full replay of chat/UI state

## Package contents

A Continuity snapshot may contain:

| Content | Class |
|---------|-------|
| Core-backed Memory facts | CORE-CANONICAL |
| Derived relationships / Connectome packaging | V2-DERIVED |
| Cultivation context summary | V2-DERIVED |
| Ephemeral notes / session fragments | V2-EPHEMERAL |
| Metadata (counts, baseline SHAs) | V2-DERIVED |

Every field is classified. Schema: `v2.0.0-foundation`.

## Reconstructibility

Canonical memories in a Continuity package are expected to match Core projection state for the same event stream.

**Claimed:**

- Canonical memory ids and versions are rebuildable from EventStore.

**Not claimed:**

- Full replayability of ephemeral chat turns or UI-only state.

## Implementation

```ts
import { buildContinuityPackage, serializeContinuity } from "@ailexsi/v2-continuity";

const pkg = buildContinuityPackage({
  memories, // from Core projection / adapter
  coreBaselineSha: "...",
  vaultReferenceSha: "...",
});
```

Filesystem export of Continuity JSON is allowed as **export/snapshot only**.
