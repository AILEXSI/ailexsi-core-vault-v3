/**
 * Long-lived Desktop CoreRuntime host (Slice A).
 *
 * Process lifecycle:
 *   desktop startup → start() → createCoreRuntime() once
 *   Tauri/IPC commands → reuse same runtime
 *   desktop shutdown → stop() → runtime.close()
 *
 * Production path refuses InMemoryEventStore (createCoreRuntime requires Postgres URL).
 */

import { randomUUID } from "node:crypto";
import type { MemoryCell, MemoryVersion, UUID } from "@ailexsi/contracts";
import type { MemoryDetailView, MemoryListItem } from "@ailexsi/v2-read-models";
import {
  createCoreRuntime,
  type CoreRuntime,
  type CreateCoreRuntimeOptions,
} from "./core-runtime.js";
import type {
  V2CreateMemoryCommand,
  V2UpdateMemoryCommand,
  V2LifecycleCommand,
} from "./types.js";
import {
  CultivationService,
  MockLlmProvider,
  type LlmProvider,
} from "@ailexsi/v2-cultivation";
import {
  HarborService,
  type ContextAssemblyInput,
  type ContradictionResolution,
  type HarborActor,
  type HarborExportPackage,
} from "@ailexsi/v3-harbor";

export type DesktopMemoryCommand =
  | "memory.create"
  | "memory.get"
  | "memory.list"
  | "memory.update"
  | "memory.archive"
  | "memory.restore"
  | "memory.history"
  | "memory.retrieve"
  | "memory.context"
  | "continuity.export"
  | "continuity.inspect"
  | "continuity.rehydrate"
  | "cultivation.session.create"
  | "cultivation.session.get"
  | "cultivation.chat"
  | "cultivation.proposal.reject"
  | "cultivation.proposal.defer"
  | "cultivation.proposal.accept"
  | "harbor.snapshot"
  | "harbor.scan"
  | "harbor.context"
  | "harbor.reflect"
  | "harbor.contradiction.resolve"
  | "harbor.propose"
  | "harbor.proposal.decide"
  | "harbor.confirm"
  | "harbor.graph"
  | "harbor.export"
  | "harbor.import";

export interface DesktopHostStartOptions extends CreateCoreRuntimeOptions {
  /** Optional fixed connection string (tests). */
  connectionString?: string;
}

export class DesktopHost {
  private runtime: CoreRuntime | null = null;
  private startGeneration = 0;
  private commandCount = 0;
  private cultivation: CultivationService | null = null;
  private harbor: HarborService | null = null;
  private llm: LlmProvider = new MockLlmProvider(
    "Cultivation foundation mock proposal text"
  );

  /** True when a CoreRuntime is retained for process lifetime. */
  get isRunning(): boolean {
    return this.runtime !== null;
  }

  /** Monotonic start generation — used by tests to prove long-lived reuse. */
  get generation(): number {
    return this.startGeneration;
  }

  get commandsServed(): number {
    return this.commandCount;
  }

  /**
   * Start (or no-op if already running). Exactly one createCoreRuntime per process
   * unless stop() was called.
   */
  async start(options: DesktopHostStartOptions = {}): Promise<void> {
    if (this.runtime) {
      return;
    }
    this.runtime = await createCoreRuntime({
      ...options,
      producer: options.producer ?? "v2-desktop-host",
      environment: options.environment ?? "development",
    });
    // Long-lived cultivation service — same adapter as CoreRuntime (no per-command runtime)
    this.cultivation = new CultivationService(this.llm, this.runtime.adapter);
    this.harbor = new HarborService({
      corePin: "652d01eb06dd0841c3b475023883675af6dcd698",
      vaultReferenceSha: "061e444389090c54e431b0e8243e82764f2c198e",
    });
    this.startGeneration += 1;
  }

  /** Test-only: replace LLM before start (or after stop). */
  setLlmProvider(provider: LlmProvider): void {
    if (this.runtime) {
      throw new Error("setLlmProvider only when DesktopHost is stopped");
    }
    this.llm = provider;
  }

