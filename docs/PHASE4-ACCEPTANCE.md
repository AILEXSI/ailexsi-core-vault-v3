# Phase 4 — Acceptance Matrix

Gate: **MEMORY RETRIEVAL + CONTEXT GATE**  
Live suite: `tests/integration/memory-retrieval-context-gate.test.ts`  
Unit: `tests/unit/memory-retrieval.test.ts`

| ID | Requirement | Coverage |
|----|-------------|----------|
| PHASE4-01 | Frozen Phase 3 baseline immutable | process / git |
| PHASE4-02 | Empty retrieval | live + unit |
| PHASE4-03 | textContains (case-normalized) | live + unit |
| PHASE4-04 | tagsAny (OR, exact) | live + unit |
| PHASE4-05 | project exact | live + unit |
| PHASE4-06 | lifecycle / includeArchived | live + unit |
| PHASE4-07 | Order confirmedAt DESC, id ASC | live + unit |
| PHASE4-08 | Repeated retrieval identical | live |
| PHASE4-09 | Cursor pagination `r1:` | live + unit |
| PHASE4-10 | No duplicates across pages | live + unit |
| PHASE4-11 | No gaps vs full ordered set | live + unit |
| PHASE4-12 | Context assembly | live |
| PHASE4-13 | Context budget maxItems + maxChars | unit + live |
| PHASE4-14 | Context deterministic identity | live |
| PHASE4-15 | History expansion | DEFERRED v1 (optional; `includeHistory` supported but not required for GREEN matrix primary) — contract present |
| PHASE4-16 | Retrieval no-write (eventCount) | live |
| PHASE4-17 | Context no-write | live |
| PHASE4-18 | Rebuild equivalence | live |
| PHASE4-19 | No new canonical UUIDs | live |
| PHASE4-20 | Filesystem integrity | FS audit regression |
| PHASE4-21 | Desktop retrieve E2E | live |
| PHASE4-22 | Desktop context E2E | live |
| PHASE4-23 | Foundation regression 13/13 | `test:foundation` |
| PHASE4-24 | Query regression 9/9 | `test:query` |
| PHASE4-25 | Desktop E2E regression 8/8 | `test:desktop-e2e` |
| PHASE4-26 | Full acceptance | `npm run acceptance` |
| PHASE4-27 | LIVE PostgreSQL | embedded/env via test-kit |

GREEN requires: LIVE POSTGRES + all implemented gates PASS + failures 0 + skipped 0 + Phase 1–3 green.

**TESTED SHA === TAG SHA** for freeze. Phase 3 tag never moved.
