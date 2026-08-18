import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import { HarborService } from "@ailexsi/v3-harbor";
import { authorizedCreate } from "../helpers/authorized-write.js";

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: "2026-08-17T12:00:00.000Z",
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

const HUMAN = { id: "martin", kind: "human" as const };

describe("Harbor rebuildability", () => {
  it("CANONICAL → REBUILD → DERIVED is deterministic", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const a = await authorizedCreate(adapter, {
      content: { type: "text", text: "user prefers tea" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const b = await authorizedCreate(adapter, {
      content: { type: "text", text: "user prefers coffee" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const cells = [a, b];
    const now = "2026-08-17T15:00:00.000Z";
    const h1 = new HarborService({ corePin: "c", vaultReferenceSha: "v" });
    const h2 = new HarborService({ corePin: "c", vaultReferenceSha: "v" });
    const r1 = h1.rebuildFromCanonical(cells, HUMAN, now);
    const r2 = h2.rebuildFromCanonical(cells, HUMAN, now);
    expect(r1).toEqual(r2);
    expect([...h1.contradictions.keys()].sort()).toEqual([...h2.contradictions.keys()].sort());
    expect([...h1.reflections.keys()].sort()).toEqual([...h2.reflections.keys()].sort());
    const beforeEvents = store.count();
    h1.rebuildFromCanonical(cells, HUMAN, now);
    expect(store.count()).toBe(beforeEvents);
  });

  it("corrupted derived state rebuilds without destroying EventStore", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const a = await authorizedCreate(adapter, {
      content: { type: "text", text: "user prefers tea" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: "c", vaultReferenceSha: "v" });
    harbor.rebuildFromCanonical([a], HUMAN, "2026-08-17T15:00:00.000Z");
    harbor.epistemic.set(a.identity.id, {
      memoryId: a.identity.id,
      status: "REJECTED",
      confidence: 0,
      evidenceEventIds: [],
      lastChangedAt: "corrupt",
      changedBy: { id: "corrupt", kind: "ai" },
      class: "V3-DERIVED",
    });
    const events = store.count();
    harbor.rebuildFromCanonical([a], HUMAN, "2026-08-17T15:00:00.000Z");
    expect(store.count()).toBe(events);
    expect(harbor.epistemic.get(a.identity.id)?.status).toBe("FACT");
  });
});
