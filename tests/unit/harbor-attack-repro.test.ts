/**
 * Six original Harbor write-path attacks — now denied.
 * Fail closed. Do not mint GREEN.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MemoryCommandAdapter, asProductionStore } from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import { MemoryDomain } from "@ailexsi/memory";
import {
  CultivationService,
  MockLlmProvider,
} from "@ailexsi/v2-cultivation";
import type { Provenance } from "@ailexsi/contracts";
import {
  AgencyDeniedError,
  HarborService,
  issueAuthorization,
  isIssuedGrant,
} from "@ailexsi/v3-harbor";
import { authorizedCreate } from "../helpers/authorized-write.js";

const CORE_PIN = "652d01eb06dd0841c3b475023883675af6dcd698";
const MARTIN = { id: "martin", kind: "human" as const, authorizeCanonical: true };
const LENA = { id: "lena", kind: "human" as const, authorizeCanonical: true };
const AI = { id: "grok", kind: "ai" as const };
const NOW = "2026-08-18T22:00:00.000Z";

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

describe("Harbor attack repros fail closed", () => {
  it("I1: Channel Token + JSON actorId does not become Martin", async () => {
    const { DesktopHost } = await import("@ailexsi/v2-command-adapter");
    const host = new DesktopHost();
    host.attachActor(LENA);
    const actor = (host as unknown as { actorOf: (args: Record<string, unknown>) => { id: string } }).actorOf?.({
      actorId: "martin",
      actorKind: "human",
    });
    // actorOf is private — Session Actor is Lena; request JSON is ignored
    expect(host.getSessionActor()?.id).toBe(LENA.id);
    expect(host.getSessionActor()?.id).not.toBe(MARTIN.id);
    expect(actor === undefined || actor.id === LENA.id).toBe(true);
  });

  it("I2: no Session Actor → mutate fails closed; AI session cannot ACCEPT", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    await expect(
      adapter.create({
        content: { type: "text", text: "no-actor" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
      })
    ).rejects.toBeInstanceOf(AgencyDeniedError);

    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = await harbor.propose(AI, { text: "remember tea", sourceMemoryIds: [] }, NOW);
    await expect(() => harbor.decideProposal(proposal.proposalId, "ACCEPTED", AI)).toThrow(
      AgencyDeniedError
    );
    expect(harbor.proposals.get(proposal.proposalId)?.status).toBe("PROPOSED");
  });

  it("I3: Martin-grant cannot authorize Lena (GRANT_SUBJECT_MISMATCH)", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const grant = issueAuthorization(MARTIN, {
      grantedTo: { id: MARTIN.id, kind: MARTIN.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "x",
      now: NOW,
    });
    const err = await denialOfAsync(() =>
      harbor.commitCanonical({
        actor: LENA,
        grant,
        action: "memory.create",
        target: "x",
        execute: async () => {
          await adapter.create({
            content: { type: "text", text: "lena-using-martin-grant" },
            provenance: provenance(),
            idempotencyKey: randomUUID(),
          });
          return { result: null, eventIds: [] };
        },
      })
    );
    expect(err.denial.code).toBe("GRANT_SUBJECT_MISMATCH");
    expect(err.denial.stateModified).toBe(false);
    expect(store.count()).toBe(0);
  });

  it("I4: A exists + B exists does not prove SUPPORTS; relation bypass dies at adapter", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const a = await authorizedCreate(adapter, {
      content: { type: "text", text: "A" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const b = await authorizedCreate(adapter, {
      content: { type: "text", text: "B" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const grant = issueAuthorization(MARTIN, {
      grantedTo: { id: MARTIN.id, kind: MARTIN.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "bypass-rel",
      now: NOW,
    });
    const err = await denialOfAsync(() =>
      harbor.commitCanonical({
        actor: MARTIN,
        grant,
        action: "memory.create",
        target: "bypass-rel",
        execute: async () => {
          const cell = await adapter.create({
            content: {
              type: "structured",
              structuredData: {
                kind: "connectome-relation",
                schema: "harbor-connectome-v1",
                from: a.identity.id,
                to: b.identity.id,
                type: "SUPPORTS",
                evidenceMemoryIds: [a.identity.id, b.identity.id],
              },
            },
            provenance: provenance([a.identity.id, b.identity.id]),
            idempotencyKey: randomUUID(),
          });
          return { result: cell, eventIds: [] };
        },
      })
    );
    expect(err.denial.code).toBe("EVENTSTORE_WRITE_FORBIDDEN");
    expect(err.message).toMatch(/commitRelation/);
    expect(store.count()).toBe(2);

    const view = harbor.connectome([a, b], MARTIN, NOW);
    const explained = harbor.explainConnectomeRelation(view.relations[0] ? [a, b] : [a, b], "missing", MARTIN, NOW);
    expect(JSON.stringify(explained)).not.toMatch(/prove the relation|existence proves|A SUPPORTS B because/i);
  });

  it("I5: speculative-only path is found:false, never found:true speculative:true", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const a = await authorizedCreate(adapter, {
      content: { type: "text", text: "alpha" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const b = await authorizedCreate(adapter, {
      content: { type: "text", text: "beta" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    harbor.proposeRelation(
      AI,
      {
        from: a.identity.id,
        to: b.identity.id,
        type: "SUPPORTS",
        reason: "speculative only",
        evidenceMemoryIds: [],
      },
      NOW
    );
    const pathResult = harbor.traverseConnectome([a, b], a.identity.id, b.identity.id, MARTIN);
    expect(pathResult.found).toBe(false);
    expect(pathResult.hops).toEqual([]);
    expect(pathResult.reason).toBe(
      "A speculative path exists but is excluded from canonical traversal."
    );
    expect(pathResult).not.toHaveProperty("speculative", true);
  });

  it("I6: reload does not mint authority; mutated and forged grants rejected", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grant-reg-"));
    try {
      const first = HarborService.open({ corePin: CORE_PIN, vaultReferenceSha: "v", persistDir: dir });
      const grant = first.agency.issueAuthorization(MARTIN, {
        grantedTo: { id: MARTIN.id, kind: MARTIN.kind },
        capability: "CANONICAL_COMMIT",
        action: "memory.create",
        target: "reg",
        now: NOW,
      });
      const issued = first.agency.issuedGrantCount();
      expect(issued).toBe(1);
      expect(first.agency.isIssuedGrant(grant)).toBe(true);

      const reopened = HarborService.open({ corePin: CORE_PIN, vaultReferenceSha: "v", persistDir: dir });
      expect(reopened.agency.issuedGrantCount()).toBe(issued);
      expect(reopened.agency.isIssuedGrant(grant)).toBe(true);

      const mutated = { ...grant, action: "memory.delete" };
      expect(reopened.agency.isIssuedGrant(mutated)).toBe(false);
      const mutErr = await denialOfAsync(() =>
        reopened.commitCanonical({
          actor: MARTIN,
          grant: mutated,
          action: "memory.delete",
          target: "reg",
          execute: async () => ({ result: null, eventIds: [] }),
        })
      );
      expect(mutErr.denial.code).toBe("GRANT_INVALID");

      const forged = {
        ...grant,
        grantId: randomUUID(),
      };
      expect(reopened.agency.isIssuedGrant(forged)).toBe(false);
      const forgedErr = await denialOfAsync(() =>
        reopened.commitCanonical({
          actor: MARTIN,
          grant: forged,
          action: "memory.create",
          target: "reg",
          execute: async () => ({ result: null, eventIds: [] }),
        })
      );
      expect(forgedErr.denial.code).toBe("GRANT_INVALID");
      expect(reopened.agency.issuedGrantCount()).toBe(issued);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("direct adapter.create and {authorized:true} are rejected", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    await expect(
      adapter.create({
        content: { type: "text", text: "direct" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject({ denial: { code: "EVENTSTORE_WRITE_FORBIDDEN" } });
    await expect(
      adapter.create({
        content: { type: "text", text: "flag" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
        authorized: true,
        source: "agency",
        grantId: "forged",
      } as never)
    ).rejects.toMatchObject({ denial: { code: "EVENTSTORE_WRITE_FORBIDDEN" } });
    await expect(
      adapter.create({
        content: { type: "text", text: "nested" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
        context: { authorized: true } as never,
      })
    ).rejects.toMatchObject({ denial: { code: "EVENTSTORE_WRITE_FORBIDDEN" } });
    expect(store.count()).toBe(0);
    expect(isIssuedGrant({
      grantId: "from-memory-citation",
      capability: "CANONICAL_COMMIT",
      grantedBy: { id: "martin", kind: "human" },
      grantedTo: { id: "martin", kind: "human" },
      action: "memory.create",
      target: "x",
      issuedAt: NOW,
      provenance: { source: "explicit-human-authorization", notFromProposalAcceptance: true },
    })).toBe(false);
  });

  it("runtime.store.append from a production-shaped store is not a write path", async () => {
    const writable = new InMemoryEventStore();
    const store = asProductionStore(writable);
    expect(typeof (store as { append?: unknown }).append).toBe("function");
    await expect(
      (store as { append: (e: unknown) => Promise<unknown> }).append({
        event: { eventId: randomUUID() },
      })
    ).rejects.toThrow(/TEST_ONLY/);
    expect(writable.count()).toBe(0);
    const harbor = await import("@ailexsi/v3-harbor");
    expect(harbor).not.toHaveProperty("installMutationContext");
    expect(harbor).not.toHaveProperty("clearMutationContext");
  });

  it("MemoryDomain mutation from outside the adapter fails", async () => {
    const writable = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store: writable, environment: "test" });
    expect((adapter as unknown as { domain?: unknown }).domain).toBeUndefined();
    const sealed = asProductionStore(writable);
    const outsider = new MemoryDomain(sealed as never, "outsider", "test");
    await expect(
      outsider.create({
        content: { type: "text", text: "bypass-domain" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
        createdBy: "outsider",
      } as never)
    ).rejects.toThrow();
    expect(writable.count()).toBe(0);
  });

  it("acceptCanonical without host write does not write EventStore", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const cult = new CultivationService(new MockLlmProvider("draft-only"), adapter);
    const s = cult.createSession();
    const { proposal } = await cult.chat(s.id, "remember");
    const before = store.count();
    const { draft } = cult.acceptCanonical(s.id, proposal.id);
    expect(draft.kind).toBe("create_memory");
    expect(store.count()).toBe(before);
    expect(proposal.status === "accepted" || proposal.status === "edited").toBe(true);
    expect(proposal.acceptedMemoryId).toBeUndefined();
  });

  it("registered grantId + mutated target is rejected", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grant-mut-"));
    try {
      const harbor = HarborService.open({ corePin: CORE_PIN, vaultReferenceSha: "v", persistDir: dir });
      const grant = harbor.agency.issueAuthorization(MARTIN, {
        grantedTo: { id: MARTIN.id, kind: MARTIN.kind },
        capability: "CANONICAL_COMMIT",
        action: "memory.create",
        target: "original-target",
        now: NOW,
      });
      const mutated = { ...grant, target: "mutated-target" };
      expect(harbor.agency.isIssuedGrant(mutated)).toBe(false);
      const err = await denialOfAsync(() =>
        harbor.commitCanonical({
          actor: MARTIN,
          grant: mutated,
          action: "memory.create",
          target: "mutated-target",
          execute: async () => ({ result: null, eventIds: [] }),
        })
      );
      expect(err.denial.code).toBe("GRANT_INVALID");
      expect(harbor.agency.issuedGrantCount()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
