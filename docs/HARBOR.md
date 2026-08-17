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
