import { randomUUID } from "node:crypto";
import type { MemoryCell } from "@ailexsi/contracts";
import {
  confirmAsUserAsserted,
  defaultEpistemicForCoreMemory,
  inferredRecord,
  rejectRecord,
} from "./epistemic.js";
import { AgencyBoundary, type CanonicalCommitRequest, type ExternalActionRequest } from "./agency-boundary.js";
import type { CanonicalActionRecord } from "./agency.js";
import { detectContradictions, resolveContradiction } from "./contradiction.js";
import { temporalFromMemory } from "./temporal.js";
import {
  assembleContextFromQuery,
  type ContextAssemblyInput,
  type ContextMemory,
} from "./context-assembly.js";
import { reflectOnMemories } from "./reflection.js";
import { reflectFromQuery, type ObservedReflection } from "./reflection-engine.js";
import {
  applyCultivationDecision,
  proposeFromReflections,
  type CultivationProposal,
  type CultivationProposalStatus,
} from "./cultivation-proposals.js";
import { MockHarborProvider, recordInvocation, type HarborProvider } from "./provider.js";
import { buildHarborExport, inspectHarborExport, type HarborExportPackage } from "./export.js";
import { buildHarborConnectome } from "./connectome-harbor.js";
import {
  assembleConnectome,
  canonicalRelationPayload,
  createRelationProposal,
  explainRelation,
  listRelations,
  traverseConnectome,
  type ConnectomePath,
  type ConnectomeView,
  type RelationProposal,
  type RelationProposalStatus,
  type RelationStatus,
} from "./connectome-engine.js";
import type { HarborEdgeType } from "./types.js";
import {
  awaitConfirm,
  conflictImportSession,
  createImportSession,
  previewImportSession,
  scanImportPayload,
  validateImportSession,
  type ImportSession,
} from "./import-pipeline.js";
import {
  buildDerivedDocument,
  DERIVED_INDEX_SCHEMA,
  FileDerivedIndex,
  rebuildFingerprint,
  type DerivedIndexStatus,
} from "./derived-index.js";
import { DerivedQueryService, type DerivedQuerySnapshot } from "./derived-query.js";
import { HARBOR_CLASS, HARBOR_VERSION, type ContextPackage, type ContradictionResolution, type EpistemicRecord, type HarborActor, type HarborProposal, type HarborProposalType, type ReflectionArtifact } from "./types.js";

export interface HarborServicePins {
  corePin: string;
  vaultReferenceSha: string;
  /** When set, derived state is persisted here. Never EventStore. */
  persistDir?: string;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function textOf(cell: MemoryCell): string {
  return cell.content.type === "text" ? cell.content.text : JSON.stringify(cell.content);
}

export class HarborService {
  readonly epistemic = new Map<string, EpistemicRecord>();
  readonly contradictions = new Map<string, ReturnType<typeof detectContradictions>[number]>();
  readonly reflections = new Map<string, ReflectionArtifact>();
  readonly proposals = new Map<string, HarborProposal>();
  /** Session-local cultivation proposals. Never persisted to the Derived Index. */
  readonly cultivation = new Map<string, CultivationProposal>();
  /** Session-local relation proposals. Never a Core Relation aggregate. */
  readonly relationProposals = new Map<string, RelationProposal>();
  readonly invocations: ReturnType<typeof recordInvocation>[] = [];
  readonly imports = new Map<string, ImportSession>();
  readonly provider: HarborProvider;
  readonly derivedIndex: FileDerivedIndex | null;
  readonly agency = new AgencyBoundary();

  private persistSuspended = false;
  private derivedStatus: DerivedIndexStatus = "empty";
  private derivedReason?: string;
  private rebuildGeneration = 0;
  private lastRebuiltAt?: string;

  constructor(
    private readonly pins: HarborServicePins,
    provider?: HarborProvider
  ) {
    this.provider = provider ?? new MockHarborProvider();
    this.derivedIndex = pins.persistDir ? new FileDerivedIndex(pins.persistDir) : null;
    if (this.derivedIndex) {
      this.loadFromDisk();
    }
  }

  /** Reopen a durable derived index (same as `new` with persistDir). */
  static open(pins: HarborServicePins, provider?: HarborProvider): HarborService {
    return new HarborService(pins, provider);
  }

