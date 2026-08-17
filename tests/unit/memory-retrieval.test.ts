import { describe, it, expect } from "vitest";
import type { MemoryCell } from "@ailexsi/contracts";
import {
  compareRetrieveOrder,
  filterAndOrderCells,
  paginateRetrieve,
  encodeRetrieveCursor,
  assembleContextFromViews,
  RETRIEVE_ORDER,
} from "@ailexsi/v2-command-adapter";
import type { MemoryDetailView } from "@ailexsi/v2-read-models";
import { classify } from "@ailexsi/v2-read-models";

function cell(
  id: string,
  confirmedAt: string,
  text: string,
  opts: {
    tags?: string[];
    project?: string;
    state?: "active" | "archived";
  } = {}
): MemoryCell {
  return {
    identity: { id, shortId: id.slice(0, 8), version: 1, canonical: true },
    content: { type: "text", text },
    context: { tags: opts.tags, project: opts.project },
    provenance: {
      sourceType: "user",
      capturedAt: confirmedAt,
      parentMemoryIds: [],
      evidenceIds: [],
    },
    evidence: [],
    lifecycle: {
      state: opts.state ?? "active",
      changedAt: confirmedAt,
    },
    timestamps: { observedAt: confirmedAt, confirmedAt },
    cognitiveState: {
      mass: 0,
      energy: 0,
      gravity: 0,
      entropy: 0,
      velocity: { mass: 0, resonance: 0, temperature: 0 },
      confidence: 0,
      resonance: 0,
      temperature: 0,
      novelty: 0,
      calculatedAt: confirmedAt,
      physicsVersion: "none",
      formulaVersion: "none",
    },
    relationRefs: [],
    currentVersion: 1,
  } as MemoryCell;
}

