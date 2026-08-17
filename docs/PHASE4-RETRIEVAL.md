# Phase 4 — Deterministic Memory Retrieval + Context Assembly

## Baseline

Built on frozen:

```text
v2.1.0-desktop-memory-green
979537472b1f8c1b265659294377b275dc5d0019
```

Core pin: `652d01eb…` (READ ONLY). Phase 08 / embeddings / Ollama / Connectome: **out of scope**.

## Classification

| Artifact | Class |
|----------|--------|
| EventStore / Memory aggregates | CANONICAL |
| MemoryReadModel | DERIVED |
| Retrieval result pages | DERIVED |
| ContextBundle | DERIVED (non-canonical) |
| UI selection | EPHEMERAL |

**READING DOES NOT WRITE.**

## Pipeline

```text
QUERY
  → HARD FILTER
  → CANDIDATE SET
  → DETERMINISTIC ORDER (not filter scores)
  → PAGINATION
  → RESULT
```

Filter membership is **not** a rank score.

## Ordinary list vs retrieval

| API | Order | Cursor |
|-----|--------|--------|
| `MemoryQueryService.listMemories` (Phase 2) | `confirmedAt ASC`, `id ASC` | `updatedAt\tid` |
| `retrieveMemories` (Phase 4) | `confirmedAt DESC`, `id ASC` | opaque `r1:` + same payload |

Do **not** reuse Phase 2 cursors for retrieval pages.

## retrieveMemories(query)

### Input

```ts
{
  tagsAny?: string[];      // match if cell.context.tags intersects (any)
  project?: string;        // exact match on context.project
  lifecycle?: "active" | "archived";  // exact lifecycle.state
  includeArchived?: boolean; // default true; false ≡ lifecycle active only when lifecycle unset
  textContains?: string;   // case-normalized substring of text content or display title
  pageSize: number;        // 1..100
  afterCursor?: string | null; // opaque exclusive cursor
}
```

Only fields present on Core `MemoryCell` / V2 list projection are filterable. No invented attributes.

### Filter semantics

| Filter | Predicate |
|--------|-----------|
| `tagsAny` | **OR**: cell matches if **any** requested tag is in `context.tags` (exact string, no case fold) |
| `project` | exact string equality on `context.project` |
| `lifecycle` | exact `lifecycle.state` |
| `includeArchived` | when `lifecycle` unset: `false` excludes `archived` (default true) |
| `textContains` | case-normalized (`toLowerCase`) substring on display title + text body |
| empty `tagsAny` / empty `textContains` | no-op for that filter |


### Order (v1)

```text
confirmedAt DESC
id ASC
```

### Cursor

- Form: `r1:{confirmedAt}\t{id}` (prefix distinguishes from list cursors)
- Opaque to callers (do not parse except via API)
- Exclusive, deterministic, no wall-clock state

### Output

```ts
{
  items: MemoryListItem[];  // same DERIVED list DTO
  pageSize: number;
  nextCursor: string | null;
  totalMatching: number;    // after hard filter, before page
  order: "confirmedAt_DESC_id_ASC";
  class: "DERIVED";
}
```

## assembleContext(spec)

### Input

```ts
{
  memoryIds?: UUID[];           // explicit order if provided
  retrieve?: RetrieveQuery;     // if memoryIds omitted, run retrieve (pageSize = maxItems)
  maxItems: number;             // >= 1
  maxChars: number;             // serialized budget; >= 1
  includeHistory?: boolean;     // default false
  maxHistoryEvents?: number;    // default 0; if includeHistory, cap per memory (0..20)
}
```

### Pipeline

```text
ids (explicit or retrieve page)
  → ordered MemoryDetailView[]
  → optional history (getMemoryHistory, truncated)
  → enforce maxItems then maxChars (deterministic)
  → ContextBundle
```

### Truncation

1. Drop trailing memories until `items.length <= maxItems`.
2. Serialize each item deterministically (fixed field order JSON).
3. Accumulate until adding next item would exceed `maxChars`; stop.
4. If **first** remaining item alone exceeds `maxChars`: include it with `content` replaced by truncated text (text type only) or omit body fields to fit prefix metadata — deterministic: keep `id`, `shortId`, `lifecycle`, set `truncated: true`, `contentPreview` = first `maxChars - overhead` chars of text if any.

### Output

```ts
{
  class: "DERIVED";
  order: string;
  items: ContextItem[];
  truncated: boolean;
  charCount: number;
}
```

No new UUIDs. Memory ids are Core ids only.

## Placement

Implemented in `@ailexsi/v2-command-adapter` as:

- `memory-retrieval.ts` (pure filter/order/page + context helpers)
- methods on `MemoryQueryService`
- optional Desktop: `memory.retrieve`, `memory.context`

No separate `packages/retrieval` (single dependency boundary with query path).

## Desktop

Uses long-lived `DesktopHost` / `CoreRuntime` / `PostgresEventStore` only.