  derivedIndexInfo() {
    return {
      schemaVersion: DERIVED_INDEX_SCHEMA,
      class: HARBOR_CLASS,
      kind: "derived-index" as const,
      status: this.derivedStatus,
      persistDir: this.derivedIndex?.persistDir ?? null,
      durable: Boolean(this.derivedIndex),
      fingerprint: this.currentFingerprint(),
      rebuildGeneration: this.rebuildGeneration,
      reason: this.derivedReason,
      corePin: this.pins.corePin,
      vaultReferenceSha: this.pins.vaultReferenceSha,
    };
  }

  currentFingerprint(): string {
    return rebuildFingerprint({
      epistemic: [...this.epistemic.values()],
      contradictions: [...this.contradictions.values()],
      reflections: [...this.reflections.values()],
    });
  }

  /**
   * READ-ONLY query facade over the current derived index.
   * Never persists. Never touches EventStore.
   */
  queries(actor: HarborActor): DerivedQueryService {
    this.agency.require(actor, "READ_ONLY", "queries");
    return new DerivedQueryService(() => this.captureQuerySnapshot());
  }

  private captureQuerySnapshot(): DerivedQuerySnapshot {
    const info = this.derivedIndexInfo();
    return {
      status: info.status,
      reason: info.reason,
      persistDir: info.persistDir,
      durable: info.durable,
      fingerprint: info.fingerprint,
      rebuildGeneration: info.rebuildGeneration,
      corePin: info.corePin,
      vaultReferenceSha: info.vaultReferenceSha,
      schemaVersion: info.schemaVersion,
      epistemic: [...this.epistemic.values()],
      contradictions: [...this.contradictions.values()],
      reflections: [...this.reflections.values()],
      proposals: [...this.proposals.values()],
    };
  }

  snapshot(actor: HarborActor) {
    this.agency.require(actor, "READ_ONLY", "snapshot");
    return {
      class: HARBOR_CLASS,
      version: HARBOR_VERSION,
      epistemic: [...this.epistemic.values()],
      contradictions: [...this.contradictions.values()],
      reflections: [...this.reflections.values()],
      proposals: [...this.proposals.values()],
      invocations: this.invocations.slice(),
      imports: [...this.imports.values()].map((s) => ({
        id: s.id,
        stage: s.stage,
        issues: s.issues,
        preview: s.preview,
        conflictCount: s.conflicts.length,
      })),
      derivedIndex: this.derivedIndexInfo(),
      cultivation: [...this.cultivation.values()],
      relationProposals: [...this.relationProposals.values()],
      agency: this.agency.inspect(),
    };
  }

  ensureCoreOverlay(memories: MemoryCell[], now = nowIso()): void {
    for (const m of memories) {
      if (!this.epistemic.has(m.identity.id)) {
        this.epistemic.set(m.identity.id, defaultEpistemicForCoreMemory(m.identity.id, now));
      }
    }
  }

  scan(memories: MemoryCell[], actor: HarborActor, now = nowIso()) {
    this.agency.require(actor, "DERIVED_WRITE", "scan");
    this.ensureCoreOverlay(memories, now);
    const found = detectContradictions(
      memories.map((m) => ({
        id: m.identity.id,
        text: textOf(m),
        updatedAt: m.timestamps.confirmedAt,
      })),
      actor,
      now
    );
    for (const c of found) {
      const prev = this.contradictions.get(c.id);
      this.contradictions.set(c.id, prev ?? c);
    }
    this.persistDerived();
    return [...this.contradictions.values()];
  }

  assemble(memories: MemoryCell[], request: ContextAssemblyInput, actor: HarborActor, now = nowIso()) {
    this.agency.require(actor, "READ_ONLY", "assemble");
    const before = this.epistemic.size;
    this.ensureCoreOverlay(memories, now);
    if (this.epistemic.size !== before) this.persistDerived();
    return assembleContextFromQuery({
      query: this.queries(actor),
      request,
      catalog: memories.map((m) => ({
        id: m.identity.id,
        text: textOf(m),
        project: m.context.project,
        tags: m.context.tags ?? [],
        updatedAt: m.timestamps.confirmedAt,
        lifecycle: m.lifecycle.state,
      })),
      now,
    });
  }

