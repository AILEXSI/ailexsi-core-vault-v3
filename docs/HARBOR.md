# V3 Cognitive Harbor

**Class:** V3-DERIVED  
**Canonical authority:** AILEXSI Core (unchanged)  
**Agency:** GREEN / implemented (`d7aa20e`; implementation HEAD `7bf0c11`).

Harbor is the user-facing cognitive infrastructure around Core Memory.

It does **not** replace EventStore, MemoryDomain, or the V2 command path.

## Journey

DOCK → SEE → RETRIEVE → UNDERSTAND → REFLECT → PROPOSE → DISCUSS → ACCEPT/EDIT/REJECT/DEFER → PERSIST → VERIFY → CONTINUE

## Ownership

| Concern | Owner |
|---------|--------|
| Identity, events, canonical memory | Core |
| Epistemic overlays, contradictions, reflections | Harbor (derived) |
| Context packages | Harbor (derived; uses existing retrieval) |
| Proposals before accept | Harbor / Cultivation (ephemeral/derived) |
| Accepted canonical writes | Core via existing MemoryCommandAdapter |
| Agency / permission boundary | Harbor (auditable, no silent escalation) |

## Agency

**Class:** permission boundary (not EventStore)  
**Capabilities:** `READ_ONLY` `DERIVED_WRITE` `PROPOSE` (`CANONICAL_PROPOSAL` is the retained identifier) `CANONICAL_COMMIT` `EXTERNAL_ACTION`

```text
Core = Canonical Truth
Harbor = Derived Understanding
AI = Proposal
Human = Authority
```

AI default: `READ_ONLY`, `DERIVED_WRITE`, `PROPOSE`.  
`CANONICAL_COMMIT` and `EXTERNAL_ACTION` require an explicit human `AuthorizationGrant`.  
AI cannot grant, escalate, or mutate itself into those capabilities.

Denied actions return a structured `AgencyDenial` (`code`, actor, requested capability, granted capabilities, action, target, `stateModified: false`). They do not write Core, EventStore, or derived state.

Authorized canonical actions record actor, authorization, action, target, timestamp, resulting event IDs, and provenance.

Proposal generation (`harbor.propose`, cultivation proposals) is separate from `HarborService.commitCanonical`. Accepting a proposal does **not** mint a grant and does **not** write EventStore. Persist is `HarborService.commitProposal`: the proposal must already be `ACCEPTED`/`EDITED`, and a **separate** human grant (`proposal.commit` + proposalId) is required.

## Epistemic rule

Inferences and AI proposals never become `FACT`.  
Human confirmation produces `USER_ASSERTED`.

## Commands (DesktopHost / HTTP bridge)

`harbor.snapshot` `harbor.scan` `harbor.context` `harbor.reflect`  
`harbor.contradiction.resolve` `harbor.propose` `harbor.proposal.decide`  
`harbor.confirm` `harbor.graph` `harbor.export`  
`harbor.import` (scan only) `harbor.import.validate` `harbor.import.preview`  
`harbor.import.conflicts` `harbor.import.confirm` `harbor.import.reject` `harbor.rebuild`  
`harbor.query.memory` `harbor.query.list` `harbor.query.source`  
`harbor.query.status` `harbor.query.contradictions` `harbor.query.provenance`

Import WRITE is derived-only and requires a human after SCAN → VALIDATE → PREVIEW → CONFLICT.

Existing `memory.*`, `cultivation.*`, `continuity.*` commands are unchanged.

## Durable derived index

**Class:** V3-DERIVED  
**Schema:** `harbor-derived-index-v1`  
**Not EventStore. Not Core.**

Harbor persists derived overlays (epistemic, contradictions, reflections, proposals, invocations) as a versioned JSON snapshot so they survive process restart.

| Concern | Owner |
|---------|--------|
| Canonical events / Memory | Core EventStore |
| Derived overlays | Harbor derived index (`HARBOR_DERIVED_INDEX_PATH`, default `data/derived-index`) |

Rebuild protocol:

1. Write `rebuilding.marker` (previous `index.json` is retained)
2. Replay canonical Memory cells
3. Atomically replace `index.json`
4. Clear the marker

