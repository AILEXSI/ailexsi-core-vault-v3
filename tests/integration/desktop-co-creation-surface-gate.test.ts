/**
 * DESKTOP CO-CREATION SURFACE GATE (DCS)
 *
 * Client/bridge surface + long-lived DesktopHost + live PostgresEventStore.
 * Mock LLM via DesktopHost default. No Ollama.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  startDesktopBridgeServer,
  getDesktopHost,
  resetDesktopHostForTests,
  type DesktopBridgeServer,
} from "@ailexsi/v2-command-adapter";
import { MockLlmProvider } from "@ailexsi/v2-cultivation";
import { startLivePostgres, type LivePgHandle } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";

const CORE = "652d01eb06dd0841c3b475023883675af6dcd698";
const VAULT = "061e444389090c54e431b0e8243e82764f2c198e";

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: "2026-08-09T12:00:00.000Z",
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

async function post(base: string, command: string, body: unknown = {}) {
  const res = await fetch(`${base}/commands/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    ok?: boolean;
    result?: unknown;
    error?: string;
  };
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `bridge ${command} ${res.status}`);
  }
  return json.result;
}

describe("DESKTOP CO-CREATION SURFACE GATE", () => {
  let live: LivePgHandle | null = null;
  let server: DesktopBridgeServer | null = null;
  let base = "";

  beforeAll(async () => {
    resetDesktopHostForTests();
    const host = getDesktopHost();
    host.setLlmProvider(new MockLlmProvider("dcs-mock-proposal-text"));
    live = await startLivePostgres();
    server = await startDesktopBridgeServer({
      connectionString: live.connectionString,
      port: 0,
      environment: "test",
      producer: "v2-dcs-surface",
      coreBaselineSha: CORE,
      vaultReferenceSha: VAULT,
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
    try {
      await live?.stop();
    } catch {
      /* ignore */
    }
  }, 60_000);

  it("DCS: client bridge retrieve/context + cultivation reject/accept + long-lived host", async () => {
    const host = getDesktopHost();
    expect(host.storeConstructorName()).toBe("PostgresEventStore");
    const gen = host.generation;

    // DCS-01 retrieve / context via bridge (same path as desktop client HTTP)
    const seed = (await post(base, "memory.create", {
      content: { type: "text", text: "dcs-seed" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
      context: { tags: ["dcs"], project: "co-creation" },
    })) as { id: string };

    const retrieved = (await post(base, "memory.retrieve", {
      pageSize: 10,
      tagsAny: ["dcs"],
    })) as { items: { id: string }[] };
    expect(retrieved.items.some((i) => i.id === seed.id)).toBe(true);

    await post(base, "memory.context", {
      memoryIds: [seed.id],
      maxItems: 5,
      maxChars: 10_000,
    });

    let count = await host.eventCount();

    // DCS-02/03 session + chat → pending
    const session = (await post(base, "cultivation.session.create", {})) as {
      id: string;
    };
    const chat = (await post(base, "cultivation.chat", {
      sessionId: session.id,
      text: "Propose",
      memoryIds: [seed.id],
    })) as { proposal: { id: string; status: string; kind: string } };
    expect(chat.proposal.status).toBe("pending");
    expect(await host.eventCount()).toBe(count);

    // DCS-04 reject
    await post(base, "cultivation.proposal.reject", {
      sessionId: session.id,
      proposalId: chat.proposal.id,
    });
    expect(await host.eventCount()).toBe(count);

    // DCS-05 defer
    const chat2 = (await post(base, "cultivation.chat", {
      sessionId: session.id,
      text: "Again",
      memoryIds: [seed.id],
    })) as { proposal: { id: string } };
    await post(base, "cultivation.proposal.defer", {
      sessionId: session.id,
      proposalId: chat2.proposal.id,
    });
    expect(await host.eventCount()).toBe(count);

    // DCS-06/07 accept + edit
    const chat3 = (await post(base, "cultivation.chat", {
      sessionId: session.id,
      text: "Create",
      memoryIds: [seed.id],
    })) as { proposal: { id: string } };
    const accepted = (await post(base, "cultivation.proposal.accept", {
      sessionId: session.id,
      proposalId: chat3.proposal.id,
      editedText: "dcs-human-canonical",
      idempotencyKey: randomUUID(),
    })) as {
      cell: { identity: { id: string }; content: unknown };
      proposal: { status: string };
    };
    expect(accepted.proposal.status).toBe("edited");
    expect(accepted.cell.content).toEqual({
      type: "text",
      text: "dcs-human-canonical",
    });
    expect(await host.eventCount()).toBe(count + 1);

    // DCS-08 list/get
    const got = (await post(base, "memory.get", {
      memoryId: accepted.cell.identity.id,
    })) as { id: string; content: { value: { text: string } } };
    expect(got.id).toBe(accepted.cell.identity.id);
    expect(got.content.value.text).toBe("dcs-human-canonical");

    const list = (await post(base, "memory.list", {
      includeArchived: true,
    })) as { id: string }[];
    expect(list.some((m) => m.id === accepted.cell.identity.id)).toBe(true);

    // DCS-10 long-lived
    expect(host.generation).toBe(gen);
    expect(host.storeConstructorName()).toBe("PostgresEventStore");
  }, 240_000);
});