  /**
   * READ-ONLY context assembly from the derived query service.
   * Optional catalog supplies project/tags/text; never writes EventStore.
   */
  assembleFromDerived(
    request: ContextAssemblyInput,
    actor: HarborActor,
    now = nowIso(),
    catalog?: ContextMemory[]
  ) {
    this.agency.require(actor, "READ_ONLY", "assembleFromDerived");
    return assembleContextFromQuery({
      query: this.queries(actor),
      request,
      catalog,
      now,
    });
  }

  reflect(memories: MemoryCell[], actor: HarborActor, now = nowIso()): ReflectionArtifact {
    this.agency.require(actor, "DERIVED_WRITE", "reflect");
    this.ensureCoreOverlay(memories, now);
    const artifact = reflectOnMemories({
      memories: memories.map((m) => ({
        id: m.identity.id,
        text: textOf(m),
        tags: m.context.tags ?? [],
        project: m.context.project,
        lifecycle: m.lifecycle.state,
        updatedAt: m.timestamps.confirmedAt,
      })),
      contradictions: [...this.contradictions.values()],
      actor,
      now,
      id: randomUUID(),
    });
    this.reflections.set(artifact.id, artifact);
    this.persistDerived();
    return artifact;
  }

  /**
   * READ-ONLY OBSERVED reflections. Does not persist, does not write EventStore,
   * does not resolve contradictions, does not store the result as memory.
   */
  reflectObserved(
    actor: HarborActor,
    now = nowIso(),
    opts?: { catalog?: ContextMemory[]; context?: ContextPackage }
  ): ObservedReflection[] {
    this.agency.require(actor, "READ_ONLY", "reflectObserved");
    return reflectFromQuery({
      query: this.queries(actor),
      actor,
      now,
      catalog: opts?.catalog,
      context: opts?.context,
    });
  }

  /**
   * Deterministic cultivation proposals from OBSERVED reflections.
   * READ-ONLY source. Session-local only. Never persists. Never writes EventStore.
   */
  cultivate(
    actor: HarborActor,
    now = nowIso(),
    opts?: { catalog?: ContextMemory[]; context?: ContextPackage }
  ): CultivationProposal[] {
    this.agency.require(actor, "READ_ONLY", "cultivate");
    const reflections = this.reflectObserved(actor, now, opts);
    const generated = proposeFromReflections(reflections, actor, now);
    const out: CultivationProposal[] = [];
    for (const next of generated) {
      const prev = this.cultivation.get(next.proposalId);
      const merged: CultivationProposal = prev
        ? {
            ...next,
            status: prev.status,
            title: prev.status === "EDITED" ? prev.title : next.title,
            description: prev.status === "EDITED" ? prev.description : next.description,
            decidedBy: prev.decidedBy,
            decidedAt: prev.decidedAt,
          }
        : next;
      this.cultivation.set(merged.proposalId, merged);
      out.push(structuredClone(merged));
    }
    return out;
  }

  decideCultivation(
    proposalId: string,
    status: Extract<CultivationProposalStatus, "ACCEPTED" | "EDITED" | "REJECTED" | "DEFERRED" | "SUPERSEDED">,
    actor: HarborActor,
    extras?: { title?: string; description?: string; now?: string }
  ): CultivationProposal {
    if (status === "ACCEPTED" || status === "EDITED") {
      this.agency.require(actor, "CANONICAL_COMMIT", "decideCultivation", proposalId);
    } else {
      this.agency.require(actor, "DERIVED_WRITE", "decideCultivation", proposalId);
    }
    if (actor.kind !== "human") {
      throw new Error("Cultivation decision requires a human");
    }
    const current = this.cultivation.get(proposalId);
    if (!current) throw new Error(`Cultivation proposal ${proposalId} not found`);
    const next = applyCultivationDecision(current, status, actor, extras?.now ?? nowIso(), extras);
    this.cultivation.set(proposalId, next);
    return structuredClone(next);
  }

  temporal(cell: MemoryCell) {
    return temporalFromMemory({
      memoryId: cell.identity.id,
      createdAt: cell.timestamps.createdAt,
      confirmedAt: cell.timestamps.confirmedAt,
      lifecycle: cell.lifecycle.state,
      superseded: this.epistemic.get(cell.identity.id)?.status === "SUPERSEDED",
    });
  }

