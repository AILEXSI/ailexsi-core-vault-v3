# Frozen baselines

| Role | Repository | SHA | Status |
|------|------------|-----|--------|
| **CORE** (Cortex) | `AILEXSI/ailexsi-core` | `652d01eb06dd0841c3b475023883675af6dcd698` | Phase 07 Projection COMPLETE / GREEN |
| **VAULT** (legacy reference) | `AILEXSI/ailexsi-core-vault` | `061e444389090c54e431b0e8243e82764f2c198e` | Tauri + Markdown FS + Ollama (READ ONLY) |
| **V2** (historical source baseline) | `AILEXSI/ailexsi-core-vault-v2` | `d684aa4a3c292c1d1f1587a68371589437b68055` | READ ONLY |
| **V3** (work target) | `AILEXSI/ailexsi-core-vault-v3` | see `git rev-parse HEAD` / `origin/main` | Active |

Machine-readable copy: [`config/baselines.json`](../config/baselines.json)

## Rules

```text
CORE = READ ONLY
CURRENT VAULT = READ ONLY
V2 = HISTORICAL SOURCE BASELINE (READ ONLY)
V3 = ONLY WRITE TARGET
```

- Do not start Core Phase 08 (Physics) in this repository.
- Do not invent new Core domains.
- Do not dual-write canonical facts to filesystem + EventStore.

Setup:

```bash
npm run setup:core
```

This clones Core and Vault reference into `.deps/` (gitignored) at the pinned SHAs.
