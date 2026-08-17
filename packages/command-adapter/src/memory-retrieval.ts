/**
 * Phase 4 — deterministic retrieval + context assembly (DERIVED, read-only).
 *
 * Pipeline: QUERY → HARD FILTER → ORDER → PAGINATE → RESULT
 * Order v1: confirmedAt DESC, id ASC
 * Filter membership is never a score.
 */

import type { MemoryCell, UUID } from "@ailexsi/contracts";
import type {
  MemoryListItem,
  MemoryDetailView,
} from "@ailexsi/v2-read-models";
import {
  MemoryQueryValidationError,
} from "@ailexsi/v2-read-models";

/** Shared history row (Core stream order) — same shape as query service. */
export type MemoryHistoryEntry = {
  version: number;
  eventType: string;
  eventId: string;
  timestamp: string;
  changeReason?: string;
  previousVersion?: number;
  content?: unknown;
};

export const RETRIEVE_ORDER = "confirmedAt_DESC_id_ASC" as const;
const CURSOR_PREFIX = "r1:";

export type RetrieveMemoriesQuery = {
  tagsAny?: string[];
  project?: string;
  lifecycle?: "active" | "archived";
  /** When lifecycle unset: false excludes archived. Default true. */
  includeArchived?: boolean;
  textContains?: string;
  pageSize: number;
  afterCursor?: string | null;
};

export type RetrieveMemoriesPage = {
  items: MemoryListItem[];
  pageSize: number;
  nextCursor: string | null;
  totalMatching: number;
  order: typeof RETRIEVE_ORDER;
  class: "DERIVED";
};

export type AssembleContextSpec = {
  memoryIds?: UUID[];
  retrieve?: Omit<RetrieveMemoriesQuery, "pageSize" | "afterCursor"> & {
    pageSize?: number;
  };
  maxItems: number;
  maxChars: number;
  includeHistory?: boolean;
  maxHistoryEvents?: number;
};

export type ContextItem = {
  id: UUID;
  shortId: string;
  lifecycleState: string;
  version: number;
  project?: string;
  tags: string[];
  title: string;
  content: unknown;
  truncated: boolean;
  contentPreview?: string;
  history?: MemoryHistoryEntry[];
};

export type ContextBundle = {
  class: "DERIVED";
  order: string;
  items: ContextItem[];
  truncated: boolean;
  charCount: number;
};

export function retrieveSortKey(item: {
  updatedAt: string;
  id: string;
}): string {
  return `${item.updatedAt}\t${item.id}`;
}

export function encodeRetrieveCursor(item: {
  updatedAt: string;
  id: string;
}): string {
  return CURSOR_PREFIX + retrieveSortKey(item);
}

export function decodeRetrieveCursor(
  cursor: string
): { updatedAt: string; id: string } {
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new MemoryQueryValidationError(
      `Invalid retrieval cursor (expected ${CURSOR_PREFIX}… prefix)`
    );
  }
  const raw = cursor.slice(CURSOR_PREFIX.length);
  const tab = raw.indexOf("\t");
  if (tab <= 0 || tab === raw.length - 1) {
    throw new MemoryQueryValidationError("Invalid retrieval cursor payload");
  }
  return { updatedAt: raw.slice(0, tab), id: raw.slice(tab + 1) };
}

/** Order: confirmedAt DESC, id ASC */
export function compareRetrieveOrder(
  a: { updatedAt: string; id: string },
  b: { updatedAt: string; id: string }
): number {
  const t = b.updatedAt.localeCompare(a.updatedAt);
  if (t !== 0) return t;
  return a.id.localeCompare(b.id);
}

function displayTitleFrom(cell: MemoryCell): string {
  if (cell.meaning?.summary) return cell.meaning.summary;
  if (cell.content.type === "text") {
    const t = cell.content.text.trim();
    return t.length > 80 ? `${t.slice(0, 77)}...` : t;
  }
  if (cell.content.type === "structured") return "structured memory";
  return cell.content.storageRef;
}

export function cellToListItem(cell: MemoryCell): MemoryListItem {
  return {
    id: cell.identity.id,
    shortId: cell.identity.shortId,
    title: displayTitleFrom(cell),
    lifecycleState: cell.lifecycle.state,
    version: cell.currentVersion,
    tags: cell.context.tags ?? [],
    project: cell.context.project,
    updatedAt: cell.timestamps.confirmedAt,
    classification: {
      id: "CANONICAL",
      lifecycleState: "CANONICAL",
      version: "CANONICAL",
      title: "DERIVED",
      tags: "CANONICAL",
    },
  };
}

export function matchesHardFilter(
  cell: MemoryCell,
  q: RetrieveMemoriesQuery
): boolean {
  const lifecycle = cell.lifecycle.state;
  if (q.lifecycle) {
    if (lifecycle !== q.lifecycle) return false;
  } else if (q.includeArchived === false && lifecycle === "archived") {
    return false;
  }

  if (q.project !== undefined) {
    if ((cell.context.project ?? "") !== q.project) return false;
  }

  if (q.tagsAny && q.tagsAny.length > 0) {
    const tags = new Set(cell.context.tags ?? []);
    if (!q.tagsAny.some((t) => tags.has(t))) return false;
  }

  if (q.textContains !== undefined && q.textContains.length > 0) {
    // Deterministic case-normalized substring (Unicode default lowercasing)
    const needle = q.textContains.toLowerCase();
    const title = displayTitleFrom(cell).toLowerCase();
    let body = "";
    if (cell.content.type === "text") body = cell.content.text;
    else if (cell.content.type === "structured")
      body = JSON.stringify(cell.content);
    else body = cell.content.storageRef;
    body = body.toLowerCase();
    if (!title.includes(needle) && !body.includes(needle)) return false;
  }

  return true;
}