  confirm(memoryId: string, actor: HarborActor, now = nowIso()): EpistemicRecord {
    this.agency.require(actor, "DERIVED_WRITE", "confirm", memoryId);
    const current =
      this.epistemic.get(memoryId) ??
      inferredRecord(memoryId, actor, [], 0.5, now, "Missing overlay — treated as INFERRED, not FACT");
    const next = confirmAsUserAsserted(current, actor, now);
    this.epistemic.set(memoryId, next);
    this.persistDerived();
    return next;
  }

  rejectInference(memoryId: string, actor: HarborActor, now = nowIso()): EpistemicRecord {
    this.agency.require(actor, "DERIVED_WRITE", "rejectInference", memoryId);
    const current = this.epistemic.get(memoryId);
    if (!current) throw new Error(`No epistemic overlay for ${memoryId}`);
    const next = rejectRecord(current, actor, now);
    this.epistemic.set(memoryId, next);
    this.persistDerived();
    return next;
  }

  resolveContradiction(
    id: string,
    resolution: ContradictionResolution,
    actor: HarborActor,
    now = nowIso()
  ) {
    this.agency.require(actor, "DERIVED_WRITE", "resolveContradiction", id);
    const rec = this.contradictions.get(id);
    if (!rec) throw new Error(`Contradiction ${id} not found`);
    const next = resolveContradiction(rec, resolution, actor, now);
    this.contradictions.set(id, next);
    this.persistDerived();
    return next;
  }

  async propose(
    actor: HarborActor,
    input: { text: string; sourceMemoryIds: string[]; contextIds?: string[] },
    now = nowIso()
  ): Promise<HarborProposal> {
    this.agency.require(actor, "PROPOSE", "propose");
    const output = await this.provider.invoke("generateProposal", input.text, input.contextIds ?? []);
    this.invocations.push(
      recordInvocation(this.provider, "generateProposal", input.text, output, input.contextIds ?? [], now)
    );
    const type = classifyProposalType(output);
    const proposal: HarborProposal = {
      proposalId: randomUUID(),
      agentId: actor.id,
      modelId: `${this.provider.name}:${this.provider.model}`,
      createdAt: now,
      contextIds: input.contextIds ?? [],
      sourceMemoryIds: input.sourceMemoryIds,
      proposalType: type,
      content: output,
      reasoningSummary: output.slice(0, 280),
      confidence: type === "create_memory" || type === "update_memory" ? 0.55 : 0.8,
      riskLevel: type === "create_memory" || type === "update_memory" ? "medium" : "low",
      status: "PROPOSED",
      resultingEventIds: [],
      provenance: {
        sourceMemoryIds: input.sourceMemoryIds,
        sourceEventIds: [],
        agentId: actor.id,
        actorKind: actor.kind,
        provider: this.provider.name,
        model: this.provider.model,
        modelVersion: this.provider.modelVersion,
        createdAt: now,
        derivationType: "propose",
        confidence: 0.55,
        class: HARBOR_CLASS,
      },
      class: HARBOR_CLASS,
    };
    this.proposals.set(proposal.proposalId, proposal);
    this.persistDerived();
    return proposal;
  }

  decideProposal(
    proposalId: string,
    status: Extract<HarborProposal["status"], "ACCEPTED" | "EDITED" | "REJECTED" | "DEFERRED" | "DISCUSSING" | "SUPERSEDED">,
    actor: HarborActor,
    extras?: { resultingEventIds?: string[]; now?: string }
  ): HarborProposal {
    const p = this.proposals.get(proposalId);
    if (!p) throw new Error(`Proposal ${proposalId} not found`);
    if (status === "ACCEPTED" || status === "EDITED") {
      this.agency.require(actor, "CANONICAL_COMMIT", "decideProposal", proposalId);
    } else {
      this.agency.require(actor, "DERIVED_WRITE", "decideProposal", proposalId);
    }
    if (p.status === "ACCEPTED" || p.status === "EDITED") {
      throw new Error("Proposal already accepted");
    }
    const now = extras?.now ?? nowIso();
    const next: HarborProposal = {
      ...p,
      status,
      acceptedBy: status === "ACCEPTED" || status === "EDITED" ? actor.id : p.acceptedBy,
      acceptedAt: status === "ACCEPTED" || status === "EDITED" ? now : p.acceptedAt,
      resultingEventIds: extras?.resultingEventIds ?? p.resultingEventIds,
    };
    this.proposals.set(proposalId, next);
    this.persistDerived();
    return next;
  }

