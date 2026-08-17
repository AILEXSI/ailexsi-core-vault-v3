/**
 * PHASE 2 — QUERY + READ-MODEL GATE (live PostgreSQL)
 *
 * Isolated fixtures — no shared-suite contamination.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createCoreRuntime,
  type CoreRuntime,
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

function snapMap(m: Map<string, unknown>) {
  return JSON.parse(
    JSON.stringify([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])))
  );
}

describe("PHASE 2 — QUERY + READ-MODEL GATE (live Postgres)", () => {
  let live: LivePgHandle | null = null;
  let runtime: CoreRuntime | null = null;

  beforeAll(async () => {
    live = await startLivePostgres();
    runtime = await createCoreRuntime({
      connectionString: live.connectionString,
      environment: "test",
      producer: "v2-query-gate",
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

  it("uses PostgresEventStore (LIVE)", () => {
    expect(runtime!.store.constructor.name).toBe("PostgresEventStore");
    expect(live!.connectionString.startsWith("postgres://")).toBe(true);
  });

  it("GET existing memory via query service", async () => {
    const cell = await runtime!.adapter.create({
      content: { type: "text", text: "query-get" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const view = await runtime!.queries.getMemory(cell.identity.id);
    expect(view).not.toBeNull();
    expect(view!.content.class).toBe("CANONICAL");
    expect(view!.displayTitle.class).toBe("DERIVED");
    expect((view!.content.value as { text: string }).text).toBe("query-get");
  });

  it("GET missing memory → null", async () => {
    const view = await runtime!.queries.getMemory(randomUUID());
    expect(view).toBeNull();
  });

  it("LIST + deterministic ordering + repeated query identical", async () => {
    // isolated dataset for ordering: create fixed-order texts
    const ids: string[] = [];
    for (const text of ["ord-a", "ord-b", "ord-c"]) {
      const c = await runtime!.adapter.create({
        content: { type: "text", text },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
      });
      ids.push(c.identity.id);
      // sync into read model via query get
      await runtime!.queries.getMemory(c.identity.id);
    }
    await runtime!.rebuildAll();
    const a = await runtime!.queries.listAll();
    const b = await runtime!.queries.listAll();
    expect(a).toEqual(b);
    // sorted deterministically
    for (let i = 1; i < a.length; i++) {
      const prev = a[i - 1]!;
      const cur = a[i]!;
      const cmp =
        prev.updatedAt.localeCompare(cur.updatedAt) ||
        prev.id.localeCompare(cur.id);
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it("pagination pageSize=1, pageSize=2, multi-page, empty, boundaries", async () => {
    // Isolated DB on the SAME embedded server (avoids multi-process Windows flakiness)
    const isoUrl = live!.newDatabase
      ? await live!.newDatabase()
      : live!.connectionString;
    const iso = await createCoreRuntime({
      connectionString: isoUrl,
      environment: "test",
      producer: "v2-query-page",
    });
    try {
      const empty = await iso.queries.listMemories({ pageSize: 10 });
      expect(empty.items).toEqual([]);
      expect(empty.totalMatching).toBe(0);
      expect(empty.nextCursor).toBeNull();

      for (let i = 0; i < 5; i++) {
        await iso.adapter.create({
          content: { type: "text", text: `page-item-${i}` },
          provenance: provenance(),
          idempotencyKey: randomUUID(),
        });
      }
      await iso.rebuildAll();

      const p1 = await iso.queries.listMemories({ pageSize: 1 });
      expect(p1.items.length).toBe(1);
      expect(p1.nextCursor).not.toBeNull();

      const p2 = await iso.queries.listMemories({ pageSize: 2 });
      expect(p2.items.length).toBe(2);

      const pages: string[] = [];
      let cursor: string | null | undefined = null;
      for (let n = 0; n < 10; n++) {
        const page = await iso.queries.listMemories({
          pageSize: 2,
          afterCursor: cursor,
        });
        pages.push(...page.items.map((i) => i.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(new Set(pages).size).toBe(5);
      expect(pages.length).toBe(5);

      // empty after last (exclusive keyset)
      const last = await iso.queries.listMemories({
        pageSize: 2,
        afterCursor: memoryLastCursor(await iso.queries.listAll()),
      });
      expect(last.items.length).toBe(0);
      expect(last.nextCursor).toBeNull();
    } finally {
      await iso.close();
    }
  }, 180_000);

  it("active/archived filtering in list", async () => {
    const isoUrl = live!.newDatabase
      ? await live!.newDatabase()
      : live!.connectionString;
    const iso = await createCoreRuntime({
      connectionString: isoUrl,
      environment: "test",
      producer: "v2-query-filter",
    });
    try {
      const a = await iso.adapter.create({
        content: { type: "text", text: "keep-active" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
      });
      const b = await iso.adapter.create({
        content: { type: "text", text: "to-archive" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
      });
      await iso.adapter.archive({
        memoryId: b.identity.id,
        idempotencyKey: randomUUID(),
      });
      await iso.rebuildAll();
      const activeOnly = await iso.queries.listAll({ includeArchived: false });
      expect(activeOnly.every((i) => i.lifecycleState === "active")).toBe(true);
      expect(activeOnly.some((i) => i.id === a.identity.id)).toBe(true);
      expect(activeOnly.some((i) => i.id === b.identity.id)).toBe(false);
      const all = await iso.queries.listAll({ includeArchived: true });
      expect(all.some((i) => i.id === b.identity.id)).toBe(true);
    } finally {
      await iso.close();
    }
  }, 120_000);

  it("history query preserves Core event order and types", async () => {
    const c = await runtime!.adapter.create({
      content: { type: "text", text: "hist-1" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    await runtime!.adapter.update({
      memoryId: c.identity.id,
      content: { type: "text", text: "hist-2" },
      idempotencyKey: randomUUID(),
    });
    await runtime!.adapter.archive({
      memoryId: c.identity.id,
      idempotencyKey: randomUUID(),
    });
    await runtime!.adapter.restore({
      memoryId: c.identity.id,
      idempotencyKey: randomUUID(),
    });
    const hist = await runtime!.queries.getMemoryHistory(c.identity.id);
    expect(hist.map((h) => h.eventType)).toEqual([
      "MemoryCreated",
      "MemoryUpdated",
      "MemoryArchived",
      "MemoryRestored",
    ]);
    expect(hist.map((h) => h.version)).toEqual([1, 2, 3, 4]);
    // event ids stable UUID
    for (const h of hist) {
      expect(h.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    }
  });

  it("CLEAR → REBUILD → IDENTICAL (isolated multi-memory; no new UUIDs)", async () => {
    const isoUrl = live!.newDatabase
      ? await live!.newDatabase()
      : live!.connectionString;
    const iso = await createCoreRuntime({
      connectionString: isoUrl,
      environment: "test",
      producer: "v2-query-replay",
    });
    try {
      const a = await iso.adapter.create({
        content: { type: "text", text: "qa-v1" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
      });
      const b = await iso.adapter.create({
        content: { type: "text", text: "qb-v1" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
      });
      await iso.adapter.update({
        memoryId: a.identity.id,
        content: { type: "text", text: "qa-v2" },
        idempotencyKey: randomUUID(),
      });
      await iso.adapter.archive({
        memoryId: b.identity.id,
        idempotencyKey: randomUUID(),
      });
      await iso.adapter.restore({
        memoryId: b.identity.id,
        idempotencyKey: randomUUID(),
      });

      await iso.rebuildAll();
      const beforeCells = snapMap(iso.readModel.snapshotCells());
      const beforeList = await iso.queries.listAll();
      const beforeHistA = await iso.queries.getMemoryHistory(a.identity.id);
      const eventIdsBefore = beforeHistA.map((h) => h.eventId);

      const countBefore = await iso.queries.eventCount();

      await iso.queries.rebuildFromCore();

      const afterCells = snapMap(iso.readModel.snapshotCells());
      const afterList = await iso.queries.listAll();
      const afterHistA = await iso.queries.getMemoryHistory(a.identity.id);

      expect(afterCells).toEqual(beforeCells);
      expect(afterList).toEqual(beforeList);
      expect(afterHistA.map((h) => h.eventId)).toEqual(eventIdsBefore);
      expect(await iso.queries.eventCount()).toBe(countBefore);

      // IDs unchanged
      expect(afterList.map((i) => i.id).sort()).toEqual(
        [a.identity.id, b.identity.id].sort()
      );
    } finally {
      await iso.close();
    }
  }, 180_000);

  it("read operations do not append events", async () => {
    const c = await runtime!.adapter.create({
      content: { type: "text", text: "no-append" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const before = await runtime!.queries.eventCount();
    await runtime!.queries.getMemory(c.identity.id);
    await runtime!.queries.listAll();
    await runtime!.queries.getMemoryHistory(c.identity.id);
    await runtime!.queries.listMemories({ pageSize: 10 });
    const after = await runtime!.queries.eventCount();
    expect(after).toBe(before);
  });
});

function memoryLastCursor(
  items: Array<{ updatedAt: string; id: string }>
): string {
  const last = items[items.length - 1]!;
  return `${last.updatedAt}\t${last.id}`;
}
