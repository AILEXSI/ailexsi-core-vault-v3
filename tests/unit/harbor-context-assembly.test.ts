import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import {
  CONTEXT_PACKAGE_SCHEMA,
  DerivedQueryService,
  HarborService,
  assembleContextFromQuery,
  type ContextMemory,
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "harbor-ctx-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function twoPrefMemories() {
  const store = new InMemoryEventStore();
  const adapter = new MemoryCommandAdapter({ store, environment: "test" });
  const a = await adapter.create({
    content: { type: "text", text: "user prefers tea" },
    context: { project: "kitchen", tags: ["drink"] },
    provenance: provenance(),
    idempotencyKey: randomUUID(),
  });
  const b = await adapter.create({
    content: { type: "text", text: "user prefers coffee" },
    context: { project: "office", tags: ["drink"] },
    provenance: provenance(),
    idempotencyKey: randomUUID(),
  });
  return { store, adapter, a, b, cells: [a, b] };
}

function openHarbor(persistDir: string) {
  return HarborService.open({
    corePin: CORE_PIN,
    vaultReferenceSha: VAULT_SHA,
    persistDir,
  });
}

function catalogOf(cells: Array<{ identity: { id: string }; content: { type: string; text?: string }; context: { project?: string; tags?: string[] }; timestamps: { confirmedAt?: string }; lifecycle: { state: string } }>): ContextMemory[] {
  return cells.map((m) => ({
    id: m.identity.id,
    text: m.content.type === "text" ? (m.content.text ?? "") : "",
    project: m.context.project,
    tags: m.context.tags ?? [],
    updatedAt: m.timestamps.confirmedAt,
    lifecycle: m.lifecycle.state,
  }));
}

const LIMITS = { maxItems: 10, maxChars: 8000 };

