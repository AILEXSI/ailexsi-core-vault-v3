/**
 * Integration: V2 command → Core MemoryDomain → EventStore → Projection → V2 read model
 * Uses InMemoryEventStore implementing Core EventStore contract (no Postgres required).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Provenance } from "@ailexsi/contracts";
import { IdempotencyConflictError } from "@ailexsi/contracts";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import { MemoryReadModel } from "@ailexsi/v2-read-models";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: "2026-08-09T12:00:00.000Z",
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

describe("Memory command path (V2 → Core → EventStore → V2 read)", () => {
  let store: InMemoryEventStore;
  let adapter: MemoryCommandAdapter;
  let readModel: MemoryReadModel;

  beforeEach(() => {
    store = new InMemoryEventStore();
    adapter = new MemoryCommandAdapter({ store, environment: "test" });
    readModel = new MemoryReadModel();
  });

  async function syncRead(memoryId: string) {
    const cell = await adapter.get(memoryId);
    if (!cell) return;
    const hist = await adapter.getHistory(memoryId);
    readModel.upsertFromCore(cell, hist);
  }

  it("Create → Event → Projection → V2 read", async () => {
    const cell = await adapter.create({
      content: { type: "text", text: "create-me" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
      createdBy: "test",
    });
    expect(store.count()).toBe(1);
    await syncRead(cell.identity.id);
    const view = readModel.get(cell.identity.id);
    expect(view).not.toBeNull();
    expect(view!.content.class).toBe("CANONICAL");
    expect(view!.displayTitle.class).toBe("DERIVED");
    expect(view!.content.value).toEqual({ type: "text", text: "create-me" });
  });

  it("Update → Event → Projection → V2 read", async () => {
    const created = await adapter.create({
      content: { type: "text", text: "v1" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const updated = await adapter.update({
      memoryId: created.identity.id,
      content: { type: "text", text: "v2" },
      changeReason: "edit",
      idempotencyKey: randomUUID(),
    });
    expect(updated.currentVersion).toBe(2);
    expect(store.count()).toBe(2);
    await syncRead(created.identity.id);
    const view = readModel.get(created.identity.id)!;
    expect(view.currentVersion.value).toBe(2);
    expect((view.content.value as { text: string }).text).toBe("v2");
  });

  it("Archive → Event → Projection → V2 read", async () => {
    const created = await adapter.create({
      content: { type: "text", text: "arch" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const archived = await adapter.archive({
      memoryId: created.identity.id,
      reason: "done",
      idempotencyKey: randomUUID(),
    });
    expect(archived.lifecycle.state).toBe("archived");
    await syncRead(created.identity.id);
    expect(readModel.get(created.identity.id)!.lifecycle.value.state).toBe(
      "archived"
    );
  });

  it("Restore → Event → Projection → V2 read", async () => {
    const created = await adapter.create({
      content: { type: "text", text: "rest" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    await adapter.archive({
      memoryId: created.identity.id,
      idempotencyKey: randomUUID(),
    });
    const restored = await adapter.restore({
      memoryId: created.identity.id,
      reason: "back",
      idempotencyKey: randomUUID(),
    });
    expect(restored.lifecycle.state).toBe("active");
    await syncRead(created.identity.id);
    expect(readModel.get(created.identity.id)!.lifecycle.value.state).toBe(
      "active"
    );
    expect(readModel.getHistory(created.identity.id).length).toBe(3);
  });

  it("idempotency: same key + same payload → no duplicate", async () => {
    const key = randomUUID();
    const a = await adapter.create({
      content: { type: "text", text: "same" },
      provenance: provenance(),
      idempotencyKey: key,
    });
    const b = await adapter.create({
      content: { type: "text", text: "same" },
      provenance: provenance(),
      idempotencyKey: key,
      memoryId: a.identity.id,
    });
    expect(b.identity.id).toBe(a.identity.id);
    expect(store.count()).toBe(1);
  });

  it("idempotency: same key + different payload → EventStore conflict", async () => {
    // Core MemoryDomain.create short-circuits on existing key and returns the
    // original cell (Phase 07 behavior). Payload conflict is enforced by EventStore
    // when append is attempted — the contract V2 depends on for canonical writes.
    const key = randomUUID();
    const first = await adapter.create({
      content: { type: "text", text: "a" },
      provenance: provenance(),
      idempotencyKey: key,
    });
    // Domain-level: returns original without second append
    const second = await adapter.create({
      content: { type: "text", text: "b" },
      provenance: provenance(),
      idempotencyKey: key,
    });
    expect(second.identity.id).toBe(first.identity.id);
    expect((second.content as { text: string }).text).toBe("a");
    expect(store.count()).toBe(1);

    // EventStore-level contract (same key, different payload → conflict)
    const existing = await store.getByIdempotencyKey(key);
    expect(existing).not.toBeNull();
    await expect(
      store.append({
        event: {
          ...existing!.event,
          eventId: randomUUID(),
          payload: { ...existing!.event.payload, content: { type: "text", text: "different" } },
        },
        schemaVersion: existing!.schemaVersion,
        producer: existing!.producer,
        environment: existing!.environment,
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("AAS-54 style replay: CLEAR → REPLAY → IDENTICAL for V2 read model", async () => {
    const c = await adapter.create({
      content: { type: "text", text: "one" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    await adapter.update({
      memoryId: c.identity.id,
      content: { type: "text", text: "two" },
      idempotencyKey: randomUUID(),
    });
    await adapter.archive({
      memoryId: c.identity.id,
      idempotencyKey: randomUUID(),
    });

    const expected = await adapter.get(c.identity.id);
    const expectedHist = await adapter.getHistory(c.identity.id);
    readModel.upsertFromCore(expected!, expectedHist);
    const expectedSnap = readModel.snapshotCells();

    // Clear both Core domain projection and V2 read model
    adapter.clearProjection();
    readModel.clear();
    expect(await adapter.get(c.identity.id)).toBeNull();
    expect(readModel.get(c.identity.id)).toBeNull();

    const stream = store.all();
    adapter.rebuildFromEvents(stream);
    readModel.rebuildFromEvents(stream);

    const reconstructed = await adapter.get(c.identity.id);
    expect(reconstructed).toEqual(expected);
    expect(await adapter.getHistory(c.identity.id)).toEqual(expectedHist);
    expect(readModel.snapshotCells()).toEqual(expectedSnap);
    expect(readModel.get(c.identity.id)!.lifecycle.value.state).toBe("archived");
  });
});
