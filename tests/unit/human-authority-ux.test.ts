/**
 * Human Authority UX — reconnect existing Agency issuance to DesktopHost / bridge / UI.
 * Does not mint a second write path.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DesktopHost,
  MemoryCommandAdapter,
  bridgeCommandStatus,
  invokeDesktopCommand,
  resetDesktopHostForTests,
} from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import {
  AgencyDeniedError,
  HarborService,
  isConsumedGrant,
} from "@ailexsi/v3-harbor";
import { bindAgencySessionActor } from "../../packages/harbor/src/session-bind.js";
import { TEST_HUMAN_A } from "../helpers/authorized-write.js";
import type { Provenance } from "@ailexsi/contracts";

const CORE_PIN = "652d01eb06dd0841c3b475023883675af6dcd698";
const NOW = "2026-08-21T12:00:00.000Z";

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

describe("Human Authority UX", () => {
  it("unbound session: issue and mutate denied", async () => {
    resetDesktopHostForTests();
    const host = new DesktopHost();
    expect(host.sessionStatus()).toMatchObject({ bound: false, actor: null });
    expect(host.getSessionActor()).toBeNull();
    expect(() =>
      host.authorizationIssue({ action: "memory.create", target: "X" })
    ).toThrow(AgencyDeniedError);
    const err = await denialOfAsync(() =>
      host.memoryCreate({
        content: { type: "text", text: "no-session" },
        provenance: provenance(),
        idempotencyKey: "X",
      })
    );
    expect(err.denial.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
  });

  it("human session + no grant → GRANT_INVALID, EventStore unchanged", async () => {
    const store = new InMemoryEventStore();
    const host = new DesktopHost();
    host.attachActor(TEST_HUMAN_A);
    expect(host.sessionStatus().bound).toBe(true);
    expect(host.sessionStatus().actor).toEqual({ id: "test-human-a", kind: "human" });
    const err = await denialOfAsync(() =>
      host.memoryCreate({
        content: { type: "text", text: "no-grant" },
        provenance: provenance(),
        idempotencyKey: "X",
      })
    );
    expect(err.denial.code).toBe("GRANT_INVALID");
    expect(err.denial.stateModified).toBe(false);
    expect(store.count()).toBe(0);
  });

  it("human session + explicit grant → one Memory, createdBy = session actor", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    bindAgencySessionActor(harbor.agency, TEST_HUMAN_A);
    const target = randomUUID();
    const grant = harbor.agency.issueAuthorization(TEST_HUMAN_A, {
      grantedTo: { id: TEST_HUMAN_A.id, kind: TEST_HUMAN_A.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target,
      now: NOW,
    });
    const { result } = await harbor.commitCanonical({
      actor: TEST_HUMAN_A,
      grant,
      action: "memory.create",
      target,
      now: NOW,
      execute: async (ctx) => {
        const cell = await adapter.create({
          content: { type: "text", text: "authorized-create" },
          provenance: provenance(),
          idempotencyKey: target,
        }, ctx);
        return { result: cell, eventIds: store.all().map((e) => e.event.eventId) };
      },
    });
    expect(store.count()).toBe(1);
    expect(result.content).toMatchObject({ type: "text", text: "authorized-create" });
    expect((store.all()[0]!.event.payload as { createdBy?: string }).createdBy).toBe(
      "test-human-a"
    );
    expect(isConsumedGrant(grant, harbor.agency.registry)).toBe(true);
  });

  it("consumed grant replay is denied", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
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
        }, ctx);
        return { result: cell, eventIds: store.all().map((e) => e.event.eventId) };
      },
    });
    const before = store.count();
    const err = await denialOfAsync(() =>
      harbor.commitCanonical({
        actor: TEST_HUMAN_A,
        grant,
        action: "memory.create",
        target,
        execute: async () => ({ result: null, eventIds: [] }),
      })
    );
    expect(err.denial.code).toBe("GRANT_ALREADY_USED");
    expect(store.count()).toBe(before);
  });

  it("target and action mismatch are denied", async () => {
    const store = new InMemoryEventStore();
    const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "v" });
    bindAgencySessionActor(harbor.agency, TEST_HUMAN_A);
    const grant = harbor.agency.issueAuthorization(TEST_HUMAN_A, {
      grantedTo: { id: TEST_HUMAN_A.id, kind: TEST_HUMAN_A.kind },
      capability: "CANONICAL_COMMIT",
      action: "memory.create",
      target: "X",
      now: NOW,
    });
    const targetErr = await denialOfAsync(() =>
      harbor.commitCanonical({
        actor: TEST_HUMAN_A,
        grant,
        action: "memory.create",
        target: "Y",
        execute: async () => ({ result: null, eventIds: [] }),
      })
    );
    expect(targetErr.denial.code).toBe("GRANT_ACTION_MISMATCH");
    const actionErr = await denialOfAsync(() =>
      harbor.commitCanonical({
        actor: TEST_HUMAN_A,
        grant,
        action: "memory.update",
        target: "X",
        execute: async () => ({ result: null, eventIds: [] }),
      })
    );
    expect(actionErr.denial.code).toBe("GRANT_ACTION_MISMATCH");
    expect(store.count()).toBe(0);
  });

  it("bridge allows session.status and authorization.issue; grant.create stays 404", () => {
    const prev = process.env.DESKTOP_HOST_TOKEN;
    process.env.DESKTOP_HOST_TOKEN = "unit-channel-token";
    const tok = { "x-channel-token": "unit-channel-token" };
    try {
      expect(bridgeCommandStatus("session.status", {})).toBe(401);
      expect(bridgeCommandStatus("session.status", tok)).toBe(200);
      expect(bridgeCommandStatus("authorization.issue", tok)).toBe(200);
      expect(bridgeCommandStatus("grant.create", tok)).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.DESKTOP_HOST_TOKEN;
      else process.env.DESKTOP_HOST_TOKEN = prev;
    }
  });

  it("invokeDesktopCommand session.status does not invent an actor", async () => {
    resetDesktopHostForTests();
    const status = (await invokeDesktopCommand("session.status", {})) as {
      bound: boolean;
      actor: { id: string } | null;
    };
    expect(status.bound).toBe(false);
    expect(status.actor).toBeNull();
  });

  it("MemoryPanel requires Authorize create before persist", () => {
    const src = readFileSync(
      path.join(process.cwd(), "apps/desktop/src/components/MemoryPanel.tsx"),
      "utf8"
    );
    expect(src).toMatch(/Authorize create/);
    expect(src).toMatch(/Create \(persist\)/);
    expect(src).toMatch(/grantState !== "issued"/);
    expect(src).toMatch(/issueAuthorization\("memory.create"/);
    expect(src).toMatch(/idempotencyKey: pendingKey/);
    expect(src).toMatch(/badge core">RECORDED</);
  });
});
