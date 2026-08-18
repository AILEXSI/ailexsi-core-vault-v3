/**
 * CONTINUITY FOUNDATION GATE — live PostgreSQL
 * Process boundary: Runtime A export → close → Runtime B rehydrate (same EventStore).
 *
 * Infrastructure: ONE Embedded-Postgres server per suite + live.newDatabase() isolation
 * (Windows port/lifecycle races from nested startLivePostgres() are forbidden).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createCoreRuntime,
  getDesktopHost,
  resetDesktopHostForTests,
  invokeDesktopCommand,
  type CoreRuntime,
  type DesktopHost,
} from "@ailexsi/v2-command-adapter";
import { packagesIdentityEqual } from "@ailexsi/v2-continuity";
import { startLivePostgres, type LivePgHandle } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import { authorizedCreate, invokeAuthorized, TEST_SESSION_ACTOR } from "../helpers/authorized-write.js";

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

async function isoUrl(live: LivePgHandle): Promise<string> {
  if (!live.newDatabase) {
    throw new Error(
      "continuity gate requires live.newDatabase() isolation (shared Embedded-Postgres server)"
    );
  }
  return live.newDatabase();
}

describe("CONTINUITY FOUNDATION GATE", () => {
  let live: LivePgHandle | null = null;

  beforeAll(async () => {
    live = await startLivePostgres();
  }, 180_000);

  afterAll(async () => {
    try {
      await live?.stop();
    } catch {
      /* ignore */
    }
  }, 60_000);

  it("LIVE PostgresEventStore process boundary + no-write", async () => {
    const url = await isoUrl(live!);
    let rtA: CoreRuntime | null = null;
    let rtB: CoreRuntime | null = null;
    try {
      rtA = await createCoreRuntime({
        connectionString: url,
        environment: "test",
        producer: "v2-continuity-a",
        coreBaselineSha: CORE,
        vaultReferenceSha: VAULT,
      });
      expect(rtA.store.constructor.name).toBe("PostgresEventStore");

      const created = [];
      for (const text of ["cont-a", "cont-b", "cont-c"]) {
        created.push(
          await authorizedCreate(rtA.adapter, {
            content: { type: "text", text },
            provenance: provenance(),
            idempotencyKey: randomUUID(),
            context: { tags: ["cont"], project: "continuity" },
          })
        );
      }
      await rtA.rebuildAll();

      const ids = created.map((c) => c.identity.id);
      const before = await rtA.queries.eventCount();

      const pkg1 = await rtA.continuity.exportPackage({
        selection: {
          mode: "ids",
          memoryIds: ids,
          context: { maxItems: 10, maxChars: 50_000 },
        },
        generatedAt: "2026-08-09T20:00:00.000Z",
      });
      const pkg2 = await rtA.continuity.exportPackage({
        selection: {
          mode: "ids",
          memoryIds: ids,
          context: { maxItems: 10, maxChars: 50_000 },
        },
        generatedAt: "2099-01-01T00:00:00.000Z",
      });
      expect(packagesIdentityEqual(pkg1, pkg2)).toBe(true);
      expect(pkg1.coreBaselineSha).toBe(CORE);
      expect(pkg1.vaultReferenceSha).toBe(VAULT);
      expect(pkg1.classifications.package).toBe("V2-DERIVED");

      const json = rtA.continuity.serialize(pkg1);
      const parsed = rtA.continuity.parse(json);
      expect(packagesIdentityEqual(pkg1, parsed)).toBe(true);

      const retrievePkg = await rtA.continuity.exportPackage({
        selection: {
          mode: "retrieve",
          retrieve: {
            pageSize: 10,
            tagsAny: ["cont"],
            project: "continuity",
          },
          context: { maxItems: 5, maxChars: 20_000 },
        },
        generatedAt: "2026-08-09T20:00:00.000Z",
      });
      expect(retrievePkg.orderedMemoryIds.length).toBe(3);

      // Process boundary: close A, open B on same EventStore DB
      await rtA.close();
      rtA = null;

      rtB = await createCoreRuntime({
        connectionString: url,
        environment: "test",
        producer: "v2-continuity-b",
        coreBaselineSha: CORE,
        vaultReferenceSha: VAULT,
      });

      const verify = await rtB.continuity.rehydrateVerify(pkg1);
      expect(verify.missingIds).toEqual([]);
      expect(verify.ok).toBe(true);

      const verifyR = await rtB.continuity.rehydrateVerify(retrievePkg);
      expect(verifyR.ok).toBe(true);
      expect(verifyR.retrieveMatch).toBe(true);

      await rtB.queries.rebuildFromCore();
      const verify2 = await rtB.continuity.rehydrateVerify(retrievePkg);
      expect(verify2.ok).toBe(true);

      const after = await rtB.queries.eventCount();
      expect(after).toBe(before);

      const bad = await rtB.continuity.rehydrateVerify({
        ...pkg1,
        orderedMemoryIds: [randomUUID()],
      });
      expect(bad.ok).toBe(false);
      expect(bad.missingIds.length).toBe(1);
    } finally {
      try {
        await rtA?.close();
      } catch {
        /* ignore */
      }
      try {
        await rtB?.close();
      } catch {
        /* ignore */
      }
    }
  }, 240_000);

  it("Desktop long-lived continuity.export / inspect / rehydrate", async () => {
    // Isolated DB on suite server — no second Embedded-Postgres process
    const url = await isoUrl(live!);
    resetDesktopHostForTests();
    const host: DesktopHost = getDesktopHost();
    try {
      await host.start({
        connectionString: url,
        environment: "test",
        producer: "v2-continuity-desktop",
        coreBaselineSha: CORE,
        vaultReferenceSha: VAULT,
        actor: TEST_SESSION_ACTOR,
      });
      expect(host.storeConstructorName()).toBe("PostgresEventStore");
      const gen = host.generation;

      await invokeAuthorized(host, "memory.create", {
        content: { type: "text", text: "desktop-cont" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
        context: { tags: ["desk-c"] },
      });

      const page = (await invokeDesktopCommand("memory.retrieve", {
        pageSize: 10,
        tagsAny: ["desk-c"],
      })) as { items: { id: string }[] };

      const pkg = await invokeDesktopCommand("continuity.export", {
        selection: {
          mode: "ids",
          memoryIds: page.items.map((i) => i.id),
        },
        generatedAt: "2026-08-09T21:00:00.000Z",
      });

      const info = (await invokeDesktopCommand("continuity.inspect", {
        package: pkg,
      })) as { memoryCount: number };
      expect(info.memoryCount).toBe(1);

      const result = (await invokeDesktopCommand("continuity.rehydrate", {
        package: pkg,
      })) as { ok: boolean };
      expect(result.ok).toBe(true);

      expect(host.generation).toBe(gen);
    } finally {
      try {
        await host.stop();
      } catch {
        /* ignore */
      }
    }
  }, 180_000);
});
