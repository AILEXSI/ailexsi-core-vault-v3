# Evidence (provenance only)

Machine-readable **acceptance evidence** for AILEXSI Core Vault V3.
Historical V2 run files in `evidence/runs/` are inherited and left unchanged.

## What this is

- Artifacts produced from `npm run acceptance` (`scripts/acceptance-gate.mjs`).
- A durable record of: tested SHA, pins, environment flags, gate PASS/FAIL, status.

## What this is NOT

- **Not** runtime state
- **Not** canonical Memory / EventStore data
- **Not** a second source of truth
- **Not** imported by production packages
- **Not** a license to claim GREEN without execution

## Authority order

```text
1. Live test execution + acceptance exit code
2. Git annotated freeze tags (tag^{} == tested SHA)
3. evidence/runs/*.acceptance.json
4. Human freeze / status docs
```

Documentation alone never grants GREEN.

## Status rules

| Acceptance exit | Evidence status | GREEN freeze file? |
|-----------------|-----------------|--------------------|
| 0 | GREEN | yes (`<sha>.acceptance.json`) |
| 2 | VERIFICATION PENDING | no (status-qualified name) |
| 1 | BLOCKED | no (status-qualified name) |

**NON-ZERO EXIT ≠ GREEN.**

## Freeze tags

Immutable historical anchors (do not move):

- `v2.0.0-memory-foundation-green`
- `v2.1.0-desktop-memory-green`
- `v2.2.0-retrieval-context-green`

The gate does **not** create or push tags.

## Schema

See `schema/acceptance-run.schema.json` (documentation; no ajv dependency required).

## Historical freezes

Existing freeze Markdown and tags are **not** rewritten. Optional reconstructed indexes would be marked explicitly if added later.