  async stop(): Promise<void> {
    if (!this.runtime) return;
    const rt = this.runtime;
    this.runtime = null;
    this.cultivation = null;
    this.harbor = null;
    await rt.close();
  }

  /**
   * Require running host. Explicit failure — no InMemory fallback.
   */
  requireRuntime(): CoreRuntime {
    if (!this.runtime) {
      throw new Error(
        "DesktopHost is not started. Call start() during desktop startup " +
          "before issuing memory.* commands. No silent InMemory fallback."
      );
    }
    // Hard guard: production desktop path must be PostgresEventStore
    if (this.runtime.store.constructor.name !== "PostgresEventStore") {
      throw new Error(
        `DesktopHost refuses non-Postgres EventStore: ${this.runtime.store.constructor.name}`
      );
    }
    return this.runtime;
  }

  /** Provenance helper for store constructor assertions in tests. */
  storeConstructorName(): string {
    return this.requireRuntime().store.constructor.name;
  }

  /** Object identity of runtime for long-lived checks. */
  runtimeIdentity(): object {
    return this.requireRuntime();
  }

  private async syncReadModel(memoryId: UUID): Promise<MemoryDetailView | null> {
    const rt = this.requireRuntime();
    const cell = await rt.adapter.get(memoryId);
    if (!cell) {
      return null;
    }
    const history = await rt.adapter.getHistory(memoryId);
    rt.readModel.upsertFromCore(cell, history);
    return rt.readModel.get(memoryId);
  }

  async memoryCreate(
    cmd: Omit<V2CreateMemoryCommand, "idempotencyKey"> & {
      idempotencyKey?: string;
    }
  ): Promise<MemoryDetailView> {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    const cell = await rt.adapter.create({
      ...cmd,
      idempotencyKey: cmd.idempotencyKey ?? randomUUID(),
      createdBy: cmd.createdBy ?? "v2-desktop",
    });
    const view = await this.syncReadModel(cell.identity.id);
    if (!view) {
      throw new Error("memory.create: read model missing after create");
    }
    return view;
  }

  async memoryGet(memoryId: UUID): Promise<MemoryDetailView | null> {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    return rt.queries.getMemory(memoryId);
  }

  async memoryUpdate(
    cmd: Omit<V2UpdateMemoryCommand, "idempotencyKey"> & {
      idempotencyKey?: string;
    }
  ): Promise<MemoryDetailView> {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    const cell = await rt.adapter.update({
      ...cmd,
      idempotencyKey: cmd.idempotencyKey ?? randomUUID(),
      createdBy: cmd.createdBy ?? "v2-desktop",
    });
    const view = await this.syncReadModel(cell.identity.id);
    if (!view) {
      throw new Error("memory.update: read model missing after update");
    }
    return view;
  }

  async memoryArchive(
    cmd: Omit<V2LifecycleCommand, "idempotencyKey"> & {
      idempotencyKey?: string;
    }
  ): Promise<MemoryDetailView> {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    const cell = await rt.adapter.archive({
      ...cmd,
      idempotencyKey: cmd.idempotencyKey ?? randomUUID(),
      createdBy: cmd.createdBy ?? "v2-desktop",
    });
    const view = await this.syncReadModel(cell.identity.id);
    if (!view) {
      throw new Error("memory.archive: read model missing after archive");
    }
    return view;
  }

  async memoryRestore(
    cmd: Omit<V2LifecycleCommand, "idempotencyKey"> & {
      idempotencyKey?: string;
    }
  ): Promise<MemoryDetailView> {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    const cell = await rt.adapter.restore({
      ...cmd,
      idempotencyKey: cmd.idempotencyKey ?? randomUUID(),
      createdBy: cmd.createdBy ?? "v2-desktop",
    });
    const view = await this.syncReadModel(cell.identity.id);
    if (!view) {
      throw new Error("memory.restore: read model missing after restore");
    }
    return view;
  }

