# AILEXSI Core Vault V3 — Current State

> **V3 bootstrap:** successor of `AILEXSI/ailexsi-core-vault-v2` @ `d684aa4a3c292c1d1f1587a68371589437b68055`.  
> **Harbor:** derived cognitive layer (`packages/harbor`, DesktopHost `harbor.*`). Core still canonical.

> **Documentation is not proof.**  
> The authoritative freeze identity is the **Git annotated tag** resolving to the tested commit (`tag^{}`).

## Latest GREEN (historical V2, inherited)

| Field | Value |
|--------|--------|
| Phase | **4** — Deterministic Retrieval + Context |
| Tag | `v2.2.0-retrieval-context-green` |
| Tested SHA | `4907119572bfab5f0589f966203c9882e37fea33` |
| Status | GREEN / FROZEN |

Verify:

```text
git rev-parse v2.2.0-retrieval-context-green^{}
# expected: 4907119572bfab5f0589f966203c9882e37fea33
```

## Prior freezes (immutable)

| Phase | Tag | SHA |
|-------|-----|-----|
| 3 Desktop Memory E2E | `v2.1.0-desktop-memory-green` | `979537472b1f8c1b265659294377b275dc5d0019` |
| Memory Foundation | `v2.0.0-memory-foundation-green` | `fa0f644d22ec075798c7d873d7cee7c7e3f334f1` |

## Pins

| | SHA |
|--|-----|
| Core | `652d01eb06dd0841c3b475023883675af6dcd698` |
| Vault V1 | `061e444389090c54e431b0e8243e82764f2c198e` |

Source: `config/baselines.json`

## Evidence

Machine-readable runs (when acceptance is executed):

```text
evidence/runs/<testedSha>.acceptance.json
```

See `evidence/README.md`.

## Harbor (this generation)

| Slice | Status |
|-------|--------|
| Epistemic overlays + confirm-to-USER_ASSERTED | VERIFIED (unit) |
| Agency boundary | VERIFIED (unit) |
| Contradiction detect/resolve (no auto-decide) | VERIFIED (unit) |
| Context package (reasons, budget, reproducible) | VERIFIED (unit) |
| Reflection (derived, evidenced) | VERIFIED (unit) |
| Provider invocation log | VERIFIED (unit) |
| Inspectable export/import (no Core write) | VERIFIED (unit) |
| Harbor Connectome wrap | VERIFIED (unit) |
| Desktop `harbor.*` commands + Harbor UI | PARTIAL |
| Live Harbor+Postgres gate | NOT STARTED |

Phase 08 Physics: **ABSENT**
