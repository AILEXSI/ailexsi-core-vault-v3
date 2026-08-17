import { describe, it, expect } from "vitest";
import {
  MemoryReadModel,
  MemoryQueryValidationError,
  memorySortKey,
} from "@ailexsi/v2-read-models";
import type { MemoryCell } from "@ailexsi/contracts";

function cell(
  id: string,
  confirmedAt: string,
  text: string,
  state: "active" | "archived" = "active"
): MemoryCell {
  return {
    identity: { id, shortId: id.slice(0, 8), version: 1, canonical: true },
    content: { type: "text", text },
    context: {},
    provenance: {
      sourceType: "user",
      capturedAt: confirmedAt,
      parentMemoryIds: [],
      evidenceIds: [],
    },
    evidence: [],
    lifecycle: { state, changedAt: confirmedAt },
    timestamps: {
      observedAt: confirmedAt,
      confirmedAt,
    },
    cognitiveState: {
      valence: 0,
      arousal: 0,
      dominance: 0,
      novelty: 0,
      confidence: 0,
      computedAt: confirmedAt,
    },
    relationRefs: [],
    currentVersion: 1,
  } as MemoryCell;
}

describe("MemoryReadModel deterministic pagination", () => {
  it("orders by updatedAt then id", () => {
    const rm = new MemoryReadModel();
    rm.upsertFromCore(cell("b0000000-0000-4000-8000-000000000002", "2026-01-02T00:00:00.000Z", "b"));
    rm.upsertFromCore(cell("a0000000-0000-4000-8000-000000000001", "2026-01-01T00:00:00.000Z", "a"));
    rm.upsertFromCore(cell("c0000000-0000-4000-8000-000000000003", "2026-01-01T00:00:00.000Z", "c"));
    const list = rm.list();
    expect(list.map((i) => i.id)).toEqual([
      "a0000000-0000-4000-8000-000000000001",
      "c0000000-0000-4000-8000-000000000003",
      "b0000000-0000-4000-8000-000000000002",
    ]);
  });

  it("pageSize 1 and multi-page continuation are stable", () => {
    const rm = new MemoryReadModel();
    for (let i = 0; i < 5; i++) {
      const id = `00000000-0000-4000-8000-00000000000${i}`;
      rm.upsertFromCore(
        cell(id, `2026-01-0${i + 1}T00:00:00.000Z`, `m${i}`)
      );
    }
    const p1 = rm.listPage({ pageSize: 2 });
    expect(p1.items.length).toBe(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = rm.listPage({ pageSize: 2, afterCursor: p1.nextCursor });
    expect(p2.items.length).toBe(2);
    const p3 = rm.listPage({ pageSize: 2, afterCursor: p2.nextCursor });
    expect(p3.items.length).toBe(1);
    expect(p3.nextCursor).toBeNull();
    // no overlap
    const ids = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(5);
    // repeated query identical
    expect(rm.listPage({ pageSize: 2 })).toEqual(p1);
  });

  it("rejects invalid pageSize", () => {
    const rm = new MemoryReadModel();
    expect(() => rm.listPage({ pageSize: 0 })).toThrow(
      MemoryQueryValidationError
    );
    expect(() => rm.listPage({ pageSize: 101 })).toThrow(
      MemoryQueryValidationError
    );
  });

  it("empty result", () => {
    const rm = new MemoryReadModel();
    const page = rm.listPage({ pageSize: 10 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.totalMatching).toBe(0);
  });

  it("filters archived when includeArchived=false", () => {
    const rm = new MemoryReadModel();
    rm.upsertFromCore(
      cell("a0000000-0000-4000-8000-000000000001", "2026-01-01T00:00:00.000Z", "a", "active")
    );
    rm.upsertFromCore(
      cell("b0000000-0000-4000-8000-000000000002", "2026-01-02T00:00:00.000Z", "b", "archived")
    );
    expect(rm.list({ includeArchived: false }).length).toBe(1);
    expect(rm.listPage({ pageSize: 10, includeArchived: false }).totalMatching).toBe(
      1
    );
  });

  it("memorySortKey is stable", () => {
    const k = memorySortKey({
      updatedAt: "2026-01-01T00:00:00.000Z",
      id: "x",
    });
    expect(k).toBe("2026-01-01T00:00:00.000Z\tx");
  });
});