  /**
   * Canonical history from Core MemoryDomain + EventStore event types.
   * UI must not invent versions.
   */
  async memoryHistory(memoryId: UUID): Promise<
    Array<{
      version: number;
      eventType: string;
      eventId: string;
      timestamp: string;
      changeReason?: string;
      content?: unknown;
      previousVersion?: number;
    }>
  > {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    return rt.queries.getMemoryHistory(memoryId);
  }

  async memoryList(options?: {
    includeArchived?: boolean;
    pageSize?: number;
    afterCursor?: string | null;
  }): Promise<MemoryListItem[] | import("@ailexsi/v2-read-models").ListMemoriesPage> {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    if (options?.pageSize != null) {
      return rt.queries.listMemories({
        includeArchived: options.includeArchived,
        pageSize: options.pageSize,
        afterCursor: options.afterCursor,
      });
    }
    return rt.queries.listAll({ includeArchived: options?.includeArchived });
  }

  /** Host/status probe for bridge health. */
  status(): {
    running: boolean;
    generation: number;
    commandsServed: number;
    store: string | null;
  } {
    return {
      running: this.isRunning,
      generation: this.startGeneration,
      commandsServed: this.commandCount,
      store: this.runtime ? this.runtime.store.constructor.name : null,
    };
  }


  private requireCultivation(): CultivationService {
    if (!this.cultivation) {
      throw new Error("Cultivation not available — DesktopHost not started");
    }
    return this.cultivation;
  }

  async cultivationSessionCreate() {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireCultivation().createSession();
  }

  async cultivationSessionGet(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    const sessionId = String(args.sessionId ?? "");
    const s = this.requireCultivation().getSession(sessionId);
    return s ?? null;
  }

  async cultivationChat(args: Record<string, unknown>) {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    const cult = this.requireCultivation();
    const sessionId = String(args.sessionId ?? "");
    const text = String(args.text ?? args.userText ?? "");
    const memoryIds = (args.memoryIds as string[] | undefined) ?? [];
    const targetMemoryId = args.targetMemoryId as string | undefined;

    // Resolve Core-backed context via existing query/adapter path (not a parallel SoT)
    const contextMemories = [];
    for (const id of memoryIds) {
      const cell = await rt.adapter.get(id as never);
      if (!cell) {
        throw new Error(`context memory not found in Core: ${id}`);
      }
      contextMemories.push(cell);
    }

    return cult.chat(sessionId, text, {
      contextMemories,
      targetMemoryId: targetMemoryId as never,
      source: "mock",
    });
  }

  async cultivationProposalReject(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireCultivation().setProposalStatus(
      String(args.sessionId ?? ""),
      String(args.proposalId ?? ""),
      "rejected"
    );
  }

  async cultivationProposalDefer(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireCultivation().setProposalStatus(
      String(args.sessionId ?? ""),
      String(args.proposalId ?? ""),
      "deferred"
    );
  }

  async cultivationProposalAccept(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireCultivation().acceptCanonical(
      String(args.sessionId ?? ""),
      String(args.proposalId ?? ""),
      {
        editedText: args.editedText as string | undefined,
        idempotencyKey: args.idempotencyKey as string | undefined,
      }
    );
  }

  async continuityExport(args: Record<string, unknown>) {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    const selection = args.selection as import("@ailexsi/v2-continuity").ContinuitySelection;
    if (!selection?.mode) throw new Error("continuity.export requires selection.mode");
    return rt.continuity.exportPackage({
      selection,
      generatedAt: args.generatedAt as string | undefined,
      includeInspection: args.includeInspection as boolean | undefined,
    });
  }

  async continuityInspect(args: Record<string, unknown>) {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    const pkg = args.package ?? args.pkg;
    if (pkg == null) throw new Error("continuity.inspect requires package");
    return rt.continuity.inspect(pkg as never);
  }

  async continuityRehydrate(args: Record<string, unknown>) {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    const pkg = args.package ?? args.pkg;
    if (pkg == null) throw new Error("continuity.rehydrate requires package");
    return rt.continuity.rehydrateVerify(pkg as never);
  }

