/**
 * V3 Connectome — derived graph over Core Memory + Harbor overlays.
 * Not a Core Relation aggregate. Never EventStore.
 *
 * Observed/derived/inferred/proposed live here.
 * Canonical persist is a Memory structured cell via Agency.
 */
import { createHash } from "node:crypto";
import type { MemoryCell } from "@ailexsi/contracts";
import { HARBOR_CLASS, type ArtifactProvenance, type ContradictionRecord, type HarborActor, type HarborEdgeType, type HarborProposal, type ReflectionArtifact } from "./types.js";

export const CONNECTOME_SCHEMA = "harbor-connectome-v1" as const;
export const CONNECTOME_RELATION_CONTENT = "connectome-relation" as const;

export type RelationStatus =
  | "CORE_REFERENCE"
  | "OBSERVED"
  | "DERIVED"
  | "INFERRED"
  | "PROPOSED"
  | "CANONICAL_MEMORY"
  | "DISPUTED"
  | "REJECTED";

export interface RelationExplanation {
  what: string;
  why: string;
  source: string;
  status: RelationStatus;
  when: string;
  authority: string;
}

export interface ConnectomeRelation {
  relationId: string;
  from: string;
  to: string;
  type: HarborEdgeType;
  status: RelationStatus;
  confidence: number;
  evidenceMemoryIds: string[];
  evidenceContradictionIds: string[];
  evidenceReflectionIds: string[];
  evidenceProposalIds: string[];
  competingRelationIds: string[];
  temporal?: { validFrom?: string; validUntil?: string };
  authorizedBy?: { id: string; kind: "human"; grantId?: string };
  canonicalMemoryId?: string;
  createdAt: string;
  explanation: RelationExplanation;
  class: typeof HARBOR_CLASS;
}

export interface ConnectomeNode {
  id: string;
  kind: "MEMORY" | "PROPOSAL" | "REFLECTION" | "QUESTION";
  label: string;
  status: RelationStatus | "CANONICAL_REFERENCE";
}

export interface ConnectomePathHop {
  relationId: string;
  from: string;
  to: string;
  type: HarborEdgeType;
  status: RelationStatus;
  explanation: RelationExplanation;
}

export interface ConnectomePath {
  found: boolean;
  from: string;
  to: string;
  hops: ConnectomePathHop[];
  reason: string;
}

export interface ConnectomeView {
  schemaVersion: typeof CONNECTOME_SCHEMA;
  class: typeof HARBOR_CLASS;
  coreRelationAggregate: "PLANNED";
  nodes: ConnectomeNode[];
  relations: ConnectomeRelation[];
}

export type RelationProposalStatus =
  | "PROPOSED"
  | "ACCEPTED"
  | "EDITED"
  | "REJECTED"
  | "DEFERRED"
  | "COMMITTED";

export interface RelationProposal {
  proposalId: string;
  from: string;
  to: string;
  type: HarborEdgeType;
  status: RelationProposalStatus;
  reason: string;
  evidenceMemoryIds: string[];
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  resultingEventIds: string[];
  canonicalMemoryId?: string;
  provenance: ArtifactProvenance;
  class: typeof HARBOR_CLASS;
}

export function isConnectomeRelationContent(content: MemoryCell["content"]): boolean {
  if (content.type !== "structured") return false;
  const data = content.structuredData as { kind?: string; schema?: string };
  return data?.kind === CONNECTOME_RELATION_CONTENT && data?.schema === CONNECTOME_SCHEMA;
}

