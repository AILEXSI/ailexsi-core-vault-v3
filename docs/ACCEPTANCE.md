# Acceptance Gate — Vault V3 (V2 foundation, inherited)

Run:

```bash
npm run setup:core
npm test
npm run acceptance
```

## Minimum requirements

```text
CORE BASELINE IDENTIFIED
V2 CLEAN CHECKOUT
DATABASE CONFIG VERIFIED (env template present; no hardcoded secrets)
UNIT TESTS GREEN
INTEGRATION TESTS GREEN
MEMORY CREATE/UPDATE/ARCHIVE/RESTORE GREEN
IDEMPOTENCY GREEN
REPLAY GREEN
AI WRITEBACK SAFETY GREEN
CONTINUITY GREEN
MIGRATION SCANNER GREEN
NO CANONICAL FS WRITEBACK
NO MODIFICATION OF CORE
NO MODIFICATION OF CURRENT VAULT
```

Every skipped test must be explicitly reported. No silent skips.

## Status vocabulary

| Label | Meaning |
|-------|---------|
| GREEN | All required foundation gates pass |
| VERIFICATION PENDING | Implemented but not fully evidenced |
| BLOCKED | Missing Core capability or external dependency |
| PARTIAL | Intentionally incomplete but honest |
| PLANNED | Documented future, not claimed |
