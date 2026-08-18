import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import {
  AgencyDeniedError,
  HarborService,
  isConnectomeRelationContent,
} from "@ailexsi/v3-harbor";
import { issueTestAuthorization } from "@ailexsi/v2-test-kit";
import { authorizedCreate } from "../helpers/authorized-write.js";

const HUMAN = { id: "martin", kind: "human" as const, authorizeCanonical: true };
const AI = { id: "grok", kind: "ai" as const };
const NOW = "2026-08-18T20:00:00.000Z";
const CORE_PIN = "652d01eb06dd0841c3b475023883675af6dcd698";

function provenance(parents: string[] = []): Provenance {
  return {
    sourceType: "user",
    capturedAt: NOW,
    parentMemoryIds: parents,
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

async function twoRelatedMemories() {
  const store = new InMemoryEventStore();
  const adapter = new MemoryCommandAdapter({ store, environment: "test" });
  const parent = await authorizedCreate(adapter, {
    content: { type: "text", text: "user prefers tea" },
    context: { project: "kitchen", tags: ["drink"] },
    provenance: provenance(),
    idempotencyKey: randomUUID(),
  });
  const child = await authorizedCreate(adapter, {
    content: { type: "text", text: "user prefers coffee" },
    context: { project: "kitchen", tags: ["drink"] },
    provenance: provenance([parent.identity.id]),
    idempotencyKey: randomUUID(),
  });
  const witness = await authorizedCreate(adapter, {
    content: { type: "text", text: "witness note about the pair" },
    context: { project: "kitchen", tags: ["evidence"] },
    provenance: provenance(),
    idempotencyKey: randomUUID(),
  });
  return { store, adapter, parent, child, witness, cells: [parent, child, witness] };
}

describe("V3 Connectome", () => {
  it("builds a derived graph from Core memories and Harbor overlays", async () => {
    const { cells, parent, child } = await twoRelatedMemories();
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    harbor.scan(cells, HUMAN, NOW);
    const view = harbor.connectome(cells, HUMAN, NOW);
    expect(view.class).toBe("V3-DERIVED");
    expect(view.coreRelationAggregate).toBe("PLANNED");
    expect(view.nodes.some((n) => n.id === parent.identity.id)).toBe(true);
    const observed = view.relations.find((r) => r.type === "DERIVED_FROM" && r.from === parent.identity.id);
    expect(observed?.to).toBe(child.identity.id);
    expect(observed?.explanation.what).toContain("DERIVED_FROM");
    expect(observed?.explanation.source).toMatch(/parentMemoryIds/);
    expect(["OBSERVED", "DISPUTED"]).toContain(observed?.status);
    const disputed = view.relations.filter((r) => r.type === "CONTRADICTS");
    expect(disputed.length).toBeGreaterThan(0);
    expect(disputed.every((r) => r.status === "DISPUTED" || r.status === "INFERRED")).toBe(true);
  });

  it("legacy graph() remains V3-DERIVED and does not write Core", async () => {
    const { store, cells } = await twoRelatedMemories();
    const events = store.count();
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    harbor.scan(cells, HUMAN, NOW);
    const g = harbor.graph(cells, AI);
    expect(g.class).toBe("V3-DERIVED");
    expect(store.count()).toBe(events);
  });

  it("traversal is deterministic and explainable", async () => {
    const { cells, parent, child } = await twoRelatedMemories();
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const first = harbor.traverseConnectome(cells, parent.identity.id, child.identity.id, HUMAN);
    const second = harbor.traverseConnectome(cells, parent.identity.id, child.identity.id, HUMAN);
    expect(first).toEqual(second);
    expect(first.found).toBe(false);
    expect(first.hops).toEqual([]);
    expect(first.reason).toBe(
      "A speculative path exists but is excluded from canonical traversal."
    );
    const missing = harbor.traverseConnectome(cells, child.identity.id, "no-such-node", HUMAN);
    expect(missing.found).toBe(false);
    expect(missing.reason).toMatch(/No path found/);
  });

  it("AI may propose a relation; accept does not persist", async () => {
    const { store, cells, parent, child } = await twoRelatedMemories();
    const events = store.count();
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = harbor.proposeRelation(AI, {
      from: parent.identity.id,
      to: child.identity.id,
      type: "SUPPORTS",
      reason: "Same kitchen preference thread",
      evidenceMemoryIds: [parent.identity.id, child.identity.id],
    }, NOW);
    expect(proposal.status).toBe("PROPOSED");
    expect(store.count()).toBe(events);
    const again = harbor.proposeRelation(AI, {
      from: parent.identity.id,
      to: child.identity.id,
      type: "SUPPORTS",
      reason: "Same kitchen preference thread",
      evidenceMemoryIds: [parent.identity.id, child.identity.id],
    }, NOW);
    expect(again.proposalId).toBe(proposal.proposalId);
    const decided = harbor.decideRelation(proposal.proposalId, "ACCEPTED", HUMAN, NOW);
    expect(decided.status).toBe("ACCEPTED");
    expect(store.count()).toBe(events);
    const listed = harbor.listConnectomeRelations(cells, HUMAN, { status: "PROPOSED" }, NOW);
    expect(listed.some((r) => r.relationId === `prop:${proposal.proposalId}`)).toBe(true);
  });

  it("unauthorized relation commit is BLOCKED and does not mutate state", async () => {
    const { store, adapter, parent, child, witness } = await twoRelatedMemories();
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = harbor.proposeRelation(AI, {
      from: parent.identity.id,
      to: child.identity.id,
      type: "SUPPORTS",
      reason: "test",
      evidenceMemoryIds: [witness.identity.id],
    }, NOW);
    harbor.decideRelation(proposal.proposalId, "ACCEPTED", HUMAN, NOW);
    const events = store.count();
    const grant = issueTestAuthorization(HUMAN, {
      grantedTo: { id: HUMAN.id, kind: HUMAN.kind },
      capability: "CANONICAL_COMMIT",
      action: "relation.commit",
      target: proposal.proposalId,
      now: NOW,
    });
    let executed = false;
    const err = await denialOfAsync(() =>
      harbor.commitRelation({
        proposalId: proposal.proposalId,
        actor: AI,
        grant,
        action: "relation.commit",
        target: proposal.proposalId,
        execute: async (ctx) => {
          executed = true;
          const cell = await adapter.create({
            content: harbor.relationContentForCommit(proposal.proposalId, grant.grantId, HUMAN.id),
            provenance: provenance([parent.identity.id, child.identity.id]),
            idempotencyKey: randomUUID(),
          }, ctx);
          return { result: cell, eventIds: [] };
        },
      })
    );
    expect(err.denial.requestedCapability).toBe("CANONICAL_COMMIT");
    expect(executed).toBe(false);
    expect(store.count()).toBe(events);
    expect(harbor.relationProposals.get(proposal.proposalId)?.status).toBe("ACCEPTED");
  });

  it("human-authorized relation persist writes a Memory cell and stays explainable", async () => {
    const { store, adapter, parent, child, witness, cells } = await twoRelatedMemories();
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = harbor.proposeRelation(AI, {
      from: parent.identity.id,
      to: child.identity.id,
      type: "SUPPORTS",
      reason: "Human-reviewed support",
      evidenceMemoryIds: [witness.identity.id],
    }, NOW);
    harbor.decideRelation(proposal.proposalId, "ACCEPTED", HUMAN, NOW);
    const grant = issueTestAuthorization(HUMAN, {
      grantedTo: { id: HUMAN.id, kind: HUMAN.kind },
      capability: "CANONICAL_COMMIT",
      action: "relation.commit",
      target: proposal.proposalId,
      now: NOW,
    });
    const { result, record, proposal: committed } = await harbor.commitRelation({
      proposalId: proposal.proposalId,
      actor: HUMAN,
      grant,
      action: "relation.commit",
      target: proposal.proposalId,
      now: NOW,
      execute: async (ctx) => {
        const cell = await adapter.create({
          content: harbor.relationContentForCommit(proposal.proposalId, grant.grantId, HUMAN.id),
          provenance: provenance([parent.identity.id, child.identity.id]),
          idempotencyKey: randomUUID(),
          createdBy: HUMAN.id,
        }, ctx);
        return { result: cell, eventIds: store.all().map((e) => e.event.eventId) };
      },
    });
    expect(isConnectomeRelationContent(result.content)).toBe(true);
    expect(committed.status).toBe("COMMITTED");
    expect(record.authorization.grantId).toBe(grant.grantId);
    expect(committed.resultingEventIds.length).toBeGreaterThan(0);
    const view = harbor.connectome([...cells, result], HUMAN, NOW);
    const canonical = view.relations.find((r) => r.status === "CANONICAL_MEMORY");
    expect(canonical?.canonicalMemoryId).toBe(result.identity.id);
    expect(canonical?.explanation.authority).toMatch(/citation/);
    expect(canonical?.explanation.status).toBe("CANONICAL_MEMORY");
    const explained = harbor.explainConnectomeRelation([...cells, result], canonical!.relationId, HUMAN, NOW);
    expect(explained.why).toMatch(/citations are not grants|do not prove/i);
  });

  it("AI cannot self-authorize a relation grant", () => {
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    expect(() =>
      issueTestAuthorization(AI, {
        grantedTo: { id: AI.id, kind: AI.kind },
        capability: "CANONICAL_COMMIT",
        action: "relation.commit",
        target: "x",
      })
    ).toThrow(AgencyDeniedError);
    expect(harbor.relationProposals.size).toBe(0);
  });

  it("history cannot be deleted through the agency boundary", () => {
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    expect(() => harbor.agency.deleteCanonicalHistory(AI, "relations")).toThrow(AgencyDeniedError);
    expect(() => harbor.agency.modifyEvidence(HUMAN, "evidence")).toThrow(AgencyDeniedError);
  });
});
