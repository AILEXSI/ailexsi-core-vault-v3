import type { MemoryCell } from "@ailexsi/contracts";
import type {
  ContinuityPackage,
  ContinuityMemoryFact,
  ContinuityFieldMeta,
} from "./types.js";

const CORE_CANONICAL: ContinuityFieldMeta = {
  class: "CORE-CANONICAL",
  description: "Projected from Core Memory / EventStore; reconstructible via replay",
};

const V2_DERIVED: ContinuityFieldMeta = {
  class: "V2-DERIVED",
  description: "V2-derived packaging; not an independent canonical store",
};

const V2_EPHEMERAL: ContinuityFieldMeta = {
  class: "V2-EPHEMERAL",
  description: "Session/UI state; not fully replayable as canonical fact",
};

export interface ContinuityBuildInput {
  memories: MemoryCell[];
  coreBaselineSha: string;
  vaultReferenceSha: string;
  derivedRelationships?: ContinuityPackage["derivedRelationships"];
  cultivationSummary?: string;
  cultivationSessionId?: string;
  ephemeralNotes?: string[];
  createdAt?: string;
}

function toFact(cell: MemoryCell): ContinuityMemoryFact {
  return {
    memoryId: cell.identity.id,
    shortId: cell.identity.shortId,
    content: cell.content,
    context: cell.context,
    meaning: cell.meaning,
    provenance: cell.provenance,
    lifecycle: cell.lifecycle,
    currentVersion: cell.currentVersion,
    timestamps: cell.timestamps,
    relationRefs: cell.relationRefs,
    _meta: CORE_CANONICAL,
  };
}

export function buildContinuityPackage(
  input: ContinuityBuildInput
): ContinuityPackage {
  const createdAt =
    input.createdAt ??
    new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");

  const relations = (input.derivedRelationships ?? []).map((r) => ({
    ...r,
    _meta: r._meta ?? V2_DERIVED,
  }));

  return {
    schemaVersion: "v2.0.0-foundation",
    kind: "continuity-snapshot",
    createdAt,
    coreBaselineSha: input.coreBaselineSha,
    vaultReferenceSha: input.vaultReferenceSha,
    canonicalMemories: input.memories.map(toFact),
    derivedRelationships: relations,
    cultivationContext: input.cultivationSummary
      ? {
          sessionId: input.cultivationSessionId,
          summary: input.cultivationSummary,
          _meta: V2_DERIVED,
        }
      : undefined,
    ephemeralNotes: (input.ephemeralNotes ?? []).map((text) => ({
      text,
      _meta: V2_EPHEMERAL,
    })),
    metadata: {
      memoryCount: input.memories.length,
      relationshipCount: relations.length,
      _meta: V2_DERIVED,
    },
  };
}

export function serializeContinuity(pkg: ContinuityPackage): string {
  return JSON.stringify(pkg, null, 2);
}

export function parseContinuity(json: string): ContinuityPackage {
  const parsed = JSON.parse(json) as ContinuityPackage;
  if (parsed.kind !== "continuity-snapshot") {
    throw new Error("Invalid continuity package kind");
  }
  if (parsed.schemaVersion !== "v2.0.0-foundation") {
    throw new Error(`Unsupported continuity schema: ${parsed.schemaVersion}`);
  }
  return parsed;
}

/**
 * Extract CORE-CANONICAL memory ids for reconstructibility checks.
 * Does not claim full replay of ephemeral notes.
 */
export function canonicalMemoryIds(pkg: ContinuityPackage): string[] {
  return pkg.canonicalMemories
    .filter((m) => m._meta.class === "CORE-CANONICAL")
    .map((m) => m.memoryId)
    .sort();
}