  async memoryRetrieve(
    query: import("./memory-retrieval.js").RetrieveMemoriesQuery
  ) {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    return rt.queries.retrieveMemories(query);
  }

  async memoryContext(
    spec: import("./memory-retrieval.js").AssembleContextSpec
  ) {
    const rt = this.requireRuntime();
    this.commandCount += 1;
    return rt.queries.assembleContext(spec);
  }

  /**
   * EventStore raw stream for a memory — used by AAS-54 / history correspondence tests.
   */
  async eventStoreHistory(memoryId: UUID) {
    const rt = this.requireRuntime();
    return rt.store.getByAggregate(memoryId);
  }

  /** Total events in EventStore (read-only). */
  async eventCount(): Promise<number> {
    const rt = this.requireRuntime();
    return rt.queries.eventCount();
  }

  /** Query path rebuild (CLEAR → REBUILD ALL). */
  async rebuildFromCore(): Promise<void> {
    const rt = this.requireRuntime();
    await rt.queries.rebuildFromCore();
  }

  /**
   * CLEAR projections/read model then rebuild from EventStore (AAS-54).
   */
  async clearAndRebuildFromEventStore(): Promise<void> {
    const rt = this.requireRuntime();
    rt.adapter.clearProjection();
    rt.memoryProjection.clear();
    rt.readModel.clear();
    await rt.rebuildAll();
  }

  /**
   * Canonical cell snapshot for equality checks (not a second authority).
   */
  async getCanonicalCell(memoryId: UUID): Promise<MemoryCell | null> {
    return this.requireRuntime().adapter.get(memoryId);
  }

  private requireHarbor(): HarborService {
    if (!this.harbor) {
      throw new Error("Harbor not available — DesktopHost not started");
    }
    return this.harbor;
  }

  private actorOf(args: Record<string, unknown>): HarborActor {
    const kind = args.actorKind === "ai" || args.actorKind === "system" ? args.actorKind : "human";
    return {
      id: String(args.actorId ?? (kind === "human" ? "desktop-user" : "desktop-ai")),
      kind,
      authorizeCanonical: kind === "human",
    };
  }

  private async loadCells(): Promise<MemoryCell[]> {
    const rt = this.requireRuntime();
    const listed = await rt.queries.listAll({ includeArchived: true });
    const cells: MemoryCell[] = [];
    for (const item of listed) {
      const cell = await rt.adapter.get(item.id);
      if (cell) cells.push(cell);
    }
    return cells;
  }

  async harborSnapshot(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor().snapshot(this.actorOf(args));
  }

  async harborScan(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    const cells = await this.loadCells();
    return this.requireHarbor().scan(cells, this.actorOf(args));
  }

  async harborContext(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    const cells = await this.loadCells();
    const request = (args.request ?? args) as ContextAssemblyInput;
    return this.requireHarbor().assemble(
      cells,
      {
        query: request.query,
        currentTask: request.currentTask,
        selectedMemoryIds: request.selectedMemoryIds,
        projects: request.projects,
        tags: request.tags,
        maxItems: request.maxItems ?? 12,
        maxChars: request.maxChars ?? 8000,
      },
      this.actorOf(args)
    );
  }

  async harborReflect(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    const cells = await this.loadCells();
    return this.requireHarbor().reflect(cells, this.actorOf(args));
  }

  async harborResolveContradiction(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor().resolveContradiction(
      String(args.id ?? args.contradictionId ?? ""),
      args.resolution as ContradictionResolution,
      this.actorOf(args)
    );
  }

  async harborPropose(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor().propose(this.actorOf({ ...args, actorKind: args.actorKind ?? "ai" }), {
      text: String(args.text ?? ""),
      sourceMemoryIds: (args.sourceMemoryIds as string[]) ?? [],
      contextIds: (args.contextIds as string[]) ?? [],
    });
  }

