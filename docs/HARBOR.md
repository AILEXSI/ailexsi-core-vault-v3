# V3 Cognitive Harbor

**Class:** V3-DERIVED  
**Canonical authority:** AILEXSI Core (unchanged)

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

AI default: `READ_ONLY`, `DERIVED_WRITE`, `CANONICAL_PROPOSAL`.  
`CANONICAL_COMMIT` and `EXTERNAL_ACTION` require an explicit human actor.  
AI cannot grant itself those capabilities.

## Epistemic rule

Inferences and AI proposals never become `FACT`.  
Human confirmation produces `USER_ASSERTED`.

## Commands (DesktopHost / HTTP bridge)

`harbor.snapshot` `harbor.scan` `harbor.context` `harbor.reflect`  
`harbor.contradiction.resolve` `harbor.propose` `harbor.proposal.decide`  
`harbor.confirm` `harbor.graph` `harbor.export`  
`harbor.import` (scan only) `harbor.import.validate` `harbor.import.preview`  
`harbor.import.conflicts` `harbor.import.confirm` `harbor.import.reject` `harbor.rebuild`

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
