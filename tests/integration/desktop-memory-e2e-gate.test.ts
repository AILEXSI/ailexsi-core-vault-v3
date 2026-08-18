/**
 * PHASE 3 — DESKTOP MEMORY E2E ACCEPTANCE
 *
 * Path:
 *   invokeDesktopCommand (Desktop UI / IPC boundary)
 *     → long-lived DesktopHost
 *     → CoreRuntime (single)
 *     → MemoryCommandAdapter | MemoryQueryService
 *     → PostgresEventStore
 *
 * Isolated live PostgreSQL — never InMemoryEventStore.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  getDesktopHost,
  resetDesktopHostForTests,
  invokeDesktopCommand,
  type DesktopHost,
} from "@ailexsi/v2-command-adapter";
import { startLivePostgres, type LivePgHandle } from "@ailexsi/v2-test-kit";
import { TEST_SESSION_ACTOR } from "../helpers/authorized-write.js";
import type { Provenance } from "@ailexsi/contracts";
import type { MemoryDetailView, MemoryListItem, ListMemoriesPage } from "@ailexsi/v2-read-models";

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: "2026-08-09T12:00:00.000Z",
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

function snapCells(host: DesktopHost) {
  const rt = host.requireRuntime();
  return JSON.parse(
    JSON.stringify(
      [...rt.readModel.snapshotCells().entries()].sort((a, b) =>
        a[0].localeCompare(b[0])
      )
    )
  );
}

describe("PHASE 3 — DESKTOP MEMORY E2E (live PostgresEventStore)", () => {
  let host: DesktopHost;
  let live: LivePgHandle | null = null;
  let runtimeRef: object | null = null;

  beforeAll(async () => {
    resetDesktopHostForTests();
    host = getDesktopHost();
    live = await startLivePostgres();
    await host.start({
      connectionString: live.connectionString,
      environment: "test",
      producer: "v2-desktop-e2e-phase3",
      actor: TEST_SESSION_ACTOR,
    });
    runtimeRef = host.runtimeIdentity();
  }, 180_000);

  afterAll(async () => {
    try {
      await host.stop();
    } catch {
      /* ignore */
    }
    try {
      await live?.stop();
    } catch {
      /* ignore */
    }
  }, 60_000);

  it("long-lived CoreRuntime + PostgresEventStore only", () => {
    expect(host.isRunning).toBe(true);
    expect(host.generation).toBe(1);
    expect(host.storeConstructorName()).toBe("PostgresEventStore");
    expect(live!.connectionString.startsWith("postgres://")).toBe(true);
  });

  it("start is idempotent — same runtime identity", async () => {
    await host.start({ connectionString: live!.connectionString, actor: TEST_SESSION_ACTOR });
    expect(host.generation).toBe(1);
    expect(host.runtimeIdentity()).toBe(runtimeRef);
  });

  it("A–F) CREATE → GET → UPDATE → HISTORY → ARCHIVE → RESTORE via Desktop IPC", async () => {
    const createKey = randomUUID();
    const created = (await invokeDesktopCommand("memory.create", {
      content: { type: "text", text: "e2e-v1" },
      provenance: provenance(),
      idempotencyKey: createKey,
      context: { tags: ["e2e"], project: "ailexsi-core-vault-v2" },
      createdBy: "desktop-e2e",
    })) as MemoryDetailView;

    expect(created.currentVersion.value).toBe(1);
    expect(created.content.class).toBe("CANONICAL");
    expect(created.displayTitle.class).toBe("DERIVED");
    expect(host.runtimeIdentity()).toBe(runtimeRef);

    let stream = await host.eventStoreHistory(created.id);
    expect(stream.length).toBe(1);
    expect(stream[0]!.event.eventType).toBe("MemoryCreated");
    expect(stream[0]!.event.idempotencyKey).toBe(createKey);

    // GET
    const got = (await invokeDesktopCommand("memory.get", {
      memoryId: created.id,
    })) as MemoryDetailView | null;
    expect(got).not.toBeNull();
    expect(got!.id).toBe(created.id);
    expect((got!.content.value as { text: string }).text).toBe("e2e-v1");

    // UPDATE
    const updated = (await invokeDesktopCommand("memory.update", {
      memoryId: created.id,
      content: { type: "text", text: "e2e-v2" },
      changeReason: "e2e-update",
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;
    expect(updated.id).toBe(created.id);
    expect(updated.currentVersion.value).toBe(2);
    expect((updated.content.value as { text: string }).text).toBe("e2e-v2");
    stream = await host.eventStoreHistory(created.id);
    expect(stream.map((e) => e.event.eventType)).toEqual([
      "MemoryCreated",
      "MemoryUpdated",
    ]);

    // HISTORY
    const hist = (await invokeDesktopCommand("memory.history", {
      memoryId: created.id,
    })) as Array<{
      version: number;
      eventType: string;
      eventId: string;
    }>;
    expect(hist.map((h) => h.eventType)).toEqual([
      "MemoryCreated",
      "MemoryUpdated",
    ]);
    expect(hist.map((h) => h.version)).toEqual([1, 2]);
    expect(hist[0]!.eventId).toBe(stream[0]!.event.eventId);

    // ARCHIVE
    const archived = (await invokeDesktopCommand("memory.archive", {
      memoryId: created.id,
      reason: "e2e-archive",
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;
    expect(archived.lifecycle.value.state).toBe("archived");
    expect(archived.currentVersion.value).toBe(3);

    // RESTORE
    const restored = (await invokeDesktopCommand("memory.restore", {
      memoryId: created.id,
      reason: "e2e-restore",
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;
    expect(restored.lifecycle.value.state).toBe("active");
    expect(restored.currentVersion.value).toBe(4);

    stream = await host.eventStoreHistory(created.id);
    expect(stream.map((e) => e.event.eventType)).toEqual([
      "MemoryCreated",
      "MemoryUpdated",
      "MemoryArchived",
      "MemoryRestored",
    ]);

    const hist2 = (await invokeDesktopCommand("memory.history", {
      memoryId: created.id,
    })) as Array<{ eventType: string; version: number }>;
    expect(hist2.map((h) => h.eventType)).toEqual([
      "MemoryCreated",
      "MemoryUpdated",
      "MemoryArchived",
      "MemoryRestored",
    ]);

    // same long-lived runtime throughout
    expect(host.runtimeIdentity()).toBe(runtimeRef);
    expect(host.generation).toBe(1);
    expect(host.storeConstructorName()).toBe("PostgresEventStore");
  });

  it("G) LIST + pagination via Desktop IPC", async () => {
    // isolated DB on suite Embedded-Postgres (no second process)
    resetDesktopHostForTests();
    const isoHost = getDesktopHost();
    if (!live?.newDatabase) {
      throw new Error("desktop e2e requires live.newDatabase() isolation");
    }
    const isoUrl = await live.newDatabase();
    try {
      await isoHost.start({
        connectionString: isoUrl,
        environment: "test",
        producer: "v2-desktop-e2e-list",
        actor: TEST_SESSION_ACTOR,
      });
      expect(isoHost.storeConstructorName()).toBe("PostgresEventStore");

      for (let i = 0; i < 5; i++) {
        await invokeDesktopCommand("memory.create", {
          content: { type: "text", text: `list-${i}` },
          provenance: provenance(),
          idempotencyKey: randomUUID(),
        });
      }

      const all = (await invokeDesktopCommand("memory.list", {
        includeArchived: true,
      })) as MemoryListItem[];
      expect(all.length).toBe(5);
      // deterministic order
      for (let i = 1; i < all.length; i++) {
        const prev = all[i - 1]!;
        const cur = all[i]!;
        const cmp =
          prev.updatedAt.localeCompare(cur.updatedAt) ||
          prev.id.localeCompare(cur.id);
        expect(cmp).toBeLessThanOrEqual(0);
      }

      const page1 = (await invokeDesktopCommand("memory.list", {
        pageSize: 2,
      })) as ListMemoriesPage;
      expect(page1.items.length).toBe(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = (await invokeDesktopCommand("memory.list", {
        pageSize: 2,
        afterCursor: page1.nextCursor,
      })) as ListMemoriesPage;
      expect(page2.items.length).toBe(2);

      const page3 = (await invokeDesktopCommand("memory.list", {
        pageSize: 2,
        afterCursor: page2.nextCursor,
      })) as ListMemoriesPage;
      expect(page3.items.length).toBe(1);
      expect(page3.nextCursor).toBeNull();

      const ids = [
        ...page1.items,
        ...page2.items,
        ...page3.items,
      ].map((i) => i.id);
      expect(new Set(ids).size).toBe(5);
      expect(ids.length).toBe(5);

      // repeated page identical
      const page1b = (await invokeDesktopCommand("memory.list", {
        pageSize: 2,
      })) as ListMemoriesPage;
      expect(page1b).toEqual(page1);
    } finally {
      try {
        await isoHost.stop();
      } catch {
        /* ignore */
      }
      // restore primary host for subsequent tests in this file
      resetDesktopHostForTests();
      host = getDesktopHost();
      await host.start({
        connectionString: live!.connectionString,
        environment: "test",
        producer: "v2-desktop-e2e-phase3",
      actor: TEST_SESSION_ACTOR,
      });
      runtimeRef = host.runtimeIdentity();
    }
  }, 180_000);

  it("REPLAY: CLEAR → rebuildFromCore → IDENTICAL via Desktop host", async () => {
    resetDesktopHostForTests();
    const isoHost = getDesktopHost();
    if (!live?.newDatabase) {
      throw new Error("desktop e2e requires live.newDatabase() isolation");
    }
    const isoUrl = await live.newDatabase();
    try {
      await isoHost.start({
        connectionString: isoUrl,
        environment: "test",
        producer: "v2-desktop-e2e-replay",
        actor: TEST_SESSION_ACTOR,
      });

      const a = (await invokeDesktopCommand("memory.create", {
        content: { type: "text", text: "replay-a" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
      })) as MemoryDetailView;
      await invokeDesktopCommand("memory.update", {
        memoryId: a.id,
        content: { type: "text", text: "replay-a-v2" },
        idempotencyKey: randomUUID(),
      });
      await invokeDesktopCommand("memory.archive", {
        memoryId: a.id,
        idempotencyKey: randomUUID(),
      });
      await invokeDesktopCommand("memory.restore", {
        memoryId: a.id,
        idempotencyKey: randomUUID(),
      });
      const b = (await invokeDesktopCommand("memory.create", {
        content: { type: "text", text: "replay-b" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
      })) as MemoryDetailView;

      // hydrate read model fully
      await isoHost.rebuildFromCore();
      const snapA = snapCells(isoHost);
      const listA = await invokeDesktopCommand("memory.list", {
        includeArchived: true,
      });
      const histA = await invokeDesktopCommand("memory.history", {
        memoryId: a.id,
      });
      const countBefore = await isoHost.eventCount();

      await isoHost.rebuildFromCore();

      const snapB = snapCells(isoHost);
      const listB = await invokeDesktopCommand("memory.list", {
        includeArchived: true,
      });
      const histB = await invokeDesktopCommand("memory.history", {
        memoryId: a.id,
      });
      const countAfter = await isoHost.eventCount();

      expect(snapB).toEqual(snapA);
      expect(listB).toEqual(listA);
      expect(histB).toEqual(histA);
      expect(countAfter).toBe(countBefore);

      // IDs preserved
      const ids = (listB as MemoryListItem[]).map((i) => i.id).sort();
      expect(ids).toEqual([a.id, b.id].sort());
    } finally {
      try {
        await isoHost.stop();
      } catch {
        /* ignore */
      }
      resetDesktopHostForTests();
      host = getDesktopHost();
      await host.start({
        connectionString: live!.connectionString,
        environment: "test",
        producer: "v2-desktop-e2e-phase3",
      actor: TEST_SESSION_ACTOR,
      });
      runtimeRef = host.runtimeIdentity();
    }
  }, 180_000);

  it("NO-APPEND: GET LIST HISTORY REBUILD do not append events", async () => {
    const created = (await invokeDesktopCommand("memory.create", {
      content: { type: "text", text: "no-append-desktop" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;

    const before = await host.eventCount();
    await invokeDesktopCommand("memory.get", { memoryId: created.id });
    await invokeDesktopCommand("memory.list", { includeArchived: true });
    await invokeDesktopCommand("memory.list", { pageSize: 5 });
    await invokeDesktopCommand("memory.history", { memoryId: created.id });
    await host.rebuildFromCore();
    const after = await host.eventCount();
    expect(after).toBe(before);
    expect(host.runtimeIdentity()).toBe(runtimeRef);
  });

  it("missing memory GET returns null (query path)", async () => {
    const got = await invokeDesktopCommand("memory.get", {
      memoryId: randomUUID(),
    });
    expect(got).toBeNull();
  });

  it("classification: content CANONICAL, title DERIVED", async () => {
    const v = (await invokeDesktopCommand("memory.create", {
      content: { type: "text", text: "class-check" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;
    expect(v.content.class).toBe("CANONICAL");
    expect(v.displayTitle.class).toBe("DERIVED");
    expect(v.lifecycle.class).toBe("CANONICAL");
  });
});
