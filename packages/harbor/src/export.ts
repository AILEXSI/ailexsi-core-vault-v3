import { createHash } from "node:crypto";
import type {
  ContradictionRecord,
  EpistemicRecord,
  HarborProposal,
  ProviderInvocation,
  ReflectionArtifact,
} from "./types.js";
import { HARBOR_CLASS, HARBOR_VERSION } from "./types.js";

export const HARBOR_EXPORT_SCHEMA = "harbor-export-v1" as const;

export interface HarborExportPackage {
  schemaVersion: typeof HARBOR_EXPORT_SCHEMA;
  kind: "harbor-export";
  class: typeof HARBOR_CLASS;
  v3Version: string;
  corePin: string;
  vaultReferenceSha: string;
  createdAt: string;
  selectedCanonicalMemoryIds: string[];
  epistemic: EpistemicRecord[];
  contradictions: ContradictionRecord[];
  reflections: ReflectionArtifact[];
  proposals: HarborProposal[];
  invocations: ProviderInvocation[];
  integrity: { sha256: string };
}

export function buildHarborExport(input: Omit<HarborExportPackage, "integrity" | "schemaVersion" | "kind" | "class" | "v3Version"> & {
  v3Version?: string;
}): HarborExportPackage {
  const base: Omit<HarborExportPackage, "integrity"> = {
    schemaVersion: HARBOR_EXPORT_SCHEMA,
    kind: "harbor-export",
    class: HARBOR_CLASS,
    v3Version: input.v3Version ?? HARBOR_VERSION,
    corePin: input.corePin,
    vaultReferenceSha: input.vaultReferenceSha,
    createdAt: input.createdAt,
    selectedCanonicalMemoryIds: input.selectedCanonicalMemoryIds,
    epistemic: input.epistemic,
    contradictions: input.contradictions,
    reflections: input.reflections,
    proposals: input.proposals,
    invocations: input.invocations,
  };
  const sha256 = createHash("sha256").update(stable(base)).digest("hex");
  return { ...base, integrity: { sha256 } };
}

export function inspectHarborExport(pkg: HarborExportPackage): {
  ok: boolean;
  canonicalCount: number;
  derivedCounts: Record<string, number>;
} {
  return {
    ok: verifyHarborExport(pkg),
    canonicalCount: pkg.selectedCanonicalMemoryIds.length,
    derivedCounts: {
      epistemic: pkg.epistemic.length,
      contradictions: pkg.contradictions.length,
      reflections: pkg.reflections.length,
      proposals: pkg.proposals.length,
      invocations: pkg.invocations.length,
    },
  };
}

export function verifyHarborExport(pkg: HarborExportPackage): boolean {
  const { integrity, ...rest } = pkg;
  return createHash("sha256").update(stable(rest)).digest("hex") === integrity.sha256;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}
