/**
 * CULTIVATION FOUNDATION GATE — live PostgreSQL + long-lived DesktopHost
 * Mock LLM only (GREEN path). Ollama not required.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  getDesktopHost,
  resetDesktopHostForTests,
  invokeDesktopCommand,
  type DesktopHost,
} from "@ailexsi/v2-command-adapter";
import { MockLlmProvider } from "@ailexsi/v2-cultivation";
import { startLivePostgres } from "@ailexsi/v2-test-kit";
import { TEST_SESSION_ACTOR } from "../helpers/authorized-write.js";
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

describe("CULTIVATION FOUNDATION GATE", () => {
  it("LIVE DesktopHost: chat/reject/accept-create/edit/update + Continuity context ids", async () => {
    resetDesktopHostForTests();
    const host: DesktopHost = getDesktopHost();
    host.setLlmProvider(new MockLlmProvider("live-mock-proposal-text"));
    const live = await startLivePostgres();
    try {
      await host.start({
        connectionString: live.connectionString,
        environment: "test",
        producer: "v2-cultivation-foundation",
        coreBaselineSha: CORE,
        vaultReferenceSha: VAULT,
        actor: TEST_SESSION_ACTOR,
      });
      expect(host.storeConstructorName()).toBe("PostgresEventStore");
      const gen = host.generation;

      // Seed Core-backed context memory
      const seed = (await invokeDesktopCommand("memory.create", {
        content: { type: "text", text: "context-seed" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
        context: { tags: ["cult"], project: "cultivation" },
      })) as { id: string };

      let count = await host.eventCount();

      // Session + chat (no write beyond seed)
      const session = (await invokeDesktopCommand(
        "cultivation.session.create",
        {}
      )) as { id: string };
      const chat = (await invokeDesktopCommand("cultivation.chat", {
        sessionId: session.id,
        text: "Propose a note",
        memoryIds: [seed.id],
      })) as {
        proposal: { id: string; status: string; kind: string };
      };
      expect(chat.proposal.status).toBe("pending");
      expect(chat.proposal.kind).toBe("create_memory");
      expect(await host.eventCount()).toBe(count);

      // Reject → no write
      await invokeDesktopCommand("cultivation.proposal.reject", {
        sessionId: session.id,
        proposalId: chat.proposal.id,
      });
      expect(await host.eventCount()).toBe(count);

      // New proposal + defer
      const chat2 = (await invokeDesktopCommand("cultivation.chat", {
        sessionId: session.id,
        text: "Another",
        memoryIds: [seed.id],
      })) as { proposal: { id: string } };
      await invokeDesktopCommand("cultivation.proposal.defer", {
        sessionId: session.id,
        proposalId: chat2.proposal.id,
      });
      expect(await host.eventCount()).toBe(count);

      // Accept-create with human edit
      const chat3 = (await invokeDesktopCommand("cultivation.chat", {
        sessionId: session.id,
        text: "Create",
        memoryIds: [seed.id],
      })) as { proposal: { id: string } };
      const accepted = (await invokeDesktopCommand(
        "cultivation.proposal.accept",
        {
          sessionId: session.id,
          proposalId: chat3.proposal.id,
          editedText: "human-canonical-text",
          idempotencyKey: randomUUID(),
        }
      )) as {
        cell: { identity: { id: string }; content: unknown };
        proposal: { status: string; acceptedMemoryId?: string };
      };
      expect(accepted.proposal.status).toBe("edited");
      expect(accepted.cell.content).toEqual({
        type: "text",
        text: "human-canonical-text",
      });
      const afterCreate = await host.eventCount();
      expect(afterCreate).toBe(count + 1);

      // Retrievable via Core query path
      const got = (await invokeDesktopCommand("memory.get", {
        memoryId: accepted.cell.identity.id,
      })) as { id: string; content: { value: { text: string } } };
      expect(got.id).toBe(accepted.cell.identity.id);
      expect(got.content.value.text).toBe("human-canonical-text");

      // Double accept → no extra write
      await expect(
        invokeDesktopCommand("cultivation.proposal.accept", {
          sessionId: session.id,
          proposalId: chat3.proposal.id,
          idempotencyKey: randomUUID(),
        })
      ).rejects.toThrow();
      expect(await host.eventCount()).toBe(afterCreate);

      // Accept-update path
      count = await host.eventCount();
      const chatU = (await invokeDesktopCommand("cultivation.chat", {
        sessionId: session.id,
        text: "Update it",
        memoryIds: [seed.id],
        targetMemoryId: accepted.cell.identity.id,
      })) as { proposal: { id: string; kind: string } };
      expect(chatU.proposal.kind).toBe("update_memory");
      const updated = (await invokeDesktopCommand(
        "cultivation.proposal.accept",
        {
          sessionId: session.id,
          proposalId: chatU.proposal.id,
          editedText: "updated-canonical",
          idempotencyKey: randomUUID(),
        }
      )) as {
        cell: { identity: { id: string }; currentVersion: number };
      };
      expect(updated.cell.identity.id).toBe(accepted.cell.identity.id);
      expect(updated.cell.currentVersion).toBeGreaterThanOrEqual(2);
      expect(await host.eventCount()).toBe(count + 1);

      // Continuity working-set: export ids → rehydrate verify (no write)
      count = await host.eventCount();
      const pkg = await invokeDesktopCommand("continuity.export", {
        selection: {
          mode: "ids",
          memoryIds: [seed.id, accepted.cell.identity.id],
        },
        generatedAt: "2026-08-10T00:00:00.000Z",
      });
      const ver = (await invokeDesktopCommand("continuity.rehydrate", {
        package: pkg,
      })) as { ok: boolean };
      expect(ver.ok).toBe(true);
      expect(await host.eventCount()).toBe(count);

      // Long-lived host
      expect(host.generation).toBe(gen);
      expect(host.storeConstructorName()).toBe("PostgresEventStore");
    } finally {
      try {
        await host.stop();
      } catch {
        /* ignore */
      }
      await live.stop();
    }
  }, 240_000);
});
