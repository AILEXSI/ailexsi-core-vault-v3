import { buildConnectome, type ConnectomeGraph } from "@ailexsi/v2-connectome";
import type { MemoryCell } from "@ailexsi/contracts";
import type {
  ConnectomeOrigin,
  ContradictionRecord,
  HarborEdgeType,
  HarborNodeKind,
  HarborProposal,
  ReflectionArtifact,
} from "./types.js";

export interface HarborGraphNode {
  id: string;
  kind: HarborNodeKind;
  label: string;
  origin: ConnectomeOrigin;
}

export interface HarborGraphEdge {
  id: string;
  from: string;
  to: string;
  type: HarborEdgeType;
  origin: ConnectomeOrigin;
  evidence?: string;
}

export interface HarborConnectome {
  baseline: ConnectomeGraph;
  nodes: HarborGraphNode[];
  edges: HarborGraphEdge[];
  class: "V3-DERIVED";
}

export function buildHarborConnectome(opts: {
  memories: MemoryCell[];
  contradictions?: ContradictionRecord[];
  reflections?: ReflectionArtifact[];
  proposals?: HarborProposal[];
}): HarborConnectome {
  const baseline = buildConnectome(opts.memories);
  const nodes: HarborGraphNode[] = baseline.nodes.map((n) => ({
    id: n.id,
    kind: "MEMORY",
    label: n.label,
    origin: "CANONICAL_REFERENCE",
  }));
  const edges: HarborGraphEdge[] = baseline.edges.map((e) => {
    const evidence = e.reason;
    const derived = e.source !== "CORE-BACKED";
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      type: e.type === "derived_from" ? "DERIVED_FROM" : "RELATES_TO",
      origin: !derived
        ? "CANONICAL_REFERENCE"
        : evidence
          ? "DERIVED"
          : "INFERRED",
      evidence,
    };
  });

  for (const c of opts.contradictions ?? []) {
    nodes.push({
      id: `contradiction:${c.id}`,
      kind: "QUESTION",
      label: `Contradiction ${c.excerptA} vs ${c.excerptB}`,
      origin: "INFERRED",
    });
    edges.push({
      id: `c-a-${c.id}`,
      from: `contradiction:${c.id}`,
      to: c.memoryIdA,
      type: "CONTRADICTS",
      origin: "INFERRED",
      evidence: c.id,
    });
    edges.push({
      id: `c-b-${c.id}`,
      from: `contradiction:${c.id}`,
      to: c.memoryIdB,
      type: "CONTRADICTS",
      origin: "INFERRED",
      evidence: c.id,
    });
  }

  for (const r of opts.reflections ?? []) {
    nodes.push({
      id: `reflection:${r.id}`,
      kind: "REFLECTION",
      label: r.findings[0]?.statement ?? "Reflection",
      origin: "DERIVED",
    });
    for (const ev of r.provenance.sourceMemoryIds) {
      edges.push({
        id: `ref-${r.id}-${ev}`,
        from: `reflection:${r.id}`,
        to: ev,
        type: "DERIVED_FROM",
        origin: "DERIVED",
        evidence: r.id,
      });
    }
  }

  for (const p of opts.proposals ?? []) {
    nodes.push({
      id: `proposal:${p.proposalId}`,
      kind: "PROPOSAL",
      label: p.proposalType,
      origin: p.status === "ACCEPTED" ? "USER_CONFIRMED" : "DERIVED",
    });
    for (const src of p.sourceMemoryIds) {
      edges.push({
        id: `prop-${p.proposalId}-${src}`,
        from: `proposal:${p.proposalId}`,
        to: src,
        type: "ABOUT",
        origin: "DERIVED",
        evidence: p.proposalId,
      });
    }
  }

  return { baseline, nodes, edges, class: "V3-DERIVED" };
}