describe("Deterministic context assembly", () => {
  it("selects explicit memory IDs with inspectable inclusion reasons", async () => {
    const { store, a, b, cells } = await twoPrefMemories();
    const events = store.count();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const pack = harbor.assembleFromDerived(
      { selectedMemoryIds: [a.identity.id], ...LIMITS },
      HUMAN,
      NOW,
      catalogOf(cells)
    );
    expect(pack.schemaVersion).toBe(CONTEXT_PACKAGE_SCHEMA);
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0]!.memoryId).toBe(a.identity.id);
    expect(pack.items[0]!.reason).toBe("selected");
    expect(pack.items[0]!.reasonDetail).toBeTruthy();
    expect(pack.items.map((i) => i.memoryId)).not.toContain(b.identity.id);
    expect(store.count()).toBe(events);
  });

  it("selects via source-memory lookup on the query service", async () => {
    const { a, cells } = await twoPrefMemories();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const pack = harbor.assembleFromDerived(
      { sourceMemoryIds: [a.identity.id], ...LIMITS },
      HUMAN,
      NOW,
      catalogOf(cells)
    );
    expect(pack.items.some((i) => i.memoryId === a.identity.id)).toBe(true);
    expect(pack.items.find((i) => i.memoryId === a.identity.id)?.reason).toBe("source_match");
    expect(pack.sourceMemoryIds).toContain(a.identity.id);
  });

  it("applies project and status filters", async () => {
    const { a, b, cells } = await twoPrefMemories();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const byProject = harbor.assembleFromDerived(
      { projects: ["kitchen"], ...LIMITS },
      HUMAN,
      NOW,
      catalogOf(cells)
    );
    expect(byProject.items.map((i) => i.memoryId)).toEqual([a.identity.id]);
    expect(byProject.items[0]!.reason).toBe("project_match");
    expect(byProject.constraints.projects).toEqual(["kitchen"]);
    expect(byProject.exclusions.some((e) => e.memoryId === b.identity.id)).toBe(false);

    harbor.epistemic.set(a.identity.id, {
      ...harbor.epistemic.get(a.identity.id)!,
      status: "INFERRED",
      confidence: 0.4,
    });
    const byStatus = harbor.assembleFromDerived(
      { statuses: ["INFERRED"], ...LIMITS },
      HUMAN,
      NOW,
      catalogOf(cells)
    );
    expect(byStatus.items.map((i) => i.memoryId)).toEqual([a.identity.id]);
    expect(byStatus.items[0]!.reason).toBe("status_match");
    expect(byStatus.items[0]!.epistemicStatus).toBe("INFERRED");
  });

  it("applies temporal constraints and records exclusions", async () => {
    const { a, b, cells } = await twoPrefMemories();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const catalog = catalogOf(cells).map((m) =>
      m.id === a.identity.id
        ? { ...m, updatedAt: "2026-01-01T00:00:00.000Z" }
        : { ...m, updatedAt: "2026-08-01T00:00:00.000Z" }
    );
    const pack = harbor.assembleFromDerived(
      {
        selectedMemoryIds: [a.identity.id, b.identity.id],
        temporal: { from: "2026-06-01T00:00:00.000Z" },
        ...LIMITS,
      },
      HUMAN,
      NOW,
      catalog
    );
    expect(pack.items.map((i) => i.memoryId)).toEqual([b.identity.id]);
    expect(pack.exclusions.some((e) => e.memoryId === a.identity.id && /temporal/.test(e.reason))).toBe(
      true
    );
    expect(pack.constraints.temporal?.from).toBe("2026-06-01T00:00:00.000Z");
  });

  it("orders deterministically and respects maxItems", async () => {
    const { a, b, cells } = await twoPrefMemories();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const pack = harbor.assembleFromDerived(
      { selectedMemoryIds: [b.identity.id, a.identity.id], maxItems: 1, maxChars: 8000 },
      HUMAN,
      NOW,
      catalogOf(cells)
    );
    expect(pack.items).toHaveLength(1);
    expect(pack.budget.truncated).toBe(true);
    expect(pack.exclusions.some((e) => e.reason === "context budget")).toBe(true);
    const again = harbor.assembleFromDerived(
      { selectedMemoryIds: [a.identity.id, b.identity.id], maxItems: 1, maxChars: 8000 },
      HUMAN,
      NOW,
      catalogOf(cells)
    );
    expect(again.items.map((i) => i.memoryId)).toEqual(pack.items.map((i) => i.memoryId));
  });

  it("preserves provenance and unresolved contradictions", async () => {
    const { a, b, cells } = await twoPrefMemories();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const pack = harbor.assembleFromDerived(
      { selectedMemoryIds: [a.identity.id], ...LIMITS },
      HUMAN,
      NOW,
      catalogOf(cells)
    );
    expect(pack.contradictions).toHaveLength(1);
    expect(pack.contradictions[0]!.resolution).toBe("UNRESOLVED");
    expect(pack.items[0]!.sourceMemoryIds).toContain(a.identity.id);
    expect(pack.items[0]!.provenance?.sourceMemoryIds).toContain(a.identity.id);
    expect(pack.items[0]!.relationships).toEqual([pack.contradictions[0]!.id]);
    expect(pack.contradictions[0]!.memoryIdA === b.identity.id || pack.contradictions[0]!.memoryIdB === b.identity.id).toBe(
      true
    );
  });

  it("identical input produces an identical ContextPackage", async () => {
    const { cells } = await twoPrefMemories();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const request = { query: "prefers", selectedMemoryIds: [cells[0]!.identity.id], ...LIMITS };
    const first = harbor.assemble(cells, request, HUMAN, NOW);
    const second = harbor.assemble(cells, request, HUMAN, NOW);
    expect(first.packageId).toBe(second.packageId);
    expect(first.reproducibleKey).toBe(second.reproducibleKey);
    expect(first.items).toEqual(second.items);
    expect(first.exclusions).toEqual(second.exclusions);
    expect(first.contradictions.map((c) => c.id)).toEqual(second.contradictions.map((c) => c.id));
    expect(first).toEqual(second);
  });

  it("survives restart/reopen of the durable derived index", async () => {
    const { cells } = await twoPrefMemories();
    const dir = tmpPersist();
    const first = openHarbor(dir);
    first.rebuildFromCanonical(cells, HUMAN, NOW);
    const request = { selectedMemoryIds: cells.map((c) => c.identity.id), ...LIMITS };
    const before = first.assembleFromDerived(request, HUMAN, NOW, catalogOf(cells));

    const reopened = openHarbor(dir);
    const after = reopened.assembleFromDerived(request, HUMAN, NOW, catalogOf(cells));
    expect(after.packageId).toBe(before.packageId);
    expect(after.items).toEqual(before.items);

    const disk = assembleContextFromQuery({
      query: DerivedQueryService.fromIndex(dir),
      request,
      catalog: catalogOf(cells),
      now: NOW,
    });
    expect(disk.packageId).toBe(before.packageId);
  });

  it("CLEAR → REBUILD → identical context result without touching EventStore", async () => {
    const { store, cells } = await twoPrefMemories();
    const events = store.count();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const request = { query: "prefers", ...LIMITS };
    const before = harbor.assemble(cells, request, HUMAN, NOW);
    harbor.clearDerived(HUMAN);
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const after = harbor.assemble(cells, request, HUMAN, NOW);
    expect(after.packageId).toBe(before.packageId);
    expect(after.items.map((i) => i.memoryId)).toEqual(before.items.map((i) => i.memoryId));
    expect(after.contradictions.map((c) => c.id)).toEqual(before.contradictions.map((c) => c.id));
    expect(store.count()).toBe(events);
  });

  it("is read-only: does not persist the package or mutate EventStore/index", async () => {
    const { store, cells } = await twoPrefMemories();
    const events = store.count();
    const dir = tmpPersist();
    const harbor = openHarbor(dir);
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const beforeFiles = readdirSync(dir).sort();
    const raw = readFileSync(path.join(dir, "index.json"), "utf8");
    const fingerprint = harbor.currentFingerprint();
    const pack = harbor.assembleFromDerived(
      { selectedMemoryIds: [cells[0]!.identity.id], ...LIMITS },
      HUMAN,
      NOW,
      catalogOf(cells)
    );
    pack.items[0]!.reasonDetail = "mutated";
    pack.contradictions[0]!.resolution = "CONFIRM_A";
    expect(store.count()).toBe(events);
    expect(harbor.currentFingerprint()).toBe(fingerprint);
    expect(harbor.contradictions.get(pack.contradictions[0]!.id)?.resolution).toBe("UNRESOLVED");
    expect(readdirSync(dir).sort()).toEqual(beforeFiles);
    expect(readFileSync(path.join(dir, "index.json"), "utf8")).toBe(raw);
  });
});
