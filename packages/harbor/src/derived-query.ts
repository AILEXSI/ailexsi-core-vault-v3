/**
 * Deterministic read model over the durable Derived Index.
 * READ-ONLY. Never EventStore. Never Core. Never persist.
 */
import {
  DERIVED_INDEX_SCHEMA,
  FileDerivedIndex,
  rebuildFingerprint,
  type DerivedIndexStatus,
} from "./derived-index.js";
import { HARBOR_CLASS } from "./types.js";
import type {
  ArtifactProvenance,
  ContradictionRecord,
  ContradictionResolution,
  EpistemicRecord,
  EpistemicStatus,
  HarborActor,
  HarborProposal,
  ReflectionArtifact,
} from "./types.js";

export interface DerivedQueryPageRequest {
  offset?: number;
  limit?: number;
}

export interface DerivedQueryPage<T> {
  class: typeof HARBOR_CLASS;
  items: T[];
  offset: number;
  limit: number;
  total: number;
  truncated: boolean;
}

export interface DerivedMemoryView {
  id: string;
  kind: "epistemic";
  memoryId: string;
  status: EpistemicStatus;
  confidence: number;
  evidenceEventIds: string[];
  lastChangedAt: string;
  changedBy: HarborActor;
  note?: string;
  class: typeof HARBOR_CLASS;
}

export type DerivedRecordKind = "epistemic" | "contradiction" | "reflection" | "proposal";

export interface DerivedRecordHit {
  id: string;
  kind: DerivedRecordKind;
  sourceMemoryIds: string[];
  class: typeof HARBOR_CLASS;
}

export interface DerivedProvenanceView {
  id: string;
  kind: DerivedRecordKind;
  sourceMemoryIds: string[];
  sourceEventIds: string[];
  provenance?: ArtifactProvenance;
  changedBy?: HarborActor;
  class: typeof HARBOR_CLASS;
}

export interface DerivedQuerySnapshot {
  status: DerivedIndexStatus;
  reason?: string;
  persistDir: string | null;
  durable: boolean;
  fingerprint: string;
  rebuildGeneration: number;
  corePin: string;
  vaultReferenceSha: string;
  schemaVersion: typeof DERIVED_INDEX_SCHEMA;
  epistemic: EpistemicRecord[];
  contradictions: ContradictionRecord[];
  reflections: ReflectionArtifact[];
  proposals: HarborProposal[];
}

export type DerivedQuerySource = () => DerivedQuerySnapshot;