describe("Phase 4 retrieval pure helpers", () => {
  it("orders confirmedAt DESC then id ASC", () => {
    const a = { updatedAt: "2026-01-01T00:00:00.000Z", id: "a" };
    const b = { updatedAt: "2026-01-02T00:00:00.000Z", id: "b" };
    const c = { updatedAt: "2026-01-01T00:00:00.000Z", id: "c" };
    expect(compareRetrieveOrder(b, a)).toBeLessThan(0); // b first
    const items = filterAndOrderCells(
      [
        cell("a", "2026-01-01T00:00:00.000Z", "a"),
        cell("c", "2026-01-01T00:00:00.000Z", "c"),
        cell("b", "2026-01-02T00:00:00.000Z", "b"),
      ],
      { pageSize: 10 }
    );
    expect(items.map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("hard filters: tagsAny, project, lifecycle, textContains", () => {
    const cells = [
      cell("1", "2026-01-03T00:00:00.000Z", "alpha", {
        tags: ["x"],
        project: "p1",
      }),
      cell("2", "2026-01-02T00:00:00.000Z", "beta", {
        tags: ["y"],
        project: "p2",
        state: "archived",
      }),
      cell("3", "2026-01-01T00:00:00.000Z", "gamma", {
        tags: ["x", "y"],
        project: "p1",
      }),
    ];
    expect(
      filterAndOrderCells(cells, { pageSize: 10, tagsAny: ["x"] }).map(
        (i) => i.id
      )
    ).toEqual(["1", "3"]);
    expect(
      filterAndOrderCells(cells, { pageSize: 10, project: "p2" }).map(
        (i) => i.id
      )
    ).toEqual(["2"]);
    expect(
      filterAndOrderCells(cells, {
        pageSize: 10,
        lifecycle: "archived",
      }).map((i) => i.id)
    ).toEqual(["2"]);
    expect(
      filterAndOrderCells(cells, {
        pageSize: 10,
        textContains: "amm",
      }).map((i) => i.id)
    ).toEqual(["3"]);
    // case-normalized
    expect(
      filterAndOrderCells(cells, {
        pageSize: 10,
        textContains: "ALPHA",
      }).map((i) => i.id)
    ).toEqual(["1"]);
  });

  it("duplicate confirmedAt uses id ASC as final tie-break", () => {
    const ts = "2026-06-01T12:00:00.000Z";
    const items = filterAndOrderCells(
      [
        cell("b0000000-0000-4000-8000-000000000002", ts, "b"),
        cell("a0000000-0000-4000-8000-000000000001", ts, "a"),
        cell("c0000000-0000-4000-8000-000000000003", ts, "c"),
      ],
      { pageSize: 10 }
    );
    expect(items.map((i) => i.id)).toEqual([
      "a0000000-0000-4000-8000-000000000001",
      "b0000000-0000-4000-8000-000000000002",
      "c0000000-0000-4000-8000-000000000003",
    ]);
  });

  it("pagination no gaps/dups over full ordered set", () => {
    const cells = [];
    for (let i = 0; i < 5; i++) {
      cells.push(
        cell(
          `00000000-0000-4000-8000-00000000000${i}`,
          `2026-01-0${i + 1}T00:00:00.000Z`,
          `t${i}`
        )
      );
    }
    const ordered = filterAndOrderCells(cells, { pageSize: 10 });
    const pages: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 10; n++) {
      const page = paginateRetrieve(ordered, 2, cursor);
      pages.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(pages.length).toBe(5);
    expect(new Set(pages).size).toBe(5);
    expect(pages).toEqual(ordered.map((i) => i.id));
    // repeated
    expect(paginateRetrieve(ordered, 2, null)).toEqual(
      paginateRetrieve(ordered, 2, null)
    );
  });

  it("empty retrieval", () => {
    const page = paginateRetrieve([], 10, null);
    expect(page.items).toEqual([]);
    expect(page.totalMatching).toBe(0);
    expect(page.order).toBe(RETRIEVE_ORDER);
  });

  it("context budget maxItems and maxChars", () => {
    const views = [0, 1, 2].map((i) => {
      const id = `00000000-0000-4000-8000-00000000000${i}`;
      return {
        id,
        shortId: id.slice(0, 8),
        content: classify(
          { type: "text", text: "hello-world-content" },
          "CANONICAL",
          "t"
        ),
        context: classify({ tags: [] }, "CANONICAL", "t"),
        meaning: classify(undefined, "CANONICAL", "t"),
        provenance: classify(
          {
            sourceType: "user",
            capturedAt: "2026-01-01T00:00:00.000Z",
            parentMemoryIds: [],
            evidenceIds: [],
          },
          "CANONICAL",
          "t"
        ),
        evidence: classify([], "CANONICAL", "t"),
        lifecycle: classify(
          { state: "active", changedAt: "2026-01-01T00:00:00.000Z" },
          "CANONICAL",
          "t"
        ),
        timestamps: classify(
          {
            observedAt: "2026-01-01T00:00:00.000Z",
            confirmedAt: "2026-01-01T00:00:00.000Z",
          },
          "CANONICAL",
          "t"
        ),
        relationRefs: classify([], "CANONICAL", "t"),
        currentVersion: classify(1, "CANONICAL", "t"),
        displayTitle: classify("hello", "DERIVED", "t"),
        cognitiveState: classify({} as never, "CANONICAL", "t"),
      } as MemoryDetailView;
    });
    const small = assembleContextFromViews(views, new Map(), {
      maxItems: 2,
      maxChars: 100_000,
      orderLabel: "test",
    });
    expect(small.items.length).toBe(2);
    expect(small.truncated).toBe(true);

    const tiny = assembleContextFromViews(views, new Map(), {
      maxItems: 10,
      maxChars: 200,
      orderLabel: "test",
    });
    expect(tiny.charCount).toBeLessThanOrEqual(200);
    expect(tiny.items.length).toBeGreaterThanOrEqual(1);
    expect(tiny.truncated || tiny.items.length < views.length).toBe(true);

    const impossible = assembleContextFromViews(views, new Map(), {
      maxItems: 10,
      maxChars: 10,
      orderLabel: "test",
    });
    expect(impossible.charCount).toBeLessThanOrEqual(10);
    expect(impossible.items.length).toBe(0);
    expect(impossible.truncated).toBe(true);
  });

  it("cursor is opaque r1 prefix", () => {
    const c = encodeRetrieveCursor({
      updatedAt: "2026-01-01T00:00:00.000Z",
      id: "x",
    });
    expect(c.startsWith("r1:")).toBe(true);
  });
});
