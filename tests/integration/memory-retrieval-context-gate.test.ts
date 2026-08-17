/**
 * PHASE 4 — MEMORY RETRIEVAL + CONTEXT GATE (live PostgreSQL)
 * Isolated fixtures. READING DOES NOT WRITE.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createCoreRuntime,
  getDesktopHost,
  resetDesktopHostForTests,
  invokeDesktopCommand,
  type CoreRuntime,
  type DesktopHost,
  RETRIEVE_ORDER,
} from "@ailexsi/v2-command-adapter";
import { startLivePostgres, type LivePgHandle } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: "2026-08-09T12:00:00.000Z",
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

describe("PHASE 4 — MEMORY RETRIEVAL + CONTEXT GATE", () => {
  let live: LivePgHandle | null = null;
  let runtime: CoreRuntime | null = null;

  beforeAll(async () => {
    live = await startLivePostgres();
    runtime = await createCoreRuntime({
      connectionString: live.connectionString,
      environment: "test",
      producer: "v2-phase4-retrieval",
    });
  }, 180_000);

  afterAll(async () => {
    try {
      await runtime?.close();
    } catch {
      /* ignore */
    }
    try {
      await live?.stop();
    } catch {
      /* ignore */
    }
  }, 60_000);

  it("LIVE PostgresEventStore", () => {
    expect(runtime!.store.constructor.name).toBe("PostgresEventStore");
  });

  it("empty retrieval", async () => {
    if (!live?.newDatabase) {
      throw new Error("retrieval gate requires live.newDatabase() isolation");
    }
    const isoUrl = await live.newDatabase();
    const rt = await createCoreRuntime({
      connectionString: isoUrl,
      environment: "test",
      producer: "v2-p4-empty",
    });
    try {
      const page = await rt.queries.retrieveMemories({ pageSize: 10 });
      expect(page.items).toEqual([]);
      expect(page.totalMatching).toBe(0);
      expect(page.order).toBe(RETRIEVE_ORDER);
      expect(page.class).toBe("DERIVED");
    } finally {
      await rt.close();
    }
  }, 120_000);

  it("hard filters + deterministic order + repeated identical", async () => {
    if (!live?.newDatabase) {
      throw new Error("retrieval gate requires live.newDatabase() isolation");
    }
    const isoUrl = await live.newDatabase();
    const rt = await createCoreRuntime({
      connectionString: isoUrl,
      environment: "test",
      producer: "v2-p4-filter",
    });
    try {
      await rt.adapter.create({
        content: { type: "text", text: "alpha-one" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
        context: { tags: ["t1"], project: "proj-a" },
      });
      // ensure distinct timestamps by sequential creates (clock may share ms)
      await rt.adapter.create({
        content: { type: "text", text: "beta-two" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
        context: { tags: ["t2"], project: "proj-b" },
      });
      const c = await rt.adapter.create({
        content: { type: "text", text: "alpha-three" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
        context: { tags: ["t1", "t2"], project: "proj-a" },
      });
      await rt.adapter.archive({
        memoryId: c.identity.id,
        idempotencyKey: randomUUID(),
      });
      await rt.rebuildAll();

      const byTag = await rt.queries.retrieveMemories({
        pageSize: 10,
        tagsAny: ["t1"],
      });
      expect(byTag.items.every((i) => i.tags.includes("t1"))).toBe(true);

      const byProj = await rt.queries.retrieveMemories({
        pageSize: 10,
        project: "proj-b",
      });
      expect(byProj.items.map((i) => i.project)).toEqual(["proj-b"]);

      const active = await rt.queries.retrieveMemories({
        pageSize: 10,
        lifecycle: "active",
      });
      expect(active.items.every((i) => i.lifecycleState === "active")).toBe(
        true
      );

      const text = await rt.queries.retrieveMemories({
        pageSize: 10,
        textContains: "beta",
      });
      expect(text.items.length).toBe(1);

      // order DESC by confirmedAt
      const all = await rt.queries.retrieveMemories({ pageSize: 10 });
      for (let i = 1; i < all.items.length; i++) {
        const prev = all.items[i - 1]!;
        const cur = all.items[i]!;
        const cmp =
          cur.updatedAt.localeCompare(prev.updatedAt) || // DESC means prev >= cur time
          (prev.updatedAt === cur.updatedAt
            ? prev.id.localeCompare(cur.id)
            : 0);
        if (prev.updatedAt !== cur.updatedAt) {
          expect(prev.updatedAt >= cur.updatedAt).toBe(true);
        } else {
          expect(prev.id < cur.id || prev.id === cur.id).toBe(true);
        }
      }

      const a = await rt.queries.retrieveMemories({ pageSize: 10 });
      const b = await rt.queries.retrieveMemories({ pageSize: 10 });
      expect(a).toEqual(b);
    } finally {
      await rt.close();
    }
  }, 180_000);

  it("pagination no dups/gaps", async () => {
    if (!live?.newDatabase) {
      throw new Error("retrieval gate requires live.newDatabase() isolation");
    }
    const isoUrl = await live.newDatabase();
    const rt = await createCoreRuntime({
      connectionString: isoUrl,
      environment: "test",
      producer: "v2-p4-page",
    });
    try {
      for (let i = 0; i < 5; i++) {
        await rt.adapter.create({
          content: { type: "text", text: `page-${i}` },
          provenance: provenance(),
          idempotencyKey: randomUUID(),
        });
      }
      await rt.rebuildAll();
      const full = await rt.queries.retrieveMemories({ pageSize: 100 });
      const seen: string[] = [];
      let cursor: string | null | undefined = null;
      for (let n = 0; n < 10; n++) {
        const page = await rt.queries.retrieveMemories({
          pageSize: 2,
          afterCursor: cursor,
        });
        seen.push(...page.items.map((i) => i.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen.length).toBe(5);
      expect(new Set(seen).size).toBe(5);
      expect(seen).toEqual(full.items.map((i) => i.id));
    } finally {
      await rt.close();
    }
  }, 180_000);

  it("context assembly + budget + deterministic + no new UUIDs", async () => {
    if (!live?.newDatabase) {
      throw new Error("retrieval gate requires live.newDatabase() isolation");
    }
    const isoUrl = await live.newDatabase();
    const rt = await createCoreRuntime({
      connectionString: isoUrl,
      environment: "test",
      producer: "v2-p4-ctx",
    });
    try {
      const created = [];
      for (const t of ["ctx-a", "ctx-b", "ctx-c"]) {
        created.push(
          await rt.adapter.create({
            content: { type: "text", text: t },
            provenance: provenance(),
            idempotencyKey: randomUUID(),
          })
        );
      }
      await rt.rebuildAll();
      const ids = created.map((c) => c.identity.id);

      const bundle = await rt.queries.assembleContext({
        memoryIds: ids,
        maxItems: 2,
        maxChars: 50_000,
      });
      expect(bundle.class).toBe("DERIVED");
      expect(bundle.items.length).toBe(2);
      expect(bundle.truncated).toBe(true);
      for (const item of bundle.items) {
        expect(ids).toContain(item.id);
      }

      const again = await rt.queries.assembleContext({
        memoryIds: ids,
        maxItems: 2,
        maxChars: 50_000,
      });
      expect(again).toEqual(bundle);

      const tight = await rt.queries.assembleContext({
        memoryIds: ids,
        maxItems: 10,
        maxChars: 120,
      });
      expect(tight.charCount).toBeLessThanOrEqual(120);
    } finally {
      await rt.close();
    }
  }, 180_000);

  it("rebuild equivalence + no-write eventCount", async () => {
    if (!live?.newDatabase) {
      throw new Error("retrieval gate requires live.newDatabase() isolation");
    }
    const isoUrl = await live.newDatabase();
    const rt = await createCoreRuntime({
      connectionString: isoUrl,
      environment: "test",
      producer: "v2-p4-rebuild",
    });
    try {
      await rt.adapter.create({
        content: { type: "text", text: "rebuild-me" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
        context: { tags: ["r"] },
      });
      await rt.rebuildAll();
      const r1 = await rt.queries.retrieveMemories({
        pageSize: 10,
        tagsAny: ["r"],
      });
      const c1 = await rt.queries.assembleContext({
        retrieve: { tagsAny: ["r"] },
        maxItems: 5,
        maxChars: 10_000,
      });
      const before = await rt.queries.eventCount();

      await rt.queries.rebuildFromCore();

      const r2 = await rt.queries.retrieveMemories({
        pageSize: 10,
        tagsAny: ["r"],
      });
      const c2 = await rt.queries.assembleContext({
        retrieve: { tagsAny: ["r"] },
        maxItems: 5,
        maxChars: 10_000,
      });
      expect(r2).toEqual(r1);
      expect(c2).toEqual(c1);

      await rt.queries.retrieveMemories({ pageSize: 5 });
      await rt.queries.assembleContext({
        retrieve: { pageSize: 5 },
        maxItems: 3,
        maxChars: 5000,
      });
      expect(await rt.queries.eventCount()).toBe(before);
    } finally {
      await rt.close();
    }
  }, 180_000);

  it("Desktop E2E memory.retrieve + memory.context long-lived", async () => {
    resetDesktopHostForTests();
    const host: DesktopHost = getDesktopHost();
    if (!live?.newDatabase) {
      throw new Error("retrieval gate requires live.newDatabase() isolation");
    }
    const isoUrl = await live.newDatabase();
    try {
      await host.start({
        connectionString: isoUrl,
        environment: "test",
        producer: "v2-p4-desktop",
      });
      expect(host.storeConstructorName()).toBe("PostgresEventStore");
      const gen = host.generation;
      const ref = host.runtimeIdentity();

      await invokeDesktopCommand("memory.create", {
        content: { type: "text", text: "desktop-retrieve" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
        context: { tags: ["desk"] },
      });

      const page = (await invokeDesktopCommand("memory.retrieve", {
        pageSize: 10,
        tagsAny: ["desk"],
      })) as { items: { id: string }[]; order: string };
      expect(page.items.length).toBe(1);
      expect(page.order).toBe(RETRIEVE_ORDER);

      const ctx = (await invokeDesktopCommand("memory.context", {
        retrieve: { tagsAny: ["desk"] },
        maxItems: 5,
        maxChars: 5000,
      })) as { class: string; items: { id: string }[] };
      expect(ctx.class).toBe("DERIVED");
      expect(ctx.items.length).toBe(1);

      expect(host.generation).toBe(gen);
      expect(host.runtimeIdentity()).toBe(ref);
    } finally {
      try {
        await host.stop();
      } catch {
        /* ignore */
      }
    }
  }, 180_000);
});
