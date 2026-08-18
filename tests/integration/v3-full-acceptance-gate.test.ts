/**
 * V3 FULL ACCEPTANCE / SYSTEM INTEGRITY GATE
 *
 * One live PostgreSQL path through:
 *   Core → Query → Context → Reflection → Cultivation → Agency
 *
 * Reuses createCoreRuntime + startLivePostgres + HarborService + AgencyBoundary.
 * Does not introduce a second EventStore, database, or test harness.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCoreRuntime, type CoreRuntime } from "@ailexsi/v2-command-adapter";
import { startLivePostgres, type LivePgHandle } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import {
  AgencyDeniedError,
  HarborService,
} from "@ailexsi/v3-harbor";
import { issueTestAuthorization } from "@ailexsi/v2-test-kit";
import { authorizedCreate } from "../helpers/authorized-write.js";

const CORE_PIN = "652d01eb06dd0841c3b475023883675af6dcd698";
const VAULT = "061e444389090c54e431b0e8243e82764f2c198e";
const HUMAN = {
  id: "martin",
  kind: "human" as const,
  authorizeCanonical: true,
  authorizeExternal: true,
};
const AI = { id: "grok", kind: "ai" as const };
const NOW = "2026-08-18T18:00:00.000Z";
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: NOW,
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

async function denialOfAsync(fn: () => Promise<unknown>): Promise<AgencyDeniedError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AgencyDeniedError) return err;
    throw err;
  }
  throw new Error("expected AgencyDeniedError");
}

describe("V3 FULL ACCEPTANCE / SYSTEM INTEGRITY GATE", () => {
  const tmpDirs: string[] = [];
  let runtime: CoreRuntime | null = null;
  let live: LivePgHandle | null = null;

  afterEach(async () => {
    if (runtime) {
      try {
        await runtime.close();
      } catch {
        /* ignore */
      }
      runtime = null;
    }
    if (live) {
      try {
        await live.stop();
      } catch {
        /* ignore */
      }
      live = null;
    }
    while (tmpDirs.length) {
      const dir = tmpDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("Core → Query → Context → Reflection → Cultivation → Agency on live PostgresEventStore", async () => {
    live = await startLivePostgres();
    runtime = await createCoreRuntime({
      connectionString: live.connectionString,
      environment: "test",
      producer: "v3-full-acceptance",
      coreBaselineSha: CORE_PIN,
      vaultReferenceSha: VAULT,
    });
    expect(runtime.store.constructor.name).toBe("PostgresEventStore");
    expect(live.connectionString.startsWith("postgres://")).toBe(true);

    const persistDir = mkdtempSync(path.join(os.tmpdir(), "v3-integrity-"));
    tmpDirs.push(persistDir);
    const harbor = new HarborService({
      corePin: CORE_PIN,
      vaultReferenceSha: VAULT,
      persistDir,
    });

    const tea = await authorizedCreate(runtime.adapter, {
      content: { type: "text", text: "user prefers tea" },
      context: { project: "kitchen", tags: ["drink"] },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
      createdBy: HUMAN.id,
    });
    const coffee = await authorizedCreate(runtime.adapter, {
      content: { type: "text", text: "user prefers coffee" },
      context: { project: "kitchen", tags: ["drink"] },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
      createdBy: HUMAN.id,
    });
    const cells = [tea, coffee];
    const seedEvents = await runtime.queries.eventCount();
    expect(seedEvents).toBeGreaterThanOrEqual(2);

    const listed = await runtime.queries.listAll({ includeArchived: true });
    expect(listed.map((m) => m.id).sort()).toEqual([tea.identity.id, coffee.identity.id].sort());
    const retrieved = await runtime.queries.retrieveMemories({ pageSize: 10 });
    expect(retrieved.items.length).toBe(2);
    expect(await runtime.queries.eventCount()).toBe(seedEvents);

    const catalog = cells.map((m) => ({
      id: m.identity.id,
      text: m.content.type === "text" ? m.content.text : "",
      project: m.context.project,
      tags: m.context.tags ?? [],
      updatedAt: m.timestamps.confirmedAt,
      lifecycle: m.lifecycle.state,
    }));

    const contradictions = harbor.scan(cells, AI, NOW);
    expect(contradictions.some((c) => c.resolution === "UNRESOLVED")).toBe(true);
    expect(await runtime.queries.eventCount()).toBe(seedEvents);

    const derived = harbor.queries(AI).getDerivedMemory(tea.identity.id);
    expect(derived?.memoryId).toBe(tea.identity.id);

    const pack = harbor.assemble(
      cells,
      {
        query: "prefers",
        maxItems: 10,
        maxChars: 4000,
        selectedMemoryIds: [tea.identity.id],
      },
      AI,
      NOW
    );
    expect(pack.items.length).toBeGreaterThan(0);
    expect(pack.items.every((i) => i.reason && i.reasonDetail)).toBe(true);
    expect(pack.contradictions.length).toBeGreaterThan(0);
    expect(await runtime.queries.eventCount()).toBe(seedEvents);

    const observed = harbor.reflectObserved(AI, NOW, { catalog, context: pack });
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((r) => r.stance === "OBSERVED")).toBe(true);

    const cultivation = harbor.cultivate(AI, NOW, { catalog, context: pack });
    expect(cultivation.length).toBeGreaterThan(0);
    expect(cultivation.every((p) => p.status === "PROPOSED")).toBe(true);
    expect(await runtime.queries.eventCount()).toBe(seedEvents);

    const proposal = await harbor.propose(
      AI,
      { text: "I don't know what to remember", sourceMemoryIds: [tea.identity.id] },
      NOW
    );
    expect(proposal.status).toBe("PROPOSED");
    expect(proposal.resultingEventIds).toEqual([]);
    expect(await runtime.queries.eventCount()).toBe(seedEvents);

    const fingerprint = harbor.currentFingerprint();
    const denyAccept = denialOfAsync(async () => {
      harbor.decideProposal(proposal.proposalId, "ACCEPTED", AI);
    });
    await expect(denyAccept).resolves.toBeInstanceOf(AgencyDeniedError);
    expect(harbor.proposals.get(proposal.proposalId)?.status).toBe("PROPOSED");

    let executed = false;
    const denyCommit = await denialOfAsync(() =>
      harbor.commitCanonical({
        actor: AI,
        grant: issueTestAuthorization(HUMAN, {
          grantedTo: { id: HUMAN.id, kind: HUMAN.kind },
          capability: "CANONICAL_COMMIT",
          action: "memory.create",
          target: "blocked",
          now: NOW,
        }, harbor.agency.registry),
        action: "memory.create",
        target: "blocked",
        execute: async () => {
          executed = true;
          await runtime!.adapter.create({
            content: { type: "text", text: "must-not-persist" },
            provenance: provenance(),
            idempotencyKey: randomUUID(),
          });
          return { result: null, eventIds: [] };
        },
      })
    );
    expect(denyCommit.denial.stateModified).toBe(false);
    expect(executed).toBe(false);
    expect(await runtime.queries.eventCount()).toBe(seedEvents);
    expect(harbor.currentFingerprint()).toBe(fingerprint);

    const grant = issueTestAuthorization(HUMAN, {
      grantedTo: { id: HUMAN.id, kind: HUMAN.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "authorized-integrity",
      now: NOW,
    }, harbor.agency.registry);
    const { result, record } = await harbor.commitCanonical({
      actor: HUMAN,
      grant,
      action: "memory.create",
      target: "authorized-integrity",
      now: NOW,
      execute: async (ctx) => {
        const cell = await runtime!.adapter.create({
          content: { type: "text", text: "authorized integrity memory" },
          provenance: provenance(),
          idempotencyKey: randomUUID(),
          createdBy: HUMAN.id,
        }, ctx);
        const stream = await runtime!.store.getByAggregate(cell.identity.id);
        return { result: cell, eventIds: stream.map((e) => e.event.eventId) };
      },
    });
    expect(result.content).toMatchObject({ type: "text", text: "authorized integrity memory" });
    expect(await runtime.queries.eventCount()).toBe(seedEvents + 1);
    expect(record.actor).toEqual({ id: HUMAN.id, kind: "human" });
    expect(record.authorization.grantId).toBe(grant.grantId);
    expect(record.authorization.grantedBy).toBe(HUMAN.id);
    expect(record.resultingEventIds.length).toBe(1);
    expect(record.provenance.originatingContext).toBe(`authorization:${grant.grantId}`);
    expect(record.provenance.derivationType).toBe("commit");

    const loaded = await runtime.queries.getMemory(result.identity.id);
    expect(loaded?.id).toBe(result.identity.id);

    const src = readFileSync(path.join(root, "packages/harbor/src/service.ts"), "utf8");
    expect(src).not.toMatch(/PostgresEventStore/);
    expect(src).not.toMatch(/appendEvent/);
    expect(existsSync(path.join(persistDir, "index.json"))).toBe(true);
    expect(harbor.derivedIndexInfo().class).toBe("V3-DERIVED");
  }, 180_000);
});