  async harborDecideProposal(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor().decideProposal(
      String(args.proposalId ?? ""),
      args.status as "ACCEPTED" | "EDITED" | "REJECTED" | "DEFERRED" | "DISCUSSING" | "SUPERSEDED",
      this.actorOf(args),
      { resultingEventIds: args.resultingEventIds as string[] | undefined }
    );
  }

  async harborConfirm(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor().confirm(String(args.memoryId ?? ""), this.actorOf(args));
  }

  async harborGraph(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    const cells = await this.loadCells();
    return this.requireHarbor().graph(cells, this.actorOf(args));
  }

  async harborExport(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    const ids = (args.selectedCanonicalMemoryIds as string[]) ?? [];
    return this.requireHarbor().exportPackage(ids, this.actorOf(args));
  }

  async harborImport(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor().importPackage(args.package as HarborExportPackage, this.actorOf(args));
  }
}

/** Process-lifetime singleton used by Tauri/IPC bridge. */
let processHost: DesktopHost | null = null;

export function getDesktopHost(): DesktopHost {
  if (!processHost) {
    processHost = new DesktopHost();
  }
  return processHost;
}

/** Test-only: replace process host (does not close previous). */
export function resetDesktopHostForTests(): void {
  processHost = new DesktopHost();
}

/**
 * IPC dispatch — single entry matching Tauri command names.
 * Desktop UI and integration suite MUST use this boundary.
 */
export async function invokeDesktopCommand(
  command: DesktopMemoryCommand,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any> = {}
): Promise<unknown> {
  const host = getDesktopHost();
  switch (command) {
    case "memory.create":
      return host.memoryCreate(args as Parameters<DesktopHost["memoryCreate"]>[0]);
    case "memory.get":
      return host.memoryGet(args.memoryId as UUID);
    case "memory.list":
      return host.memoryList(
        args as {
          includeArchived?: boolean;
          pageSize?: number;
          afterCursor?: string | null;
        }
      );
    case "memory.update":
      return host.memoryUpdate(args as Parameters<DesktopHost["memoryUpdate"]>[0]);
    case "memory.archive":
      return host.memoryArchive(args as Parameters<DesktopHost["memoryArchive"]>[0]);
    case "memory.restore":
      return host.memoryRestore(args as Parameters<DesktopHost["memoryRestore"]>[0]);
    case "memory.history":
      return host.memoryHistory(args.memoryId as UUID);
    case "memory.retrieve":
      return host.memoryRetrieve(
        args as import("./memory-retrieval.js").RetrieveMemoriesQuery
      );
    case "memory.context":
      return host.memoryContext(
        args as import("./memory-retrieval.js").AssembleContextSpec
      );
    case "continuity.export":
      return host.continuityExport(args);
    case "continuity.inspect":
      return host.continuityInspect(args);
    case "continuity.rehydrate":
      return host.continuityRehydrate(args);
    case "cultivation.session.create":
      return host.cultivationSessionCreate();
    case "cultivation.session.get":
      return host.cultivationSessionGet(args);
    case "cultivation.chat":
      return host.cultivationChat(args);
    case "cultivation.proposal.reject":
      return host.cultivationProposalReject(args);
    case "cultivation.proposal.defer":
      return host.cultivationProposalDefer(args);
    case "cultivation.proposal.accept":
      return host.cultivationProposalAccept(args);
    case "harbor.snapshot":
      return host.harborSnapshot(args);
    case "harbor.scan":
      return host.harborScan(args);
    case "harbor.context":
      return host.harborContext(args);
    case "harbor.reflect":
      return host.harborReflect(args);
    case "harbor.contradiction.resolve":
      return host.harborResolveContradiction(args);
    case "harbor.propose":
      return host.harborPropose(args);
    case "harbor.proposal.decide":
      return host.harborDecideProposal(args);
    case "harbor.confirm":
      return host.harborConfirm(args);
    case "harbor.graph":
      return host.harborGraph(args);
    case "harbor.export":
      return host.harborExport(args);
    case "harbor.import":
      return host.harborImport(args);
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unknown desktop command: ${String(_exhaustive)}`);
    }
  }
}
