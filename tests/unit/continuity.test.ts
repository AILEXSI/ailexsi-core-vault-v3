import { describe, it, expect } from "vitest";
import {
  buildContinuityPackage,
  serializeContinuity,
  parseContinuity,
  canonicalMemoryIds,
} from "@ailexsi/v2-continuity";
import type { MemoryCell } from "@ailexsi/contracts";
import { zeroCognitiveState } from "@ailexsi/contracts";

const ts = "2026-08-09T12:00:00.000Z";
const cell: MemoryCell = {
  identity: {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    shortId: "cccccccc",
    version: 1,
    canonical: true,
  },
  content: { type: "text", text: "canonical fact" },
  context: { tags: ["t"] },
  provenance: {
    sourceType: "user",
    capturedAt: ts,
    parentMemoryIds: [],
    evidenceIds: [],
  },
  evidence: [],
  lifecycle: { state: "active", changedAt: ts },
  timestamps: {
    createdAt: ts,
    observedAt: ts,
    validFrom: ts,
    validTo: null,
    confirmedAt: ts,
    deprecatedAt: null,
  },
  cognitiveState: zeroCognitiveState(ts),
  relationRefs: [],
  currentVersion: 1,
};

describe("continuity serialization", () => {
  it("round-trips and classifies fields", () => {
    const pkg = buildContinuityPackage({
      memories: [cell],
      coreBaselineSha: "652d01eb06dd0841c3b475023883675af6dcd698",
      vaultReferenceSha: "061e444389090c54e431b0e8243e82764f2c198e",
      ephemeralNotes: ["ui note"],
      cultivationSummary: "session summary",
      createdAt: ts,
    });

    expect(pkg.canonicalMemories[0]!._meta.class).toBe("CORE-CANONICAL");
    expect(pkg.ephemeralNotes?.[0]?._meta.class).toBe("V2-EPHEMERAL");
    expect(pkg.cultivationContext?._meta.class).toBe("V2-DERIVED");

    const json = serializeContinuity(pkg);
    const back = parseContinuity(json);
    expect(canonicalMemoryIds(back)).toEqual([cell.identity.id]);
    expect(back.metadata.memoryCount).toBe(1);
  });
});
