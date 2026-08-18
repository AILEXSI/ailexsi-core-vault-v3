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
  AgencyDeniedError,
  HarborService,
  sealActor,
  type AuthorizedMutationContext,
  type ContextAssemblyInput,
  type ContradictionResolution,
  type EpistemicStatus,
  type HarborActor,
  type HarborExportPackage,
} from "@ailexsi/v3-harbor";
import { bindAgencySessionActor } from "../../harbor/src/session-bind.js";

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
  | "harbor.import"
  | "harbor.import.validate"
  | "harbor.import.preview"
  | "harbor.import.conflicts"
  | "harbor.import.confirm"
  | "harbor.import.reject"
  | "harbor.rebuild"
  | "harbor.query.memory"
  | "harbor.query.list"
  | "harbor.query.source"
  | "harbor.query.status"
  | "harbor.query.contradictions"
  | "harbor.query.provenance"
  | "harbor.connectome"
  | "harbor.connectome.propose"
  | "harbor.connectome.decide"
  | "harbor.connectome.traverse"
  | "harbor.connectome.explain";

export interface DesktopHostStartOptions extends CreateCoreRuntimeOptions {
  /** Optional fixed connection string (tests). */
  connectionString?: string;
  /**
   * Non-canonical Harbor derived-index directory.
   * Defaults to HARBOR_DERIVED_INDEX_PATH when set. Never EventStore.
   */
  harborPersistDir?: string;
  /** Session Actor for this host process. Not taken from request JSON. */
  actor?: HarborActor;
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
  private sessionActor: HarborActor | null = null;

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
    const persistDir = options.harborPersistDir ?? process.env.HARBOR_DERIVED_INDEX_PATH;
    this.harbor = HarborService.open({
      corePin: "652d01eb06dd0841c3b475023883675af6dcd698",
      vaultReferenceSha: "061e444389090c54e431b0e8243e82764f2c198e",
      persistDir: persistDir || undefined,
    });
    if (options.actor && !this.sessionActor) {
      this.sessionActor = sealActor(options.actor);
    }
    if (this.sessionActor) {
      bindAgencySessionActor(this.harbor.agency, this.sessionActor);
    }
    this.startGeneration += 1;
  }

  /** Bind the Session Actor once. Request actorKind/actorId are never the actor. */
  attachActor(actor: HarborActor): void {
    if (this.sessionActor) {
      throw new AgencyDeniedError(
        this.sessionActor,
        "CANONICAL_COMMIT",
        "Session Actor already attached",
        { code: "PERMISSION_ESCALATION_BLOCKED", action: "session" }
      );
    }
    this.sessionActor = sealActor(actor);
    if (this.harbor) {
      bindAgencySessionActor(this.harbor.agency, this.sessionActor);
    }
  }

  /** Session Actor for this host. Null when none is attached. */
  getSessionActor(): HarborActor | null {
    return this.sessionActor;
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
    this.sessionActor = null;
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
    const actor = this.requireSessionActor();
    if (actor.kind !== "human") {
      throw new AgencyDeniedError(actor, "CANONICAL_COMMIT", "AI session cannot issueAuthorization", {
        code: "HUMAN_AUTHORIZATION_REQUIRED",
        action: "memory.create",
      });
    }
    const rt = this.requireRuntime();
    this.commandCount += 1;
    const key = cmd.idempotencyKey ?? randomUUID();
    const cell = await this.commitThroughAgency(actor, "memory.create", key, async (ctx) => {
      const created = await rt.adapter.create({
        ...cmd,
        idempotencyKey: key,
        createdBy: actor.id,
      }, ctx);
      const stream = await rt.store.getByAggregate(created.identity.id);
      return { result: created, eventIds: stream.map((e) => e.event.eventId) };
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
    const actor = this.requireSessionActor();
    const key = cmd.idempotencyKey ?? randomUUID();
    const cell = await this.commitThroughAgency(actor, "memory.update", String(cmd.memoryId), async (ctx) => {
      const updated = await rt.adapter.update({
        ...cmd,
        idempotencyKey: key,
        createdBy: actor.id,
      }, ctx);
      const stream = await rt.store.getByAggregate(updated.identity.id);
      return { result: updated, eventIds: stream.map((e) => e.event.eventId) };
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
    const actor = this.requireSessionActor();
    const key = cmd.idempotencyKey ?? randomUUID();
    const cell = await this.commitThroughAgency(actor, "memory.archive", String(cmd.memoryId), async (ctx) => {
      const archived = await rt.adapter.archive({
        ...cmd,
        idempotencyKey: key,
        createdBy: actor.id,
      }, ctx);
      const stream = await rt.store.getByAggregate(archived.identity.id);
      return { result: archived, eventIds: stream.map((e) => e.event.eventId) };
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
    const actor = this.requireSessionActor();
    const key = cmd.idempotencyKey ?? randomUUID();
    const cell = await this.commitThroughAgency(actor, "memory.restore", String(cmd.memoryId), async (ctx) => {
      const restored = await rt.adapter.restore({
        ...cmd,
        idempotencyKey: key,
        createdBy: actor.id,
      }, ctx);
      const stream = await rt.store.getByAggregate(restored.identity.id);
      return { result: restored, eventIds: stream.map((e) => e.event.eventId) };
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
    const actor = this.requireSessionActor();
    if (actor.kind !== "human") {
      throw new AgencyDeniedError(
        actor,
        "CANONICAL_COMMIT",
        "AI session cannot ACCEPT",
        { code: "HUMAN_AUTHORIZATION_REQUIRED", action: "cultivation.proposal.accept" }
      );
    }
    const rt = this.requireRuntime();
    this.commandCount += 1;
    const proposalId = String(args.proposalId ?? "");
    return this.commitThroughAgency(actor, "cultivation.accept", proposalId, async (ctx) => {
      const { proposal, draft } = this.requireCultivation().acceptCanonical(
        String(args.sessionId ?? ""),
        proposalId,
        {
          editedText: args.editedText as string | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined,
          createdBy: actor.id,
        }
      );
      const cell =
        draft.kind === "update_memory"
          ? await rt.adapter.update({
              memoryId: draft.memoryId!,
              content: draft.content,
              changeReason: draft.changeReason,
              provenance: draft.provenance,
              idempotencyKey: draft.idempotencyKey,
              createdBy: actor.id,
            }, ctx)
          : await rt.adapter.create({
              content: draft.content,
              provenance: draft.provenance,
              idempotencyKey: draft.idempotencyKey,
              createdBy: actor.id,
            }, ctx);
      proposal.acceptedMemoryId = cell.identity.id;
      const stream = await rt.store.getByAggregate(cell.identity.id);
      return { result: { proposal, cell }, eventIds: stream.map((e) => e.event.eventId) };
    });
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

  private requireSessionActor(): HarborActor {
    if (!this.sessionActor) {
      throw new AgencyDeniedError(
        { id: "unauthenticated", kind: "system" },
        "CANONICAL_COMMIT",
        "No session actor — mutate fails closed",
        { code: "HUMAN_AUTHORIZATION_REQUIRED", action: "session" }
      );
    }
    return this.sessionActor;
  }

  /**
   * Session Actor only. Request actorKind/actorId are ignored for auth.
   * Channel Token is not an actor.
   */
  private actorOf(_args: Record<string, unknown>): HarborActor {
    return this.requireSessionActor();
  }

  private async commitThroughAgency<T>(
    actor: HarborActor,
    action: string,
    target: string,
    execute: (ctx: AuthorizedMutationContext) => Promise<{ result: T; eventIds: string[] }>
  ): Promise<T> {
    const harbor = this.requireHarbor();
    const grant = harbor.agency.issueAuthorization(actor, {
      grantedTo: { id: actor.id, kind: actor.kind },
      capability: "CANONICAL_COMMIT",
      action,
      target,
    });
    const { result } = await harbor.commitCanonical({
      actor,
      grant,
      action,
      target,
      execute,
    });
    return result;
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

  async harborConnectome(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    const cells = await this.loadCells();
    return this.requireHarbor().connectome(cells, this.actorOf(args));
  }

  async harborConnectomePropose(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor().proposeRelation(this.actorOf({ ...args, actorKind: args.actorKind ?? "ai" }), {
      from: String(args.from ?? ""),
      to: String(args.to ?? ""),
      type: args.type as "RELATES_TO",
      reason: String(args.reason ?? ""),
      evidenceMemoryIds: (args.evidenceMemoryIds as string[]) ?? [],
    });
  }

  async harborConnectomeDecide(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor().decideRelation(
      String(args.proposalId ?? ""),
      args.status as "ACCEPTED" | "EDITED" | "REJECTED" | "DEFERRED",
      this.actorOf(args)
    );
  }

  async harborConnectomeTraverse(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    const cells = await this.loadCells();
    return this.requireHarbor().traverseConnectome(
      cells,
      String(args.from ?? ""),
      String(args.to ?? ""),
      this.actorOf(args),
      typeof args.maxDepth === "number" ? args.maxDepth : 6
    );
  }

  async harborConnectomeExplain(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    const cells = await this.loadCells();
    return this.requireHarbor().explainConnectomeRelation(
      cells,
      String(args.relationId ?? ""),
      this.actorOf(args)
    );
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
    return this.requireHarbor().beginImport(args.package as HarborExportPackage, this.actorOf(args));
  }

  async harborImportValidate(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor().validateImport(String(args.sessionId ?? ""), this.actorOf(args));
  }

  async harborImportPreview(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor().previewImport(String(args.sessionId ?? ""), this.actorOf(args));
  }

  async harborImportConflicts(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    const cells = await this.loadCells();
    return this.requireHarbor().detectImportConflicts(
      String(args.sessionId ?? ""),
      cells.map((c) => ({
        id: c.identity.id,
        text: c.content.type === "text" ? c.content.text : JSON.stringify(c.content),
        updatedAt: c.timestamps.confirmedAt,
      })),
      this.actorOf(args)
    );
  }

  async harborImportConfirm(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor().confirmImport(String(args.sessionId ?? ""), this.actorOf(args));
  }

  async harborImportReject(args: Record<string, unknown>) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor().rejectImport(String(args.sessionId ?? ""), this.actorOf(args));
  }

  async harborRebuild(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    const cells = await this.loadCells();
    return this.requireHarbor().rebuildFromCanonical(cells, this.actorOf(args));
  }

  async harborQueryMemory(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor()
      .queries(this.actorOf(args))
      .getDerivedMemory(String(args.id ?? args.memoryId ?? ""));
  }

  async harborQueryList(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor()
      .queries(this.actorOf(args))
      .listDerivedMemories({
        offset: typeof args.offset === "number" ? args.offset : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
  }

  async harborQuerySource(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor()
      .queries(this.actorOf(args))
      .findDerivedBySource(String(args.memoryId ?? args.id ?? ""), {
        offset: typeof args.offset === "number" ? args.offset : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
  }

  async harborQueryStatus(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor()
      .queries(this.actorOf(args))
      .findDerivedByStatus(args.status as EpistemicStatus, {
        offset: typeof args.offset === "number" ? args.offset : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
  }

  async harborQueryContradictions(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor()
      .queries(this.actorOf(args))
      .findContradictions({
        resolution: args.resolution as ContradictionResolution | undefined,
        sourceMemoryId: typeof args.sourceMemoryId === "string" ? args.sourceMemoryId : undefined,
        offset: typeof args.offset === "number" ? args.offset : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
  }

  async harborQueryProvenance(args: Record<string, unknown> = {}) {
    this.requireRuntime();
    this.commandCount += 1;
    return this.requireHarbor()
      .queries(this.actorOf(args))
      .getDerivedProvenance(String(args.id ?? args.memoryId ?? ""));
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
    case "harbor.connectome":
      return host.harborConnectome(args);
    case "harbor.connectome.propose":
      return host.harborConnectomePropose(args);
    case "harbor.connectome.decide":
      return host.harborConnectomeDecide(args);
    case "harbor.connectome.traverse":
      return host.harborConnectomeTraverse(args);
    case "harbor.connectome.explain":
      return host.harborConnectomeExplain(args);
    case "harbor.export":
      return host.harborExport(args);
    case "harbor.import":
      return host.harborImport(args);
    case "harbor.import.validate":
      return host.harborImportValidate(args);
    case "harbor.import.preview":
      return host.harborImportPreview(args);
    case "harbor.import.conflicts":
      return host.harborImportConflicts(args);
    case "harbor.import.confirm":
      return host.harborImportConfirm(args);
    case "harbor.import.reject":
      return host.harborImportReject(args);
    case "harbor.rebuild":
      return host.harborRebuild(args);
    case "harbor.query.memory":
      return host.harborQueryMemory(args);
    case "harbor.query.list":
      return host.harborQueryList(args);
    case "harbor.query.source":
      return host.harborQuerySource(args);
    case "harbor.query.status":
      return host.harborQueryStatus(args);
    case "harbor.query.contradictions":
      return host.harborQueryContradictions(args);
    case "harbor.query.provenance":
      return host.harborQueryProvenance(args);
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unknown desktop command: ${String(_exhaustive)}`);
    }
  }
}
