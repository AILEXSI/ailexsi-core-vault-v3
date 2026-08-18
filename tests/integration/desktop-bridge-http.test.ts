/**
 * Bridge + UI path (HTTP):
 *   HTTP /commands/* → DesktopHost → PostgresEventStore
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  startDesktopBridgeServer,
  getDesktopHost,
  resetDesktopHostForTests,
  type DesktopBridgeServer,
} from "@ailexsi/v2-command-adapter";
import { startLivePostgres, type LivePgHandle } from "@ailexsi/v2-test-kit";
import { TEST_CHANNEL_TOKEN, TEST_SESSION_ACTOR, withHostGrant } from "../helpers/authorized-write.js";
import type { Provenance } from "@ailexsi/contracts";

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: "2026-08-09T12:00:00.000Z",
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

async function post(base: string, command: string, body: unknown) {
  const res = await fetch(`${base}/commands/${command}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-channel-token": process.env.DESKTOP_HOST_TOKEN ?? TEST_CHANNEL_TOKEN,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe("Desktop HTTP bridge → long-lived DesktopHost → PostgresEventStore", () => {
  let live: LivePgHandle | null = null;
  let server: DesktopBridgeServer | null = null;
  let base = "";

  beforeAll(async () => {
    resetDesktopHostForTests();
    process.env.DESKTOP_HOST_TOKEN = TEST_CHANNEL_TOKEN;
    live = await startLivePostgres();
    server = await startDesktopBridgeServer({
      connectionString: live.connectionString,
      port: 0,
      environment: "test",
      producer: "v2-bridge-test",
      actor: TEST_SESSION_ACTOR,
    });
    base = server.url;
  }, 180_000);

  afterAll(async () => {
    if (server) {
      try {
        await server.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await getDesktopHost().stop();
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

  it("missing Channel Token on /commands is 401", async () => {
    const res = await fetch(`${base}/commands/memory.list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/token/i);
  });

  it("health reports PostgresEventStore", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.store).toBe("PostgresEventStore");
    expect(body.running).toBe(true);
  });

  it("CREATE + LIST + GET via HTTP bridge", async () => {
    const key = randomUUID();
    const created = await post(base, "memory.create", withHostGrant(getDesktopHost(), "memory.create", {
      content: { type: "text", text: `bridge-ui-${key.slice(0, 8)}` },
      provenance: provenance(),
      idempotencyKey: key,
      createdBy: "bridge-test",
    }));
    expect(created.status).toBe(200);
    expect(created.json.ok).toBe(true);
    const view = created.json.result;
    expect(view.currentVersion.value).toBe(1);

    const listed = await post(base, "memory.list", { includeArchived: true });
    expect(listed.status).toBe(200);
    const items = listed.json.result as Array<{ id: string }>;
    expect(items.some((i) => i.id === view.id)).toBe(true);

    const got = await post(base, "memory.get", { memoryId: view.id });
    expect(got.json.result.id).toBe(view.id);
    expect(getDesktopHost().storeConstructorName()).toBe("PostgresEventStore");
  });

  it("UPDATE + ARCHIVE + RESTORE + HISTORY via HTTP", async () => {
    const created = await post(base, "memory.create", withHostGrant(getDesktopHost(), "memory.create", {
      content: { type: "text", text: "lifecycle-bridge-v1" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
      context: { tags: ["project"], project: "ailexsi-core-vault-v2" },
    }));
    const id = created.json.result.id as string;

    const updated = await post(base, "memory.update", withHostGrant(getDesktopHost(), "memory.update", {
      memoryId: id,
      content: { type: "text", text: "lifecycle-bridge-v2" },
      changeReason: "bridge-update",
      idempotencyKey: randomUUID(),
    }));
    expect(updated.json.result.currentVersion.value).toBe(2);

    const archived = await post(base, "memory.archive", withHostGrant(getDesktopHost(), "memory.archive", {
      memoryId: id,
      reason: "bridge-archive",
      idempotencyKey: randomUUID(),
    }));
    expect(archived.json.result.lifecycle.value.state).toBe("archived");

    const restored = await post(base, "memory.restore", withHostGrant(getDesktopHost(), "memory.restore", {
      memoryId: id,
      reason: "bridge-restore",
      idempotencyKey: randomUUID(),
    }));
    expect(restored.json.result.lifecycle.value.state).toBe("active");

    const hist = await post(base, "memory.history", { memoryId: id });
    expect(hist.json.result.length).toBe(4);
    const stream = await getDesktopHost().eventStoreHistory(id);
    expect(stream.length).toBe(4);
  });

  it("acceptance evidence memory with tags evidence+acceptance", async () => {
    const created = await post(base, "memory.create", withHostGrant(getDesktopHost(), "memory.create", {
      content: {
        type: "text",
        text: "AILEXSI Core Vault V2 — Acceptance Evidence\nHEAD: test\nPhase 08: ABSENT",
      },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
      context: {
        tags: ["evidence", "acceptance"],
        project: "ailexsi-core-vault-v2",
      },
      createdBy: "v2-acceptance-evidence",
    }));
    expect(created.status).toBe(200);
    const view = created.json.result;
    expect(view.context.value.tags).toEqual(
      expect.arrayContaining(["evidence", "acceptance"])
    );
    expect(view.context.value.project).toBe("ailexsi-core-vault-v2");

    const listed = await post(base, "memory.list", { includeArchived: true });
    const items = listed.json.result as Array<{ id: string; tags: string[] }>;
    const hit = items.find((i) => i.id === view.id);
    expect(hit?.tags).toEqual(
      expect.arrayContaining(["evidence", "acceptance"])
    );
  });

  it("long-lived host: generation stays 1 across HTTP commands", async () => {
    expect(getDesktopHost().generation).toBe(1);
    await post(base, "memory.create", withHostGrant(getDesktopHost(), "memory.create", {
      content: { type: "text", text: "bridge-long-lived" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    }));
    expect(getDesktopHost().generation).toBe(1);
    expect(getDesktopHost().commandsServed).toBeGreaterThan(1);
  });
});
