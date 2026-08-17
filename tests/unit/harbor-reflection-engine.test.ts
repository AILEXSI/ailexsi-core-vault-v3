import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import {
  HarborService,
  REFLECTION_OBSERVATION_SCHEMA,
  type ContextMemory,
  type ObservedReflection,
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
const NOW = "2026-08-17T15:00:00.000Z";
const CORE_PIN = "652d01eb06dd0841c3b475023883675af6dcd698";
const VAULT_SHA = "061e444389090c54e431b0e8243e82764f2c198e";

const tmpDirs: string[] = [];

function tmpPersist(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harbor-reflect-"));
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
  const a = await adapter.create({
    content: { type: "text", text: "user prefers tea" },
    context: { project: "kitchen", tags: ["drink", "goal"] },
    provenance: provenance(),
    idempotencyKey: randomUUID(),
  });
  const b = await adapter.create({
    content: { type: "text", text: "user prefers coffee" },
    context: { project: "kitchen", tags: ["drink"] },
    provenance: provenance(),
    idempotencyKey: randomUUID(),
  });
  const c = await adapter.create({
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

function byType(items: ObservedReflection[], type: ObservedReflection["type"]) {
  return items.filter((i) => i.type === type);
}

describe("Deterministic reflection engine", () => {
  it("observes recurring topics and repeated projects/goals", async () => {
    const { cells } = await fixture();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const items = harbor.reflectObserved(HUMAN, NOW, { catalog: catalogOf(cells) });
    const topics = byType(items, "recurring_topic");
    expect(topics.some((t) => t.observation.includes('Tag "drink"') && t.observation.includes("2 records"))).toBe(
      true
    );
    const projects = byType(items, "repeated_project");
    expect(projects).toHaveLength(1);
    expect(projects[0]!.observation).toMatch(/Project "kitchen" is referenced by 3 records/);
    const goals = byType(items, "repeated_goal");
    expect(goals.some((g) => g.observation.includes("2 records"))).toBe(true);
    expect(items.every((i) => i.stance === "OBSERVED")).toBe(true);
    expect(items.every((i) => i.schemaVersion === REFLECTION_OBSERVATION_SCHEMA)).toBe(true);
    expect(items.every((i) => !("interpretation" in i))).toBe(true);
  });

  it("observes preference values over time without interpreting motive", async () => {
    const { cells } = await fixture();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const items = harbor.reflectObserved(HUMAN, NOW, { catalog: catalogOf(cells) });
    const prefs = byType(items, "preference_change");
    expect(prefs).toHaveLength(1);
    expect(prefs[0]!.observation).toMatch(/Preference values recorded:/);
    expect(prefs[0]!.observation).toMatch(/tea/);
    expect(prefs[0]!.observation).toMatch(/coffee/);
    expect(prefs[0]!.observation).not.toMatch(/obsess|becoming|personality|intent/i);
  });

  it("surfaces unresolved contradictions without resolving them", async () => {
    const { store, cells } = await fixture();
    const events = store.count();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const items = harbor.reflectObserved(HUMAN, NOW, { catalog: catalogOf(cells) });
    const cons = byType(items, "unresolved_contradiction");
    expect(cons).toHaveLength(1);
    expect(cons[0]!.observation).toMatch(/^Unresolved contradiction /);
    expect(cons[0]!.supportingDerivedIds).toHaveLength(1);
    expect(harbor.contradictions.get(cons[0]!.supportingDerivedIds[0]!)?.resolution).toBe("UNRESOLVED");
    expect(store.count()).toBe(events);
  });

  it("preserves provenance and deterministic IDs/order", async () => {
    const { cells } = await fixture();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const first = harbor.reflectObserved(HUMAN, NOW, { catalog: catalogOf(cells) });
    const second = harbor.reflectObserved(HUMAN, NOW, { catalog: catalogOf(cells) });
    expect(first.map((i) => i.reflectionId)).toEqual(second.map((i) => i.reflectionId));
    expect(first.every((i) => i.provenance.sourceMemoryIds.length > 0)).toBe(true);
    expect(first.every((i) => i.provenance.derivationType === "reflect")).toBe(true);
    expect(first.every((i) => i.status === "DERIVED")).toBe(true);
    const types = first.map((i) => i.type);
    const order = [
      "recurring_topic",
      "repeated_goal",
      "repeated_project",
      "preference_change",
      "unresolved_contradiction",
      "stale_derived",
      "frequent_reference",
      "temporal_pattern",
      "shared_source",
    ];
    const ranks = types.map((t) => order.indexOf(t));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });

  it("identical input produces identical reflections", async () => {
    const { cells } = await fixture();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const catalog = catalogOf(cells);
    expect(harbor.reflectObserved(HUMAN, NOW, { catalog })).toEqual(
      harbor.reflectObserved(HUMAN, NOW, { catalog })
    );
  });

  it("observes unconfirmed derived status and temporal clustering", async () => {
    const { c, cells } = await fixture();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    harbor.epistemic.set(c.identity.id, {
      ...harbor.epistemic.get(c.identity.id)!,
      status: "INFERRED",
      confidence: 0.4,
    });
    const items = harbor.reflectObserved(HUMAN, NOW, { catalog: catalogOf(cells) });
    const stale = byType(items, "stale_derived");
    expect(stale.some((s) => s.observation.includes("INFERRED") && s.sourceMemoryIds.includes(c.identity.id))).toBe(
      true
    );
    const temporal = byType(items, "temporal_pattern");
    expect(temporal.some((t) => t.observation.includes("3 records share date"))).toBe(true);
  });

  it("survives restart/reopen and CLEAR → REBUILD", async () => {
    const { store, cells } = await fixture();
    const events = store.count();
    const dir = tmpPersist();
    const first = openHarbor(dir);
    first.rebuildFromCanonical(cells, HUMAN, NOW);
    const catalog = catalogOf(cells);
    const before = first.reflectObserved(HUMAN, NOW, { catalog });
    const reopened = openHarbor(dir);
    expect(reopened.reflectObserved(HUMAN, NOW, { catalog })).toEqual(before);
    first.clearDerived(HUMAN);
    first.rebuildFromCanonical(cells, HUMAN, NOW);
    expect(first.reflectObserved(HUMAN, NOW, { catalog }).map((i) => i.reflectionId)).toEqual(
      before.map((i) => i.reflectionId)
    );
    expect(store.count()).toBe(events);
  });

  it("is read-only: no EventStore write, no derived-index mutation, mutation of results is local", async () => {
    const { store, cells } = await fixture();
    const events = store.count();
    const dir = tmpPersist();
    const harbor = openHarbor(dir);
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const storedReflections = harbor.reflections.size;
    const fingerprint = harbor.currentFingerprint();
    const files = readdirSync(dir).sort();
    const raw = readFileSync(path.join(dir, "index.json"), "utf8");
    const items = harbor.reflectObserved(HUMAN, NOW, { catalog: catalogOf(cells) });
    expect(items.length).toBeGreaterThan(0);
    items[0]!.observation = "mutated";
    items[0]!.sourceMemoryIds.push("injected");
    expect(harbor.reflectObserved(HUMAN, NOW, { catalog: catalogOf(cells) })[0]!.observation).not.toBe("mutated");
    expect(store.count()).toBe(events);
    expect(harbor.reflections.size).toBe(storedReflections);
    expect(harbor.currentFingerprint()).toBe(fingerprint);
    expect(readdirSync(dir).sort()).toEqual(files);
    expect(readFileSync(path.join(dir, "index.json"), "utf8")).toBe(raw);
  });
});
