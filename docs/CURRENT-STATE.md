# AILEXSI Core Vault V3 — Current State

Documentation describes reality. GREEN is evidence, not the product.

This repository is **AILEXSI Core Vault V3**.

## CURRENT IMPLEMENTATION HEAD

`7bf0c115b1fce501f24b0b8b2266a081655c0819`

Agency implementation: `d7aa20e201908dabb561c327dc4de200857d0765` (`feat: enforce explicit agency boundaries`).  
`7bf0c11` records acceptance + `verify:live` evidence for that agency tree.

Implemented capabilities run **through EXPLICIT AGENCY / PERMISSION BOUNDARY**. Agency is **GREEN / implemented**.

## LATEST VERIFIED SHA

| Kind | SHA | Note |
|------|-----|------|
| V3 bootstrap tag | `v3.0.0-v2-baseline` @ `0eba4dbe36cfab839da8bbcd1ddf2df10a5447d1` | tag object; peels to `8a29278760021c63320d1bd4284c21dae5058445` (V2 copy + identity only) |
| Harbor core | `219dbfa72bb137c0b7a5957e7983c903e668cc17` | derived package + unit tests |
| Harbor import | `be6b53b176d0bd80cc733172d611af35b9517a48` | staged import + agentic + nav |
| Durable derived index | `d7cccd21680ededcf36be1783583bf754b822611` | persist + rebuild marker |
| Derived query | `4d2003b15d2d4eecc15f5174cc8cec8685d8cfda` | read-only derived query service |
| Context assembly | `bcf6a82b8a932e551b5ac214985b643924ea6edb` | deterministic ContextPackage |
| Observed reflection | `5d5b112be9bf16d5657d72c522e98931d35fdc6a` | deterministic OBSERVED reflections |
| Cultivation proposals | `6804c377acc15fdd52ae47f4b13704c0891ea77c` | deterministic cultivation proposals |
| Agency implementation | `d7aa20e201908dabb561c327dc4de200857d0765` | explicit agency / permission boundary — GREEN |
| Implementation HEAD | `7bf0c115b1fce501f24b0b8b2266a081655c0819` | agency evidence on `d7aa20e` |

## LATEST GREEN TAG

| Tag | Object | Meaning |
|-----|--------|---------|
| `v3.0.0-v2-baseline` | `0eba4db` | V3 created from verified V2 (bootstrap identity) |
| `v2.2.0-retrieval-context-green` | historical V2 | Inherited V2 freeze — not a V3 implementation tag |

No new V3 GREEN freeze tag is minted until a dedicated freeze is authorized. The bootstrap tag is **not** a product release and does **not** mean later Harbor/agency work is absent.

## IMPLEMENTED (through agency)

- Core Memory command path (V2 inherited): create/get/update/archive/restore/history
- Retrieval + V2 context bundle
- Cultivation accept/reject/defer (human; EventStore only on accept)
- Harbor epistemic overlays (FACT default for Core cells; confirm → USER_ASSERTED, never silent FACT)
- **Agency = GREEN / implemented.** Enforceable permission boundary (`AgencyBoundary`): frozen authority, issued grants, structured denials, audit of authorized canonical/external actions. AI cannot self-grant `CANONICAL_COMMIT`.
- Proposal generation is separate from canonical mutation; accept does not mint `CANONICAL_COMMIT`
- Contradiction detect/resolve (human resolution only)
- Temporal is_true / was_true overlay
- ContextPackage with inclusion reasons and reproducible key
- Deterministic context assembly (`harbor-context-package-v1`)
- Reflection with evidence IDs (rule-based, works without an LLM)
- Deterministic OBSERVED reflection engine (`harbor-reflection-observation-v1`)
- Deterministic cultivation proposals (`harbor-cultivation-proposal-v1`); human ACCEPT/EDIT/REJECT/DEFER; never a Core write
- Provider invocation log (mock)
- Staged import: SCAN → VALIDATE → PREVIEW → CONFLICT → CONFIRM → WRITE (derived only)
- Rebuild derived from canonical without touching EventStore
- Durable derived index (`harbor-derived-index-v1`)
- Deterministic derived query service (READ-ONLY)
- Agentic failure tests
- Full-system acceptance / integrity gate: live PostgresEventStore walk Core → Query → Context → Reflection → Cultivation → Agency; unauthorized canonical writes blocked; authorized writes keep provenance; denied actions do not mutate EventStore
- Desktop nav labels exist (Home/Harbor, Memory, Context, Reflection, Cultivation, Connectome, Continuity, Evidence, Settings). Nav labels are not product completion.

## NOT IMPLEMENTED

These are **not** implemented. Do not treat nav labels, inherited V2 presentation, or planned docs as GREEN.

| Item | Status |
|------|--------|
| Connectome | **NOT implemented** |
| Integration | **NOT implemented** |
| Full Acceptance | **GREEN / implemented** — `tests/integration/v3-full-acceptance-gate.test.ts` (`npm run test:integrity`) |
| Hardening | **NOT implemented** |
| Stress | **NOT implemented** |
| Optimization | **NOT implemented** |
| Release Candidate | **NOT implemented** |

## PARTIAL

- Desktop Context/Reflection/Connectome/Continuity panels are host-backed or honest placeholders
- Harbor export does not copy canonical Memory bodies (IDs + derived overlays only)
- Continuity v1 schema unchanged; Harbor has a separate export schema
- Evidence UI does not render run files (honest: disk-only)

## PLANNED (not started)

- Live Harbor+Postgres dedicated gate
- Full contradiction/confirm UI (not JSON dump)
- Core Relation aggregate
- Physics / Knowledge / Learning / Trust / Scheduler
- External actions (authorized path exists; no product external-action surface)

## KNOWN LIMITATIONS

- Multiple Embedded-Postgres instances can exhaust Windows sockets if verification is stacked
- `tsc -b` still reports pre-existing desktop/JSX project issues; Vitest is the executable suite
- Import WRITE is derived-only; it never creates Core Memory cells
- Preference contradiction heuristic is literal (`user prefers X`)
- Inherited package names `@ailexsi/v2-*`, desktop bundle id `com.ailexsi.core-vault-v2`, and Cargo crate `ailexsi-core-vault-v2` are historical V2 module/bundle identity inside this V3 repository. They are not a second product and do not mean this tree is Vault V2.

## NEXT BUILD SLICE

Not started. Do not start Connectome, Integration, Hardening, Stress, Optimization, or Release Candidate from this slice.

## ARCHITECTURAL INVARIANTS

1. Core owns canonical identity, events, replay.
2. Harbor is V3-DERIVED. Filesystem is not a second EventStore.
3. AI default: READ_ONLY + DERIVED_WRITE + PROPOSE (`CANONICAL_PROPOSAL` identifier retained). CANONICAL_COMMIT / EXTERNAL_ACTION require an explicit human grant.
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
| V3 bootstrap tag | `v3.0.0-v2-baseline` @ `0eba4dbe36cfab839da8bbcd1ddf2df10a5447d1` |
| Agency implementation | `d7aa20e201908dabb561c327dc4de200857d0765` |
| Implementation HEAD | `7bf0c115b1fce501f24b0b8b2266a081655c0819` |
