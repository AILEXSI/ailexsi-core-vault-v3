/**
 * Continuity Foundation v1 — DERIVED portable package (not Core SoT).
 */

export const CONTINUITY_V1_SCHEMA = "continuity-v1" as const;
export const CONTINUITY_V1_KIND = "continuity-package" as const;

export type ContinuitySelectionMode = "ids" | "retrieve";

/** Mirrors retrieval filters without inventing new ranking. */
export type ContinuityRetrieveParams = {
  tagsAny?: string[];
  project?: string;
  lifecycle?: "active" | "archived";
  includeArchived?: boolean;
  textContains?: string;
  pageSize: number;
  afterCursor?: string | null;
};

export type ContinuityContextParams = {
  maxItems: number;
  maxChars: number;
  includeHistory?: boolean;
  maxHistoryEvents?: number;
};

export type ContinuitySelection = {
  mode: ContinuitySelectionMode;
  memoryIds?: string[];
  retrieve?: ContinuityRetrieveParams;
  context?: ContinuityContextParams;
};

export type ContinuityInspectionItem = {
  id: string;
  shortId: string;
  version: number;
  lifecycleState: string;
  title: string;
  updatedAt: string;
  tags: string[];
  project?: string;
  _meta: { class: "CORE-CANONICAL" };
};

export type ContinuityPackageV1 = {
  schemaVersion: typeof CONTINUITY_V1_SCHEMA;
  kind: typeof CONTINUITY_V1_KIND;
  coreBaselineSha: string;
  vaultReferenceSha: string;
  selection: ContinuitySelection;
  orderedMemoryIds: string[];
  classifications: {
    package: "V2-DERIVED";
    orderedMemoryIds: "CORE-CANONICAL";
    selection: "V2-DERIVED";
    inspection: "CORE-CANONICAL" | "ABSENT";
  };
  inspection?: {
    memories: ContinuityInspectionItem[];
    _meta: { class: "CORE-CANONICAL" };
  };
  auditOnly?: {
    generatedAt: string;
  };
};

export type ContinuityPackageIdentity = Omit<ContinuityPackageV1, "auditOnly">;

export function stripAuditOnly(
  pkg: ContinuityPackageV1
): ContinuityPackageIdentity {
  const { auditOnly: _a, ...rest } = pkg;
  return rest;
}

export function packagesIdentityEqual(
  a: ContinuityPackageV1,
  b: ContinuityPackageV1
): boolean {
  return (
    JSON.stringify(stripAuditOnly(a)) === JSON.stringify(stripAuditOnly(b))
  );
}

export function buildContinuityPackageV1(input: {
  coreBaselineSha: string;
  vaultReferenceSha: string;
  selection: ContinuitySelection;
  orderedMemoryIds: string[];
  inspectionMemories?: ContinuityInspectionItem[];
  generatedAt?: string;
}): ContinuityPackageV1 {
  if (!input.coreBaselineSha || !input.vaultReferenceSha) {
    throw new Error("coreBaselineSha and vaultReferenceSha are required");
  }
  if (!Array.isArray(input.orderedMemoryIds)) {
    throw new Error("orderedMemoryIds required");
  }
  // dedupe preserving first-seen order
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of input.orderedMemoryIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }

  const pkg: ContinuityPackageV1 = {
    schemaVersion: CONTINUITY_V1_SCHEMA,
    kind: CONTINUITY_V1_KIND,
    coreBaselineSha: input.coreBaselineSha,
    vaultReferenceSha: input.vaultReferenceSha,
    selection: input.selection,
    orderedMemoryIds: ordered,
    classifications: {
      package: "V2-DERIVED",
      orderedMemoryIds: "CORE-CANONICAL",
      selection: "V2-DERIVED",
      inspection: input.inspectionMemories?.length
        ? "CORE-CANONICAL"
        : "ABSENT",
    },
  };

  if (input.inspectionMemories?.length) {
    pkg.inspection = {
      memories: input.inspectionMemories.map((m) => ({
        ...m,
        _meta: { class: "CORE-CANONICAL" as const },
      })),
      _meta: { class: "CORE-CANONICAL" },
    };
  }

  if (input.generatedAt !== undefined) {
    pkg.auditOnly = { generatedAt: input.generatedAt };
  }

  return pkg;
}

export function serializeContinuityV1(pkg: ContinuityPackageV1): string {
  return JSON.stringify(pkg);
}

export function parseContinuityV1(json: string): ContinuityPackageV1 {
  const parsed = JSON.parse(json) as ContinuityPackageV1;
  if (parsed.schemaVersion !== CONTINUITY_V1_SCHEMA) {
    throw new Error(`Unsupported continuity schema: ${parsed.schemaVersion}`);
  }
  if (parsed.kind !== CONTINUITY_V1_KIND) {
    throw new Error(`Invalid continuity kind: ${parsed.kind}`);
  }
  if (!parsed.coreBaselineSha || !parsed.vaultReferenceSha) {
    throw new Error("Package missing baseline pins");
  }
  if (!Array.isArray(parsed.orderedMemoryIds)) {
    throw new Error("Package missing orderedMemoryIds");
  }
  if (!parsed.selection?.mode) {
    throw new Error("Package missing selection.mode");
  }
  return parsed;
}

export function inspectContinuityV1(pkg: ContinuityPackageV1): {
  memoryCount: number;
  orderedMemoryIds: string[];
  mode: ContinuitySelectionMode;
  pins: { core: string; vault: string };
  classifications: ContinuityPackageV1["classifications"];
} {
  return {
    memoryCount: pkg.orderedMemoryIds.length,
    orderedMemoryIds: [...pkg.orderedMemoryIds],
    mode: pkg.selection.mode,
    pins: { core: pkg.coreBaselineSha, vault: pkg.vaultReferenceSha },
    classifications: pkg.classifications,
  };
}