  /**
   * The only Harbor path that may mutate Core / EventStore.
   * Requires an explicit human AuthorizationGrant. Proposal accept is not a grant.
   */
  commitCanonical<T>(request: CanonicalCommitRequest<T>) {
    return this.agency.commitCanonical(request);
  }

  /**
   * Persist an already-decided proposal. Accept/edit is not a write.
   * Requires a separate human AuthorizationGrant bound to this proposalId.
   */
  async commitProposal<T>(
    request: CanonicalCommitRequest<T> & { proposalId: string }
  ): Promise<{ result: T; record: CanonicalActionRecord; proposal: HarborProposal }> {
    const proposal = this.proposals.get(request.proposalId);
    if (!proposal) throw new Error(`Proposal ${request.proposalId} not found`);
    if (proposal.status !== "ACCEPTED" && proposal.status !== "EDITED") {
      this.agency.refuseProposalPersist(
        request.actor,
        request.proposalId,
        "Proposal must be ACCEPTED or EDITED before an authorized canonical persist"
      );
    }
    if (proposal.resultingEventIds.length > 0) {
      this.agency.refuseProposalPersist(
        request.actor,
        request.proposalId,
        "Proposal already produced canonical events"
      );
    }
    if (request.target !== request.proposalId || request.action !== "proposal.commit") {
      this.agency.refuseProposalPersist(
        request.actor,
        request.proposalId,
        "Proposal persist requires action proposal.commit bound to the proposalId"
      );
    }
    const { result, record } = await this.agency.commitCanonical(request);
    const next: HarborProposal = {
      ...proposal,
      resultingEventIds: [...record.resultingEventIds],
    };
    this.proposals.set(proposal.proposalId, next);
    this.persistDerived();
    return { result, record, proposal: structuredClone(next) };
  }

  performExternal<T>(request: ExternalActionRequest<T>) {
    return this.agency.performExternal(request);
  }

  graph(memories: MemoryCell[], actor: HarborActor) {
    this.agency.require(actor, "READ_ONLY", "graph");
    return buildHarborConnectome({
      memories,
      contradictions: [...this.contradictions.values()],
      reflections: [...this.reflections.values()],
      proposals: [...this.proposals.values()],
    });
  }

  connectome(memories: MemoryCell[], actor: HarborActor, now = nowIso()): ConnectomeView {
    this.agency.require(actor, "READ_ONLY", "connectome");
    return assembleConnectome({
      memories,
      contradictions: [...this.contradictions.values()],
      reflections: [...this.reflections.values()],
      proposals: [...this.proposals.values()],
      relationProposals: [...this.relationProposals.values()],
      now,
    });
  }

  listConnectomeRelations(
    memories: MemoryCell[],
    actor: HarborActor,
    filter?: { status?: RelationStatus; type?: HarborEdgeType; memoryId?: string },
    now = nowIso()
  ) {
    return listRelations(this.connectome(memories, actor, now), filter);
  }

  explainConnectomeRelation(
    memories: MemoryCell[],
    relationId: string,
    actor: HarborActor,
    now = nowIso()
  ) {
    this.agency.require(actor, "READ_ONLY", "explainConnectome", relationId);
    const explanation = explainRelation(this.connectome(memories, actor, now), relationId);
    if (!explanation) {
      return {
        what: "unknown",
        why: "No relation with that id in the current derived graph.",
        source: "none",
        status: "INFERRED" as const,
        when: now,
        authority: "none",
      };
    }
    return explanation;
  }

  traverseConnectome(
    memories: MemoryCell[],
    from: string,
    to: string,
    actor: HarborActor,
    maxDepth = 6,
    now = nowIso()
  ): ConnectomePath {
    this.agency.require(actor, "READ_ONLY", "traverseConnectome");
    return traverseConnectome(this.connectome(memories, actor, now), from, to, maxDepth);
  }

