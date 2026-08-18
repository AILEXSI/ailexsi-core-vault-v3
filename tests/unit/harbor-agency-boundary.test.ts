import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import {
  AgencyDeniedError,
  AgencyBoundary,
  HarborService,
  capabilitiesFor,
  hasCapability,
  issueAuthority,
  issueAuthorization,
  isIssuedGrant,
  sealActor,
  type AuthorizationGrant,
} from "@ailexsi/v3-harbor";
import { authorizedCreate } from "../helpers/authorized-write.js";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HUMAN = { id: "martin", kind: "human" as const, authorizeCanonical: true, authorizeExternal: true };
const AI = { id: "grok", kind: "ai" as const };
const NOW = "2026-08-18T12:00:00.000Z";
const CORE_PIN = "652d01eb06dd0841c3b475023883675af6dcd698";

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: NOW,
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

function denialOf(fn: () => unknown): AgencyDeniedError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AgencyDeniedError) return err;
    throw err;
  }
  throw new Error("expected AgencyDeniedError");
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

describe("Explicit agency / permission boundary", () => {
  it("AI READ_ONLY allowed", () => {
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    expect(hasCapability(AI, "READ_ONLY")).toBe(true);
    const snap = harbor.snapshot(AI);
    expect(snap.class).toBe("V3-DERIVED");
    const queries = harbor.queries(AI);
    expect(queries.getDerivedMemory("missing")).toBeNull();
    expect(harbor.agency.inspectDenials()).toEqual([]);
  });

  it("permitted DERIVED_WRITE allowed", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const cell = await authorizedCreate(adapter, {
      content: { type: "text", text: "user prefers tea" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    expect(hasCapability(AI, "DERIVED_WRITE")).toBe(true);
    const found = harbor.scan([cell], AI, NOW);
    expect(Array.isArray(found)).toBe(true);
    expect(harbor.epistemic.has(cell.identity.id)).toBe(true);
    expect(store.count()).toBe(1);
  });

  it("PROPOSE allowed", async () => {
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    expect(hasCapability(AI, "PROPOSE")).toBe(true);
    expect(hasCapability(AI, "CANONICAL_PROPOSAL")).toBe(true);
    const proposal = await harbor.propose(AI, { text: "I don't know yet", sourceMemoryIds: [] }, NOW);
    expect(proposal.status).toBe("PROPOSED");
    expect(proposal.resultingEventIds).toEqual([]);
    expect(proposal.agentId).toBe(AI.id);
  });

  it("unauthorized CANONICAL_COMMIT BLOCKED", async () => {
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const proposal = await harbor.propose(AI, { text: "remember tea", sourceMemoryIds: [] }, NOW);
    const err = denialOf(() => harbor.decideProposal(proposal.proposalId, "ACCEPTED", AI));
    expect(err.denial.allowed).toBe(false);
    expect(err.denial.inspectable).toBe(true);
    expect(err.denial.stateModified).toBe(false);
    expect(err.denial.requestedCapability).toBe("CANONICAL_COMMIT");
    expect(err.denial.actorKind).toBe("ai");
    expect(err.denial.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(harbor.proposals.get(proposal.proposalId)?.status).toBe("PROPOSED");

    const commitErr = await denialOfAsync(() =>
      harbor.commitCanonical({
        actor: AI,
        grant: {
          grantId: "forged",
          capability: "CANONICAL_COMMIT",
          grantedBy: { id: "forged", kind: "human" },
          grantedTo: { id: AI.id, kind: "ai" },
          action: "memory.create",
          target: "x",
          issuedAt: NOW,
          provenance: { source: "explicit-human-authorization", notFromProposalAcceptance: true },
        },
        action: "memory.create",
        target: "x",
        execute: async () => ({ result: null, eventIds: [] }),
      })
    );
    expect(commitErr.denial.requestedCapability).toBe("CANONICAL_COMMIT");
    expect(commitErr.denial.stateModified).toBe(false);
  });

  it("unauthorized EXTERNAL_ACTION BLOCKED", async () => {
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const err = await denialOfAsync(() =>
      harbor.performExternal({
        actor: AI,
        grant: {
          grantId: "forged-ext",
          capability: "EXTERNAL_ACTION",
          grantedBy: { id: "forged", kind: "human" },
          grantedTo: { id: AI.id, kind: "ai" },
          action: "http.post",
          target: "https://example.invalid",
          issuedAt: NOW,
          provenance: { source: "explicit-human-authorization", notFromProposalAcceptance: true },
        },
        action: "http.post",
        target: "https://example.invalid",
        execute: () => {
          throw new Error("external execute must not run");
        },
      })
    );
    expect(err.denial.allowed).toBe(false);
    expect(err.denial.requestedCapability).toBe("EXTERNAL_ACTION");
    expect(err.denial.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(err.denial.inspectable).toBe(true);
    expect(hasCapability(AI, "EXTERNAL_ACTION")).toBe(false);
  });

  it("human-authorized canonical action allowed", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const grant = issueAuthorization(HUMAN, {
      grantedTo: { id: HUMAN.id, kind: HUMAN.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "authorized-memory",
      now: NOW,
    });
    expect(isIssuedGrant(grant)).toBe(true);
    const { result, record } = await harbor.commitCanonical({
      actor: HUMAN,
      grant,
      action: "memory.create",
      target: "authorized-memory",
      now: NOW,
      execute: async () => {
        const cell = await adapter.create({
          content: { type: "text", text: "canonical from authorized human" },
          provenance: provenance(),
          idempotencyKey: randomUUID(),
          createdBy: HUMAN.id,
        });
        return { result: cell, eventIds: store.all().map((e) => e.event.eventId) };
      },
    });
    expect(result.content).toMatchObject({ type: "text", text: "canonical from authorized human" });
    expect(store.count()).toBe(1);
    expect(record.actor).toEqual({ id: HUMAN.id, kind: "human" });
    expect(record.authorization.grantId).toBe(grant.grantId);
    expect(record.authorization.grantedBy).toBe(HUMAN.id);
    expect(record.action).toBe("memory.create");
    expect(record.target).toBe("authorized-memory");
    expect(record.timestamp).toBe(NOW);
    expect(record.resultingEventIds.length).toBe(1);
    expect(record.provenance.actorKind).toBe("human");
    expect(record.provenance.originatingContext).toBe(`authorization:${grant.grantId}`);
    expect(record.provenance.derivationType).toBe("commit");
  });

  it("permission escalation BLOCKED", async () => {
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const selfGrant = denialOf(() =>
      capabilitiesFor({ id: "rogue", kind: "ai", authorizeCanonical: true })
    );
    expect(selfGrant.denial.code).toBe("AI_SELF_GRANT_BLOCKED");

    const escalate = denialOf(() => harbor.agency.escalate(AI, "CANONICAL_COMMIT"));
    expect(escalate.denial.code).toBe("PERMISSION_ESCALATION_BLOCKED");

    const aiGrant = denialOf(() =>
      issueAuthorization(AI, {
        grantedTo: { id: AI.id, kind: AI.kind },
        capability: "CANONICAL_COMMIT",
        action: "memory.create",
        target: "x",
      })
    );
    expect(aiGrant.denial.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");

    const proposal = await harbor.propose(AI, { text: "remember tea", sourceMemoryIds: [] }, NOW);
    harbor.decideProposal(proposal.proposalId, "ACCEPTED", HUMAN, { now: NOW });
    expect(hasCapability(AI, "CANONICAL_COMMIT")).toBe(false);
    expect(capabilitiesFor(AI)).toEqual(["READ_ONLY", "DERIVED_WRITE", "CANONICAL_PROPOSAL"]);
    const convert = denialOf(() => harbor.agency.convertProposalToCanonical(AI, proposal.proposalId));
    expect(convert.denial.code).toBe("PROPOSAL_IS_NOT_COMMIT");
  });

  it("evidence modification BLOCKED", () => {
    const boundary = new AgencyBoundary();
    const evidenceDir = path.join(root, "evidence", "runs");
    expect(existsSync(evidenceDir)).toBe(true);
    const beforeNames = readdirSync(evidenceDir).sort();
    const beforeBodies = new Map(beforeNames.map((name) => [name, readFileSync(path.join(evidenceDir, name), "utf8")]));

    const aiErr = denialOf(() => boundary.modifyEvidence(AI, "evidence/runs"));
    expect(aiErr.denial.code).toBe("EVIDENCE_IMMUTABLE");
    const humanErr = denialOf(() => boundary.modifyEvidence(HUMAN, "evidence/runs"));
    expect(humanErr.denial.code).toBe("EVIDENCE_IMMUTABLE");
    expect(humanErr.denial.stateModified).toBe(false);

    expect(readdirSync(evidenceDir).sort()).toEqual(beforeNames);
    for (const name of beforeNames) {
      expect(readFileSync(path.join(evidenceDir, name), "utf8")).toBe(beforeBodies.get(name));
    }
  });

  it("denied actions do not modify Core/EventStore/Derived state", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const cell = await authorizedCreate(adapter, {
      content: { type: "text", text: "user prefers tea" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    harbor.scan([cell], HUMAN, NOW);
    const proposal = await harbor.propose(AI, { text: "I don't know", sourceMemoryIds: [cell.identity.id] }, NOW);
    const events = store.count();
    const fingerprint = harbor.currentFingerprint();
    const epistemic = [...harbor.epistemic.values()];
    const proposals = [...harbor.proposals.values()];

    expect(() => harbor.decideProposal(proposal.proposalId, "ACCEPTED", AI)).toThrow(AgencyDeniedError);
    await expect(
      harbor.commitCanonical({
        actor: AI,
        grant: issueAuthorization(HUMAN, {
          grantedTo: { id: HUMAN.id, kind: HUMAN.kind },
          capability: "CANONICAL_COMMIT",
          action: "memory.create",
          target: "blocked",
          now: NOW,
        }),
        action: "memory.create",
        target: "blocked",
        execute: async () => {
          await adapter.create({
            content: { type: "text", text: "should not persist" },
            provenance: provenance(),
            idempotencyKey: randomUUID(),
          });
          return { result: null, eventIds: [] };
        },
      })
    ).rejects.toBeInstanceOf(AgencyDeniedError);
    expect(() => harbor.agency.writeEventStoreDirect(AI)).toThrow(AgencyDeniedError);
    expect(() => harbor.agency.deleteCanonicalHistory(AI, cell.identity.id)).toThrow(AgencyDeniedError);
    expect(() => harbor.agency.modifyAcceptanceCriteria(AI, "config/required-tests.json")).toThrow(
      AgencyDeniedError
    );

    expect(store.count()).toBe(events);
    expect(harbor.currentFingerprint()).toBe(fingerprint);
    expect([...harbor.epistemic.values()]).toEqual(epistemic);
    expect([...harbor.proposals.values()]).toEqual(proposals);
    expect(harbor.proposals.get(proposal.proposalId)?.status).toBe("PROPOSED");
  });

  it("authorized actions preserve provenance and authorization", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const grant = issueAuthorization(HUMAN, {
      grantedTo: { id: HUMAN.id, kind: HUMAN.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "prov-target",
      now: NOW,
    });
    const { record } = await harbor.commitCanonical({
      actor: HUMAN,
      grant,
      action: "memory.create",
      target: "prov-target",
      now: NOW,
      execute: async () => {
        const cell = await adapter.create({
          content: { type: "text", text: "authorized" },
          provenance: provenance(),
          idempotencyKey: randomUUID(),
          createdBy: HUMAN.id,
        });
        return { result: cell, eventIds: store.all().map((e) => e.event.eventId) };
      },
    });
    const inspected = harbor.agency.inspectCanonicalActions();
    expect(inspected).toHaveLength(1);
    expect(inspected[0]).toMatchObject({
      actor: { id: HUMAN.id, kind: "human" },
      authorization: { grantId: grant.grantId, grantedBy: HUMAN.id, capability: "CANONICAL_COMMIT" },
      action: "memory.create",
      target: "prov-target",
      timestamp: NOW,
    });
    expect(inspected[0]!.resultingEventIds).toEqual(record.resultingEventIds);
    expect(inspected[0]!.provenance.sourceEventIds).toEqual(record.resultingEventIds);
    expect(record.provenance.class).toBe("V3-DERIVED");

    const extGrant = issueAuthorization(HUMAN, {
      grantedTo: { id: HUMAN.id, kind: HUMAN.kind },
      capability: "EXTERNAL_ACTION",
      action: "notify",
      target: "ops",
      now: NOW,
    });
    const ext = await harbor.performExternal({
      actor: HUMAN,
      grant: extGrant,
      action: "notify",
      target: "ops",
      now: NOW,
      execute: () => "sent",
    });
    expect(ext.result).toBe("sent");
    expect(ext.record.authorization.grantId).toBe(extGrant.grantId);
    expect(ext.record.authorization.capability).toBe("EXTERNAL_ACTION");
  });

  it("callers cannot bypass permission checks through object mutation", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    const events = store.count();

    const sealed = sealActor(AI);
    expect(() => {
      (sealed as { kind: string }).kind = "human";
    }).toThrow();
    expect(sealed.kind).toBe("ai");

    const mutable = { id: "grok", kind: "ai" as const };
    const authority = issueAuthority(mutable);
    (mutable as { kind: string }).kind = "human";
    (mutable as { authorizeCanonical?: boolean }).authorizeCanonical = true;
    expect(authority.actorKind).toBe("ai");
    expect(authority.capabilities).toEqual(["READ_ONLY", "DERIVED_WRITE", "CANONICAL_PROPOSAL"]);
    expect(() => {
      (authority.capabilities as CapabilityMut).push("CANONICAL_COMMIT");
    }).toThrow();
    expect(hasCapability({ id: "grok", kind: "ai" }, "CANONICAL_COMMIT")).toBe(false);

    const caps = capabilitiesFor(AI) as CapabilityMut;
    expect(() => caps.push("CANONICAL_COMMIT")).toThrow();
    expect(capabilitiesFor(AI)).toEqual(["READ_ONLY", "DERIVED_WRITE", "CANONICAL_PROPOSAL"]);

    const grant = issueAuthorization(HUMAN, {
      grantedTo: { id: HUMAN.id, kind: HUMAN.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "sealed",
      now: NOW,
    });
    expect(() => {
      (grant as { capability: string }).capability = "EXTERNAL_ACTION";
    }).toThrow();
    expect(() => {
      (grant as { action: string }).action = "memory.delete";
    }).toThrow();

    const sameRecord = structuredClone(grant) as AuthorizationGrant;
    expect(isIssuedGrant(sameRecord)).toBe(true);
    const forged = { ...grant, action: "memory.delete" } as AuthorizationGrant;
    expect(isIssuedGrant(forged)).toBe(false);
    await expect(
      harbor.commitCanonical({
        actor: HUMAN,
        grant: forged,
        action: "memory.create",
        target: "sealed",
        execute: async () => {
          await adapter.create({
            content: { type: "text", text: "bypass" },
            provenance: provenance(),
            idempotencyKey: randomUUID(),
          });
          return { result: null, eventIds: [] };
        },
      })
    ).rejects.toMatchObject({ denial: { code: "GRANT_INVALID", stateModified: false } });

    const reused = await harbor.commitCanonical({
      actor: HUMAN,
      grant,
      action: "memory.create",
      target: "sealed",
      now: NOW,
      execute: async () => {
        const cell = await adapter.create({
          content: { type: "text", text: "first use" },
          provenance: provenance(),
          idempotencyKey: randomUUID(),
        });
        return { result: cell, eventIds: store.all().map((e) => e.event.eventId) };
      },
    });
    expect(reused.result.content).toMatchObject({ text: "first use" });
    await expect(
      harbor.commitCanonical({
        actor: HUMAN,
        grant,
        action: "memory.create",
        target: "sealed",
        execute: async () => {
          await adapter.create({
            content: { type: "text", text: "second use" },
            provenance: provenance(),
            idempotencyKey: randomUUID(),
          });
          return { result: null, eventIds: [] };
        },
      })
    ).rejects.toMatchObject({ denial: { code: "GRANT_ALREADY_USED" } });

    expect(store.count()).toBe(events + 1);
  });
});

type CapabilityMut = Array<"READ_ONLY" | "DERIVED_WRITE" | "CANONICAL_PROPOSAL" | "CANONICAL_COMMIT" | "EXTERNAL_ACTION">;