export function relationFromCanonicalMemory(cell: MemoryCell): ConnectomeRelation | null {
  if (!isConnectomeRelationContent(cell.content)) return null;
  const data = cell.content.structuredData as {
    from?: string;
    to?: string;
    type?: HarborEdgeType;
    evidenceMemoryIds?: string[];
    grantId?: string;
    authorizedById?: string;
  };
  if (!data.from || !data.to || !data.type) return null;
  const grantId = typeof data.grantId === "string" ? data.grantId.trim() : "";
  const authorizedById = typeof data.authorizedById === "string" ? data.authorizedById.trim() : "";
  if (!grantId || !authorizedById) return null;
  const when = cell.timestamps.confirmedAt ?? cell.timestamps.createdAt;
  return {
    relationId: `can:${cell.identity.id}`,
    from: data.from,
    to: data.to,
    type: data.type,
    status: "CANONICAL_MEMORY",
    confidence: 1,
    evidenceMemoryIds: [...(data.evidenceMemoryIds ?? [])],
    evidenceContradictionIds: [],
    evidenceReflectionIds: [],
    evidenceProposalIds: [],
    competingRelationIds: [],
    temporal: { validFrom: cell.timestamps.validFrom, validUntil: cell.timestamps.validTo ?? undefined },
    authorizedBy: { id: authorizedById, kind: "human", grantId },
    canonicalMemoryId: cell.identity.id,
    createdAt: when,
    explanation: explain({
      type: data.type,
      from: data.from,
      to: data.to,
      status: "CANONICAL_MEMORY",
      why: "Core Memory structured cell citing grant metadata from the relation.commit path. Citations are not grants and do not prove the relation.",
      source: `memory:${cell.identity.id}`,
      when,
      authority: `citation authorizedById:${authorizedById} grantId:${grantId} (citation, not a grant)`,
    }),
    class: HARBOR_CLASS,
  };
}