  proposeRelation(
    actor: HarborActor,
    spec: { from: string; to: string; type: HarborEdgeType; reason: string; evidenceMemoryIds?: string[] },
    now = nowIso()
  ): RelationProposal {
    this.agency.require(actor, "PROPOSE", "proposeRelation");
    const next = createRelationProposal(spec, actor, now);
    this.relationProposals.set(next.proposalId, next);
    return structuredClone(next);
  }

  decideRelation(
    proposalId: string,
    status: Extract<RelationProposalStatus, "ACCEPTED" | "EDITED" | "REJECTED" | "DEFERRED">,
    actor: HarborActor,
    now = nowIso()
  ): RelationProposal {
    const current = this.relationProposals.get(proposalId);
    if (!current) throw new Error(`Relation proposal ${proposalId} not found`);
    if (status === "ACCEPTED" || status === "EDITED") {
      this.agency.require(actor, "CANONICAL_COMMIT", "decideRelation", proposalId);
    } else {
      this.agency.require(actor, "DERIVED_WRITE", "decideRelation", proposalId);
    }
    if (actor.kind !== "human") {
      throw new Error("Relation decision requires a human");
    }
    if (current.status === "COMMITTED") {
      throw new Error("Relation proposal already committed");
    }
    const next: RelationProposal = {
      ...current,
      status,
      decidedBy: actor.id,
      decidedAt: now,
    };
    this.relationProposals.set(proposalId, next);
    return structuredClone(next);
  }

  async commitRelation<T>(
    request: CanonicalCommitRequest<T> & { proposalId: string }
  ): Promise<{ result: T; record: CanonicalActionRecord; proposal: RelationProposal }> {
    const proposal = this.relationProposals.get(request.proposalId);
    if (!proposal) throw new Error(`Relation proposal ${request.proposalId} not found`);
    if (proposal.status !== "ACCEPTED" && proposal.status !== "EDITED") {
      this.agency.refuseProposalPersist(
        request.actor,
        request.proposalId,
        "Relation proposal must be ACCEPTED or EDITED before authorized persist"
      );
    }
    if (proposal.resultingEventIds.length > 0 || proposal.status === "COMMITTED") {
      this.agency.refuseProposalPersist(
        request.actor,
        request.proposalId,
        "Relation proposal already produced canonical events"
      );
    }
    if (request.action !== "relation.commit" || request.target !== request.proposalId) {
      this.agency.refuseProposalPersist(
        request.actor,
        request.proposalId,
        "Relation persist requires action relation.commit bound to the proposalId"
      );
    }
    const { result, record } = await this.agency.commitCanonical(request);
    const next: RelationProposal = {
      ...proposal,
      status: "COMMITTED",
      resultingEventIds: [...record.resultingEventIds],
      canonicalMemoryId:
        result && typeof result === "object" && result !== null && "identity" in result
          ? String((result as { identity?: { id?: string } }).identity?.id ?? "")
          : proposal.canonicalMemoryId,
    };
    this.relationProposals.set(proposal.proposalId, next);
    return { result, record, proposal: structuredClone(next) };
  }

  relationContentForCommit(proposalId: string, grantId: string, authorizedById: string) {
    const proposal = this.relationProposals.get(proposalId);
    if (!proposal) throw new Error(`Relation proposal ${proposalId} not found`);
    return canonicalRelationPayload({
      from: proposal.from,
      to: proposal.to,
      type: proposal.type,
      evidenceMemoryIds: proposal.evidenceMemoryIds,
      grantId,
      authorizedById,
    });
  }

  exportPackage(selectedCanonicalMemoryIds: string[], actor: HarborActor, now = nowIso()): HarborExportPackage {
    this.agency.require(actor, "READ_ONLY", "exportPackage");
    return buildHarborExport({
      corePin: this.pins.corePin,
      vaultReferenceSha: this.pins.vaultReferenceSha,
      createdAt: now,
      selectedCanonicalMemoryIds,
      epistemic: [...this.epistemic.values()],
      contradictions: [...this.contradictions.values()],
      reflections: [...this.reflections.values()],
      proposals: [...this.proposals.values()],
      invocations: this.invocations,
    });
  }

  /**
   * One-shot import is forbidden. Returns a scanned session only.
   * Call validate → preview → conflicts → confirm to write derived state.
   */
  importPackage(pkg: HarborExportPackage, actor: HarborActor): ImportSession {
    return this.beginImport(pkg, actor);
  }

