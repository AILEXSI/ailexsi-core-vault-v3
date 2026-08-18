/**
 * SLICE A — Desktop / IPC command path against LIVE PostgreSQL.
 * NEVER uses InMemoryEventStore.
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
import type { Provenance, MemoryVersion } from "@ailexsi/contracts";
import type { MemoryDetailView } from "@ailexsi/v2-read-models";

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: "2026-08-09T12:00:00.000Z",
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

describe("SLICE A Desktop IPC → long-lived CoreRuntime → PostgresEventStore", () => {
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
      producer: "v2-desktop-slice-a",
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
    if (live) {
      try {
        await live.stop();
      } catch {
        /* ignore */
      }
    }
  }, 60_000);

  it("long-lived runtime: single PostgresEventStore, no InMemory", () => {
    expect(host.isRunning).toBe(true);
    expect(host.generation).toBe(1);
    expect(host.storeConstructorName()).toBe("PostgresEventStore");
    expect(["env", "embedded"]).toContain(live!.mode);
    expect(live!.connectionString.startsWith("postgres://")).toBe(true);
  });

  it("start() is idempotent — does not create a second runtime", async () => {
    const gen = host.generation;
    const idBefore = host.runtimeIdentity();
    await host.start({
      connectionString: live!.connectionString,
      environment: "test",
    });
    expect(host.generation).toBe(gen);
    expect(host.runtimeIdentity()).toBe(idBefore);
    expect(host.runtimeIdentity()).toBe(runtimeRef);
  });

  it("A) CREATE via IPC → persisted MemoryCreated", async () => {
    const key = randomUUID();
    const view = (await invokeDesktopCommand("memory.create", {
      content: { type: "text", text: `desktop-create-${key.slice(0, 8)}` },
      provenance: provenance(),
      idempotencyKey: key,
      createdBy: "desktop-ipc-test",
    })) as MemoryDetailView;

    expect(view.currentVersion.value).toBe(1);
    expect(view.content.class).toBe("CANONICAL");
    expect(host.runtimeIdentity()).toBe(runtimeRef);
    expect(host.storeConstructorName()).toBe("PostgresEventStore");

    const stream = await host.eventStoreHistory(view.id);
    expect(stream.length).toBe(1);
    expect(stream[0]!.event.eventType).toBe("MemoryCreated");
    expect(stream[0]!.event.idempotencyKey).toBe(key);
    expect(typeof stream[0]!.sequenceId).toBe("number");
  });

  it("B) GET via IPC retrieves created memory", async () => {
    const created = (await invokeDesktopCommand("memory.create", {
      content: { type: "text", text: "desktop-get-target" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;

    const got = (await invokeDesktopCommand("memory.get", {
      memoryId: created.id,
    })) as MemoryDetailView | null;

    expect(got).not.toBeNull();
    expect(got!.id).toBe(created.id);
    expect((got!.content.value as { text: string }).text).toBe(
      "desktop-get-target"
    );
    expect(host.runtimeIdentity()).toBe(runtimeRef);
  });

  it("C) UPDATE via IPC — version++, event persisted, read model updated", async () => {
    const created = (await invokeDesktopCommand("memory.create", {
      content: { type: "text", text: "desktop-upd-v1" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;

    const updated = (await invokeDesktopCommand("memory.update", {
      memoryId: created.id,
      content: { type: "text", text: "desktop-upd-v2" },
      changeReason: "slice-a-update",
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;

    expect(updated.currentVersion.value).toBe(2);
    expect((updated.content.value as { text: string }).text).toBe(
      "desktop-upd-v2"
    );
    const stream = await host.eventStoreHistory(created.id);
    expect(stream.length).toBe(2);
    expect(stream[1]!.event.eventType).toBe("MemoryUpdated");
  });

  it("D) ARCHIVE via IPC — lifecycle archived + event", async () => {
    const created = (await invokeDesktopCommand("memory.create", {
      content: { type: "text", text: "desktop-arch" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;

    const archived = (await invokeDesktopCommand("memory.archive", {
      memoryId: created.id,
      reason: "slice-a-archive",
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;

    expect(archived.lifecycle.value.state).toBe("archived");
    const stream = await host.eventStoreHistory(created.id);
    expect(stream.some((e) => e.event.eventType === "MemoryArchived")).toBe(
      true
    );
  });

  it("E) RESTORE via IPC — lifecycle active + event", async () => {
    const created = (await invokeDesktopCommand("memory.create", {
      content: { type: "text", text: "desktop-rest" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;
    await invokeDesktopCommand("memory.archive", {
      memoryId: created.id,
      idempotencyKey: randomUUID(),
    });
    const restored = (await invokeDesktopCommand("memory.restore", {
      memoryId: created.id,
      reason: "slice-a-restore",
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;

    expect(restored.lifecycle.value.state).toBe("active");
    const stream = await host.eventStoreHistory(created.id);
    expect(stream.some((e) => e.event.eventType === "MemoryRestored")).toBe(
      true
    );
    expect(host.runtimeIdentity()).toBe(runtimeRef);
  });

  it("F) HISTORY via IPC corresponds to EventStore history", async () => {
    const created = (await invokeDesktopCommand("memory.create", {
      content: { type: "text", text: "desktop-hist-v1" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;
    await invokeDesktopCommand("memory.update", {
      memoryId: created.id,
      content: { type: "text", text: "desktop-hist-v2" },
      idempotencyKey: randomUUID(),
    });
    await invokeDesktopCommand("memory.archive", {
      memoryId: created.id,
      idempotencyKey: randomUUID(),
    });

    const history = (await invokeDesktopCommand("memory.history", {
      memoryId: created.id,
    })) as MemoryVersion[];
    const stream = await host.eventStoreHistory(created.id);

    expect(history.length).toBe(stream.length);
    expect(history.length).toBe(3);
    expect(history.map((h) => h.version)).toEqual([1, 2, 3]);
  });

  it("G) AAS-54 desktop: CREATE→UPDATE→ARCHIVE → CLEAR → REBUILD → IDENTICAL", async () => {
    const created = (await invokeDesktopCommand("memory.create", {
      content: { type: "text", text: "desktop-aas54-v1" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    })) as MemoryDetailView;
    await invokeDesktopCommand("memory.update", {
      memoryId: created.id,
      content: { type: "text", text: "desktop-aas54-v2" },
      idempotencyKey: randomUUID(),
    });
    await invokeDesktopCommand("memory.archive", {
      memoryId: created.id,
      idempotencyKey: randomUUID(),
    });

    const beforeCell = await host.getCanonicalCell(created.id);
    const beforeView = (await invokeDesktopCommand("memory.get", {
      memoryId: created.id,
    })) as MemoryDetailView;
    expect(beforeCell).not.toBeNull();

    await host.clearAndRebuildFromEventStore();

    expect(host.runtimeIdentity()).toBe(runtimeRef);
    expect(host.storeConstructorName()).toBe("PostgresEventStore");

    const afterCell = await host.getCanonicalCell(created.id);
    const afterView = (await invokeDesktopCommand("memory.get", {
      memoryId: created.id,
    })) as MemoryDetailView;

    expect(afterCell).toEqual(beforeCell);
    expect(afterView.currentVersion.value).toBe(beforeView.currentVersion.value);
    expect((afterView.content.value as { text: string }).text).toBe(
      "desktop-aas54-v2"
    );
    expect(afterView.lifecycle.value.state).toBe("archived");
  });

  it("all IPC commands reused one runtime (no per-command createCoreRuntime)", () => {
    expect(host.generation).toBe(1);
    expect(host.commandsServed).toBeGreaterThanOrEqual(6);
    expect(host.runtimeIdentity()).toBe(runtimeRef);
  });
});
