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

describe("Cultivation Foundation unit", () => {
  let store: InMemoryEventStore;
  let adapter: MemoryCommandAdapter;
  let cult: CultivationService;

  beforeEach(() => {
    store = new InMemoryEventStore();
    adapter = new MemoryCommandAdapter({ store, environment: "test" });
    cult = new CultivationService(
      new MockLlmProvider("unit-proposal-body"),
      adapter
    );
  });

  it("pending proposal then reject/defer leave store unchanged", async () => {
    const s = cult.createSession();
    const before = store.count();
    const { proposal } = await cult.chat(s.id, "hi");
    expect(proposal.status).toBe("pending");
    expect(store.count()).toBe(before);
    cult.setProposalStatus(s.id, proposal.id, "rejected");
    expect(store.count()).toBe(before);
  });

  it("cannot accept rejected proposal", async () => {
    const s = cult.createSession();
    const { proposal } = await cult.chat(s.id, "x");
    cult.setProposalStatus(s.id, proposal.id, "rejected");
    const before = store.count();
    await expect(cult.acceptCanonical(s.id, proposal.id)).rejects.toThrow(
      /Cannot accept/
    );
    expect(store.count()).toBe(before);
  });

  it("double accept fails without second write", async () => {
    const s = cult.createSession();
    const { proposal } = await cult.chat(s.id, "x");
    await cult.acceptCanonical(s.id, proposal.id, {
      idempotencyKey: randomUUID(),
    });
    const afterFirst = store.count();
    await expect(
      cult.acceptCanonical(s.id, proposal.id, { idempotencyKey: randomUUID() })
    ).rejects.toThrow(/already accepted/);
    expect(store.count()).toBe(afterFirst);
  });

  it("accept update targets existing memory", async () => {
    const existing = await adapter.create({
      content: { type: "text", text: "orig" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const s = cult.createSession();
    const { proposal } = await cult.chat(s.id, "update please", {
      targetMemoryId: existing.identity.id,
    });
    expect(proposal.kind).toBe("update_memory");
    const { cell } = await cult.acceptCanonical(s.id, proposal.id, {
      idempotencyKey: randomUUID(),
    });
    expect(cell.identity.id).toBe(existing.identity.id);
    expect(cell.currentVersion).toBe(2);
  });

  it("accept without adapter fails", async () => {
    const bare = new CultivationService(new MockLlmProvider("x"));
    const s = bare.createSession();
    const { proposal } = await bare.chat(s.id, "x");
    await expect(bare.acceptCanonical(s.id, proposal.id)).rejects.toThrow(
      /MemoryCommandAdapter required/
    );
  });
});
