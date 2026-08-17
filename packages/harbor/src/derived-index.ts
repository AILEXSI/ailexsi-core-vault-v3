/**
 * Durable Derived Index — V3-DERIVED only.
 * JSON files on disk. Never EventStore. Never Core.
 *
 * Layout (persistDir):
 *   index.json           ready snapshot
 *   index.json.tmp       atomic write scratch
 *   rebuilding.marker    present while rebuild is in progress
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  ContradictionRecord,
  EpistemicRecord,
  HarborProposal,
  ProviderInvocation,
  ReflectionArtifact,
} from "./types.js";
import { HARBOR_CLASS } from "./types.js";

export const DERIVED_INDEX_SCHEMA = "harbor-derived-index-v1" as const;

export type DerivedIndexStatus =
  | "empty"
  | "ready"
  | "rebuilding"
  | "corrupt"
  | "schema_mismatch"
  | "interrupted";

export interface DerivedIndexDocument {
  schemaVersion: typeof DERIVED_INDEX_SCHEMA;
  class: typeof HARBOR_CLASS;
  kind: "derived-index";
  corePin: string;
  vaultReferenceSha: string;
  rebuiltAt: string;
  rebuildGeneration: number;
  status: DerivedIndexStatus;
  epistemic: EpistemicRecord[];
  contradictions: ContradictionRecord[];
  reflections: ReflectionArtifact[];
  proposals: HarborProposal[];
  invocations: ProviderInvocation[];
  fingerprint: string;
}

export interface DerivedIndexLoadResult {
  status: DerivedIndexStatus;
  document: DerivedIndexDocument | null;
  reason?: string;
}

export function rebuildFingerprint(input: {
  epistemic: EpistemicRecord[];
  contradictions: ContradictionRecord[];
  reflections: ReflectionArtifact[];
}): string {
  const payload = {
    epistemic: [...input.epistemic].sort((a, b) => a.memoryId.localeCompare(b.memoryId)),
    contradictions: [...input.contradictions].sort((a, b) => a.id.localeCompare(b.id)),
    reflections: [...input.reflections].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildDerivedDocument(input: {
  corePin: string;
  vaultReferenceSha: string;
  rebuiltAt: string;
  rebuildGeneration: number;
  status: DerivedIndexStatus;
  epistemic: EpistemicRecord[];
  contradictions: ContradictionRecord[];
  reflections: ReflectionArtifact[];
  proposals: HarborProposal[];
  invocations: ProviderInvocation[];
}): DerivedIndexDocument {
  return {
    schemaVersion: DERIVED_INDEX_SCHEMA,
    class: HARBOR_CLASS,
    kind: "derived-index",
    corePin: input.corePin,
    vaultReferenceSha: input.vaultReferenceSha,
    rebuiltAt: input.rebuiltAt,
    rebuildGeneration: input.rebuildGeneration,
    status: input.status,
    epistemic: input.epistemic,
    contradictions: input.contradictions,
    reflections: input.reflections,
    proposals: input.proposals,
    invocations: input.invocations,
    fingerprint: rebuildFingerprint(input),
  };
}

export class FileDerivedIndex {
  readonly persistDir: string;
  readonly indexPath: string;
  readonly tmpPath: string;
  readonly markerPath: string;

  constructor(persistDir: string) {
    this.persistDir = persistDir;
    this.indexPath = path.join(persistDir, "index.json");
    this.tmpPath = path.join(persistDir, "index.json.tmp");
    this.markerPath = path.join(persistDir, "rebuilding.marker");
  }

  ensureDir(): void {
    mkdirSync(this.persistDir, { recursive: true });
  }

  hasMarker(): boolean {
    return existsSync(this.markerPath);
  }

  markRebuilding(): void {
    this.ensureDir();
    writeFileSync(this.markerPath, "rebuilding\n", "utf8");
  }

  clearMarker(): void {
    if (existsSync(this.markerPath)) unlinkSync(this.markerPath);
  }

  load(): DerivedIndexLoadResult {
    if (this.hasMarker() && !existsSync(this.indexPath)) {
      return { status: "interrupted", document: null, reason: "rebuild marker without index" };
    }
    if (this.hasMarker() && existsSync(this.indexPath)) {
      const inner = this.readDocument();
      if (inner.status === "ready" && inner.document) {
        return {
          status: "interrupted",
          document: inner.document,
          reason: "rebuild marker present; last ready snapshot retained",
        };
      }
      return { status: "interrupted", document: null, reason: "rebuild interrupted; snapshot unreadable" };
    }
    if (!existsSync(this.indexPath)) {
      return { status: "empty", document: null };
    }
    return this.readDocument();
  }

  save(doc: DerivedIndexDocument): void {
    this.ensureDir();
    const body = JSON.stringify(doc, null, 2) + "\n";
    writeFileSync(this.tmpPath, body, "utf8");
    try {
      renameSync(this.tmpPath, this.indexPath);
    } catch {
      if (existsSync(this.indexPath)) unlinkSync(this.indexPath);
      renameSync(this.tmpPath, this.indexPath);
    }
    this.clearMarker();
  }

  clearFiles(): void {
    for (const p of [this.indexPath, this.tmpPath, this.markerPath]) {
      if (existsSync(p)) unlinkSync(p);
    }
  }

  private readDocument(): DerivedIndexLoadResult {
    let raw: string;
    try {
      raw = readFileSync(this.indexPath, "utf8");
    } catch (e) {
      return { status: "corrupt", document: null, reason: String(e) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "corrupt", document: null, reason: "JSON parse failed" };
    }
    if (!parsed || typeof parsed !== "object") {
      return { status: "corrupt", document: null, reason: "not an object" };
    }
    const doc = parsed as DerivedIndexDocument;
    if (doc.schemaVersion !== DERIVED_INDEX_SCHEMA) {
      return { status: "schema_mismatch", document: doc, reason: `schema=${String(doc.schemaVersion)}` };
    }
    if (doc.kind !== "derived-index" || doc.class !== HARBOR_CLASS) {
      return { status: "corrupt", document: null, reason: "kind/class mismatch" };
    }
    return { status: doc.status === "ready" ? "ready" : doc.status, document: doc };
  }
}
