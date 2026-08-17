# Cultivation Foundation v1

## Baseline

`v2.3.0-continuity-green` (`141fe87…`)

## Purpose

```text
Core-backed context → Mock LLM → EPHEMERAL proposal → human accept/reject
  reject → zero EventStore writes
  accept → MemoryCommandAdapter.create|update only
```

Not a full chat product. Not Ollama-GREEN. Not a second SoT.

## Classification

| Object | Class |
|--------|--------|
| Session / messages | EPHEMERAL |
| Pending proposal | EPHEMERAL |
| Accepted memory | CORE-CANONICAL (via Core EventStore) |

## Context

Resolved via DesktopHost: `adapter.get(memoryId)` for each context id (Core path). Optional Continuity export/rehydrate supplies working-set ids only.