export function filterAndOrderCells(
  cells: Iterable<MemoryCell>,
  q: RetrieveMemoriesQuery
): MemoryListItem[] {
  const items: MemoryListItem[] = [];
  for (const cell of cells) {
    if (matchesHardFilter(cell, q)) items.push(cellToListItem(cell));
  }
  items.sort(compareRetrieveOrder);
  return items;
}

export function paginateRetrieve(
  ordered: MemoryListItem[],
  pageSize: number,
  afterCursor?: string | null
): RetrieveMemoriesPage {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new MemoryQueryValidationError(
      `pageSize must be an integer 1..100 (got ${pageSize})`
    );
  }

  let start = 0;
  if (afterCursor) {
    const cur = decodeRetrieveCursor(afterCursor);
    const idx = ordered.findIndex(
      (item) => item.updatedAt === cur.updatedAt && item.id === cur.id
    );
    if (idx >= 0) {
      start = idx + 1;
    } else {
      // gap-safe: first item strictly after cursor in retrieve order
      start = ordered.findIndex((item) => compareRetrieveOrder(item, cur) > 0);
      if (start < 0) start = ordered.length;
    }
  }

  const slice = ordered.slice(start, start + pageSize);
  const hasMore = start + slice.length < ordered.length;
  const last = slice[slice.length - 1];
  return {
    items: slice,
    pageSize,
    nextCursor: hasMore && last ? encodeRetrieveCursor(last) : null,
    totalMatching: ordered.length,
    order: RETRIEVE_ORDER,
    class: "DERIVED",
  };
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(value);
}

export function assembleContextFromViews(
  views: MemoryDetailView[],
  histories: Map<UUID, MemoryHistoryEntry[]>,
  spec: {
    maxItems: number;
    maxChars: number;
    includeHistory?: boolean;
    maxHistoryEvents?: number;
    orderLabel: string;
  }
): ContextBundle {
  if (!Number.isInteger(spec.maxItems) || spec.maxItems < 1) {
    throw new MemoryQueryValidationError("maxItems must be integer >= 1");
  }
  if (!Number.isInteger(spec.maxChars) || spec.maxChars < 1) {
    throw new MemoryQueryValidationError("maxChars must be integer >= 1");
  }

  const maxHist = spec.maxHistoryEvents ?? 0;
  if (maxHist < 0 || maxHist > 20) {
    throw new MemoryQueryValidationError("maxHistoryEvents must be 0..20");
  }

  const limited = views.slice(0, spec.maxItems);
  const built: ContextItem[] = [];
  let truncated = views.length > spec.maxItems;
  let charCount = 0;

  for (const v of limited) {
    const hist =
      spec.includeHistory && maxHist > 0
        ? (histories.get(v.id) ?? []).slice(0, maxHist)
        : undefined;

    let item: ContextItem = {
      id: v.id,
      shortId: v.shortId,
      lifecycleState: v.lifecycle.value.state,
      version: v.currentVersion.value,
      project: v.context.value.project,
      tags: v.context.value.tags ?? [],
      title: v.displayTitle.value,
      content: v.content.value,
      truncated: false,
      history: hist,
    };

    let serialized = stableSerialize(item);
    if (charCount + serialized.length <= spec.maxChars) {
      built.push(item);
      charCount += serialized.length;
      continue;
    }

    // Does not fit fully
    truncated = true;
    if (built.length === 0) {
      // First item alone exceeds budget — deterministic shrink of preview
      const previewSource =
        v.content.value &&
        typeof v.content.value === "object" &&
        "type" in v.content.value &&
        (v.content.value as { type: string }).type === "text"
          ? String((v.content.value as { text: string }).text)
          : v.displayTitle.value;

      // Minimal shell first (may still exceed tiny budgets)
      let shell: ContextItem = {
        id: v.id,
        shortId: v.shortId,
        lifecycleState: v.lifecycle.value.state,
        version: v.currentVersion.value,
        tags: [],
        title: "",
        content: null,
        truncated: true,
        contentPreview: "",
      };
      if (stableSerialize(shell).length > spec.maxChars) {
        // Cannot fit even minimal shell — empty bundle under budget
        return {
          class: "DERIVED",
          order: spec.orderLabel,
          items: [],
          truncated: true,
          charCount: 0,
        };
      }
      // Grow optional fields deterministically if room
      const withTitle: ContextItem = {
        ...shell,
        title: v.displayTitle.value,
      };
      if (stableSerialize(withTitle).length <= spec.maxChars) shell = withTitle;

      let lo = 0;
      let hi = previewSource.length;
      let best = shell;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate: ContextItem = {
          ...shell,
          contentPreview: previewSource.slice(0, mid),
        };
        const len = stableSerialize(candidate).length;
        if (len <= spec.maxChars) {
          best = candidate;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      built.push(best);
      charCount = stableSerialize(best).length;
    }
    break;
  }

  return {
    class: "DERIVED",
    order: spec.orderLabel,
    items: built,
    truncated,
    charCount,
  };
}
