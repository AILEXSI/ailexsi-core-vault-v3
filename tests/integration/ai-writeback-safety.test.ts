/**
 * AI writeback safety:
 * 1) proposal without acceptance → EventStore unchanged
 * 2) acceptance → Core command → event
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import {
  CultivationService,
  MockLlmProvider,
} from "@ailexsi/v2-cultivation";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: "2026-08-09T12:00:00.000Z",
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

describe("AI writeback safety", () => {
  let store: InMemoryEventStore;
  let adapter: MemoryCommandAdapter;
  let cultivation: CultivationService;

  beforeEach(() => {
    store = new InMemoryEventStore();
    adapter = new MemoryCommandAdapter({ store, environment: "test" });
    cultivation = new CultivationService(
      new MockLlmProvider("Proposed memory text from AI"),
      adapter
    );
  });

  it("AI proposal without acceptance leaves EventStore unchanged", async () => {
    const before = store.count();
    const session = cultivation.createSession();
    const { proposal } = await cultivation.chat(
      session.id,
      "Please propose a memory"
    );
    expect(proposal.status).toBe("pending");
    expect(store.count()).toBe(before);

    cultivation.setProposalStatus(session.id, proposal.id, "rejected");
    expect(store.count()).toBe(before);

    cultivation.setProposalStatus(session.id, proposal.id, "deferred");
    expect(store.count()).toBe(before);
  });

  it("AI proposal acceptance issues Core command and appends event", async () => {
    const session = cultivation.createSession();
    // seed a core memory for context assembly only
    await adapter.create({
      content: { type: "text", text: "context seed" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const seedCount = store.count();

    const { proposal } = await cultivation.chat(session.id, "Remember this");
    expect(store.count()).toBe(seedCount);

    const { cell } = await cultivation.acceptCanonical(session.id, proposal.id, {
      idempotencyKey: randomUUID(),
    });
    expect(cell.content).toMatchObject({
      type: "text",
      text: "Proposed memory text from AI",
    });
    expect(store.count()).toBe(seedCount + 1);
    expect(proposal.status === "accepted" || proposal.status === "edited").toBe(
      true
    );
    expect(proposal.acceptedMemoryId).toBe(cell.identity.id);
  });

  it("edited acceptance uses edited text", async () => {
    const session = cultivation.createSession();
    const { proposal } = await cultivation.chat(session.id, "x");
    const { cell } = await cultivation.acceptCanonical(session.id, proposal.id, {
      editedText: "human-edited canonical text",
      idempotencyKey: randomUUID(),
    });
    expect(cell.content).toEqual({
      type: "text",
      text: "human-edited canonical text",
    });
    expect(proposal.status).toBe("edited");
  });
});
