# AILEXSI Core Vault V3 — Current State

Documentation describes reality. GREEN is evidence, not the product.

## CURRENT HEAD

See `git rev-parse HEAD`. Last Harbor slice commit is on `main`.

## LATEST VERIFIED SHA

| Kind | SHA | Note |
|------|-----|------|
| V3 bootstrap tag | `v3.0.0-v2-baseline` → `8a29278760021c63320d1bd4284c21dae5058445` | V2 copy + identity only |
| Harbor core | `219dbfa72bb137c0b7a5957e7983c903e668cc17` | derived package + unit tests |
| Harbor import | `be6b53b176d0bd80cc733172d611af35b9517a48` | staged import + agentic + nav |
| Durable derived index | `d7cccd21680ededcf36be1783583bf754b822611` | persist + rebuild marker |
| Derived query | `4d2003b15d2d4eecc15f5174cc8cec8685d8cfda` | read-only derived query service |
| Context assembly | `bcf6a82b8a932e551b5ac214985b643924ea6edb` | deterministic ContextPackage |
| Observed reflection | `5d5b112be9bf16d5657d72c522e98931d35fdc6a` | deterministic OBSERVED reflections |
| This worktree | `git rev-parse HEAD` | deterministic cultivation proposals |

## LATEST GREEN TAG

| Tag | Meaning |
|-----|---------|
| `v3.0.0-v2-baseline` | V3 created from verified V2 |
| `v2.2.0-retrieval-context-green` | Historical V2 freeze (inherited, not a V3 tag) |

No new V3 GREEN tag is minted until a dedicated freeze is authorized.

## IMPLEMENTED

- Core Memory command path (V2 inherited): create/get/update/archive/restore/history
- Retrieval + V2 context bundle
- Cultivation accept/reject/defer (human; EventStore only on accept)
- Harbor epistemic overlays (FACT default for Core cells; confirm → USER_ASSERTED, never silent FACT)
- Agency defaults; AI cannot self-grant CANONICAL_COMMIT
- Contradiction detect/resolve (human resolution only)
- Temporal is_true / was_true overlay
- ContextPackage with inclusion reasons and reproducible key
- Deterministic context assembly (`harbor-context-package-v1`) over the Derived Query Service: explicit IDs/source/status/project/temporal, inspectable inclusions/exclusions, unresolved contradictions preserved
- Reflection with evidence IDs (rule-based, works without an LLM)
- Deterministic OBSERVED reflection engine (`harbor-reflection-observation-v1`) over query/context: topics, projects, goals, preference values, unresolved contradictions, unconfirmed derived, frequent references, temporal clusters, shared sources
- Deterministic cultivation proposals (`harbor-cultivation-proposal-v1`) from observed reflections: review preference/contradiction/unconfirmed/goal/project; human ACCEPT/EDIT/REJECT/DEFER; never a Core write
- Provider invocation log (mock)
- Staged import: SCAN → VALIDATE → PREVIEW → CONFLICT → CONFIRM → WRITE (derived only)
- Rebuild derived from canonical without touching EventStore
- Durable derived index (`harbor-derived-index-v1`): JSON snapshot, atomic write, rebuild marker
- CLEAR DERIVED → REPLAY CANONICAL → REBUILD is deterministic; corrupt/missing/interrupted/schema-mismatch are known states
- Deterministic derived query service (READ-ONLY): get/list/source/status/contradictions/provenance + pagination
- Agentic failure tests (blocked unauthorized write, flagged contradiction, required-test inventory)
- Desktop nav: Home/Harbor, Memory, Context, Reflection, Cultivation, Connectome, Continuity, Evidence, Settings

## PARTIAL

- Desktop Context/Reflection/Connectome/Continuity panels are host-backed or honest placeholders
- Harbor export does not copy canonical Memory bodies (IDs + derived overlays only)
- Continuity v1 schema unchanged; Harbor has a separate export schema
- Evidence UI does not render run files (honest: disk-only)

## PLANNED

- Live Harbor+Postgres dedicated gate
- Full contradiction/confirm UI (not JSON dump)
- Core Relation aggregate
- Physics / Knowledge / Learning / Trust / Scheduler
- External actions

## KNOWN LIMITATIONS

- Multiple Embedded-Postgres instances can exhaust Windows sockets if verification is stacked
- `tsc -b` still reports pre-existing desktop/JSX project issues; Vitest is the executable suite
- Import WRITE is derived-only; it never creates Core Memory cells
- Preference contradiction heuristic is literal (`user prefers X`)

## NEXT BUILD SLICE

Dedicated Harbor+Postgres live gate — not more mock surfaces.

## ARCHITECTURAL INVARIANTS

1. Core owns canonical identity, events, replay.
2. Harbor is V3-DERIVED. Filesystem is not a second EventStore.
3. AI default: READ_ONLY + DERIVED_WRITE + CANONICAL_PROPOSAL.
4. Inference never becomes FACT. Human confirm → USER_ASSERTED.
5. Import cannot skip SCAN → VALIDATE → PREVIEW → CONFLICT → CONFIRM.
6. Acceptance tests may not be deleted to obtain GREEN (`config/required-tests.json`).
7. Phase 08 Physics is absent.

## Pins

| | SHA |
|--|-----|
| Core | `652d01eb06dd0841c3b475023883675af6dcd698` |
| Vault V1 | `061e444389090c54e431b0e8243e82764f2c198e` |
| V2 source | `d684aa4a3c292c1d1f1587a68371589437b68055` |