  beginImport(raw: unknown, actor: HarborActor, now = nowIso()): ImportSession {
    this.agency.require(actor, "DERIVED_WRITE", "beginImport");
    const session = scanImportPayload(raw, createImportSession(now));
    this.imports.set(session.id, session);
    return session;
  }

  validateImport(sessionId: string, actor: HarborActor): ImportSession {
    this.agency.require(actor, "DERIVED_WRITE", "validateImport", sessionId);
    const cur = this.requireImport(sessionId);
    const next = validateImportSession(cur, this.pins.corePin);
    this.imports.set(sessionId, next);
    return next;
  }

  previewImport(sessionId: string, actor: HarborActor): ImportSession {
    this.agency.require(actor, "READ_ONLY", "previewImport", sessionId);
    const next = previewImportSession(this.requireImport(sessionId));
    this.imports.set(sessionId, next);
    return next;
  }

  detectImportConflicts(
    sessionId: string,
    existing: Array<{ id: string; text: string; updatedAt?: string }>,
    actor: HarborActor,
    now = nowIso()
  ): ImportSession {
    this.agency.require(actor, "DERIVED_WRITE", "detectImportConflicts", sessionId);
    const next = conflictImportSession(this.requireImport(sessionId), existing, actor, now);
    this.imports.set(sessionId, next);
    return next;
  }

  confirmImport(sessionId: string, actor: HarborActor, now = nowIso()): ImportSession {
    this.agency.require(actor, "DERIVED_WRITE", "confirmImport", sessionId);
    if (actor.kind !== "human") {
      throw new Error("Import WRITE requires explicit human confirmation");
    }
    const waiting = awaitConfirm(this.requireImport(sessionId));
    if (waiting.stage === "BLOCKED" || !waiting.pkg) {
      this.imports.set(sessionId, waiting);
      return waiting;
    }
    const pkg = waiting.pkg;
    for (const e of pkg.epistemic) this.epistemic.set(e.memoryId, e);
    for (const c of pkg.contradictions) this.contradictions.set(c.id, c);
    for (const r of pkg.reflections) this.reflections.set(r.id, r);
    for (const p of pkg.proposals) this.proposals.set(p.proposalId, p);
    this.invocations.push(...pkg.invocations);
    const applied: ImportSession = {
      ...waiting,
      stage: "APPLIED",
      confirmedBy: actor,
      appliedAt: now,
    };
    this.imports.set(sessionId, applied);
    this.persistDerived();
    return applied;
  }

  rejectImport(sessionId: string, actor: HarborActor): ImportSession {
    this.agency.require(actor, "DERIVED_WRITE", "rejectImport", sessionId);
    const cur = this.requireImport(sessionId);
    const next: ImportSession = { ...cur, stage: "REJECTED" };
    this.imports.set(sessionId, next);
    return next;
  }

  /**
   * Drop derived state only. Never touches EventStore / Core.
   * Durable files are removed; canonical replay is required to rebuild.
   */
  clearDerived(actor: HarborActor): { class: typeof HARBOR_CLASS; status: DerivedIndexStatus } {
    this.agency.require(actor, "DERIVED_WRITE", "clearDerived");
    this.epistemic.clear();
    this.contradictions.clear();
    this.reflections.clear();
    this.proposals.clear();
    this.cultivation.clear();
    this.relationProposals.clear();
    this.invocations.length = 0;
    this.rebuildGeneration = 0;
    this.lastRebuiltAt = undefined;
    this.derivedIndex?.clearFiles();
    this.derivedStatus = "empty";
    this.derivedReason = undefined;
    return { class: HARBOR_CLASS, status: this.derivedStatus };
  }

