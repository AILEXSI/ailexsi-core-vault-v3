import { randomUUID } from "node:crypto";
import type { ContradictionRecord, HarborActor } from "./types.js";
import { HARBOR_CLASS } from "./types.js";
import {
  inspectHarborExport,
  verifyHarborExport,
  type HarborExportPackage,
} from "./export.js";
import { detectContradictions } from "./contradiction.js";

export type ImportStage =
  | "SCANNED"
  | "VALIDATED"
  | "PREVIEWED"
  | "CONFLICTS_DETECTED"
  | "AWAITING_CONFIRMATION"
  | "APPLIED"
  | "REJECTED"
  | "BLOCKED";

export interface ImportIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface ImportPreview {
  canonicalIdsReferenced: string[];
  derivedCounts: Record<string, number>;
  wouldWriteCanonical: false;
  wouldWriteDerived: true;
}

export interface ImportSession {
  id: string;
  stage: ImportStage;
  createdAt: string;
  pkg: HarborExportPackage | null;
  issues: ImportIssue[];
  preview?: ImportPreview;
  conflicts: ContradictionRecord[];
  confirmedBy?: HarborActor;
  appliedAt?: string;
  class: typeof HARBOR_CLASS;
}

const EXPECTED_CORE = "652d01eb06dd0841c3b475023883675af6dcd698";

export function createImportSession(now: string): ImportSession {
  return {
    id: randomUUID(),
    stage: "SCANNED",
    createdAt: now,
    pkg: null,
    issues: [],
    conflicts: [],
    class: HARBOR_CLASS,
  };
}

export function scanImportPayload(raw: unknown, session: ImportSession): ImportSession {
  const issues: ImportIssue[] = [];
  if (raw == null || typeof raw !== "object") {
    issues.push({ severity: "error", code: "not_object", message: "Payload is not an object" });
    return { ...session, stage: "BLOCKED", pkg: null, issues };
  }
  const pkg = raw as HarborExportPackage;
  if (pkg.kind !== "harbor-export") {
    issues.push({ severity: "error", code: "bad_kind", message: `kind=${String(pkg.kind)}` });
  }
  if (pkg.schemaVersion !== "harbor-export-v1") {
    issues.push({
      severity: "error",
      code: "bad_schema",
      message: `schemaVersion=${String(pkg.schemaVersion)}`,
    });
  }
  return {
    ...session,
    stage: issues.some((i) => i.severity === "error") ? "BLOCKED" : "SCANNED",
    pkg: issues.some((i) => i.severity === "error") ? null : pkg,
    issues,
  };
}

export function validateImportSession(session: ImportSession, expectedCorePin?: string): ImportSession {
  if (session.stage === "BLOCKED" || !session.pkg) {
    return { ...session, stage: "BLOCKED" };
  }
  const issues = [...session.issues];
  if (!verifyHarborExport(session.pkg)) {
    issues.push({ severity: "error", code: "integrity", message: "Integrity hash mismatch" });
  }
  const pin = expectedCorePin ?? EXPECTED_CORE;
  if (session.pkg.corePin && session.pkg.corePin !== pin && session.pkg.corePin.length >= 7) {
    if (!pin.startsWith(session.pkg.corePin) && !session.pkg.corePin.startsWith(pin.slice(0, 7))) {
      issues.push({
        severity: "warning",
        code: "core_pin_mismatch",
        message: `Package Core pin ${session.pkg.corePin} differs from harbor pin ${pin}`,
      });
    }
  }
  const inspection = inspectHarborExport(session.pkg);
  if (!inspection.ok) {
    issues.push({ severity: "error", code: "inspect_failed", message: "inspectHarborExport.ok=false" });
  }
  const blocked = issues.some((i) => i.severity === "error");
  return {
    ...session,
    issues,
    stage: blocked ? "BLOCKED" : "VALIDATED",
  };
}

export function previewImportSession(session: ImportSession): ImportSession {
  if (session.stage !== "VALIDATED" && session.stage !== "PREVIEWED" && session.stage !== "CONFLICTS_DETECTED") {
    return {
      ...session,
      stage: "BLOCKED",
      issues: [...session.issues, { severity: "error", code: "order", message: "Preview requires VALIDATE first" }],
    };
  }
  if (!session.pkg) {
    return { ...session, stage: "BLOCKED" };
  }
  const inspection = inspectHarborExport(session.pkg);
  return {
    ...session,
    stage: "PREVIEWED",
    preview: {
      canonicalIdsReferenced: session.pkg.selectedCanonicalMemoryIds.slice(),
      derivedCounts: inspection.derivedCounts,
      wouldWriteCanonical: false,
      wouldWriteDerived: true,
    },
  };
}

export function conflictImportSession(
  session: ImportSession,
  existingTexts: Array<{ id: string; text: string; updatedAt?: string }>,
  actor: HarborActor,
  now: string
): ImportSession {
  if (session.stage !== "PREVIEWED" && session.stage !== "CONFLICTS_DETECTED") {
    return {
      ...session,
      stage: "BLOCKED",
      issues: [...session.issues, { severity: "error", code: "order", message: "Conflict detection requires PREVIEW first" }],
    };
  }
  const incoming = (session.pkg?.epistemic ?? []).map((e) => ({
    id: e.memoryId,
    text: e.note ?? e.status,
    updatedAt: e.lastChangedAt,
  }));
  const conflicts = detectContradictions([...existingTexts, ...incoming], actor, now);
  return {
    ...session,
    stage: "CONFLICTS_DETECTED",
    conflicts,
  };
}

export function awaitConfirm(session: ImportSession): ImportSession {
  if (session.stage !== "CONFLICTS_DETECTED") {
    return {
      ...session,
      stage: "BLOCKED",
      issues: [...session.issues, { severity: "error", code: "order", message: "Confirm requires CONFLICT DETECTION first" }],
    };
  }
  return { ...session, stage: "AWAITING_CONFIRMATION" };
}
