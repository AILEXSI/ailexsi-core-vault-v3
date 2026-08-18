/**
 * V2 Memory Query Service — READ PATH only.
 *
 * PostgresEventStore / Core Projection
 *   → MemoryDomain projection (via adapter)
 *   → V2 MemoryReadModel (DERIVED)
 *   → Query results
 *
 * NEVER mutates canonical state.
 * NEVER appends events.
 * NEVER writes filesystem.
 */

import type { UUID } from "@ailexsi/contracts";
import type { MemoryCommandAdapter } from "./memory-command-adapter.js";
import type { EventStoreRead } from "./event-store-read.js";
import type {
  MemoryDetailView,
  MemoryListItem,
  ListMemoriesQuery,
  ListMemoriesPage,
  MemoryReadModel,
} from "@ailexsi/v2-read-models";
import {
  filterAndOrderCells,
  paginateRetrieve,
  assembleContextFromViews,
  type RetrieveMemoriesQuery,
  type RetrieveMemoriesPage,
  type AssembleContextSpec,
  type ContextBundle,
  RETRIEVE_ORDER,
} from "./memory-retrieval.js";

export type MemoryHistoryEntry = {
  version: number;
  eventType: string;
  eventId: string;
  timestamp: string;
  changeReason?: string;
  previousVersion?: number;
  content?: unknown;
};

export interface MemoryQueryServiceDeps {
  store: EventStoreRead;
  adapter: MemoryCommandAdapter;
  readModel: MemoryReadModel;
  /**
   * Full rebuild of domain + projection engine + V2 read model from EventStore.
   * Provided by CoreRuntime.rebuildAll — not invented here.
   */
  rebuildAll: () => Promise<void>;
}

/**
 * Query surface. All methods are side-effect free w.r.t. EventStore append.
 */
export class MemoryQueryService {
  constructor(private readonly deps: MemoryQueryServiceDeps) {}

  /**
   * getMemory — hydrate read model from Core domain if cold.
   * Does not append events.
   */
  async getMemory(memoryId: UUID): Promise<MemoryDetailView | null> {
    const existing = this.deps.readModel.get(memoryId);
    if (existing) return existing;

    // Cold path: load from Core domain projection (may need stream apply)
    let cell = await this.deps.adapter.get(memoryId);
    if (!cell) {
      // Domain cold: apply aggregate stream into domain, then read
      const stream = await this.deps.store.getByAggregate(memoryId);
      if (stream.length === 0) return null;
      this.deps.adapter.rebuildFromEvents(stream);
      cell = await this.deps.adapter.get(memoryId);
      if (!cell) return null;
    }
    const history = await this.deps.adapter.getHistory(memoryId);
    this.deps.readModel.upsertFromCore(cell, history);
    return this.deps.readModel.get(memoryId);
  }

  /**
   * listMemories — deterministic page from V2 read model.
   * Ensures read model is populated via rebuildAll when empty but store has events.
   */
  async listMemories(
    query: ListMemoriesQuery
  ): Promise<ListMemoriesPage> {
    await this.ensureHydrated();
    return this.deps.readModel.listPage(query);
  }

  /** Convenience full list (deterministic). */
  async listAll(options?: {
    includeArchived?: boolean;
  }): Promise<MemoryListItem[]> {
    await this.ensureHydrated();
    return this.deps.readModel.list(options);
  }

  /**
   * getMemoryHistory — Core EventStore stream order + domain version metadata.
   */
  async getMemoryHistory(memoryId: UUID): Promise<MemoryHistoryEntry[]> {
    const stream = await this.deps.store.getByAggregate(memoryId);
    if (stream.length === 0) return [];

    // Align domain history
    let history = await this.deps.adapter.getHistory(memoryId);
    if (history.length === 0) {
      this.deps.adapter.rebuildFromEvents(stream);
      history = await this.deps.adapter.getHistory(memoryId);
    }
    const byVersion = new Map(history.map((h) => [h.version, h]));

    return stream.map((env) => {
      const ver = byVersion.get(env.event.aggregateVersion);
      return {
        version: env.event.aggregateVersion,
        eventType: env.event.eventType,
        eventId: env.event.eventId,
        timestamp: env.event.timestamp,
        changeReason: ver?.changeReason,
        previousVersion: ver?.previousVersion,
        content: ver?.content,
      };
    });
  }

  /**
   * CLEAR → REBUILD from EventStore (complete).
   * Query-side rebuild entry — delegates to runtime rebuildAll.
   */
  async rebuildFromCore(): Promise<void> {
    this.deps.adapter.clearProjection();
    this.deps.readModel.clear();
    await this.deps.rebuildAll();
  }

  /** Read-only probe: current EventStore event count (no append). */
  async eventCount(): Promise<number> {
    const page = await this.deps.store.getStream({
      afterSequence: 0,
      limit: 100_000,
    });
    return page.length;
  }

  /**
   * Phase 4 retrieve — HARD FILTER → ORDER (confirmedAt DESC, id ASC) → PAGE.
   * Does not append events. Does not use Phase 2 list cursors.
   */
  async retrieveMemories(
    query: RetrieveMemoriesQuery
  ): Promise<RetrieveMemoriesPage> {
    await this.ensureHydrated();
    const cells = this.deps.readModel.snapshotCells().values();
    const ordered = filterAndOrderCells(cells, query);
    return paginateRetrieve(ordered, query.pageSize, query.afterCursor);
  }

  /**
   * Phase 4 context assembly — DERIVED, read-only, budgeted.
   */
  async assembleContext(spec: AssembleContextSpec): Promise<ContextBundle> {
    await this.ensureHydrated();
    let ids: string[] = [];
    let orderLabel = "explicit_ids";

    if (spec.memoryIds && spec.memoryIds.length > 0) {
      ids = [...spec.memoryIds];
    } else if (spec.retrieve) {
      const pageSize = spec.retrieve.pageSize ?? spec.maxItems;
      const page = await this.retrieveMemories({
        ...spec.retrieve,
        pageSize,
      });
      ids = page.items.map((i) => i.id);
      orderLabel = RETRIEVE_ORDER;
    } else {
      ids = [];
    }

    const views: MemoryDetailView[] = [];
    const histories = new Map<
      string,
      Awaited<ReturnType<MemoryQueryService["getMemoryHistory"]>>
    >();

    for (const id of ids) {
      const view = await this.getMemory(id);
      if (!view) continue;
      views.push(view);
      if (spec.includeHistory) {
        histories.set(id, await this.getMemoryHistory(id));
      }
    }

    return assembleContextFromViews(views, histories, {
      maxItems: spec.maxItems,
      maxChars: spec.maxChars,
      includeHistory: spec.includeHistory,
      maxHistoryEvents: spec.maxHistoryEvents,
      orderLabel,
    });
  }

  private async ensureHydrated(): Promise<void> {
    if (this.deps.readModel.size() > 0) return;
    const n = await this.eventCount();
    if (n === 0) return;
    await this.deps.rebuildAll();
  }
}
