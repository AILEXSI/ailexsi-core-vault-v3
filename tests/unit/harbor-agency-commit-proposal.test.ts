import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import {
  AgencyDeniedError,
  HarborService,
} from "@ailexsi/v3-harbor";
import { issueTestAuthorization } from "@ailexsi/v2-test-kit";

const HUMAN = { id: "martin", kind: "human" as const, authorizeCanonical: true };
const AI = { id: "grok", kind: "ai" as const };
const NOW = "2026-08-18T19:00:00.000Z";
const CORE_PIN = "652d01eb06dd0841c3b475023883675af6dcd698";

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

describe("Agency proposal persist", () => {
  it("accepting a proposal does not write EventStore or mint a grant", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = await harbor.propose(AI, { text: "remember tea", sourceMemoryIds: [] }, NOW);
    const events = store.count();
    const decided = harbor.decideProposal(proposal.proposalId, "ACCEPTED", HUMAN, { now: NOW });
    expect(decided.status).toBe("ACCEPTED");
    expect(decided.resultingEventIds).toEqual([]);
    expect(store.count()).toBe(events);
    expect(() => harbor.agency.convertProposalToCanonical(AI, proposal.proposalId)).toThrow(
      AgencyDeniedError
    );
  });

  it("unaccepted proposal persist is BLOCKED and does not execute", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = await harbor.propose(AI, { text: "remember tea", sourceMemoryIds: [] }, NOW);
    const events = store.count();
    let executed = false;
    const grant = issueTestAuthorization(HUMAN, {
      grantedTo: { id: HUMAN.id, kind: HUMAN.kind },
      capability: "CANONICAL_COMMIT",
      action: "proposal.commit",
      target: proposal.proposalId,
      now: NOW,
    });
    const err = await denialOfAsync(() =>
      harbor.commitProposal({
        proposalId: proposal.proposalId,
        actor: HUMAN,
        grant,
        action: "proposal.commit",
        target: proposal.proposalId,
        execute: async (ctx) => {
          executed = true;
          const cell = await adapter.create({
            content: { type: "text", text: "should not write" },
            provenance: provenance(),
            idempotencyKey: randomUUID(),
          }, ctx);
          return { result: cell, eventIds: [] };
        },
      })
    );
    expect(err.denial.code).toBe("PROPOSAL_IS_NOT_COMMIT");
    expect(err.denial.stateModified).toBe(false);
    expect(executed).toBe(false);
    expect(store.count()).toBe(events);
    expect(harbor.proposals.get(proposal.proposalId)?.status).toBe("PROPOSED");
  });

  it("human-authorized persist after accept writes Core and preserves provenance", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = await harbor.propose(AI, { text: "remember tea", sourceMemoryIds: [] }, NOW);
    harbor.decideProposal(proposal.proposalId, "ACCEPTED", HUMAN, { now: NOW });
    const grant = issueTestAuthorization(HUMAN, {
      grantedTo: { id: HUMAN.id, kind: HUMAN.kind },
      capability: "CANONICAL_COMMIT",
      action: "proposal.commit",
      target: proposal.proposalId,
      now: NOW,
    });
    const { result, record, proposal: persisted } = await harbor.commitProposal({
      proposalId: proposal.proposalId,
      actor: HUMAN,
      grant,
      action: "proposal.commit",
      target: proposal.proposalId,
      now: NOW,
      execute: async (ctx) => {
        const cell = await adapter.create({
          content: { type: "text", text: proposal.content },
          provenance: provenance(),
          idempotencyKey: randomUUID(),
          createdBy: HUMAN.id,
        }, ctx);
        return { result: cell, eventIds: store.all().map((e) => e.event.eventId) };
      },
    });
    expect(result.content).toMatchObject({ type: "text", text: proposal.content });
    expect(store.count()).toBe(1);
    expect(record.authorization.grantId).toBe(grant.grantId);
    expect(record.action).toBe("proposal.commit");
    expect(record.target).toBe(proposal.proposalId);
    expect(record.resultingEventIds.length).toBe(1);
    expect(record.provenance.originatingContext).toBe(`authorization:${grant.grantId}`);
    expect(persisted.resultingEventIds).toEqual(record.resultingEventIds);
    expect(harbor.proposals.get(proposal.proposalId)?.resultingEventIds).toEqual(
      record.resultingEventIds
    );
  });

  it("AI cannot persist even after a human accepted the proposal", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = await harbor.propose(AI, { text: "remember tea", sourceMemoryIds: [] }, NOW);
    harbor.decideProposal(proposal.proposalId, "ACCEPTED", HUMAN, { now: NOW });
    const grant = issueTestAuthorization(HUMAN, {
      grantedTo: { id: HUMAN.id, kind: HUMAN.kind },
      capability: "CANONICAL_COMMIT",
      action: "proposal.commit",
      target: proposal.proposalId,
      now: NOW,
    });
    const events = store.count();
    const err = await denialOfAsync(() =>
      harbor.commitProposal({
        proposalId: proposal.proposalId,
        actor: AI,
        grant,
        action: "proposal.commit",
        target: proposal.proposalId,
        execute: async (ctx) => {
          await adapter.create({
            content: { type: "text", text: "ai write" },
            provenance: provenance(),
            idempotencyKey: randomUUID(),
          }, ctx);
          return { result: null, eventIds: [] };
        },
      })
    );
    expect(err.denial.requestedCapability).toBe("CANONICAL_COMMIT");
    expect(store.count()).toBe(events);
    expect(harbor.proposals.get(proposal.proposalId)?.resultingEventIds).toEqual([]);
  });
});
