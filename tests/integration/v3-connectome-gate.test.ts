/**
 * Live Connectome persist path: Agency + PostgresEventStore Memory cell.
 * No Core Relation aggregate. No second EventStore.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createCoreRuntime, type CoreRuntime } from "@ailexsi/v2-command-adapter";
import { startLivePostgres, type LivePgHandle } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import { AgencyDeniedError, HarborService, issueAuthorization, isConnectomeRelationContent } from "@ailexsi/v3-harbor";

const CORE_PIN = "652d01eb06dd0841c3b475023883675af6dcd698";
const HUMAN = { id: "martin", kind: "human" as const, authorizeCanonical: true };
const AI = { id: "grok", kind: "ai" as const };
const NOW = "2026-08-18T20:30:00.000Z";

function provenance(parents: string[] = []): Provenance {
  return {
    sourceType: "user",
    capturedAt: NOW,
    parentMemoryIds: parents,
    evidenceIds: [],
  };
}

describe("V3 CONNECTOME LIVE GATE", () => {
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
  }, 60_000);

  it("authorized relation persist is a Memory cell; AI commit is blocked", async () => {
    live = await startLivePostgres();
    runtime = await createCoreRuntime({
      connectionString: live.connectionString,
      environment: "test",
      producer: "v3-connectome-gate",
      coreBaselineSha: CORE_PIN,
    });
    expect(runtime.store.constructor.name).toBe("PostgresEventStore");
    const a = await runtime.adapter.create({
      content: { type: "text", text: "source note" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const b = await runtime.adapter.create({
      content: { type: "text", text: "target note" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = harbor.proposeRelation(AI, {
      from: a.identity.id,
      to: b.identity.id,
      type: "ABOUT",
      reason: "Source is about the target",
    }, NOW);
    harbor.decideRelation(proposal.proposalId, "ACCEPTED", HUMAN, NOW);
    const seed = await runtime.queries.eventCount();
    await expect(
      harbor.commitRelation({
        proposalId: proposal.proposalId,
        actor: AI,
        grant: issueAuthorization(HUMAN, {
          capability: "CANONICAL_COMMIT",
          action: "relation.commit",
          target: proposal.proposalId,
          now: NOW,
        }),
        action: "relation.commit",
        target: proposal.proposalId,
        execute: async () => {
          throw new Error("must not execute");
        },
      })
    ).rejects.toBeInstanceOf(AgencyDeniedError);
    expect(await runtime.queries.eventCount()).toBe(seed);

    const grant = issueAuthorization(HUMAN, {
      capability: "CANONICAL_COMMIT",
      action: "relation.commit",
      target: proposal.proposalId,
      now: NOW,
    });
    const { result, proposal: committed } = await harbor.commitRelation({
      proposalId: proposal.proposalId,
      actor: HUMAN,
      grant,
      action: "relation.commit",
      target: proposal.proposalId,
      now: NOW,
      execute: async () => {
        const cell = await runtime!.adapter.create({
          content: harbor.relationContentForCommit(proposal.proposalId, grant.grantId, HUMAN.id),
          provenance: provenance([a.identity.id, b.identity.id]),
          idempotencyKey: randomUUID(),
          createdBy: HUMAN.id,
        });
        const stream = await runtime!.store.getByAggregate(cell.identity.id);
        return { result: cell, eventIds: stream.map((e) => e.event.eventId) };
      },
    });
    expect(isConnectomeRelationContent(result.content)).toBe(true);
    expect(committed.status).toBe("COMMITTED");
    expect(await runtime.queries.eventCount()).toBe(seed + 1);
    const view = harbor.connectome([a, b, result], HUMAN, NOW);
    expect(view.relations.some((r) => r.status === "CANONICAL_MEMORY")).toBe(true);
    expect(view.coreRelationAggregate).toBe("PLANNED");
  }, 180_000);
});
