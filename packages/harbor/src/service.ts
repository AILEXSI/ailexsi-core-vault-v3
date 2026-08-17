import { randomUUID } from "node:crypto";
import type { MemoryCell } from "@ailexsi/contracts";
import {
  confirmAsUserAsserted,
  defaultEpistemicForCoreMemory,
  inferredRecord,
  rejectRecord,
} from "./epistemic.js";
import { assertCapability } from "./agency.js";
import { detectContradictions, resolveContradiction } from "./contradiction.js";
import { temporalFromMemory } from "./temporal.js";
import { assembleContextPackage, type ContextAssemblyInput } from "./context-assembly.js";
import { reflectOnMemories } from "./reflection.js";
import { MockHarborProvider, recordInvocation, type HarborProvider } from "./provider.js";
import { buildHarborExport, inspectHarborExport, type HarborExportPackage } from "./export.js";
import { buildHarborConnectome } from "./connectome-harbor.js";
import {
  awaitConfirm,
  conflictImportSession,
  createImportSession,
  previewImportSession,
  scanImportPayload,
  validateImportSession,
  type ImportSession,
} from "./import-pipeline.js";
import { HARBOR_CLASS, HARBOR_VERSION, type ContradictionResolution, type EpistemicRecord, type HarborActor, type HarborProposal, type HarborProposalType, type ReflectionArtifact } from "./types.js";

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
  readonly invocations: ReturnType<typeof recordInvocation>[] = [];
  readonly imports = new Map<string, ImportSession>();
  readonly provider: HarborProvider;

  constructor(
    private readonly pins: { corePin: string; vaultReferenceSha: string },
    provider?: HarborProvider
  ) {
    this.provider = provider ?? new MockHarborProvider();
  }

  snapshot(actor: HarborActor) {
    assertCapability(actor, "READ_ONLY");
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
    assertCapability(actor, "DERIVED_WRITE");
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
    return [...this.contradictions.values()];
  }

  assemble(memories: MemoryCell[], request: ContextAssemblyInput, actor: HarborActor, now = nowIso()) {
    assertCapability(actor, "READ_ONLY");
    this.ensureCoreOverlay(memories, now);
    return assembleContextPackage({
      request,
      memories: memories.map((m) => ({
        id: m.identity.id,
        text: textOf(m),
        project: m.context.project,
        tags: m.context.tags ?? [],
        updatedAt: m.timestamps.confirmedAt,
        lifecycle: m.lifecycle.state,
      })),
      epistemic: this.epistemic,
      contradictions: [...this.contradictions.values()],
      now,
    });
  }

  reflect(memories: MemoryCell[], actor: HarborActor, now = nowIso()): ReflectionArtifact {
    assertCapability(actor, "DERIVED_WRITE");
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
    return artifact;
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
    assertCapability(actor, "DERIVED_WRITE");
    const current =
      this.epistemic.get(memoryId) ??
      inferredRecord(memoryId, actor, [], 0.5, now, "Missing overlay — treated as INFERRED, not FACT");
    const next = confirmAsUserAsserted(current, actor, now);
    this.epistemic.set(memoryId, next);
    return next;
  }

  rejectInference(memoryId: string, actor: HarborActor, now = nowIso()): EpistemicRecord {
    assertCapability(actor, "DERIVED_WRITE");
    const current = this.epistemic.get(memoryId);
    if (!current) throw new Error(`No epistemic overlay for ${memoryId}`);
    const next = rejectRecord(current, actor, now);
    this.epistemic.set(memoryId, next);
    return next;
  }

  resolveContradiction(
    id: string,
    resolution: ContradictionResolution,
    actor: HarborActor,
    now = nowIso()
  ) {
    assertCapability(actor, "DERIVED_WRITE");
    const rec = this.contradictions.get(id);
    if (!rec) throw new Error(`Contradiction ${id} not found`);
    const next = resolveContradiction(rec, resolution, actor, now);
    this.contradictions.set(id, next);
    return next;
  }

  async propose(
    actor: HarborActor,
    input: { text: string; sourceMemoryIds: string[]; contextIds?: string[] },
    now = nowIso()
  ): Promise<HarborProposal> {
    assertCapability(actor, "CANONICAL_PROPOSAL");
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
      assertCapability(actor, "CANONICAL_COMMIT");
    } else {
      assertCapability(actor, "DERIVED_WRITE");
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
    return next;
  }

  graph(memories: MemoryCell[], actor: HarborActor) {
    assertCapability(actor, "READ_ONLY");
    return buildHarborConnectome({
      memories,
      contradictions: [...this.contradictions.values()],
      reflections: [...this.reflections.values()],
      proposals: [...this.proposals.values()],
    });
  }

  exportPackage(selectedCanonicalMemoryIds: string[], actor: HarborActor, now = nowIso()): HarborExportPackage {
    assertCapability(actor, "READ_ONLY");
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
    assertCapability(actor, "DERIVED_WRITE");
    const session = scanImportPayload(raw, createImportSession(now));
    this.imports.set(session.id, session);
    return session;
  }

  validateImport(sessionId: string, actor: HarborActor): ImportSession {
    assertCapability(actor, "DERIVED_WRITE");
    const cur = this.requireImport(sessionId);
    const next = validateImportSession(cur, this.pins.corePin);
    this.imports.set(sessionId, next);
    return next;
  }

  previewImport(sessionId: string, actor: HarborActor): ImportSession {
    assertCapability(actor, "READ_ONLY");
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
    assertCapability(actor, "DERIVED_WRITE");
    const next = conflictImportSession(this.requireImport(sessionId), existing, actor, now);
    this.imports.set(sessionId, next);
    return next;
  }

  confirmImport(sessionId: string, actor: HarborActor, now = nowIso()): ImportSession {
    assertCapability(actor, "DERIVED_WRITE");
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
    return applied;
  }

  rejectImport(sessionId: string, actor: HarborActor): ImportSession {
    assertCapability(actor, "DERIVED_WRITE");
    const cur = this.requireImport(sessionId);
    const next: ImportSession = { ...cur, stage: "REJECTED" };
    this.imports.set(sessionId, next);
    return next;
  }

  /**
   * Rebuild derived overlays from canonical memories.
   * Does not touch EventStore. Deterministic given the same cells + time.
   */
  rebuildFromCanonical(memories: MemoryCell[], actor: HarborActor, now = nowIso()) {
    assertCapability(actor, "DERIVED_WRITE");
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
    return {
      class: HARBOR_CLASS,
      epistemic: this.epistemic.size,
      contradictions: this.contradictions.size,
      reflections: this.reflections.size,
    };
  }

  private requireImport(id: string): ImportSession {
    const s = this.imports.get(id);
    if (!s) throw new Error(`Import session ${id} not found`);
    return s;
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
