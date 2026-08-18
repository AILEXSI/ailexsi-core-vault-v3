/**
 * Six original Harbor write-path attacks — now denied.
 * Fail closed. Do not mint GREEN.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MemoryCommandAdapter,
  DesktopHost,
  bridgeCommandStatus,
} from "@ailexsi/v2-command-adapter";
import * as commandAdapter from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore, issueTestAuthorization } from "@ailexsi/v2-test-kit";
import { MemoryDomain } from "@ailexsi/memory";
import * as harborExports from "@ailexsi/v3-harbor";
import {
  CultivationService,
  MockLlmProvider,
} from "@ailexsi/v2-cultivation";
import type { Provenance } from "@ailexsi/contracts";
import {
  AgencyDeniedError,
  HarborService,
  isConsumedGrant,
  isIssuedGrant,
} from "@ailexsi/v3-harbor";
import {
  authorizedCreate,
  TEST_HUMAN_A,
  TEST_HUMAN_B,
} from "../helpers/authorized-write.js";
import { bindAgencySessionActor } from "../../packages/harbor/src/session-bind.js";

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
    const grant = issueTestAuthorization(MARTIN, {
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
        execute: async (ctx) => {
          await adapter.create({
            content: { type: "text", text: "lena-using-martin-grant" },
            provenance: provenance(),
            idempotencyKey: randomUUID(),
          }, ctx);
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
    const grant = issueTestAuthorization(MARTIN, {
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
        execute: async (ctx) => {
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
          }, ctx);
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
      const grant = issueTestAuthorization(MARTIN, {
        grantedTo: { id: MARTIN.id, kind: MARTIN.kind },
        capability: "CANONICAL_COMMIT",
        action: "memory.create",
        target: "reg",
        now: NOW,
      }, first.agency.registry);
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

  it("testOnlyEventStore and asProductionStore are absent from production exports", () => {
    expect(commandAdapter).not.toHaveProperty("testOnlyEventStore");
    expect(commandAdapter).not.toHaveProperty("asProductionStore");
    expect(harborExports).not.toHaveProperty("issueAuthorization");
    expect(harborExports).not.toHaveProperty("installMutationContext");
    expect(harborExports).not.toHaveProperty("currentMutationContext");
    expect(harborExports).not.toHaveProperty("consumeMutationContext");
  });

  it("production runtime store cannot recover a writer or feed MemoryDomain", async () => {
    const host = new DesktopHost();
    expect(() => host.requireRuntime()).toThrow(/not started/);
    const inner = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store: inner, environment: "test" });
    expect((adapter as unknown as { domain?: unknown }).domain).toBeUndefined();
    expect(host).not.toHaveProperty("testOnlyEventStore");
  });

  it("MemoryDomain mutation from outside the adapter fails", async () => {
    const writable = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store: writable, environment: "test" });
    expect((adapter as unknown as { domain?: unknown }).domain).toBeUndefined();
    const readOnly = {
      getCurrentVersion: async () => 0,
      getByAggregate: async () => [],
      getStream: async () => [],
      getByEventId: async () => null,
      getByIdempotencyKey: async () => null,
    };
    const outsider = new MemoryDomain(readOnly as never, "outsider", "test");
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
      const grant = issueTestAuthorization(MARTIN, {
        grantedTo: { id: MARTIN.id, kind: MARTIN.kind },
        capability: "CANONICAL_COMMIT",
        action: "memory.create",
        target: "original-target",
        now: NOW,
      }, harbor.agency.registry);
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

  it("A: bridge memory.create without token is 401", () => {
    const prev = process.env.DESKTOP_HOST_TOKEN;
    process.env.DESKTOP_HOST_TOKEN = "unit-channel-token";
    try {
      expect(bridgeCommandStatus("memory.create", {})).toBe(401);
      expect(bridgeCommandStatus("memory.create", { "x-channel-token": "wrong" })).toBe(401);
      expect(bridgeCommandStatus("grant.create", { "x-channel-token": "unit-channel-token" })).toBe(
        404
      );
      expect(
        bridgeCommandStatus("memory.create", { "x-channel-token": "unit-channel-token" })
      ).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.DESKTOP_HOST_TOKEN;
      else process.env.DESKTOP_HOST_TOKEN = prev;
    }
  });

  it("B: session AI + actorKind human ACCEPT is denied", async () => {
    const host = new DesktopHost();
    host.attachActor(AI);
    await expect(
      host.cultivationProposalAccept({
        actorKind: "human",
        actorId: "martin",
        sessionId: "s",
        proposalId: "p",
      })
    ).rejects.toMatchObject({ denial: { code: "HUMAN_AUTHORIZATION_REQUIRED" } });
    expect(host.getSessionActor()?.kind).toBe("ai");
    expect(host.getSessionActor()?.id).not.toBe(MARTIN.id);
    expect(() => host.attachActor(MARTIN)).toThrow(AgencyDeniedError);
  });

  it("C: martin grant used by lena is GRANT_SUBJECT_MISMATCH", async () => {
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const grant = issueTestAuthorization(MARTIN, {
      grantedTo: { id: MARTIN.id, kind: MARTIN.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "c-target",
      now: NOW,
    });
    const err = await denialOfAsync(() =>
      harbor.commitCanonical({
        actor: LENA,
        grant,
        action: "memory.create",
        target: "c-target",
        execute: async () => ({ result: null, eventIds: [] }),
      })
    );
    expect(err.denial.code).toBe("GRANT_SUBJECT_MISMATCH");
  });

  it("D: connectome-relation create outside commitRelation is rejected", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const grant = issueTestAuthorization(MARTIN, {
      grantedTo: { id: MARTIN.id, kind: MARTIN.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "d-rel",
      now: NOW,
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const err = await denialOfAsync(() =>
      harbor.commitCanonical({
        actor: MARTIN,
        grant,
        action: "memory.create",
        target: "d-rel",
        execute: async (ctx) => {
          await adapter.create({
            content: {
              type: "structured",
              structuredData: {
                kind: "connectome-relation",
                schema: "harbor-connectome-v1",
                from: "a",
                to: "b",
                type: "SUPPORTS",
                evidenceMemoryIds: ["c"],
              },
            },
            provenance: provenance(),
            idempotencyKey: randomUUID(),
          }, ctx);
          return { result: null, eventIds: [] };
        },
      })
    );
    expect(err.denial.code).toBe("EVENTSTORE_WRITE_FORBIDDEN");
    expect(store.count()).toBe(0);
  });

  it("E: traverse tea/coffee/unrelated is found:false hops:[]", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const tea = await authorizedCreate(adapter, {
      content: { type: "text", text: "user prefers tea" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const coffee = await authorizedCreate(adapter, {
      content: { type: "text", text: "user prefers coffee" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const unrelated = await authorizedCreate(adapter, {
      content: { type: "text", text: "unrelated note" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const cells = [tea, coffee, unrelated];
    harbor.scan(cells, MARTIN, NOW);
    const teaCoffee = harbor.traverseConnectome(cells, tea.identity.id, coffee.identity.id, MARTIN);
    expect(teaCoffee.found).toBe(false);
    expect(teaCoffee.hops).toEqual([]);
    const teaUnrelated = harbor.traverseConnectome(
      cells,
      tea.identity.id,
      unrelated.identity.id,
      MARTIN
    );
    expect(teaUnrelated.found).toBe(false);
    expect(teaUnrelated.hops).toEqual([]);
  });

  it("F: reopen persistDir issued count unchanged; mutated grant record rejected", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grant-f-"));
    try {
      const first = HarborService.open({ corePin: CORE_PIN, vaultReferenceSha: "v", persistDir: dir });
      const grant = issueTestAuthorization(MARTIN, {
        grantedTo: { id: MARTIN.id, kind: MARTIN.kind },
        capability: "CANONICAL_COMMIT",
        action: "memory.create",
        target: "f-target",
        now: NOW,
      }, first.agency.registry);
      const issued = first.agency.issuedGrantCount();
      const reopened = HarborService.open({ corePin: CORE_PIN, vaultReferenceSha: "v", persistDir: dir });
      expect(reopened.agency.issuedGrantCount()).toBe(issued);
      const mutated = { ...grant, grantId: randomUUID() };
      expect(reopened.agency.isIssuedGrant(mutated)).toBe(false);
      const err = await denialOfAsync(() =>
        reopened.commitCanonical({
          actor: MARTIN,
          grant: mutated,
          action: "memory.create",
          target: "f-target",
          execute: async () => ({ result: null, eventIds: [] }),
        })
      );
      expect(err.denial.code).toBe("GRANT_INVALID");
      expect(reopened.agency.issuedGrantCount()).toBe(issued);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("G: session human + own grant + commitCanonical writes one Memory cell and stores the record", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grant-g-"));
    try {
      const store = new InMemoryEventStore();
      const adapter = new MemoryCommandAdapter({ store, environment: "test" });
      const harbor = HarborService.open({
        corePin: CORE_PIN,
        vaultReferenceSha: "v",
        persistDir: dir,
      });
      const host = new DesktopHost();
      host.attachActor(MARTIN);
      expect(host.getSessionActor()?.id).toBe(MARTIN.id);
      const key = randomUUID();
      const grant = issueTestAuthorization(host.getSessionActor()!, {
        grantedTo: { id: MARTIN.id, kind: MARTIN.kind },
        capability: "CANONICAL_COMMIT",
        action: "memory.create",
        target: key,
        now: NOW,
      }, harbor.agency.registry);
      const { result, record } = await harbor.commitCanonical({
        actor: host.getSessionActor()!,
        grant,
        action: "memory.create",
        target: key,
        now: NOW,
        execute: async (ctx) => {
          const cell = await adapter.create({
            content: { type: "text", text: "canonical session write" },
            provenance: provenance(),
            idempotencyKey: key,
            createdBy: host.getSessionActor()!.id,
          }, ctx);
          return { result: cell, eventIds: store.all().map((e) => e.event.eventId) };
        },
      });
      expect(store.count()).toBe(1);
      expect(result.content).toMatchObject({ type: "text", text: "canonical session write" });
      expect(record.actor).toEqual({ id: MARTIN.id, kind: "human" });
      expect((store.all()[0]!.event.payload as { createdBy?: string }).createdBy).toBe(MARTIN.id);
      expect(harbor.agency.inspectCanonicalActions()).toHaveLength(1);
      expect(harbor.agency.inspectCanonicalActions()[0]!.authorization.grantId).toBe(grant.grantId);
      const reopened = HarborService.open({ corePin: CORE_PIN, vaultReferenceSha: "v", persistDir: dir });
      expect(reopened.agency.issuedGrantCount()).toBe(1);
      expect(reopened.agency.inspectCanonicalActions()).toHaveLength(1);
      expect(reopened.agency.inspectCanonicalActions()[0]!.recordId).toBe(record.recordId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overlapping adapter.create cannot borrow an in-flight authorized context", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = new InMemoryEventStore();
    let enteredAppend = false;
    const hanging = {
      append: async (envelope: Parameters<InMemoryEventStore["append"]>[0]) => {
        enteredAppend = true;
        await gate;
        return inner.append(envelope);
      },
      getCurrentVersion: (id: string) => inner.getCurrentVersion(id),
      getByAggregate: (id: string) => inner.getByAggregate(id),
      getStream: (opts?: Parameters<InMemoryEventStore["getStream"]>[0]) => inner.getStream(opts),
      getByEventId: (id: string) => inner.getByEventId(id),
      getByIdempotencyKey: (key: string) => inner.getByIdempotencyKey(key),
    };
    const adapter = new MemoryCommandAdapter({ store: hanging as never, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const grant = issueTestAuthorization(MARTIN, {
      grantedTo: { id: MARTIN.id, kind: MARTIN.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "overlap",
      now: NOW,
    });
    const first = harbor.commitCanonical({
      actor: MARTIN,
      grant,
      action: "memory.create",
      target: "overlap",
      execute: async (ctx) => {
        const cell = await adapter.create({
          content: { type: "text", text: "legitimate" },
          provenance: provenance(),
          idempotencyKey: randomUUID(),
          createdBy: MARTIN.id,
        }, ctx);
        return { result: cell, eventIds: [] };
      },
    });
    while (!enteredAppend) {
      await new Promise((r) => setImmediate(r));
    }
    await expect(
      adapter.create({
        content: { type: "text", text: "borrowed" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject({ denial: { code: "EVENTSTORE_WRITE_FORBIDDEN" } });
    release();
    const { result } = await first;
    expect(result.content).toMatchObject({ type: "text", text: "legitimate" });
    expect(inner.count()).toBe(1);
  });

  it("production issueAuthorization without Session Actor fails / is not exported", () => {
    expect(harborExports).not.toHaveProperty("issueAuthorization");
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    expect(() =>
      harbor.agency.issueAuthorization(MARTIN, {
        grantedTo: { id: MARTIN.id, kind: MARTIN.kind },
        capability: "CANONICAL_COMMIT",
        action: "memory.create",
        target: "no-session",
      })
    ).toThrow(AgencyDeniedError);
  });

  it("AI Session Actor cannot issueAuthorization", async () => {
    const host = new DesktopHost();
    host.attachActor(AI);
    await expect(
      host.memoryCreate({
        content: { type: "text", text: "ai-write" },
        provenance: provenance(),
        idempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject({ denial: { code: "HUMAN_AUTHORIZATION_REQUIRED" } });
  });
});

describe("AUTO-GRANT removed — Session Actor is not AuthorizationGrant", () => {
  it("commitThroughAgency does not issueAuthorization", () => {
    const src = readFileSync(
      path.join(process.cwd(), "packages/command-adapter/src/desktop-host.ts"),
      "utf8"
    );
    const start = src.indexOf("private async commitThroughAgency");
    const end = src.indexOf("private async loadCells");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toMatch(/issueAuthorization/);
  });

  it("A: human session without grant is DENIED; EventStore unchanged", async () => {
    const host = new DesktopHost();
    host.attachActor(TEST_HUMAN_A);
    expect(host.getSessionActor()?.id).toBe("test-human-a");
    const err = await denialOfAsync(() =>
      host.memoryCreate({
        content: { type: "text", text: "no-grant" },
        provenance: provenance(),
        idempotencyKey: "X",
      })
    );
    expect(err.denial.code).toBe("GRANT_INVALID");
    expect(err.denial.stateModified).toBe(false);
    expect(err.message).toMatch(/already-issued AuthorizationGrant/i);
  });

  it("B: explicit grant success — one Memory, createdBy=test-human-a, record, consumed", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-grant-b-"));
    try {
      const store = new InMemoryEventStore();
      const adapter = new MemoryCommandAdapter({ store, environment: "test" });
      const harbor = HarborService.open({
        corePin: CORE_PIN,
        vaultReferenceSha: "v",
        persistDir: dir,
      });
      bindAgencySessionActor(harbor.agency, TEST_HUMAN_A);
      expect(harbor.agency.issuedGrantCount()).toBe(0);
      const target = "X";
      const grant = harbor.agency.issueAuthorization(TEST_HUMAN_A, {
        grantedTo: { id: TEST_HUMAN_A.id, kind: TEST_HUMAN_A.kind },
        capability: "CANONICAL_COMMIT",
        action: "memory.create",
        target,
        now: NOW,
      });
      const { result, record } = await harbor.commitCanonical({
        actor: TEST_HUMAN_A,
        grant,
        action: "memory.create",
        target,
        now: NOW,
        execute: async (ctx) => {
          const cell = await adapter.create({
            content: { type: "text", text: "explicit-grant" },
            provenance: provenance(),
            idempotencyKey: target,
            createdBy: TEST_HUMAN_A.id,
          }, ctx);
          return { result: cell, eventIds: store.all().map((e) => e.event.eventId) };
        },
      });
      expect(store.count()).toBe(1);
      expect(result.content).toMatchObject({ type: "text", text: "explicit-grant" });
      expect((store.all()[0]!.event.payload as { createdBy?: string }).createdBy).toBe(
        "test-human-a"
      );
      expect(record.actor).toEqual({ id: "test-human-a", kind: "human" });
      expect(harbor.agency.inspectCanonicalActions()).toHaveLength(1);
      expect(harbor.agency.inspectCanonicalActions()[0]!.authorization.grantId).toBe(
        grant.grantId
      );
      expect(isConsumedGrant(grant, harbor.agency.registry)).toBe(true);
      expect(isIssuedGrant(grant, harbor.agency.registry)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("C: grant replay is DENIED; EventStore unchanged", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-grant-c-"));
    try {
      const store = new InMemoryEventStore();
      const adapter = new MemoryCommandAdapter({ store, environment: "test" });
      const harbor = HarborService.open({
        corePin: CORE_PIN,
        vaultReferenceSha: "v",
        persistDir: dir,
      });
      bindAgencySessionActor(harbor.agency, TEST_HUMAN_A);
      const target = "X";
      const grant = harbor.agency.issueAuthorization(TEST_HUMAN_A, {
        grantedTo: { id: TEST_HUMAN_A.id, kind: TEST_HUMAN_A.kind },
        capability: "CANONICAL_COMMIT",
        action: "memory.create",
        target,
        now: NOW,
      });
      await harbor.commitCanonical({
        actor: TEST_HUMAN_A,
        grant,
        action: "memory.create",
        target,
        execute: async (ctx) => {
          const cell = await adapter.create({
            content: { type: "text", text: "once" },
            provenance: provenance(),
            idempotencyKey: target,
            createdBy: TEST_HUMAN_A.id,
          }, ctx);
          return { result: cell, eventIds: store.all().map((e) => e.event.eventId) };
        },
      });
      const before = store.count();
      expect(before).toBe(1);
      const err = await denialOfAsync(() =>
        harbor.commitCanonical({
          actor: TEST_HUMAN_A,
          grant,
          action: "memory.create",
          target,
          execute: async (ctx) => {
            await adapter.create({
              content: { type: "text", text: "replay" },
              provenance: provenance(),
              idempotencyKey: randomUUID(),
              createdBy: TEST_HUMAN_A.id,
            }, ctx);
            return { result: null, eventIds: [] };
          },
        })
      );
      expect(err.denial.code).toBe("GRANT_ALREADY_USED");
      expect(err.denial.stateModified).toBe(false);
      expect(store.count()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("D: grant target confusion X vs Y is DENIED; EventStore unchanged", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    bindAgencySessionActor(harbor.agency, TEST_HUMAN_A);
    const grant = harbor.agency.issueAuthorization(TEST_HUMAN_A, {
      grantedTo: { id: TEST_HUMAN_A.id, kind: TEST_HUMAN_A.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "X",
      now: NOW,
    });
    const err = await denialOfAsync(() =>
      harbor.commitCanonical({
        actor: TEST_HUMAN_A,
        grant,
        action: "memory.create",
        target: "Y",
        execute: async (ctx) => {
          await adapter.create({
            content: { type: "text", text: "confused-target" },
            provenance: provenance(),
            idempotencyKey: "Y",
            createdBy: TEST_HUMAN_A.id,
          }, ctx);
          return { result: null, eventIds: [] };
        },
      })
    );
    expect(err.denial.code).toBe("GRANT_ACTION_MISMATCH");
    expect(err.denial.stateModified).toBe(false);
    expect(store.count()).toBe(0);
    expect(isIssuedGrant(grant, harbor.agency.registry)).toBe(true);
  });

  it("E: grant action confusion create vs update/archive/restore is DENIED", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    bindAgencySessionActor(harbor.agency, TEST_HUMAN_A);
    const grant = harbor.agency.issueAuthorization(TEST_HUMAN_A, {
      grantedTo: { id: TEST_HUMAN_A.id, kind: TEST_HUMAN_A.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "X",
      now: NOW,
    });
    for (const action of ["memory.update", "memory.archive", "memory.restore"] as const) {
      const before = store.count();
      const err = await denialOfAsync(() =>
        harbor.commitCanonical({
          actor: TEST_HUMAN_A,
          grant,
          action,
          target: "X",
          execute: async (ctx) => {
            await adapter.create({
              content: { type: "text", text: action },
              provenance: provenance(),
              idempotencyKey: randomUUID(),
              createdBy: TEST_HUMAN_A.id,
            }, ctx);
            return { result: null, eventIds: [] };
          },
        })
      );
      expect(err.denial.code).toBe("GRANT_ACTION_MISMATCH");
      expect(err.denial.stateModified).toBe(false);
      expect(store.count()).toBe(before);
    }
    expect(isIssuedGrant(grant, harbor.agency.registry)).toBe(true);
  });

  it("F: session does not equal grant — subject mismatch and attach mints no grant", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-grant-f-"));
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = HarborService.open({
      corePin: CORE_PIN,
      vaultReferenceSha: "v",
      persistDir: dir,
    });
    try {
    bindAgencySessionActor(harbor.agency, TEST_HUMAN_A);
    expect(harbor.agency.issuedGrantCount()).toBe(0);

    const host = new DesktopHost();
    host.attachActor(TEST_HUMAN_A);
    expect(host.getSessionActor()?.id).toBe("test-human-a");
    await expect(
      host.memoryCreate({
        content: { type: "text", text: "session-is-not-grant" },
        provenance: provenance(),
        idempotencyKey: "X",
      })
    ).rejects.toMatchObject({ denial: { code: "GRANT_INVALID" } });

    const foreign = issueTestAuthorization(TEST_HUMAN_B, {
      grantedTo: { id: TEST_HUMAN_B.id, kind: TEST_HUMAN_B.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "X",
      now: NOW,
    }, harbor.agency.registry);
    const err = await denialOfAsync(() =>
      harbor.commitCanonical({
        actor: TEST_HUMAN_A,
        grant: foreign,
        action: "memory.create",
        target: "X",
        execute: async (ctx) => {
          await adapter.create({
            content: { type: "text", text: "wrong-subject" },
            provenance: provenance(),
            idempotencyKey: "X",
            createdBy: TEST_HUMAN_A.id,
          }, ctx);
          return { result: null, eventIds: [] };
        },
      })
    );
    expect(err.denial.code).toBe("GRANT_SUBJECT_MISMATCH");
    expect(err.denial.stateModified).toBe(false);
    expect(store.count()).toBe(0);

    expect(() =>
      harbor.agency.issueAuthorization(TEST_HUMAN_B, {
        grantedTo: { id: TEST_HUMAN_B.id, kind: TEST_HUMAN_B.kind },
        capability: "CANONICAL_COMMIT",
        action: "memory.create",
        target: "X",
      })
    ).toThrow(AgencyDeniedError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