export function assembleConnectome(input: {
  memories: MemoryCell[];
  contradictions?: ContradictionRecord[];
  reflections?: ReflectionArtifact[];
  proposals?: HarborProposal[];
  relationProposals?: RelationProposal[];
  now: string;
}): ConnectomeView {
  const relations: ConnectomeRelation[] = [];
  const nodes = new Map<string, ConnectomeNode>();

  for (const m of input.memories) {
    nodes.set(m.identity.id, {
      id: m.identity.id,
      kind: "MEMORY",
      label: labelOf(m),
      status: "CANONICAL_REFERENCE",
    });
    const persisted = relationFromCanonicalMemory(m);
    if (persisted) relations.push(persisted);

    for (const ref of m.relationRefs ?? []) {
      relations.push(
        makeRelation({
          relationId: `core:${ref.relationId}`,
          from: ref.direction === "outgoing" ? m.identity.id : ref.targetMemoryId,
          to: ref.direction === "outgoing" ? ref.targetMemoryId : m.identity.id,
          type: mapCoreType(String(ref.type)),
          status: "CORE_REFERENCE",
          confidence: 1,
          evidenceMemoryIds: [m.identity.id, ref.targetMemoryId],
          now: input.now,
          why: "Recorded on the Core Memory relationRefs field.",
          source: `memory.relationRefs:${ref.relationId}`,
          authority: "Core Memory cell (no V3 Relation aggregate)",
        })
      );
    }

    for (const parentId of m.provenance.parentMemoryIds ?? []) {
      relations.push(
        makeRelation({
          relationId: `obs:${parentId}->${m.identity.id}:DERIVED_FROM`,
          from: parentId,
          to: m.identity.id,
          type: "DERIVED_FROM",
          status: "OBSERVED",
          confidence: 0.9,
          evidenceMemoryIds: [parentId, m.identity.id],
          now: m.timestamps.createdAt,
          why: "Observed from provenance.parentMemoryIds on the child Memory.",
          source: `memory.provenance.parentMemoryIds`,
          authority: "none — observed, not a Relation aggregate",
        })
      );
    }
  }

  for (const c of input.contradictions ?? []) {
    const id = `inf:contradict:${c.id}`;
    nodes.set(`contradiction:${c.id}`, {
      id: `contradiction:${c.id}`,
      kind: "QUESTION",
      label: `Contradiction ${c.excerptA} vs ${c.excerptB}`,
      status: "INFERRED",
    });
    relations.push(
      makeRelation({
        relationId: `${id}:A`,
        from: c.memoryIdA,
        to: c.memoryIdB,
        type: "CONTRADICTS",
        status: c.resolution === "UNRESOLVED" ? "DISPUTED" : "INFERRED",
        confidence: c.confidence,
        evidenceMemoryIds: [c.memoryIdA, c.memoryIdB],
        evidenceContradictionIds: [c.id],
        now: c.detectedAt,
        why: `Harbor contradiction ${c.id} (${c.resolution}). Both records kept.`,
        source: `harbor.contradiction:${c.id}`,
        authority: c.resolvedBy ? `${c.resolvedBy.kind}:${c.resolvedBy.id}` : "unresolved — no human resolution",
      })
    );
  }

  for (const r of input.reflections ?? []) {
    nodes.set(`reflection:${r.id}`, {
      id: `reflection:${r.id}`,
      kind: "REFLECTION",
      label: r.findings[0]?.statement ?? "Reflection",
      status: "DERIVED",
    });
    for (const mem of r.provenance.sourceMemoryIds) {
      relations.push(
        makeRelation({
          relationId: `der:reflection:${r.id}:${mem}`,
          from: `reflection:${r.id}`,
          to: mem,
          type: "DERIVED_FROM",
          status: "DERIVED",
          confidence: r.provenance.confidence,
          evidenceMemoryIds: [mem],
          evidenceReflectionIds: [r.id],
          now: r.createdAt,
          why: "Reflection artifact cites this Memory as evidence.",
          source: `harbor.reflection:${r.id}`,
          authority: "none — derived overlay",
        })
      );
    }
  }

  for (const p of input.proposals ?? []) {
    nodes.set(`proposal:${p.proposalId}`, {
      id: `proposal:${p.proposalId}`,
      kind: "PROPOSAL",
      label: p.proposalType,
      status: p.status === "ACCEPTED" ? "DERIVED" : "PROPOSED",
    });
    for (const src of p.sourceMemoryIds) {
      relations.push(
        makeRelation({
          relationId: `der:proposal:${p.proposalId}:${src}`,
          from: `proposal:${p.proposalId}`,
          to: src,
          type: "ABOUT",
          status: "PROPOSED",
          confidence: p.confidence,
          evidenceMemoryIds: [src],
          evidenceProposalIds: [p.proposalId],
          now: p.createdAt,
          why: "Harbor proposal cites this Memory. Not a canonical relation.",
          source: `harbor.proposal:${p.proposalId}`,
          authority: p.acceptedBy ? `human-decision:${p.acceptedBy} (decision only, not persist)` : "none",
        })
      );
    }
  }

  for (const rp of input.relationProposals ?? []) {
    if (rp.status === "REJECTED") continue;
    if (rp.status === "COMMITTED" && rp.canonicalMemoryId) continue;
    relations.push(
      makeRelation({
        relationId: `prop:${rp.proposalId}`,
        from: rp.from,
        to: rp.to,
        type: rp.type,
        status: rp.status === "REJECTED" ? "INFERRED" : "PROPOSED",
        confidence: rp.evidenceMemoryIds.length === 0 ? 0 : rp.status === "REJECTED" ? 0 : 0.4,
        evidenceMemoryIds: rp.evidenceMemoryIds,
        evidenceProposalIds: [rp.proposalId],
        now: rp.createdAt,
        why:
          rp.evidenceMemoryIds.length === 0
            ? `${rp.reason} Unsubstantiated — no evidence Memory ids. Existence of from/to is not proof.`
            : rp.reason,
        source: `harbor.relationProposal:${rp.proposalId}`,
        authority:
          rp.evidenceMemoryIds.length === 0
            ? "none — unsubstantiated proposal"
            : rp.status === "COMMITTED" && rp.canonicalMemoryId
              ? `canonical memory:${rp.canonicalMemoryId}`
              : rp.decidedBy
                ? `human-decision:${rp.decidedBy} (decision only, not persist)`
                : "none — proposal only",
      })
    );
  }

  markCompeting(relations);

  const seen = new Set<string>();
  const unique: ConnectomeRelation[] = [];
  for (const rel of relations.sort((a, b) => a.relationId.localeCompare(b.relationId))) {
    if (seen.has(rel.relationId)) continue;
    seen.add(rel.relationId);
    unique.push(rel);
    if (!nodes.has(rel.from)) {
      nodes.set(rel.from, { id: rel.from, kind: "MEMORY", label: rel.from, status: rel.status });
    }
    if (!nodes.has(rel.to)) {
      nodes.set(rel.to, { id: rel.to, kind: "MEMORY", label: rel.to, status: rel.status });
    }
  }

  return {
    schemaVersion: CONNECTOME_SCHEMA,
    class: HARBOR_CLASS,
    coreRelationAggregate: "PLANNED",
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    relations: unique,
  };
}

