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
  defaultEpistemicForCoreMemory,
  isConsumedGrant,
  isIssuedGrant,
  temporalFromMemory,
} from "@ailexsi/v3-harbor";
import {
  authorizedCreate,
  TEST_AI,
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
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const host = new DesktopHost();
    host.attachActor(TEST_HUMAN_A);
    expect(host.getSessionActor()?.id).toBe("test-human-a");
    const hostErr = await denialOfAsync(() =>
      host.memoryCreate({
        content: { type: "text", text: "no-grant" },
        provenance: provenance(),
        idempotencyKey: "X",
      })
    );
    expect(hostErr.denial.code).toBe("GRANT_INVALID");
    expect(hostErr.denial.stateModified).toBe(false);
    expect(hostErr.message).toMatch(/already-issued AuthorizationGrant/i);
    const adapterErr = await denialOfAsync(() =>
      adapter.create({
        content: { type: "text", text: "no-grant-adapter" },
        provenance: provenance(),
        idempotencyKey: "X",
        createdBy: "spoofed",
      })
    );
    expect(adapterErr.denial.code).toBe("EVENTSTORE_WRITE_FORBIDDEN");
    expect(adapterErr.denial.stateModified).toBe(false);
    expect(store.count()).toBe(0);
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

  it("G: AI session cannot issueAuthorization or ACCEPT", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-grant-g-"));
    try {
      const harbor = HarborService.open({
        corePin: CORE_PIN,
        vaultReferenceSha: "v",
        persistDir: dir,
      });
      bindAgencySessionActor(harbor.agency, TEST_AI);
      expect(harbor.agency.issuedGrantCount()).toBe(0);
      expect(() =>
        harbor.agency.issueAuthorization(TEST_AI, {
          grantedTo: { id: TEST_AI.id, kind: TEST_AI.kind },
          capability: "CANONICAL_COMMIT",
          action: "memory.create",
          target: "X",
        })
      ).toThrow(AgencyDeniedError);
      expect(harbor.agency.issuedGrantCount()).toBe(0);

      const host = new DesktopHost();
      host.attachActor(TEST_AI);
      expect(host.getSessionActor()?.id).toBe("test-ai");
      expect(() =>
        host.issueAuthorization({
          grantedTo: { id: TEST_AI.id, kind: TEST_AI.kind },
          capability: "CANONICAL_COMMIT",
          action: "memory.create",
          target: "X",
        })
      ).toThrow(AgencyDeniedError);
      await expect(
        host.cultivationProposalAccept({
          actorId: "test-human-a",
          actorKind: "human",
          sessionId: "s",
          proposalId: "p",
        })
      ).rejects.toMatchObject({ denial: { code: "HUMAN_AUTHORIZATION_REQUIRED" } });
      expect(host.getSessionActor()?.kind).toBe("ai");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("H: request actorId/actorKind cannot rebind the Session Actor", async () => {
    const host = new DesktopHost();
    host.attachActor(TEST_HUMAN_A);
    const spoofAi = await denialOfAsync(() =>
      host.memoryCreate({
        actorId: "test-ai",
        actorKind: "ai",
        content: { type: "text", text: "spoof-ai" },
        provenance: provenance(),
        idempotencyKey: "X",
      } as never)
    );
    expect(spoofAi.denial.code).toBe("GRANT_INVALID");
    expect(spoofAi.denial.actorId).toBe("test-human-a");
    const spoofB = await denialOfAsync(() =>
      host.memoryCreate({
        actorId: "test-human-b",
        actorKind: "human",
        content: { type: "text", text: "spoof-b" },
        provenance: provenance(),
        idempotencyKey: "Y",
      } as never)
    );
    expect(spoofB.denial.code).toBe("GRANT_INVALID");
    expect(spoofB.denial.actorId).toBe("test-human-a");
    expect(host.getSessionActor()?.id).toBe("test-human-a");
    expect(host.getSessionActor()?.kind).toBe("human");
    const viaActorOf = (
      host as unknown as { actorOf: (args: Record<string, unknown>) => { id: string; kind: string } }
    ).actorOf?.({ actorId: "test-human-b", actorKind: "human" });
    expect(viaActorOf === undefined || viaActorOf.id === "test-human-a").toBe(true);
  });

  it("multi-user: human B cannot use human A's Grant; A succeeds once; replay denied", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-grant-multi-"));
    try {
      const store = new InMemoryEventStore();
      const adapter = new MemoryCommandAdapter({ store, environment: "test" });
      const harbor = HarborService.open({
        corePin: CORE_PIN,
        vaultReferenceSha: "v",
        persistDir: dir,
      });
      bindAgencySessionActor(harbor.agency, TEST_HUMAN_A);
      const grant = harbor.agency.issueAuthorization(TEST_HUMAN_A, {
        grantedTo: { id: TEST_HUMAN_A.id, kind: TEST_HUMAN_A.kind },
        capability: "CANONICAL_COMMIT",
        action: "memory.create",
        target: "X",
        now: NOW,
      });
      const stolen = await denialOfAsync(() =>
        harbor.commitCanonical({
          actor: TEST_HUMAN_B,
          grant,
          action: "memory.create",
          target: "X",
          execute: async (ctx) => {
            await adapter.create({
              content: { type: "text", text: "stolen" },
              provenance: provenance(),
              idempotencyKey: "X",
              createdBy: TEST_HUMAN_B.id,
            }, ctx);
            return { result: null, eventIds: [] };
          },
        })
      );
      expect(stolen.denial.code).toBe("GRANT_SUBJECT_MISMATCH");
      expect(stolen.denial.stateModified).toBe(false);
      expect(store.count()).toBe(0);

      const { result } = await harbor.commitCanonical({
        actor: TEST_HUMAN_A,
        grant,
        action: "memory.create",
        target: "X",
        execute: async (ctx) => {
          const cell = await adapter.create({
            content: { type: "text", text: "owner-write" },
            provenance: provenance(),
            idempotencyKey: "X",
            createdBy: "ignored-request-identity",
          }, ctx);
          return { result: cell, eventIds: store.all().map((e) => e.event.eventId) };
        },
      });
      expect(store.count()).toBe(1);
      expect(result.content).toMatchObject({ type: "text", text: "owner-write" });
      expect((store.all()[0]!.event.payload as { createdBy?: string }).createdBy).toBe(
        "test-human-a"
      );
      expect(isConsumedGrant(grant, harbor.agency.registry)).toBe(true);

      const replay = await denialOfAsync(() =>
        harbor.commitCanonical({
          actor: TEST_HUMAN_A,
          grant,
          action: "memory.create",
          target: "X",
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
      expect(replay.denial.code).toBe("GRANT_ALREADY_USED");
      expect(replay.denial.stateModified).toBe(false);
      expect(store.count()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("production has one Grant issuer and no hardcoded Martin identity", () => {
    const hostSrc = readFileSync(
      path.join(process.cwd(), "packages/command-adapter/src/desktop-host.ts"),
      "utf8"
    );
    const adapterSrc = readFileSync(
      path.join(process.cwd(), "packages/command-adapter/src/memory-command-adapter.ts"),
      "utf8"
    );
    const boundarySrc = readFileSync(
      path.join(process.cwd(), "packages/harbor/src/agency-boundary.ts"),
      "utf8"
    );
    const agencySrc = readFileSync(
      path.join(process.cwd(), "packages/harbor/src/agency.ts"),
      "utf8"
    );
    const harborIndex = readFileSync(
      path.join(process.cwd(), "packages/harbor/src/index.ts"),
      "utf8"
    );
    expect(harborIndex).not.toMatch(/issueAuthorizationOn/);
    expect(harborIndex).not.toMatch(/export function issueAuthorization/);
    expect(boundarySrc).toMatch(/issueAuthorization\(granter/);
    expect(agencySrc).toMatch(/export function issueAuthorizationOn/);
    expect(hostSrc).toMatch(/agency\.issueAuthorization/);
    expect(hostSrc).not.toMatch(/issueAuthorizationOn/);
    expect(hostSrc).not.toMatch(/issueTestAuthorization/);
    expect(adapterSrc).not.toMatch(/issueAuthorization/);
    expect(adapterSrc).toMatch(/createdBy: ctx\.actor\.id/);
    expect(adapterSrc).not.toMatch(/cmd\.createdBy \?\? "v2"/);
    for (const src of [hostSrc, adapterSrc, boundarySrc, agencySrc]) {
      expect(src).not.toMatch(/\bmartin\b/i);
    }
  });
});

describe("semantic honesty — identity, grant bearer, connectome, ACCEPT", () => {
  it("1: host start without actor does not invent a human Session Actor", async () => {
    const host = new DesktopHost();
    expect(host.getSessionActor()).toBeNull();
    const err = await denialOfAsync(() =>
      host.memoryCreate({
        content: { type: "text", text: "no-identity" },
        provenance: provenance(),
        idempotencyKey: "X",
      })
    );
    expect(err.denial.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(err.message).toMatch(/No session actor/i);
    const entry = readFileSync(
      path.join(process.cwd(), "scripts/desktop-host-entry.ts"),
      "utf8"
    );
    expect(entry).not.toMatch(/desktop-user/);
    expect(entry).toMatch(/DESKTOP_SESSION_ACTOR_ID/);
  });

  it("2: grant JSON is not authority without a matching Durable Grant Registry record", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const bearer = {
      grantId: randomUUID(),
      capability: "CANONICAL_COMMIT" as const,
      grantedBy: { id: TEST_HUMAN_A.id, kind: "human" as const },
      grantedTo: { id: TEST_HUMAN_A.id, kind: "human" as const },
      action: "memory.create",
      target: "X",
      issuedAt: NOW,
      provenance: {
        source: "explicit-human-authorization" as const,
        notFromProposalAcceptance: true as const,
      },
    };
    const err = await denialOfAsync(() =>
      harbor.commitCanonical({
        actor: TEST_HUMAN_A,
        grant: bearer,
        action: "memory.create",
        target: "X",
        execute: async (ctx) => {
          await adapter.create({
            content: { type: "text", text: "bearer" },
            provenance: provenance(),
            idempotencyKey: "X",
          }, ctx);
          return { result: null, eventIds: [] };
        },
      })
    );
    expect(err.denial.code).toBe("GRANT_INVALID");
    expect(store.count()).toBe(0);
  });

  it("3: connectome-relation cell shape without grant markers is not CANONICAL_MEMORY", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const a = await authorizedCreate(adapter, {
      content: { type: "text", text: "shape-a" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const b = await authorizedCreate(adapter, {
      content: { type: "text", text: "shape-b" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const fake = {
      ...a,
      identity: { ...a.identity, id: randomUUID(), shortId: "fake" },
      content: {
        type: "structured" as const,
        structuredData: {
          kind: "connectome-relation",
          schema: "harbor-connectome-v1",
          from: a.identity.id,
          to: b.identity.id,
          type: "SUPPORTS",
          evidenceMemoryIds: [a.identity.id, b.identity.id],
        },
      },
    };
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const view = harbor.connectome([a, b, fake], TEST_HUMAN_A, NOW);
    expect(view.relations.some((r) => r.status === "CANONICAL_MEMORY")).toBe(false);
    expect(JSON.stringify(view)).not.toMatch(/after explicit human authorization/i);
    const pathResult = harbor.traverseConnectome(
      [a, b, fake],
      a.identity.id,
      b.identity.id,
      TEST_HUMAN_A
    );
    expect(pathResult.found).toBe(false);
    expect(pathResult.hops).toEqual([]);
  });

  it("4: OBSERVED parentMemoryIds is not a canonical traverse path", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const parent = await authorizedCreate(adapter, {
      content: { type: "text", text: "parent" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const child = await authorizedCreate(adapter, {
      content: { type: "text", text: "child" },
      provenance: provenance([parent.identity.id]),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const view = harbor.connectome([parent, child], TEST_HUMAN_A, NOW);
    const observed = view.relations.find(
      (r) => r.type === "DERIVED_FROM" && r.status === "OBSERVED"
    );
    expect(observed).toBeDefined();
    const pathResult = harbor.traverseConnectome(
      [parent, child],
      parent.identity.id,
      child.identity.id,
      TEST_HUMAN_A
    );
    expect(pathResult.found).toBe(false);
    expect(pathResult.hops).toEqual([]);
    expect(pathResult.reason).toBe(
      "A speculative path exists but is excluded from canonical traversal."
    );
    expect(pathResult).not.toHaveProperty("speculative", true);
  });

  it("5: ACCEPT is a decision — no Grant, no EventStore write, no CanonicalActionRecord", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sem-accept-"));
    const store = new InMemoryEventStore();
    const harbor = HarborService.open({
      corePin: CORE_PIN,
      vaultReferenceSha: "v",
      persistDir: dir,
    });
    try {
    const proposal = await harbor.propose(TEST_AI, { text: "remember tea", sourceMemoryIds: [] }, NOW);
    expect(harbor.agency.issuedGrantCount()).toBe(0);
    await expect(() => harbor.decideProposal(proposal.proposalId, "ACCEPTED", TEST_AI)).toThrow(
      AgencyDeniedError
    );
    expect(harbor.proposals.get(proposal.proposalId)?.status).toBe("PROPOSED");
    const decided = harbor.decideProposal(proposal.proposalId, "ACCEPTED", TEST_HUMAN_A, { now: NOW });
    expect(decided.status).toBe("ACCEPTED");
    expect(harbor.agency.issuedGrantCount()).toBe(0);
    expect(harbor.agency.inspectCanonicalActions()).toHaveLength(0);
    expect(store.count()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("6: relation proposal without evidence is unsubstantiated, not proof", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const a = await authorizedCreate(adapter, {
      content: { type: "text", text: "tea" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const b = await authorizedCreate(adapter, {
      content: { type: "text", text: "coffee" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = harbor.proposeRelation(
      TEST_AI,
      {
        from: a.identity.id,
        to: b.identity.id,
        type: "SUPPORTS",
        reason: "looks related",
        evidenceMemoryIds: [],
      },
      NOW
    );
    harbor.decideRelation(proposal.proposalId, "ACCEPTED", TEST_HUMAN_A, NOW);
    const view = harbor.connectome([a, b], TEST_HUMAN_A, NOW);
    const listed = view.relations.find((r) => r.relationId === `prop:${proposal.proposalId}`);
    expect(listed?.status).toBe("PROPOSED");
    expect(listed?.confidence).toBe(0);
    expect(listed?.explanation.why).toMatch(/Unsubstantiated/i);
    expect(listed?.explanation.authority).toMatch(/unsubstantiated/i);
    const grant = issueTestAuthorization(TEST_HUMAN_A, {
      grantedTo: { id: TEST_HUMAN_A.id, kind: TEST_HUMAN_A.kind },
      capability: "CANONICAL_COMMIT",
      action: "relation.commit",
      target: proposal.proposalId,
      now: NOW,
    });
    const err = await denialOfAsync(() =>
      harbor.commitRelation({
        proposalId: proposal.proposalId,
        actor: TEST_HUMAN_A,
        grant,
        action: "relation.commit",
        target: proposal.proposalId,
        execute: async () => ({ result: null, eventIds: [] }),
      })
    );
    expect(err.denial.code).toBe("PROPOSAL_IS_NOT_COMMIT");
    expect(err.message).toMatch(/third-party Core Memory evidence/i);
    expect(store.count()).toBe(2);
    expect(harbor.agency.inspectCanonicalActions()).toHaveLength(0);
  });

  it("forged grantId/authorizedById are replaced by ctx values on relation.commit", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const a = await authorizedCreate(adapter, {
      content: { type: "text", text: "from-mem" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const b = await authorizedCreate(adapter, {
      content: { type: "text", text: "to-mem" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const witness = await authorizedCreate(adapter, {
      content: { type: "text", text: "witness" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = harbor.proposeRelation(
      TEST_AI,
      {
        from: a.identity.id,
        to: b.identity.id,
        type: "SUPPORTS",
        reason: "reviewed",
        evidenceMemoryIds: [witness.identity.id],
      },
      NOW
    );
    harbor.decideRelation(proposal.proposalId, "ACCEPTED", TEST_HUMAN_A, NOW);
    const grant = issueTestAuthorization(TEST_HUMAN_A, {
      grantedTo: { id: TEST_HUMAN_A.id, kind: TEST_HUMAN_A.kind },
      capability: "CANONICAL_COMMIT",
      action: "relation.commit",
      target: proposal.proposalId,
      now: NOW,
    });
    const { result } = await harbor.commitRelation({
      proposalId: proposal.proposalId,
      actor: TEST_HUMAN_A,
      grant,
      action: "relation.commit",
      target: proposal.proposalId,
      now: NOW,
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
              evidenceMemoryIds: [witness.identity.id],
              grantId: "forged-grant",
              authorizedById: "test-human-b",
            },
          },
          provenance: provenance([a.identity.id, b.identity.id]),
          idempotencyKey: randomUUID(),
          createdBy: "ignored",
        }, ctx);
        return { result: cell, eventIds: store.all().map((e) => e.event.eventId) };
      },
    });
    expect(result.content.type).toBe("structured");
    const data = (result.content as { structuredData: Record<string, unknown> }).structuredData;
    expect(data.grantId).toBe(grant.grantId);
    expect(data.authorizedById).toBe("test-human-a");
    expect(data.grantId).not.toBe("forged-grant");
    expect(data.authorizedById).not.toBe("test-human-b");
    expect((store.all().at(-1)!.event.payload as { createdBy?: string }).createdBy).toBe(
      "test-human-a"
    );
    const view = harbor.connectome([a, b, witness, result], TEST_HUMAN_A, NOW);
    const canonical = view.relations.find((r) => r.status === "CANONICAL_MEMORY");
    expect(canonical?.authorizedBy?.id).toBe("test-human-a");
    expect(canonical?.authorizedBy?.grantId).toBe(grant.grantId);
  });

  it("forged resultingEventIds on ACCEPT are not recorded", async () => {
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = await harbor.propose(TEST_AI, { text: "note", sourceMemoryIds: [] }, NOW);
    const decided = harbor.decideProposal(proposal.proposalId, "ACCEPTED", TEST_HUMAN_A, {
      now: NOW,
      resultingEventIds: ["evt-forged-1", "evt-forged-2"],
    } as never);
    expect(decided.status).toBe("ACCEPTED");
    expect(decided.resultingEventIds).toEqual([]);
    expect(harbor.proposals.get(proposal.proposalId)?.resultingEventIds).toEqual([]);
    expect(harbor.agency.inspectCanonicalActions()).toHaveLength(0);
  });

  it("A: Core Memory existence is not FACT and not confidence 1", async () => {
    const overlay = defaultEpistemicForCoreMemory("mem-1", NOW);
    expect(overlay.status).not.toBe("FACT");
    expect(overlay.status).not.toBe("DERIVED");
    expect(overlay.status).toBe("UNCERTAIN");
    expect(overlay.confidence).toBeLessThan(1);
    expect(overlay.note).toMatch(/not proof/i);
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const cell = await authorizedCreate(adapter, {
      content: { type: "text", text: "recorded only" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    harbor.scan([cell], TEST_HUMAN_A, NOW);
    const rec = harbor.epistemic.get(cell.identity.id);
    expect(rec?.status).toBe("UNCERTAIN");
    expect(rec?.confidence).toBeLessThan(1);
  });

  it("B: timestamps/lifecycle never produce is_true/was_true", () => {
    const active = temporalFromMemory({
      memoryId: "m-active",
      createdAt: NOW,
      confirmedAt: NOW,
      lifecycle: "active",
    });
    const archived = temporalFromMemory({
      memoryId: "m-arch",
      createdAt: NOW,
      confirmedAt: NOW,
      archivedAt: NOW,
      lifecycle: "archived",
    });
    expect(active.temporalStatus).toBe("unknown");
    expect(archived.temporalStatus).toBe("unknown");
    expect(JSON.stringify({ active, archived })).not.toMatch(/is_true|was_true/);
  });

  it("C/D: traverse found:true is a structural path, not relation truth; CORE_REFERENCE is not truth evidence", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const a = await authorizedCreate(adapter, {
      content: { type: "text", text: "node-a" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const b = await authorizedCreate(adapter, {
      content: { type: "text", text: "node-b" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const withRef = {
      ...a,
      relationRefs: [
        {
          relationId: "ref-ab",
          targetMemoryId: b.identity.id,
          type: "RELATES_TO",
          direction: "outgoing" as const,
        },
      ],
    };
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const view = harbor.connectome([withRef, b], TEST_HUMAN_A, NOW);
    const coreRef = view.relations.find((r) => r.status === "CORE_REFERENCE");
    expect(coreRef).toBeDefined();
    expect(coreRef!.confidence).toBeLessThan(1);
    expect(coreRef!.evidenceMemoryIds).toEqual([]);
    expect(coreRef!.evidenceMemoryIds).not.toEqual([a.identity.id, b.identity.id]);
    expect(coreRef!.explanation.why).toMatch(/not evidence that the asserted relation is true/i);
    expect(coreRef!.explanation.what).toMatch(/recorded\/asserted relation type/i);
    expect(coreRef!.explanation.what).toMatch(/not proof that the relation is true/i);
    const pathResult = harbor.traverseConnectome(
      [withRef, b],
      a.identity.id,
      b.identity.id,
      TEST_HUMAN_A
    );
    expect(pathResult.found).toBe(true);
    expect(pathResult.reason).toMatch(/structural path/i);
    expect(pathResult.reason).toMatch(/not that the relation is true/i);
    expect(pathResult.reason).toMatch(/CORE_REFERENCE endpoints are not truth evidence/i);
  });

  it("E: prefers tea vs coffee is a possible inferred contradiction, not proven", async () => {
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
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const found = harbor.scan([tea, coffee], TEST_HUMAN_A, NOW);
    expect(found).toHaveLength(1);
    expect(found[0]!.resolution).toBe("UNRESOLVED");
    expect(found[0]!.possibleExplanations.join(" ")).toMatch(/possible inferred contradiction/i);
    expect(found[0]!.possibleExplanations.join(" ")).toMatch(/not a proven contradiction/i);
    expect(JSON.stringify(found[0])).not.toMatch(/proven fact|is true/i);
  });

  it("F: ACCEPT is a decision only — EventStore unchanged, no Grant consumed", async () => {
    const store = new InMemoryEventStore();
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = await harbor.propose(TEST_AI, { text: "remember tea", sourceMemoryIds: [] }, NOW);
    const issued = harbor.agency.issuedGrantCount();
    const decided = harbor.decideProposal(proposal.proposalId, "ACCEPTED", TEST_HUMAN_A, { now: NOW });
    expect(decided.status).toBe("ACCEPTED");
    expect(decided.resultingEventIds).toEqual([]);
    expect(harbor.agency.issuedGrantCount()).toBe(issued);
    expect(harbor.agency.inspectCanonicalActions()).toHaveLength(0);
    expect(store.count()).toBe(0);
  });

  it("G: proposal classification without sufficient evidence is not create_memory", async () => {
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const p = await harbor.propose(TEST_AI, { text: "hello there, maybe later", sourceMemoryIds: [] }, NOW);
    expect(p.proposalType).toBe("insufficient_evidence");
    expect(p.proposalType).not.toBe("create_memory");
    expect(p.resultingEventIds).toEqual([]);
  });

  it("OBSERVED confidence is not stronger than authorized persist; Memory nodes are not CANONICAL_REFERENCE", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const parent = await authorizedCreate(adapter, {
      content: { type: "text", text: "parent" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const child = await authorizedCreate(adapter, {
      content: { type: "text", text: "child" },
      provenance: provenance([parent.identity.id]),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const view = harbor.connectome([parent, child], TEST_HUMAN_A, NOW);
    const observed = view.relations.find((r) => r.status === "OBSERVED");
    expect(observed).toBeDefined();
    expect(observed!.confidence).toBeLessThanOrEqual(0.5);
    expect(observed!.explanation.what).toMatch(/recorded\/asserted relation type/i);
    expect(observed!.explanation.what).toMatch(/not proof that the relation is true/i);
    const memNodes = view.nodes.filter((n) => n.kind === "MEMORY");
    expect(memNodes.length).toBeGreaterThan(0);
    expect(memNodes.every((n) => n.status !== "CANONICAL_REFERENCE")).toBe(true);
    expect(memNodes.every((n) => n.status === "UNCERTAIN")).toBe(true);
  });

  it("A: graph() does not turn Core-backed existence into CANONICAL_REFERENCE", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const cell = await authorizedCreate(adapter, {
      content: { type: "text", text: "graph-node" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const graph = harbor.graph([cell], TEST_HUMAN_A);
    expect(graph.class).toBe("V3-DERIVED");
    expect(graph.nodes.every((n) => n.origin !== "CANONICAL_REFERENCE")).toBe(true);
    expect(graph.edges.every((e) => e.origin !== "CANONICAL_REFERENCE")).toBe(true);
  });

  it("B: ACCEPTED proposal is not USER_CONFIRMED on the legacy graph", async () => {
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = await harbor.propose(TEST_AI, { text: "remember tea", sourceMemoryIds: [] }, NOW);
    harbor.decideProposal(proposal.proposalId, "ACCEPTED", TEST_HUMAN_A, { now: NOW });
    const graph = harbor.graph([], TEST_HUMAN_A);
    const node = graph.nodes.find((n) => n.id === `proposal:${proposal.proposalId}`);
    expect(node).toBeDefined();
    expect(node!.origin).toBe("DERIVED");
    expect(node!.origin).not.toBe("USER_CONFIRMED");
  });

  it("C: context assembly does not map FACT into canonical authority", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const cell = await authorizedCreate(adapter, {
      content: { type: "text", text: "context-item" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    harbor.scan([cell], TEST_HUMAN_A, NOW);
    const uncertain = harbor.assemble(
      [cell],
      { query: "context", maxItems: 8, maxChars: 4000, selectedMemoryIds: [cell.identity.id] },
      TEST_HUMAN_A
    );
    expect(uncertain.items.every((i) => i.kind === "derived")).toBe(true);
    expect(uncertain.items.every((i) => i.kind !== "canonical")).toBe(true);
    expect(uncertain.items.some((i) => i.epistemicStatus === "UNCERTAIN")).toBe(true);
    harbor.epistemic.set(cell.identity.id, {
      ...harbor.epistemic.get(cell.identity.id)!,
      status: "FACT",
      confidence: 1,
    });
    const forcedFact = harbor.assemble(
      [cell],
      { query: "context", maxItems: 8, maxChars: 4000, selectedMemoryIds: [cell.identity.id] },
      TEST_HUMAN_A
    );
    expect(forcedFact.items.every((i) => i.kind === "derived")).toBe(true);
    expect(forcedFact.items.every((i) => i.kind !== "canonical")).toBe(true);
  });
});
