# Continuity v1 — Acceptance Matrix

Gate: **CONTINUITY FOUNDATION GATE**

| ID | Requirement |
|----|-------------|
| CONTINUITY-01 | Export from Core-backed runtime |
| CONTINUITY-02 | Package contains Core/Vault pins |
| CONTINUITY-03 | Classifications explicit |
| CONTINUITY-04 | Serialize → parse round trip |
| CONTINUITY-05 | Identity snapshot deterministic (excl. auditOnly) |
| CONTINUITY-06 | Explicit ID selection deterministic |
| CONTINUITY-07 | Retrieve-driven selection deterministic |
| CONTINUITY-08 | Rehydrate/verify against Core succeeds |
| CONTINUITY-09 | Same IDs after new runtime (same EventStore) |
| CONTINUITY-10 | Same cells after rebuild |
| CONTINUITY-11 | Same retrieve results reapplied |
| CONTINUITY-12 | Same context results reapplied |
| CONTINUITY-13 | eventCount unchanged |
| CONTINUITY-14 | No EventStore append |
| CONTINUITY-15 | No canonical FS write (regression) |
| CONTINUITY-16 | No new canonical UUIDs in package ops |
| CONTINUITY-17 | CLEAR→rebuild→verify identical |
| CONTINUITY-18 | Desktop long-lived path |
| CONTINUITY-19 | LIVE PostgreSQL |
| CONTINUITY-20–23 | Foundation / Query / Desktop E2E / Retrieval regression |
| CONTINUITY-24 | Evidence GREEN when acceptance GREEN |
| CONTINUITY-25 | Freeze only on exact tested SHA (human) |

Negative: invalid schema, missing/unknown id, empty selection.
