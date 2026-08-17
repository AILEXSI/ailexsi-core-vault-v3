/**
 * V2 Connectome presentation.
 *
 * MVP: derive graph from Core Memory.relationRefs + parentMemoryIds provenance.
 * Does NOT introduce a Core Relation aggregate.
 * Full Connectome ontology = PLANNED / FUTURE CORE DOMAIN extension.
 */

import type { MemoryCell, RelationType, UUID } from "@ailexsi/contracts";

export interface ConnectomeNode {
  id: UUID;
  shortId: string;
  label: string;
  lifecycleState: string;
  source: "CORE-CANONICAL";
}

export interface ConnectomeEdge {
  id: string;
  from: UUID;
  to: UUID;
  type: string;
  direction: "outgoing" | "incoming" | "undirected";
  source: "CORE-BACKED" | "V2-DERIVED";
  reason?: string;
}

export interface ConnectomeGraph {
  nodes: ConnectomeNode[];
  edges: ConnectomeEdge[];
  /** Explicit status for honesty. */
  status: {
    coreRelationAggregate: "PLANNED";
    fullOntology: "PLANNED";
    mvp: "VERIFIED" | "PARTIAL";
  };
}

function labelOf(cell: MemoryCell): string {
  if (cell.meaning?.summary) return cell.meaning.summary;
  if (cell.content.type === "text") {
    const t = cell.content.text.trim();
    return t.length > 48 ? `${t.slice(0, 45)}...` : t;
  }
  return cell.identity.shortId;
}

export function buildConnectome(memories: MemoryCell[]): ConnectomeGraph {
  const nodes: ConnectomeNode[] = memories.map((m) => ({
    id: m.identity.id,
    shortId: m.identity.shortId,
    label: labelOf(m),
    lifecycleState: m.lifecycle.state,
    source: "CORE-CANONICAL",
  }));

  const edges: ConnectomeEdge[] = [];
  const seen = new Set<string>();

  for (const m of memories) {
    for (const ref of m.relationRefs) {
      const key = `${ref.relationId}:${ref.direction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        id: ref.relationId,
        from: ref.direction === "outgoing" ? m.identity.id : ref.targetMemoryId,
        to: ref.direction === "outgoing" ? ref.targetMemoryId : m.identity.id,
        type: ref.type as RelationType,
        direction: ref.direction,
        source: "CORE-BACKED",
      });
    }

    // V2-derived edges from provenance parents (no Core Relation domain)
    for (const parentId of m.provenance.parentMemoryIds) {
      const key = `derived:${parentId}->${m.identity.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        id: key,
        from: parentId,
        to: m.identity.id,
        type: "derived_from",
        direction: "outgoing",
        source: "V2-DERIVED",
        reason: "provenance.parentMemoryIds",
      });
    }
  }

  return {
    nodes,
    edges,
    status: {
      coreRelationAggregate: "PLANNED",
      fullOntology: "PLANNED",
      mvp: edges.length > 0 || nodes.length > 0 ? "PARTIAL" : "PARTIAL",
    },
  };
}
