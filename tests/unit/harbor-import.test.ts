import { describe, it, expect } from "vitest";
import { HarborService } from "@ailexsi/v3-harbor";

const HUMAN = { id: "martin", kind: "human" as const, authorizeCanonical: true };
const AI = { id: "grok", kind: "ai" as const };

function fresh() {
  return new HarborService({
    corePin: "652d01eb06dd0841c3b475023883675af6dcd698",
    vaultReferenceSha: "061e444389090c54e431b0e8243e82764f2c198e",
  });
}

describe("Harbor import pipeline", () => {
  it("SCAN → VALIDATE → PREVIEW → CONFLICT → CONFIRM → WRITE derived only", () => {
    const src = fresh();
    src.epistemic.set("m-tea", {
      memoryId: "m-tea",
      status: "INFERRED",
      confidence: 0.71,
      evidenceEventIds: [],
      lastChangedAt: "2026-08-17T12:00:00.000Z",
      changedBy: AI,
      note: "user prefers tea",
      class: "V3-DERIVED",
    });
    const pkg = src.exportPackage(["m-tea"], HUMAN);

    const dst = fresh();
    const scanned = dst.beginImport(pkg, HUMAN);
    expect(scanned.stage).toBe("SCANNED");
    expect(dst.epistemic.size).toBe(0);

    const validated = dst.validateImport(scanned.id, HUMAN);
    expect(validated.stage).toBe("VALIDATED");
    expect(dst.epistemic.size).toBe(0);

    const previewed = dst.previewImport(scanned.id, HUMAN);
    expect(previewed.stage).toBe("PREVIEWED");
    expect(previewed.preview?.wouldWriteCanonical).toBe(false);
    expect(dst.epistemic.size).toBe(0);

    const conflicts = dst.detectImportConflicts(
      scanned.id,
      [{ id: "m-coffee", text: "user prefers coffee" }],
      HUMAN
    );
    expect(conflicts.stage).toBe("CONFLICTS_DETECTED");
    expect(dst.epistemic.size).toBe(0);

    expect(() => dst.confirmImport(scanned.id, AI)).toThrow(/human/i);
    expect(dst.epistemic.size).toBe(0);

    const applied = dst.confirmImport(scanned.id, HUMAN);
    expect(applied.stage).toBe("APPLIED");
    expect(dst.epistemic.get("m-tea")?.status).toBe("INFERRED");
  });

  it("tampered package is BLOCKED and never written", () => {
    const src = fresh();
    const pkg = src.exportPackage([], HUMAN);
    const bad = { ...pkg, v3Version: "tampered" };
    const dst = fresh();
    const scanned = dst.beginImport(bad, HUMAN);
    const validated = dst.validateImport(scanned.id, HUMAN);
    expect(validated.stage).toBe("BLOCKED");
    expect(dst.epistemic.size).toBe(0);
    expect(() => dst.previewImport(scanned.id, HUMAN).stage).not.toBe("APPLIED");
    expect(dst.previewImport(scanned.id, HUMAN).stage).toBe("BLOCKED");
  });

  it("reject leaves derived store empty", () => {
    const src = fresh();
    const pkg = src.exportPackage(["x"], HUMAN);
    const dst = fresh();
    const s = dst.beginImport(pkg, HUMAN);
    dst.validateImport(s.id, HUMAN);
    dst.previewImport(s.id, HUMAN);
    dst.detectImportConflicts(s.id, [], HUMAN);
    const rejected = dst.rejectImport(s.id, HUMAN);
    expect(rejected.stage).toBe("REJECTED");
    expect(dst.epistemic.size).toBe(0);
  });
});
