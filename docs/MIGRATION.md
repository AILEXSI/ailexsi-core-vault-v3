# Migration — Vault V3 (V2 foundation, inherited)

## Safety

```text
CURRENT VAULT = READ ONLY
No production Vault mutation
No automatic production Core event writeback in foundation
```

Reference baseline:

```text
AILEXSI/ailexsi-core-vault @ 061e444389090c54e431b0e8243e82764f2c198e
```

## Foundation pipeline

```text
CURRENT VAULT (or fixture)
    ↓
read-only scanner
    ↓
parse Markdown + YAML frontmatter
    ↓
validate
    ↓
normalized migration report
```

Supported operations:

- `scan`
- `parse`
- `validate`
- `report`

Intermediate representation: `NormalizedVaultNote[]` + `MigrationReport`.

`coreWrites` is always `0` in this milestone.

## Report fingerprint

`contentFingerprint` is a deterministic SHA-256 over normalized note content for test stability.

## Future (NOT foundation)

Event writeback of migrated notes through Core Memory commands — only after explicit migration write tests and acceptance beyond foundation.

## Fixtures

`fixtures/migration/sample-vault/` — synthetic notes for unit/migration tests.  
Do not require a live clone of production vault for CI.