export interface ContradictionQuery extends DerivedQueryPageRequest {
  resolution?: ContradictionResolution;
  sourceMemoryId?: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function pageOf<T>(items: T[], request?: DerivedQueryPageRequest): DerivedQueryPage<T> {
  const total = items.length;
  const offset = Math.max(0, request?.offset ?? 0);
  const limit = request?.limit === undefined ? Math.max(0, total - offset) : Math.max(0, request.limit);
  const sliced = items.slice(offset, offset + limit).map((item) => clone(item));
  return {
    class: HARBOR_CLASS,
    items: sliced,
    offset,
    limit,
    total,
    truncated: offset + sliced.length < total,
  };
}

function byId(a: string, b: string): number {
  return a.localeCompare(b);
}

function memoryView(rec: EpistemicRecord): DerivedMemoryView {
  return {
    id: rec.memoryId,
    kind: "epistemic",
    memoryId: rec.memoryId,
    status: rec.status,
    confidence: rec.confidence,
    evidenceEventIds: [...rec.evidenceEventIds],
    lastChangedAt: rec.lastChangedAt,
    changedBy: clone(rec.changedBy),
    note: rec.note,
    class: HARBOR_CLASS,
  };
}

function sourceIdsForContradiction(rec: ContradictionRecord): string[] {
  return [...new Set([...rec.provenance.sourceMemoryIds, rec.memoryIdA, rec.memoryIdB])].sort(byId);
}

function kindOrder(kind: DerivedRecordKind): number {
  switch (kind) {
    case "epistemic":
      return 0;
    case "contradiction":
      return 1;
    case "reflection":
      return 2;
    case "proposal":
      return 3;
  }
}

export function emptyDerivedQuerySnapshot(
  extras?: Partial<Pick<DerivedQuerySnapshot, "status" | "reason" | "persistDir" | "durable" | "corePin" | "vaultReferenceSha">>
): DerivedQuerySnapshot {
  return {
    status: extras?.status ?? "empty",
    reason: extras?.reason,
    persistDir: extras?.persistDir ?? null,
    durable: extras?.durable ?? false,
    fingerprint: rebuildFingerprint({ epistemic: [], contradictions: [], reflections: [] }),
    rebuildGeneration: 0,
    corePin: extras?.corePin ?? "",
    vaultReferenceSha: extras?.vaultReferenceSha ?? "",
    schemaVersion: DERIVED_INDEX_SCHEMA,
    epistemic: [],
    contradictions: [],
    reflections: [],
    proposals: [],
  };
}

export function loadDerivedQuerySnapshot(persistDir: string): DerivedQuerySnapshot {
  const index = new FileDerivedIndex(persistDir);
  const loaded = index.load();
  const base = emptyDerivedQuerySnapshot({
    status: loaded.status,
    reason: loaded.reason,
    persistDir,
    durable: true,
  });
  const doc = loaded.document;
  if (!doc || (loaded.status !== "ready" && loaded.status !== "interrupted")) {
    return base;
  }
  return {
    ...base,
    corePin: doc.corePin,
    vaultReferenceSha: doc.vaultReferenceSha,
    rebuildGeneration: doc.rebuildGeneration,
    fingerprint: rebuildFingerprint(doc),
    epistemic: clone(doc.epistemic),
    contradictions: clone(doc.contradictions),
    reflections: clone(doc.reflections),
    proposals: clone(doc.proposals),
  };
}

export class DerivedQueryService {
  constructor(private readonly source: DerivedQuerySource) {}

  static fromSnapshot(snapshot: DerivedQuerySnapshot): DerivedQueryService {
    const frozen = clone(snapshot);
    return new DerivedQueryService(() => frozen);
  }

  static fromIndex(persistDir: string): DerivedQueryService {
    return DerivedQueryService.fromSnapshot(loadDerivedQuerySnapshot(persistDir));
  }

  status(): Pick<
    DerivedQuerySnapshot,
    "status" | "reason" | "persistDir" | "durable" | "fingerprint" | "rebuildGeneration" | "schemaVersion" | "corePin" | "vaultReferenceSha"
  > {
    const snap = this.source();
    return {
      status: snap.status,
      reason: snap.reason,
      persistDir: snap.persistDir,
      durable: snap.durable,
      fingerprint: snap.fingerprint,
      rebuildGeneration: snap.rebuildGeneration,
      schemaVersion: snap.schemaVersion,
      corePin: snap.corePin,
      vaultReferenceSha: snap.vaultReferenceSha,
    };
  }

  getDerivedMemory(id: string): DerivedMemoryView | null {
    const rec = this.source().epistemic.find((e) => e.memoryId === id);
    return rec ? memoryView(rec) : null;
  }

  listDerivedMemories(request?: DerivedQueryPageRequest): DerivedQueryPage<DerivedMemoryView> {
    const items = [...this.source().epistemic]
      .sort((a, b) => byId(a.memoryId, b.memoryId))
      .map(memoryView);
    return pageOf(items, request);
  }

  findDerivedByStatus(
    status: EpistemicStatus,
    request?: DerivedQueryPageRequest
  ): DerivedQueryPage<DerivedMemoryView> {
    const items = [...this.source().epistemic]
      .filter((e) => e.status === status)
      .sort((a, b) => byId(a.memoryId, b.memoryId))
      .map(memoryView);
    return pageOf(items, request);
  }

