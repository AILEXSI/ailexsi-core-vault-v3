/**
 * V2 Memory read model — DERIVED only.
 *
 * Core MemoryProjection / EventStore
 *        ↓
 * V2 MemoryReadModel (classified view)
 *        ↓
 * Query Service → Desktop UI
 *
 * Rebuildable: CLEAR → rebuildFromEvents/CoreProjection → IDENTICAL
 * Never a second source of truth.
 */

import type {
  MemoryCell,
  MemoryVersion,
  UUID,
  EventEnvelope,
} from "@ailexsi/contracts";
import { MemoryProjection } from "@ailexsi/projections";
import type { ClassifiedField, FactClass } from "./classification.js";
import { classify } from "./classification.js";

export interface MemoryListItem {
  id: UUID;
  shortId: string;
  title: string;
  lifecycleState: string;
  version: number;
  tags: string[];
  project?: string;
  updatedAt: string;
  classification: Record<string, FactClass>;
}

export interface MemoryDetailView {
  id: UUID;
  shortId: string;
  content: ClassifiedField<MemoryCell["content"]>;
  context: ClassifiedField<MemoryCell["context"]>;
  meaning: ClassifiedField<MemoryCell["meaning"] | undefined>;
  provenance: ClassifiedField<MemoryCell["provenance"]>;
  evidence: ClassifiedField<MemoryCell["evidence"]>;
  lifecycle: ClassifiedField<MemoryCell["lifecycle"]>;
  timestamps: ClassifiedField<MemoryCell["timestamps"]>;
  relationRefs: ClassifiedField<MemoryCell["relationRefs"]>;
  currentVersion: ClassifiedField<number>;
  displayTitle: ClassifiedField<string>;
  cognitiveState: ClassifiedField<MemoryCell["cognitiveState"]>;
}

/** Deterministic list query — foundation, not search. */
export interface ListMemoriesQuery {
  includeArchived?: boolean;
  /** 1..100 inclusive */
  pageSize: number;
  /**
   * Keyset cursor from previous page (`updatedAt\tid`).
   * Exclusive: returns items strictly after this sort key.
   */
  afterCursor?: string | null;
}

export interface ListMemoriesPage {
  items: MemoryListItem[];
  pageSize: number;
  nextCursor: string | null;
  /** Total matching (filter) before pagination — DERIVED count. */
  totalMatching: number;
}

