import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import {
  CultivationService,
  MockLlmProvider,
} from "@ailexsi/v2-cultivation";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import { authorizedCreate, viaCanonicalCommit } from "../helpers/authorized-write.js";

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
    expect(() => cult.acceptCanonical(s.id, proposal.id)).toThrow(/Cannot accept/);
    expect(store.count()).toBe(before);
  });

  it("double accept fails without second write", async () => {
    const s = cult.createSession();
    const { proposal } = await cult.chat(s.id, "x");
    const { draft } = cult.acceptCanonical(s.id, proposal.id, {
      idempotencyKey: randomUUID(),
    });
    await viaCanonicalCommit(
      () =>
        adapter.create({
          content: draft.content,
          provenance: draft.provenance,
          idempotencyKey: draft.idempotencyKey,
        }),
      { action: "memory.create", target: proposal.id }
    );
    const afterFirst = store.count();
    expect(() =>
      cult.acceptCanonical(s.id, proposal.id, { idempotencyKey: randomUUID() })
    ).toThrow(/already accepted/);
    expect(store.count()).toBe(afterFirst);
  });

  it("accept update targets existing memory", async () => {
    const existing = await authorizedCreate(adapter, {
      content: { type: "text", text: "orig" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const s = cult.createSession();
    const { proposal } = await cult.chat(s.id, "update please", {
      targetMemoryId: existing.identity.id,
    });
    expect(proposal.kind).toBe("update_memory");
    const { draft } = cult.acceptCanonical(s.id, proposal.id, {
      idempotencyKey: randomUUID(),
    });
    const cell = await viaCanonicalCommit(
      () =>
        adapter.update({
          memoryId: draft.memoryId!,
          content: draft.content,
          provenance: draft.provenance,
          changeReason: draft.changeReason,
          idempotencyKey: draft.idempotencyKey,
        }),
      { action: "memory.update", target: proposal.id }
    );
    expect(cell.identity.id).toBe(existing.identity.id);
    expect(cell.currentVersion).toBe(2);
  });

  it("accept without adapter returns a draft and does not write", async () => {
    const bare = new CultivationService(new MockLlmProvider("x"));
    const s = bare.createSession();
    const { proposal } = await bare.chat(s.id, "x");
    const { draft } = bare.acceptCanonical(s.id, proposal.id);
    expect(draft.kind).toBe("create_memory");
    expect(store.count()).toBe(0);
  });
});
