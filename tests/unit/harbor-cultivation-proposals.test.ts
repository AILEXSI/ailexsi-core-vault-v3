import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import { authorizedCreate } from "../helpers/authorized-write.js";
import {
  AgencyDeniedError,
  CULTIVATION_PROPOSAL_SCHEMA,
  HarborService,
  type ContextMemory,
  type CultivationProposalType,
} from "@ailexsi/v3-harbor";

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: "2026-08-17T12:00:00.000Z",
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

const HUMAN = { id: "martin", kind: "human" as const, authorizeCanonical: true };
const AI = { id: "grok", kind: "ai" as const };
const NOW = "2026-08-17T15:00:00.000Z";
const CORE_PIN = "652d01eb06dd0841c3b475023883675af6dcd698";
const VAULT_SHA = "061e444389090c54e431b0e8243e82764f2c198e";

const tmpDirs: string[] = [];

function tmpPersist(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harbor-cult-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function fixture() {
  const store = new InMemoryEventStore();
  const adapter = new MemoryCommandAdapter({ store, environment: "test" });
  const a = await authorizedCreate(adapter, {
    content: { type: "text", text: "user prefers tea" },
    context: { project: "kitchen", tags: ["drink", "goal"] },
    provenance: provenance(),
    idempotencyKey: randomUUID(),
  });
  const b = await authorizedCreate(adapter, {
    content: { type: "text", text: "user prefers coffee" },
    context: { project: "kitchen", tags: ["drink"] },
    provenance: provenance(),
    idempotencyKey: randomUUID(),
  });
  const c = await authorizedCreate(adapter, {
    content: { type: "text", text: "goal: ship v3" },
    context: { project: "kitchen", tags: ["goal"] },
    provenance: provenance(),
    idempotencyKey: randomUUID(),
  });
  return { store, adapter, a, b, c, cells: [a, b, c] };
}

function catalogOf(
  cells: Array<{
    identity: { id: string };
    content: { type: string; text?: string };
    context: { project?: string; tags?: string[] };
    timestamps: { confirmedAt?: string };
    lifecycle: { state: string };
  }>
): ContextMemory[] {
  return cells.map((m) => ({
    id: m.identity.id,
    text: m.content.type === "text" ? (m.content.text ?? "") : "",
    project: m.context.project,
    tags: m.context.tags ?? [],
    updatedAt: m.timestamps.confirmedAt,
    lifecycle: m.lifecycle.state,
  }));
}

function openHarbor(persistDir: string) {
  return HarborService.open({
    corePin: CORE_PIN,
    vaultReferenceSha: VAULT_SHA,
    persistDir,
  });
}

function readyHarbor(
  persistDir: string,
  cells: Parameters<HarborService["rebuildFromCanonical"]>[0],
  inferredId?: string
) {
  const harbor = openHarbor(persistDir);
  harbor.rebuildFromCanonical(cells, HUMAN, NOW);
  if (inferredId) {
    harbor.epistemic.set(inferredId, {
      ...harbor.epistemic.get(inferredId)!,
      status: "INFERRED",
      confidence: 0.4,
    });
  }
  return harbor;
}

describe("Deterministic cultivation proposals", () => {
  it("generates a proposal from each supported reflection type", async () => {
    const { c, cells } = await fixture();
    const harbor = readyHarbor(tmpPersist(), cells, c.identity.id);
    const proposals = harbor.cultivate(HUMAN, NOW, { catalog: catalogOf(cells) });
    const types = proposals.map((p) => p.proposalType);
    const expected: CultivationProposalType[] = [
      "review_preference",
      "review_contradiction",
      "review_unconfirmed",
      "review_goal",
      "review_project",
    ];
    for (const t of expected) expect(types).toContain(t);
    expect(proposals.every((p) => p.status === "PROPOSED")).toBe(true);
    expect(proposals.every((p) => p.schemaVersion === CULTIVATION_PROPOSAL_SCHEMA)).toBe(true);
    expect(proposals.every((p) => p.class === "V3-DERIVED")).toBe(true);
    expect(proposals.find((p) => p.proposalType === "review_preference")?.description).toMatch(
      /newer preference should supersede/
    );
    expect(proposals.find((p) => p.proposalType === "review_contradiction")?.description).toBe(
      "Review contradictory records."
    );
    expect(proposals.every((p) => !/obsess|emotion|personality|intent/i.test(p.description))).toBe(true);
  });

  it("preserves provenance, reflection IDs, and source memory IDs", async () => {
    const { a, b, cells } = await fixture();
    const harbor = readyHarbor(tmpPersist(), cells);
    const reflections = harbor.reflectObserved(HUMAN, NOW, { catalog: catalogOf(cells) });
    const proposals = harbor.cultivate(HUMAN, NOW, { catalog: catalogOf(cells) });
    const contra = proposals.find((p) => p.proposalType === "review_contradiction")!;
    const sourceReflection = reflections.find((r) => r.type === "unresolved_contradiction")!;
    expect(contra.sourceReflectionIds).toEqual([sourceReflection.reflectionId]);
    expect(contra.sourceMemoryIds.sort()).toEqual([a.identity.id, b.identity.id].sort());
    expect(contra.provenance.sourceMemoryIds.sort()).toEqual([a.identity.id, b.identity.id].sort());
    expect(contra.provenance.derivationType).toBe("propose");
    expect(contra.evidenceStrength).toBe(sourceReflection.evidenceStrength);
  });

  it("keeps deterministic IDs, order, and identical input output", async () => {
    const { c, cells } = await fixture();
    const harbor = readyHarbor(tmpPersist(), cells, c.identity.id);
    const catalog = catalogOf(cells);
    const first = harbor.cultivate(HUMAN, NOW, { catalog });
    const second = harbor.cultivate(HUMAN, NOW, { catalog });
    expect(first).toEqual(second);
    expect(first.map((p) => p.proposalId)).toEqual(second.map((p) => p.proposalId));
    const order: CultivationProposalType[] = [
      "review_preference",
      "review_contradiction",
      "review_unconfirmed",
      "review_goal",
      "review_project",
    ];
    const ranks = first.map((p) => order.indexOf(p.proposalType));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });

  it("supports human reject, defer, and edit without writing Core", async () => {
    const { store, cells } = await fixture();
    const events = store.count();
    const harbor = readyHarbor(tmpPersist(), cells);
    const [first] = harbor.cultivate(HUMAN, NOW, { catalog: catalogOf(cells) });
    expect(first).toBeTruthy();
    expect(() => harbor.decideCultivation(first!.proposalId, "REJECTED", AI)).toThrow(/human/i);
    const rejected = harbor.decideCultivation(first!.proposalId, "REJECTED", HUMAN);
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.decidedBy).toBe(HUMAN.id);

    const rest = harbor.cultivate(HUMAN, NOW, { catalog: catalogOf(cells) }).filter((p) => p.proposalId !== first!.proposalId);
    const deferred = harbor.decideCultivation(rest[0]!.proposalId, "DEFERRED", HUMAN);
    expect(deferred.status).toBe("DEFERRED");
    const edited = harbor.decideCultivation(rest[1]!.proposalId, "EDITED", HUMAN, {
      title: "Edited title",
      description: "Edited description",
      now: NOW,
    });
    expect(edited.status).toBe("EDITED");
    expect(edited.title).toBe("Edited title");
    expect(harbor.cultivate(HUMAN, NOW, { catalog: catalogOf(cells) }).find((p) => p.proposalId === edited.proposalId)?.title).toBe(
      "Edited title"
    );
    expect(store.count()).toBe(events);
    expect(() => harbor.decideCultivation(edited.proposalId, "ACCEPTED", HUMAN)).toThrow(/already decided/i);
  });

  it("accepts a proposal as a human decision only — no EventStore or memory write", async () => {
    const { store, cells } = await fixture();
    const events = store.count();
    const harbor = readyHarbor(tmpPersist(), cells);
    const [p] = harbor.cultivate(HUMAN, NOW, { catalog: catalogOf(cells) });
    expect(() => harbor.decideCultivation(p!.proposalId, "ACCEPTED", AI)).toThrow(AgencyDeniedError);
    const accepted = harbor.decideCultivation(p!.proposalId, "ACCEPTED", HUMAN, { now: NOW });
    expect(accepted.status).toBe("ACCEPTED");
    expect(store.count()).toBe(events);
    expect([...harbor.epistemic.values()].every((e) => e.status === "DERIVED")).toBe(true);
  });

  it("survives restart/reopen and CLEAR → REBUILD for generated proposals", async () => {
    const { store, c, cells } = await fixture();
    const events = store.count();
    const dir = tmpPersist();
    const first = readyHarbor(dir, cells, c.identity.id);
    const catalog = catalogOf(cells);
    const before = first.cultivate(HUMAN, NOW, { catalog });
    const reopened = openHarbor(dir);
    reopened.epistemic.set(c.identity.id, {
      ...reopened.epistemic.get(c.identity.id)!,
      status: "INFERRED",
      confidence: 0.4,
    });
    const afterOpen = reopened.cultivate(HUMAN, NOW, { catalog });
    expect(afterOpen.map((p) => p.proposalId)).toEqual(before.map((p) => p.proposalId));
    expect(afterOpen.map((p) => p.description)).toEqual(before.map((p) => p.description));
    first.clearDerived(HUMAN);
    first.rebuildFromCanonical(cells, HUMAN, NOW);
    first.epistemic.set(c.identity.id, {
      ...first.epistemic.get(c.identity.id)!,
      status: "INFERRED",
      confidence: 0.4,
    });
    expect(first.cultivate(HUMAN, NOW, { catalog }).map((p) => p.proposalId)).toEqual(
      before.map((p) => p.proposalId)
    );
    expect(store.count()).toBe(events);
  });

  it("is read-only against Core and the Derived Index; caller mutation is isolated", async () => {
    const { store, cells } = await fixture();
    const events = store.count();
    const dir = tmpPersist();
    const harbor = readyHarbor(dir, cells);
    const fingerprint = harbor.currentFingerprint();
    const files = readdirSync(dir).sort();
    const raw = readFileSync(path.join(dir, "index.json"), "utf8");
    const proposals = harbor.cultivate(HUMAN, NOW, { catalog: catalogOf(cells) });
    proposals[0]!.description = "mutated";
    proposals[0]!.sourceMemoryIds.push("injected");
    expect(harbor.cultivate(HUMAN, NOW, { catalog: catalogOf(cells) })[0]!.description).not.toBe("mutated");
    expect(store.count()).toBe(events);
    expect(harbor.currentFingerprint()).toBe(fingerprint);
    expect(harbor.proposals.size).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(files);
    expect(readFileSync(path.join(dir, "index.json"), "utf8")).toBe(raw);
  });
});