export class MemoryQueryValidationError extends Error {
  readonly code = "VALIDATION" as const;
  constructor(message: string) {
    super(message);
    this.name = "MemoryQueryValidationError";
  }
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

/** Sort key: confirmedAt ASC, then id ASC — stable & deterministic. */
export function memorySortKey(item: {
  updatedAt: string;
  id: string;
}): string {
  return `${item.updatedAt}\t${item.id}`;
}

export function compareMemoryListItems(
  a: { updatedAt: string; id: string },
  b: { updatedAt: string; id: string }
): number {
  const t = a.updatedAt.localeCompare(b.updatedAt);
  if (t !== 0) return t;
  return a.id.localeCompare(b.id);
}

function toListItem(cell: MemoryCell): MemoryListItem {
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

export class MemoryReadModel {
  private cells = new Map<UUID, MemoryCell>();
  private histories = new Map<UUID, MemoryVersion[]>();
  private coreProjection = new MemoryProjection();

  upsertFromCore(cell: MemoryCell, history?: MemoryVersion[]): void {
    this.cells.set(cell.identity.id, cell);
    if (history) {
      this.histories.set(cell.identity.id, [...history]);
    }
  }

  rebuildFromCoreProjection(projection: MemoryProjection): void {
    this.cells.clear();
    this.histories.clear();
    for (const [id, cell] of projection.snapshot()) {
      this.cells.set(id, cell);
      this.histories.set(id, projection.getHistory(id));
    }
  }

  rebuildFromEvents(envelopes: EventEnvelope[]): void {
    this.coreProjection.rebuildFromEvents(envelopes);
    this.rebuildFromCoreProjection(this.coreProjection);
  }

  clear(): void {
    this.cells.clear();
    this.histories.clear();
    this.coreProjection.clear();
  }

  get(id: UUID): MemoryDetailView | null {
    const cell = this.cells.get(id);
    if (!cell) return null;
    return this.toDetail(cell);
  }

  /** Full list (no pagination) — deterministic order. */
  list(options?: { includeArchived?: boolean }): MemoryListItem[] {
    const includeArchived = options?.includeArchived ?? true;
    const items: MemoryListItem[] = [];
    for (const cell of this.cells.values()) {
      if (!includeArchived && cell.lifecycle.state === "archived") continue;
      items.push(toListItem(cell));
    }
    return items.sort(compareMemoryListItems);
  }

  /**
   * Deterministic keyset pagination.
   * Ordering: updatedAt ASC, id ASC.
   * Cursor: memorySortKey of last item on previous page.
   */
  listPage(query: ListMemoriesQuery): ListMemoriesPage {
    const pageSize = query.pageSize;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new MemoryQueryValidationError(
        `pageSize must be an integer 1..100 (got ${pageSize})`
      );
    }

    const all = this.list({ includeArchived: query.includeArchived });
    let start = 0;
    if (query.afterCursor) {
      const cursor = query.afterCursor;
      const idx = all.findIndex((item) => memorySortKey(item) === cursor);
      if (idx >= 0) {
        start = idx + 1;
      } else {
        // Cursor not found: advance past all keys <= cursor (gap-safe continue)
        start = all.findIndex((item) => memorySortKey(item) > cursor);
        if (start < 0) start = all.length;
      }
    }

    const slice = all.slice(start, start + pageSize);
    const last = slice[slice.length - 1];
    const nextCursor =
      slice.length === pageSize && last && start + pageSize < all.length
        ? memorySortKey(last)
        : slice.length === pageSize && start + pageSize === all.length
          ? null
          : last && start + slice.length < all.length
            ? memorySortKey(last)
            : null;

    // Fix nextCursor: non-null only if more remain
    const hasMore = start + slice.length < all.length;
    return {
      items: slice,
      pageSize,
      nextCursor: hasMore && last ? memorySortKey(last) : null,
      totalMatching: all.length,
    };
  }

  getHistory(id: UUID): MemoryVersion[] {
    return [...(this.histories.get(id) ?? [])];
  }

  snapshotCells(): Map<UUID, MemoryCell> {
    return new Map(this.cells);
  }

  size(): number {
    return this.cells.size;
  }

  private toDetail(cell: MemoryCell): MemoryDetailView {
    return {
      id: cell.identity.id,
      shortId: cell.identity.shortId,
      content: classify(cell.content, "CANONICAL", "core.MemoryCell.content"),
      context: classify(cell.context, "CANONICAL", "core.MemoryCell.context"),
      meaning: classify(cell.meaning, "CANONICAL", "core.MemoryCell.meaning"),
      provenance: classify(
        cell.provenance,
        "CANONICAL",
        "core.MemoryCell.provenance"
      ),
      evidence: classify(cell.evidence, "CANONICAL", "core.MemoryCell.evidence"),
      lifecycle: classify(
        cell.lifecycle,
        "CANONICAL",
        "core.MemoryCell.lifecycle"
      ),
      timestamps: classify(
        cell.timestamps,
        "CANONICAL",
        "core.MemoryCell.timestamps"
      ),
      relationRefs: classify(
        cell.relationRefs,
        "CANONICAL",
        "core.MemoryCell.relationRefs"
      ),
      currentVersion: classify(
        cell.currentVersion,
        "CANONICAL",
        "core.MemoryCell.currentVersion"
      ),
      displayTitle: classify(
        displayTitleFrom(cell),
        "DERIVED",
        "v2.MemoryReadModel.displayTitle"
      ),
      cognitiveState: classify(
        cell.cognitiveState,
        "CANONICAL",
        "core.MemoryCell.cognitiveState (zero placeholder; Physics PLANNED)"
      ),
    };
  }
}
