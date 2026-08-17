import { describe, it, expect } from "vitest";
import { classify } from "@ailexsi/v2-read-models";
import { buildConnectome } from "@ailexsi/v2-connectome";
import type { MemoryCell } from "@ailexsi/contracts";
import { zeroCognitiveState } from "@ailexsi/contracts";

describe("classification rules", () => {
  it("marks fields with explicit class", () => {
    const f = classify("x", "DERIVED", "v2.test");
    expect(f.class).toBe("DERIVED");
    expect(f.source).toBe("v2.test");
    expect(f.value).toBe("x");
  });
});

describe("connectome MVP", () => {
  it("derives edges from provenance parents without Core Relation domain", () => {
    const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const ts = "2026-08-09T12:00:00.000Z";
    const cells: MemoryCell[] = [
      {
        identity: { id: parentId, shortId: "aaaaaaaa", version: 1, canonical: true },
        content: { type: "text", text: "parent" },
        context: {},
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
      },
      {
        identity: { id: childId, shortId: "bbbbbbbb", version: 1, canonical: true },
        content: { type: "text", text: "child" },
        context: {},
        provenance: {
          sourceType: "user",
          capturedAt: ts,
          parentMemoryIds: [parentId],
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
      },
    ];

    const g = buildConnectome(cells);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges.some((e) => e.source === "V2-DERIVED")).toBe(true);
    expect(g.status.coreRelationAggregate).toBe("PLANNED");
    expect(g.status.fullOntology).toBe("PLANNED");
  });
});