export function explainRelation(view: ConnectomeView, relationId: string): RelationExplanation | null {
  return view.relations.find((r) => r.relationId === relationId)?.explanation ?? null;
}

export function listRelations(
  view: ConnectomeView,
  filter?: { status?: RelationStatus; type?: HarborEdgeType; memoryId?: string }
): ConnectomeRelation[] {
  return view.relations.filter((r) => {
    if (filter?.status && r.status !== filter.status) return false;
    if (filter?.type && r.type !== filter.type) return false;
    if (filter?.memoryId && r.from !== filter.memoryId && r.to !== filter.memoryId) return false;
    return true;
  });
}

const CANONICAL_TRAVERSAL = new Set<RelationStatus>([
  "CORE_REFERENCE",
  "CANONICAL_MEMORY",
]);

const SPECULATIVE_TRAVERSAL_REASON =
  "A speculative path exists but is excluded from canonical traversal.";

function walkDirected(
  view: ConnectomeView,
  from: string,
  to: string,
  maxDepth: number,
  allow: (rel: ConnectomeRelation) => boolean
): ConnectomePathHop[] | null {
  const adj = new Map<string, ConnectomeRelation[]>();
  for (const r of view.relations) {
    if (!allow(r)) continue;
    const list = adj.get(r.from) ?? [];
    list.push(r);
    adj.set(r.from, list);
  }
  for (const [, list] of adj) list.sort((a, b) => a.relationId.localeCompare(b.relationId));

  const queue: Array<{ node: string; hops: ConnectomePathHop[] }> = [{ node: from, hops: [] }];
  const visited = new Set<string>([from]);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.hops.length >= maxDepth) continue;
    for (const rel of adj.get(cur.node) ?? []) {
      if (visited.has(rel.to)) continue;
      const hop: ConnectomePathHop = {
        relationId: rel.relationId,
        from: rel.from,
        to: rel.to,
        type: rel.type,
        status: rel.status,
        explanation: rel.explanation,
      };
      const hops = [...cur.hops, hop];
      if (rel.to === to) return hops;
      visited.add(rel.to);
      queue.push({ node: rel.to, hops });
    }
  }
  return null;
}

export function traverseConnectome(
  view: ConnectomeView,
  from: string,
  to: string,
  maxDepth = 6
): ConnectomePath {
  if (from === to) {
    return { found: true, from, to, hops: [], reason: "Start and end are the same node." };
  }
  const canonical = walkDirected(view, from, to, maxDepth, (r) => CANONICAL_TRAVERSAL.has(r.status));
  if (canonical) {
    return {
      found: true,
      from,
      to,
      hops: canonical,
      reason: `Path of ${canonical.length} hop(s). Statuses are per-edge; inferred hops are not canonical.`,
    };
  }
  const speculative = walkDirected(
    view,
    from,
    to,
    maxDepth,
    (r) => r.status !== "REJECTED" && !CANONICAL_TRAVERSAL.has(r.status)
  );
  if (speculative) {
    return {
      found: false,
      from,
      to,
      hops: [],
      reason: SPECULATIVE_TRAVERSAL_REASON,
    };
  }
  return {
    found: false,
    from,
    to,
    hops: [],
    reason: "No path found within depth using directed edges. Absence is not proof of no relation.",
  };
}

export function createRelationProposal(
  spec: {
    from: string;
    to: string;
    type: HarborEdgeType;
    reason: string;
    evidenceMemoryIds?: string[];
  },
  actor: HarborActor,
  now: string
): RelationProposal {
  const proposalId = createHash("sha256")
    .update(`relprop:${spec.from}|${spec.to}|${spec.type}|${actor.id}|${now}|${spec.reason}`)
    .digest("hex")
    .slice(0, 24);
  return {
    proposalId,
    from: spec.from,
    to: spec.to,
    type: spec.type,
    status: "PROPOSED",
    reason: spec.reason,
    evidenceMemoryIds: [...(spec.evidenceMemoryIds ?? [])],
    createdAt: now,
    resultingEventIds: [],
    provenance: {
      sourceMemoryIds: [...(spec.evidenceMemoryIds ?? [])],
      sourceEventIds: [],
      agentId: actor.id,
      actorKind: actor.kind,
      createdAt: now,
      derivationType: "propose",
      confidence: 0.4,
      class: HARBOR_CLASS,
    },
    class: HARBOR_CLASS,
  };
}

