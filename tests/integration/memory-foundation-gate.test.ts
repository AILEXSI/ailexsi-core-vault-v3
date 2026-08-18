/**
 * MEMORY FOUNDATION ACCEPTANCE GATE (live PostgreSQL)
 *
 * Proves Core-backed lifecycle for V2 — no InMemory EventStore.
 *
 * Matrix:
 *   CREATE GET UPDATE ARCHIVE RESTORE HISTORY
 *   IDEMPOTENCY (same / conflict)
 *   INVALID INPUT
 *   CONCURRENCY
 *   MULTI-MEMORY + REPLAY DETERMINISM
 *   DB BOUNDARY
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createCoreRuntime,
  classifyV2Error,
  V2CommandValidationError,
  type CoreRuntime,
} from "@ailexsi/v2-command-adapter";
import { startLivePostgres, type LivePgHandle } from "@ailexsi/v2-test-kit";
import { createDb } from "@ailexsi/persistence";
import { PostgresEventStore } from "@ailexsi/eventstore";
import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  EventValidationError,
  type Provenance,
} from "@ailexsi/contracts";
import { authorizedCreate, authorizedUpdate, authorizedArchive, authorizedRestore } from "../helpers/authorized-write.js";

function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    sourceType: "user",
    capturedAt: "2026-08-09T12:00:00.000Z",
    parentMemoryIds: [],
    evidenceIds: [],
    ...overrides,
  };
}

function snapshotCell(cell: NonNullable<Awaited<ReturnType<CoreRuntime["adapter"]["get"]>>>) {
  return JSON.parse(JSON.stringify(cell));
}

describe("MEMORY FOUNDATION GATE — live PostgresEventStore", () => {
  let runtime: CoreRuntime | null = null;
  let live: LivePgHandle | null = null;
  let dbInfo: { database: string; version: string; mode: string } | null = null;

  beforeAll(async () => {
    live = await startLivePostgres();
    runtime = await createCoreRuntime({
      connectionString: live.connectionString,
      environment: "test",
      producer: "v2-memory-foundation-gate",
    });
    const rows = await runtime.database.client`
      SELECT current_database() AS db, version() AS ver
    `;
    dbInfo = {
      database: String(rows[0]!.db),
      version: String(rows[0]!.ver).slice(0, 80),
      mode: live.mode,
    };
  }, 180_000);

  afterAll(async () => {
    if (runtime) {
      try {
        await runtime.close();
      } catch {
        /* ignore */
      }
    }
    if (live) {
      try {
        await live.stop();
      } catch {
        /* ignore */
      }
    }
  }, 60_000);

  // ── 14. DATABASE BOUNDARY ──────────────────────────────────────────
  it("DATABASE BOUNDARY: V2 test DB is isolated PostgresEventStore (not frozen Core repo DB)", () => {
    expect(runtime).not.toBeNull();
    expect(live!.connectionString.startsWith("postgres://")).toBe(true);
    expect(runtime!.store.constructor.name).toBe("PostgresEventStore");
    // Must not point at a path that looks like "production core" host secrets in repo
    expect(live!.connectionString).not.toMatch(/ailexsi-core-prod|production-core/i);
    // Embedded or explicit v2-named DB
    if (live!.mode === "embedded") {
      expect(live!.connectionString).toMatch(/ailexsi_v2/);
    }
    expect(dbInfo!.database.length).toBeGreaterThan(0);
    // Report-friendly
    // eslint-disable-next-line no-console
    console.log(
      `V2 DATABASE: ${dbInfo!.database} mode=${dbInfo!.mode} | ${dbInfo!.version}`
    );
    // eslint-disable-next-line no-console
    console.log(
      `CORE DEPENDENCY: pin 652d01eb (packages under .deps/) — not mutated by this suite`
    );
  });

  // ── 4. CREATE ──────────────────────────────────────────────────────
  it("CREATE: V2 → Core → PostgresEventStore → MemoryCreated → read model", async () => {
    const key = randomUUID();
    const cell = await authorizedCreate(runtime!.adapter, {
      content: { type: "text", text: "foundation-create" },
      context: {
        tags: ["foundation", "gate"],
        project: "ailexsi-core-vault-v2",
      },
      provenance: provenance(),
      idempotencyKey: key,
      createdBy: "foundation-gate",
    });

    expect(cell.identity.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(cell.currentVersion).toBe(1);
    expect(cell.lifecycle.state).toBe("active");
    expect((cell.content as { text: string }).text).toBe("foundation-create");
    expect(cell.context.tags).toEqual(
      expect.arrayContaining(["foundation", "gate"])
    );
    expect(cell.context.project).toBe("ailexsi-core-vault-v2");

    const stream = await runtime!.store.getByAggregate(cell.identity.id);
    expect(stream.length).toBe(1);
    expect(stream[0]!.event.eventType).toBe("MemoryCreated");
    expect(stream[0]!.event.aggregateVersion).toBe(1);

    runtime!.readModel.upsertFromCore(cell, await runtime!.adapter.getHistory(cell.identity.id));
    const view = runtime!.readModel.get(cell.identity.id)!;
    expect(view.content.class).toBe("CANONICAL");
    expect(view.displayTitle.class).toBe("DERIVED");
    expect((view.content.value as { text: string }).text).toBe("foundation-create");
  });

  // ── 5. UPDATE ──────────────────────────────────────────────────────
  it("UPDATE: version 1 → MemoryUpdated → version 2; history has both", async () => {
    const created = await authorizedCreate(runtime!.adapter, {
      content: { type: "text", text: "v1-content" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const id = created.identity.id;

    const updated = await authorizedUpdate(runtime!.adapter, {
      memoryId: id,
      content: { type: "text", text: "v2-content" },
      changeReason: "foundation-update",
      idempotencyKey: randomUUID(),
    });

    expect(updated.identity.id).toBe(id);
    expect(updated.currentVersion).toBe(2);
    expect((updated.content as { text: string }).text).toBe("v2-content");

    const stream = await runtime!.store.getByAggregate(id);
    expect(stream.map((e) => e.event.eventType)).toEqual([
      "MemoryCreated",
      "MemoryUpdated",
    ]);
    expect(stream[1]!.event.aggregateVersion).toBe(2);

    const hist = await runtime!.adapter.getHistory(id);
    expect(hist.length).toBe(2);
    expect(hist[0]!.version).toBe(1);
    expect(hist[1]!.version).toBe(2);
    expect(hist[1]!.changeReason).toBe("foundation-update");

    // no second aggregate
    const allIds = new Set(
      (await runtime!.store.getStream({ afterSequence: 0, limit: 10_000 })).map(
        (e) => e.event.aggregateId
      )
    );
    expect(allIds.has(id)).toBe(true);
  });

  // ── 6–7 ARCHIVE + RESTORE ──────────────────────────────────────────
  it("ARCHIVE then RESTORE: lifecycle events + history preserved", async () => {
    const created = await authorizedCreate(runtime!.adapter, {
      content: { type: "text", text: "lifecycle-body" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const id = created.identity.id;

    const archived = await authorizedArchive(runtime!.adapter, {
      memoryId: id,
      reason: "foundation-archive",
      idempotencyKey: randomUUID(),
    });
    expect(archived.identity.id).toBe(id);
    expect(archived.lifecycle.state).toBe("archived");
    expect(archived.currentVersion).toBe(2);

    let stream = await runtime!.store.getByAggregate(id);
    expect(stream[stream.length - 1]!.event.eventType).toBe("MemoryArchived");

    const restored = await authorizedRestore(runtime!.adapter, {
      memoryId: id,
      reason: "foundation-restore",
      idempotencyKey: randomUUID(),
    });
    expect(restored.identity.id).toBe(id);
    expect(restored.lifecycle.state).toBe("active");
    expect(restored.currentVersion).toBe(3);

    stream = await runtime!.store.getByAggregate(id);
    expect(stream.map((e) => e.event.eventType)).toEqual([
      "MemoryCreated",
      "MemoryArchived",
      "MemoryRestored",
    ]);

    const hist = await runtime!.adapter.getHistory(id);
    expect(hist.length).toBe(3);
    runtime!.readModel.upsertFromCore(restored, hist);
    expect(runtime!.readModel.get(id)!.lifecycle.value.state).toBe("active");
  });

  // ── 8 HISTORY from Core stream ─────────────────────────────────────
  it("HISTORY: EventStore stream is source of truth (event types)", async () => {
    const created = await authorizedCreate(runtime!.adapter, {
      content: { type: "text", text: "hist-v1" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    await authorizedUpdate(runtime!.adapter, {
      memoryId: created.identity.id,
      content: { type: "text", text: "hist-v2" },
      idempotencyKey: randomUUID(),
      changeReason: "edit",
    });
    await authorizedArchive(runtime!.adapter, {
      memoryId: created.identity.id,
      idempotencyKey: randomUUID(),
      reason: "done",
    });
    await authorizedRestore(runtime!.adapter, {
      memoryId: created.identity.id,
      idempotencyKey: randomUUID(),
      reason: "undo",
    });

    const stream = await runtime!.store.getByAggregate(created.identity.id);
    expect(stream.map((e) => e.event.eventType)).toEqual([
      "MemoryCreated",
      "MemoryUpdated",
      "MemoryArchived",
      "MemoryRestored",
    ]);
    expect(stream.map((e) => e.event.aggregateVersion)).toEqual([1, 2, 3, 4]);

    const hist = await runtime!.adapter.getHistory(created.identity.id);
    expect(hist.length).toBe(4);
    // History versions align with Core aggregate versions
    expect(hist.map((h) => h.version)).toEqual([1, 2, 3, 4]);
  });

  // ── 9 IDEMPOTENCY ──────────────────────────────────────────────────
  it("IDEMPOTENCY same key + same payload → no duplicate event", async () => {
    const key = randomUUID();
    const a = await authorizedCreate(runtime!.adapter, {
      content: { type: "text", text: "idem-same" },
      provenance: provenance(),
      idempotencyKey: key,
    });
    const b = await authorizedCreate(runtime!.adapter, {
      content: { type: "text", text: "idem-same" },
      provenance: provenance(),
      idempotencyKey: key,
    });
    expect(b.identity.id).toBe(a.identity.id);
    const stream = await runtime!.store.getByAggregate(a.identity.id);
    expect(stream.length).toBe(1);
  });

  it("IDEMPOTENCY same key + different payload → domain returns original; EventStore conflicts on append", async () => {
    const key = randomUUID();
    const first = await authorizedCreate(runtime!.adapter, {
      content: { type: "text", text: "payload-A" },
      provenance: provenance(),
      idempotencyKey: key,
    });
    // Core MemoryDomain short-circuits — returns original (no second append)
    const second = await authorizedCreate(runtime!.adapter, {
      content: { type: "text", text: "payload-B" },
      provenance: provenance(),
      idempotencyKey: key,
    });
    expect(second.identity.id).toBe(first.identity.id);
    expect((second.content as { text: string }).text).toBe("payload-A");
    expect((await runtime!.store.getByAggregate(first.identity.id)).length).toBe(
      1
    );

    // EventStore contract: same key, different payload → IdempotencyConflictError
    const existing = await runtime!.store.getByIdempotencyKey(key);
    expect(existing).not.toBeNull();
    const db = createDb(live!.connectionString);
    const writable = new PostgresEventStore(db);
    await expect(
      writable.append({
        event: {
          ...existing!.event,
          eventId: randomUUID(),
          payload: {
            ...existing!.event.payload,
            content: { type: "text", text: "payload-DIFFERENT" },
          },
        },
        schemaVersion: existing!.schemaVersion,
        producer: existing!.producer,
        environment: existing!.environment,
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await db.client.end({ timeout: 2 }).catch(() => undefined);

    const classified = classifyV2Error(
      new IdempotencyConflictError(key)
    );
    expect(classified.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  // ── 10 INVALID INPUT ───────────────────────────────────────────────
  it("INVALID: bad provenance → V2 validation boundary; no event / no corruption", async () => {
    /**
     * Architecturally correct path:
     *   V2 adapter validateCreateMemory (ProvenanceSchema)
     *     → V2CommandValidationError  (before Core is invoked)
     *   Core EventValidationError is not reached for this input.
     *
     * Acceptance invariant:
     *   INVALID → VALIDATION → NO EVENT → NO CORRUPTION
     */
    const before = (
      await runtime!.store.getStream({ afterSequence: 0, limit: 50_000 })
    ).length;

    let caught: unknown;
    try {
      await authorizedCreate(runtime!.adapter, {
        content: { type: "text", text: "x" },
        // @ts-expect-error intentional invalid — rejected at V2 boundary
        provenance: { sourceType: "nope" },
        idempotencyKey: randomUUID(),
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(V2CommandValidationError);
    expect(classifyV2Error(caught).code).toBe("VALIDATION");

    const after = (
      await runtime!.store.getStream({ afterSequence: 0, limit: 50_000 })
    ).length;
    expect(after).toBe(before);
  });

  it("INVALID: update archived without restore → validation; no extra corrupt state", async () => {
    const created = await authorizedCreate(runtime!.adapter, {
      content: { type: "text", text: "will-archive" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    await authorizedArchive(runtime!.adapter, {
      memoryId: created.identity.id,
      idempotencyKey: randomUUID(),
    });
    const streamLen = (await runtime!.store.getByAggregate(created.identity.id))
      .length;

    await expect(
      runtime!.adapter.update({
        memoryId: created.identity.id,
        content: { type: "text", text: "should-fail" },
        idempotencyKey: randomUUID(),
      })
    ).rejects.toBeInstanceOf(EventValidationError);

    expect(
      (await runtime!.store.getByAggregate(created.identity.id)).length
    ).toBe(streamLen);
    expect(classifyV2Error(new EventValidationError("x")).code).toBe(
      "VALIDATION"
    );
  });

  it("INVALID: unknown memory id → validation", async () => {
    await expect(
      runtime!.adapter.update({
        memoryId: randomUUID(),
        content: { type: "text", text: "ghost" },
        idempotencyKey: randomUUID(),
      })
    ).rejects.toBeInstanceOf(EventValidationError);
  });

  // ── 11 CONCURRENCY ─────────────────────────────────────────────────
  it("CONCURRENCY: two updates expecting same next version → one wins, one conflicts", async () => {
    const created = await authorizedCreate(runtime!.adapter, {
      content: { type: "text", text: "race-base" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const id = created.identity.id;
    expect(created.currentVersion).toBe(1);

    // Parallel updates both read v1 and try aggregateVersion 2
    const results = await Promise.allSettled([
      runtime!.adapter.update({
        memoryId: id,
        content: { type: "text", text: "race-A" },
        idempotencyKey: randomUUID(),
        changeReason: "A",
      }),
      runtime!.adapter.update({
        memoryId: id,
        content: { type: "text", text: "race-B" },
        idempotencyKey: randomUUID(),
        changeReason: "B",
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(ConcurrencyConflictError);
    expect(classifyV2Error(err).code).toBe("CONCURRENCY_CONFLICT");

    const final = await runtime!.adapter.get(id);
    expect(final!.currentVersion).toBe(2);
    const stream = await runtime!.store.getByAggregate(id);
    // create + one successful update only
    expect(stream.length).toBe(2);
    expect(stream[1]!.event.eventType).toBe("MemoryUpdated");
  });

  // ── 12–13 MULTI-MEMORY REPLAY ──────────────────────────────────────
  it("MULTI-MEMORY REPLAY: CLEAR → REBUILD → IDENTICAL (A,B,C nontrivial order)", async () => {
    /**
     * Isolation: dedicated embedded Postgres + runtime so rebuildAll() rebuilds
     * ONLY this fixture's event stream (not events from earlier shared tests).
     * rebuildAll() still means REBUILD ALL EVENTS from that EventStore — correct semantic.
     */
    const isoLive = await startLivePostgres();
    const iso = await createCoreRuntime({
      connectionString: isoLive.connectionString,
      environment: "test",
      producer: "v2-memory-foundation-replay-iso",
    });

    try {
      const a = await authorizedCreate(iso.adapter, {
        content: { type: "text", text: "mem-A-v1" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
        context: { tags: ["A"], project: "ailexsi-core-vault-v2" },
      });
      const b = await authorizedCreate(iso.adapter, {
        content: { type: "text", text: "mem-B-v1" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
        context: { tags: ["B"] },
      });
      const c = await authorizedCreate(iso.adapter, {
        content: { type: "text", text: "mem-C-v1" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
      });

      await authorizedUpdate(iso.adapter, {
        memoryId: b.identity.id,
        content: { type: "text", text: "mem-B-v2" },
        idempotencyKey: randomUUID(),
      });
      await authorizedArchive(iso.adapter, {
        memoryId: a.identity.id,
        idempotencyKey: randomUUID(),
        reason: "archive-A",
      });
      await authorizedUpdate(iso.adapter, {
        memoryId: c.identity.id,
        content: { type: "text", text: "mem-C-v2" },
        idempotencyKey: randomUUID(),
      });
      await authorizedRestore(iso.adapter, {
        memoryId: a.identity.id,
        idempotencyKey: randomUUID(),
        reason: "restore-A",
      });
      await authorizedArchive(iso.adapter, {
        memoryId: c.identity.id,
        idempotencyKey: randomUUID(),
      });

      // EventStore contains exactly this fixture's events
      const allEvents = await iso.store.getStream({
        afterSequence: 0,
        limit: 10_000,
      });
      expect(allEvents.length).toBe(8); // 3 create + 2 update + 2 archive + 1 restore

      const ids = [a.identity.id, b.identity.id, c.identity.id];
      const stateA: Record<string, unknown> = {};
      for (const id of ids) {
        stateA[id] = {
          cell: snapshotCell((await iso.adapter.get(id))!),
          history: JSON.parse(
            JSON.stringify(await iso.adapter.getHistory(id))
          ),
        };
      }

      // Full projection state A (domain + V2 read model after rebuildAll path)
      await iso.rebuildAll();
      const domainSnapA = new Map(
        await Promise.all(
          ids.map(async (id) => [
            id,
            snapshotCell((await iso.adapter.get(id))!),
          ] as const)
        )
      );
      const readSnapA = JSON.parse(
        JSON.stringify([...iso.readModel.snapshotCells().entries()].sort())
      );
      const histSnapA = JSON.parse(
        JSON.stringify(
          Object.fromEntries(
            await Promise.all(
              ids.map(async (id) => [id, await iso.adapter.getHistory(id)])
            )
          )
        )
      );

      // CLEAR projections only (EventStore untouched)
      iso.adapter.clearProjection();
      iso.readModel.clear();
      for (const id of ids) {
        expect(await iso.adapter.get(id)).toBeNull();
        expect(iso.readModel.get(id)).toBeNull();
      }
      // EventStore still complete
      expect(
        (await iso.store.getStream({ afterSequence: 0, limit: 10_000 })).length
      ).toBe(8);

      // REPLAY ALL from EventStore
      await iso.rebuildAll();

      for (const id of ids) {
        const cell = await iso.adapter.get(id);
        const hist = await iso.adapter.getHistory(id);
        expect(snapshotCell(cell!)).toEqual(
          (stateA[id] as { cell: unknown }).cell
        );
        expect(JSON.parse(JSON.stringify(hist))).toEqual(
          (stateA[id] as { history: unknown }).history
        );
        expect(snapshotCell(cell!)).toEqual(domainSnapA.get(id));
      }

      const readSnapB = JSON.parse(
        JSON.stringify([...iso.readModel.snapshotCells().entries()].sort())
      );
      expect(readSnapB).toEqual(readSnapA);
      expect(iso.readModel.snapshotCells().size).toBe(3);

      const histSnapB = JSON.parse(
        JSON.stringify(
          Object.fromEntries(
            await Promise.all(
              ids.map(async (id) => [id, await iso.adapter.getHistory(id)])
            )
          )
        )
      );
      expect(histSnapB).toEqual(histSnapA);

      // Specific expected finals
      expect((await iso.adapter.get(a.identity.id))!.lifecycle.state).toBe(
        "active"
      );
      expect(
        (
          (await iso.adapter.get(b.identity.id))!.content as { text: string }
        ).text
      ).toBe("mem-B-v2");
      expect((await iso.adapter.get(c.identity.id))!.lifecycle.state).toBe(
        "archived"
      );

      // No new IDs
      expect((await iso.adapter.get(a.identity.id))!.identity.id).toBe(
        a.identity.id
      );
      expect((await iso.adapter.get(b.identity.id))!.identity.id).toBe(
        b.identity.id
      );
      expect((await iso.adapter.get(c.identity.id))!.identity.id).toBe(
        c.identity.id
      );
    } finally {
      try {
        await iso.close();
      } catch {
        /* ignore */
      }
      try {
        await isoLive.stop();
      } catch {
        /* ignore */
      }
    }
  }, 180_000);

  // ── GET after create ───────────────────────────────────────────────
  it("GET returns same aggregate after create", async () => {
    const created = await authorizedCreate(runtime!.adapter, {
      content: { type: "text", text: "get-me" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const got = await runtime!.adapter.get(created.identity.id);
    expect(got).toEqual(created);
  });
});
