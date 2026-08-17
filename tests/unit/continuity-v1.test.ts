import { describe, it, expect } from "vitest";
import {
  buildContinuityPackageV1,
  serializeContinuityV1,
  parseContinuityV1,
  packagesIdentityEqual,
  stripAuditOnly,
  inspectContinuityV1,
} from "@ailexsi/v2-continuity";

describe("Continuity v1 package", () => {
  const base = {
    coreBaselineSha: "652d01eb06dd0841c3b475023883675af6dcd698",
    vaultReferenceSha: "061e444389090c54e431b0e8243e82764f2c198e",
    selection: {
      mode: "ids" as const,
      memoryIds: ["a0000000-0000-4000-8000-000000000001"],
    },
    orderedMemoryIds: ["a0000000-0000-4000-8000-000000000001"],
  };

  it("round-trip serialize/parse", () => {
    const pkg = buildContinuityPackageV1({
      ...base,
      generatedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(pkg.classifications.package).toBe("V2-DERIVED");
    expect(pkg.classifications.orderedMemoryIds).toBe("CORE-CANONICAL");
    const back = parseContinuityV1(serializeContinuityV1(pkg));
    expect(packagesIdentityEqual(pkg, back)).toBe(true);
  });

  it("identity ignores auditOnly.generatedAt", () => {
    const a = buildContinuityPackageV1({
      ...base,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const b = buildContinuityPackageV1({
      ...base,
      generatedAt: "2026-12-31T23:59:59.000Z",
    });
    expect(packagesIdentityEqual(a, b)).toBe(true);
    expect(a.auditOnly?.generatedAt).not.toBe(b.auditOnly?.generatedAt);
    expect(stripAuditOnly(a).auditOnly).toBeUndefined();
  });

  it("inspect summary", () => {
    const pkg = buildContinuityPackageV1(base);
    const info = inspectContinuityV1(pkg);
    expect(info.memoryCount).toBe(1);
    expect(info.mode).toBe("ids");
  });

  it("rejects invalid schema", () => {
    expect(() =>
      parseContinuityV1(JSON.stringify({ schemaVersion: "nope", kind: "x" }))
    ).toThrow(/Unsupported continuity schema/);
  });

  it("dedupes ordered ids preserving first", () => {
    const pkg = buildContinuityPackageV1({
      ...base,
      orderedMemoryIds: ["id1", "id2", "id1"],
    });
    expect(pkg.orderedMemoryIds).toEqual(["id1", "id2"]);
  });
});