export function canonicalRelationPayload(input: {
  from: string;
  to: string;
  type: HarborEdgeType;
  evidenceMemoryIds: string[];
  grantId: string;
  authorizedById: string;
}): { type: "structured"; structuredData: Record<string, unknown> } {
  return {
    type: "structured",
    structuredData: {
      kind: CONNECTOME_RELATION_CONTENT,
      schema: CONNECTOME_SCHEMA,
      from: input.from,
      to: input.to,
      type: input.type,
      evidenceMemoryIds: input.evidenceMemoryIds,
      grantId: input.grantId,
      authorizedById: input.authorizedById,
    },
  };
}

function makeRelation(input: {
  relationId: string;
  from: string;
  to: string;
  type: HarborEdgeType;
  status: RelationStatus;
  confidence: number;
  evidenceMemoryIds: string[];
  evidenceContradictionIds?: string[];
  evidenceReflectionIds?: string[];
  evidenceProposalIds?: string[];
  now: string;
  why: string;
  source: string;
  authority: string;
}): ConnectomeRelation {
  return {
    relationId: input.relationId,
    from: input.from,
    to: input.to,
    type: input.type,
    status: input.status,
    confidence: input.confidence,
    evidenceMemoryIds: [...new Set(input.evidenceMemoryIds)],
    evidenceContradictionIds: input.evidenceContradictionIds ?? [],
    evidenceReflectionIds: input.evidenceReflectionIds ?? [],
    evidenceProposalIds: input.evidenceProposalIds ?? [],
    competingRelationIds: [],
    createdAt: input.now,
    explanation: explain({
      type: input.type,
      from: input.from,
      to: input.to,
      status: input.status,
      why: input.why,
      source: input.source,
      when: input.now,
      authority: input.authority,
    }),
    class: HARBOR_CLASS,
  };
}

function explain(input: {
  type: HarborEdgeType;
  from: string;
  to: string;
  status: RelationStatus;
  why: string;
  source: string;
  when: string;
  authority: string;
}): RelationExplanation {
  return {
    what: `${input.from} ${input.type} ${input.to}`,
    why: input.why,
    source: input.source,
    status: input.status,
    when: input.when,
    authority: input.authority,
  };
}

function markCompeting(relations: ConnectomeRelation[]): void {
  const byPair = new Map<string, ConnectomeRelation[]>();
  for (const r of relations) {
    const key = [r.from, r.to].sort().join("|");
    const list = byPair.get(key) ?? [];
    list.push(r);
    byPair.set(key, list);
  }
  for (const group of byPair.values()) {
    const types = new Set(group.map((g) => g.type));
    if (types.has("CONTRADICTS") && (types.has("SUPPORTS") || types.size > 1)) {
      const ids = group.map((g) => g.relationId);
      for (const g of group) {
        g.competingRelationIds = ids.filter((id) => id !== g.relationId);
        if (g.status !== "CANONICAL_MEMORY" && g.status !== "CORE_REFERENCE") {
          g.status = "DISPUTED";
          g.explanation = { ...g.explanation, status: "DISPUTED", why: `${g.explanation.why} Competing relations on the same pair remain inspectable.` };
        }
      }
    }
  }
}

function mapCoreType(type: string): HarborEdgeType {
  const t = type.toUpperCase();
  if (t === "CONTRADICTS") return "CONTRADICTS";
  if (t === "SUPPORTS") return "SUPPORTS";
  if (t === "DERIVED_FROM") return "DERIVED_FROM";
  if (t === "PART_OF") return "PART_OF";
  return "RELATES_TO";
}

function labelOf(cell: MemoryCell): string {
  if (cell.meaning?.summary) return cell.meaning.summary;
  if (cell.content.type === "text") {
    const t = cell.content.text.trim();
    return t.length > 48 ? `${t.slice(0, 45)}...` : t;
  }
  if (isConnectomeRelationContent(cell.content)) return "connectome-relation";
  return cell.identity.shortId;
}