  /**
   * Rebuild derived overlays from canonical memories.
   * Does not touch EventStore. Deterministic given the same cells + time.
   * Interrupt-safe: previous ready snapshot stays on disk until the new
   * snapshot is written atomically; a leftover marker is a known state.
   */
  rebuildFromCanonical(memories: MemoryCell[], actor: HarborActor, now = nowIso()) {
    this.agency.require(actor, "DERIVED_WRITE", "rebuildFromCanonical");
    this.persistSuspended = true;
    try {
      this.derivedIndex?.markRebuilding();
      this.derivedStatus = "rebuilding";
      this.derivedReason = undefined;
      this.rebuildGeneration += 1;
      this.lastRebuiltAt = now;
      this.epistemic.clear();
      this.contradictions.clear();
      this.reflections.clear();
      this.ensureCoreOverlay(memories, now);
      this.scan(memories, actor, now);
      const reflection = reflectOnMemories({
        memories: memories.map((m) => ({
          id: m.identity.id,
          text: textOf(m),
          tags: m.context.tags ?? [],
          project: m.context.project,
          lifecycle: m.lifecycle.state,
          updatedAt: m.timestamps.confirmedAt,
        })),
        contradictions: [...this.contradictions.values()],
        actor,
        now,
        id: `rebuild:${memories.map((m) => m.identity.id).sort().join(",")}`,
      });
      this.reflections.set(reflection.id, reflection);
      this.persistSuspended = false;
      this.persistDerived();
      return {
        class: HARBOR_CLASS,
        epistemic: this.epistemic.size,
        contradictions: this.contradictions.size,
        reflections: this.reflections.size,
        fingerprint: this.currentFingerprint(),
        rebuildGeneration: this.rebuildGeneration,
        derivedIndex: this.derivedIndexInfo(),
      };
    } catch (err) {
      this.derivedStatus = this.derivedIndex ? "interrupted" : this.derivedStatus;
      this.derivedReason = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.persistSuspended = false;
    }
  }

  private requireImport(id: string): ImportSession {
    const s = this.imports.get(id);
    if (!s) throw new Error(`Import session ${id} not found`);
    return s;
  }

  private loadFromDisk(): void {
    if (!this.derivedIndex) {
      this.derivedStatus = "empty";
      return;
    }
    const loaded = this.derivedIndex.load();
    this.derivedStatus = loaded.status;
    this.derivedReason = loaded.reason;
    if (
      loaded.document &&
      (loaded.status === "ready" || loaded.status === "interrupted")
    ) {
      this.applyDocument(loaded.document);
    }
  }

  private applyDocument(doc: {
    epistemic: EpistemicRecord[];
    contradictions: ReturnType<typeof detectContradictions>;
    reflections: ReflectionArtifact[];
    proposals: HarborProposal[];
    invocations: ReturnType<typeof recordInvocation>[];
    rebuildGeneration: number;
    rebuiltAt: string;
  }): void {
    this.epistemic.clear();
    for (const e of doc.epistemic) this.epistemic.set(e.memoryId, e);
    this.contradictions.clear();
    for (const c of doc.contradictions) this.contradictions.set(c.id, c);
    this.reflections.clear();
    for (const r of doc.reflections) this.reflections.set(r.id, r);
    this.proposals.clear();
    for (const p of doc.proposals) this.proposals.set(p.proposalId, p);
    this.invocations.length = 0;
    this.invocations.push(...doc.invocations);
    this.rebuildGeneration = doc.rebuildGeneration;
    this.lastRebuiltAt = doc.rebuiltAt;
  }

  private persistDerived(): void {
    if (!this.derivedIndex || this.persistSuspended) return;
    const doc = buildDerivedDocument({
      corePin: this.pins.corePin,
      vaultReferenceSha: this.pins.vaultReferenceSha,
      rebuiltAt: this.lastRebuiltAt ?? nowIso(),
      rebuildGeneration: this.rebuildGeneration,
      status: "ready",
      epistemic: [...this.epistemic.values()],
      contradictions: [...this.contradictions.values()],
      reflections: [...this.reflections.values()],
      proposals: [...this.proposals.values()],
      invocations: this.invocations.slice(),
    });
    this.derivedIndex.save(doc);
    this.derivedStatus = "ready";
    this.derivedReason = undefined;
  }
}

function classifyProposalType(output: string): HarborProposalType {
  const t = output.toLowerCase();
  if (t.includes("don't know") || t.includes("i dont know") || t.includes("i don't know")) {
    return "i_dont_know";
  }
  if (t.includes("insufficient evidence")) return "insufficient_evidence";
  if (t.includes("conflicting evidence")) return "conflicting_evidence";
  if (t.includes("no action")) return "no_action";
  return "create_memory";
}