Known load states: `empty` | `ready` | `rebuilding` | `corrupt` | `schema_mismatch` | `interrupted`.

A missing, corrupt, mismatched, or interrupted index is repaired by `harbor.rebuild` / `rebuildFromCanonical`. It never requires deleting or rewriting canonical state.

CLEAR DERIVED → REPLAY CANONICAL → REBUILD DERIVED is deterministic for the rebuildable slices (epistemic, contradictions, reflections). Proposals/invocations are session-derived and are not part of the rebuild fingerprint.

## Derived query service

**Class:** V3-DERIVED  
**Capability:** `READ_ONLY`  
**Not EventStore. Not a write path.**

`HarborService.queries(actor)` and `DerivedQueryService.fromIndex(persistDir)` expose a deterministic read model over the derived index:

| Method | Result |
|--------|--------|
| `getDerivedMemory(id)` | Epistemic overlay by stable memory ID |
| `listDerivedMemories({ offset, limit })` | All overlays, `memoryId` ascending |
| `findDerivedBySource(memoryId)` | Epistemic / contradiction / reflection / proposal hits citing that canonical ID |
| `findDerivedByStatus(status)` | Epistemic overlays with that status |
| `findContradictions({ resolution, sourceMemoryId })` | Contradiction records, `id` ascending |
| `getDerivedProvenance(id)` | Canonical source IDs for a derived record |

Query results are cloned. Mutating them does not mutate the index and does not persist. Missing, corrupt, schema-mismatch, or interrupted indexes remain known states; repair is still `rebuildFromCanonical`.

## Context assembly

**Class:** V3-DERIVED  
**Schema:** `harbor-context-package-v1`  
**Capability:** `READ_ONLY`  
**Not EventStore. ContextPackage is not persisted.**

`HarborService.assemble` / `assembleFromDerived` and `assembleContextFromQuery` build an inspectable ContextPackage from the Derived Query Service.

Selection uses explicit deterministic rules only (no embeddings):

- direct memory ID (`selected`)
- source-memory match (`source_match`)
- status filter (`status_match`)
- project / tag / query-task substring (`project_match`, `tag_match`, `task_match`)

Every included item has a reason. Temporal, status, project, tag, and budget misses are recorded as exclusions. Contradictions touching selected items are attached unresolved.

Identical canonical + derived state and identical request produce the same `packageId`, selection, and ordering.

## Deterministic reflection

**Class:** V3-DERIVED  
**Schema:** `harbor-reflection-observation-v1`  
**Capability:** `READ_ONLY`  
**Stance:** OBSERVED only. Not EventStore. Not persisted. Not a memory write.

`HarborService.reflectObserved` / `reflectFromQuery` derive inspectable observations from the Derived Query Service and optional ContextPackage/catalog.

Rules are explicit counts and matches (tags, projects, `goal:` labels, `user prefers X`, unresolved contradictions, unconfirmed statuses, derived-reference counts, shared dates, shared source sets).

A reflection does **not** interpret motive, emotion, personality, or intent. Contradictions are surfaced unresolved. The existing `harbor.reflect` path (legacy findings artifact) is unchanged and still derived-only.

## Deterministic cultivation proposals

**Class:** V3-DERIVED  
**Schema:** `harbor-cultivation-proposal-v1`  
**Not a memory. Not EventStore. Not Derived Index. Not auto-accepted.**

`HarborService.cultivate` / `proposeFromReflections` turn supported OBSERVED reflections into human-review proposals:

| Reflection | Proposal |
|------------|----------|
| `preference_change` | Review whether the newer preference should supersede the older one |
| `unresolved_contradiction` | Review contradictory records |
| `stale_derived` | Review unconfirmed derived information |
| `repeated_goal` / `repeated_project` | Review whether this goal/project should remain active |

Statuses: `DRAFT` `PROPOSED` `ACCEPTED` `EDITED` `REJECTED` `DEFERRED` `SUPERSEDED`.  
Generation starts at `PROPOSED`. `decideCultivation` requires a human. Accept/edit do **not** write Core or mint events. The existing provider `harbor.propose` path is unchanged.