  findDerivedBySource(
    memoryId: string,
    request?: DerivedQueryPageRequest
  ): DerivedQueryPage<DerivedRecordHit> {
    const snap = this.source();
    const hits: DerivedRecordHit[] = [];
    for (const e of snap.epistemic) {
      if (e.memoryId === memoryId) {
        hits.push({
          id: e.memoryId,
          kind: "epistemic",
          sourceMemoryIds: [e.memoryId],
          class: HARBOR_CLASS,
        });
      }
    }
    for (const c of snap.contradictions) {
      const sourceMemoryIds = sourceIdsForContradiction(c);
      if (sourceMemoryIds.includes(memoryId)) {
        hits.push({ id: c.id, kind: "contradiction", sourceMemoryIds, class: HARBOR_CLASS });
      }
    }
    for (const r of snap.reflections) {
      if (r.provenance.sourceMemoryIds.includes(memoryId)) {
        hits.push({
          id: r.id,
          kind: "reflection",
          sourceMemoryIds: [...r.provenance.sourceMemoryIds].sort(byId),
          class: HARBOR_CLASS,
        });
      }
    }
    for (const p of snap.proposals) {
      const sourceMemoryIds = [...new Set([...p.sourceMemoryIds, ...p.provenance.sourceMemoryIds])].sort(byId);
      if (sourceMemoryIds.includes(memoryId)) {
        hits.push({ id: p.proposalId, kind: "proposal", sourceMemoryIds, class: HARBOR_CLASS });
      }
    }
    hits.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || byId(a.id, b.id));
    return pageOf(hits, request);
  }

  findContradictions(request?: ContradictionQuery): DerivedQueryPage<ContradictionRecord> {
    let items = [...this.source().contradictions];
    if (request?.resolution) {
      items = items.filter((c) => c.resolution === request.resolution);
    }
    if (request?.sourceMemoryId) {
      items = items.filter((c) => sourceIdsForContradiction(c).includes(request.sourceMemoryId!));
    }
    items.sort((a, b) => byId(a.id, b.id));
    return pageOf(items, request);
  }

  getDerivedProvenance(id: string): DerivedProvenanceView | null {
    const snap = this.source();
    const epistemic = snap.epistemic.find((e) => e.memoryId === id);
    if (epistemic) {
      return {
        id: epistemic.memoryId,
        kind: "epistemic",
        sourceMemoryIds: [epistemic.memoryId],
        sourceEventIds: [...epistemic.evidenceEventIds],
        changedBy: clone(epistemic.changedBy),
        class: HARBOR_CLASS,
      };
    }
    const contradiction = snap.contradictions.find((c) => c.id === id);
    if (contradiction) {
      return {
        id: contradiction.id,
        kind: "contradiction",
        sourceMemoryIds: sourceIdsForContradiction(contradiction),
        sourceEventIds: [...contradiction.provenance.sourceEventIds],
        provenance: clone(contradiction.provenance),
        class: HARBOR_CLASS,
      };
    }
    const reflection = snap.reflections.find((r) => r.id === id);
    if (reflection) {
      return {
        id: reflection.id,
        kind: "reflection",
        sourceMemoryIds: [...reflection.provenance.sourceMemoryIds].sort(byId),
        sourceEventIds: [...reflection.provenance.sourceEventIds],
        provenance: clone(reflection.provenance),
        class: HARBOR_CLASS,
      };
    }
    const proposal = snap.proposals.find((p) => p.proposalId === id);
    if (proposal) {
      return {
        id: proposal.proposalId,
        kind: "proposal",
        sourceMemoryIds: [...new Set([...proposal.sourceMemoryIds, ...proposal.provenance.sourceMemoryIds])].sort(
          byId
        ),
        sourceEventIds: [...proposal.provenance.sourceEventIds],
        provenance: clone(proposal.provenance),
        class: HARBOR_CLASS,
      };
    }
    return null;
  }
}
