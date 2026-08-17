import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import {
  DerivedQueryService,
  FileDerivedIndex,
  HarborService,
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "harbor-query-"));
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
    provenance: provenance(),
    idempotencyKey: randomUUID(),
  });
  const b = await adapter.create({
    content: { type: "text", text: "user prefers coffee" },
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

describe("Derived query service", () => {
  it("looks up a derived memory by stable ID", async () => {
    const { store, a, cells } = await twoPrefMemories();
    const events = store.count();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const found = harbor.queries(HUMAN).getDerivedMemory(a.identity.id);
    expect(found?.id).toBe(a.identity.id);
    expect(found?.memoryId).toBe(a.identity.id);
    expect(found?.status).toBe("FACT");
    expect(found?.class).toBe("V3-DERIVED");
    expect(harbor.queries(HUMAN).getDerivedMemory("missing")).toBeNull();
    expect(store.count()).toBe(events);
  });

  it("lists derived memories in deterministic ID order", async () => {
    const { cells } = await twoPrefMemories();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const first = harbor.queries(HUMAN).listDerivedMemories();
    const second = harbor.queries(AI).listDerivedMemories();
    expect(first.items.map((i) => i.id)).toEqual([...first.items.map((i) => i.id)].sort());
    expect(first.items.map((i) => i.id)).toEqual(second.items.map((i) => i.id));
    expect(first.total).toBe(2);
    expect(first.truncated).toBe(false);
    expect(first.class).toBe("V3-DERIVED");
  });

  it("paginates listings deterministically", async () => {
    const { cells } = await twoPrefMemories();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const q = harbor.queries(HUMAN);
    const all = q.listDerivedMemories();
    const page1 = q.listDerivedMemories({ offset: 0, limit: 1 });
    const page2 = q.listDerivedMemories({ offset: 1, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page2.items).toHaveLength(1);
    expect(page1.items[0]!.id).toBe(all.items[0]!.id);
    expect(page2.items[0]!.id).toBe(all.items[1]!.id);
    expect(page1.total).toBe(2);
    expect(page1.truncated).toBe(true);
    expect(page2.truncated).toBe(false);
  });

  it("filters by epistemic status", async () => {
    const { a, cells } = await twoPrefMemories();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    harbor.epistemic.set(a.identity.id, {
      ...harbor.epistemic.get(a.identity.id)!,
      status: "INFERRED",
      confidence: 0.4,
      lastChangedAt: NOW,
      changedBy: AI,
    });
    const inferred = harbor.queries(HUMAN).findDerivedByStatus("INFERRED");
    const facts = harbor.queries(HUMAN).findDerivedByStatus("FACT");
    expect(inferred.items.map((i) => i.id)).toEqual([a.identity.id]);
    expect(facts.items.every((i) => i.status === "FACT")).toBe(true);
    expect(facts.items.map((i) => i.id)).not.toContain(a.identity.id);
  });

  it("finds derived records by canonical source memory", async () => {
    const { a, cells } = await twoPrefMemories();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const hits = harbor.queries(HUMAN).findDerivedBySource(a.identity.id);
    const kinds = hits.items.map((h) => h.kind);
    expect(kinds).toContain("epistemic");
    expect(kinds).toContain("contradiction");
    expect(kinds).toContain("reflection");
    expect(hits.items.every((h) => h.sourceMemoryIds.includes(a.identity.id))).toBe(true);
    const order = ["epistemic", "contradiction", "reflection", "proposal"];
    const ranks = hits.items.map((h) => order.indexOf(h.kind));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });

  it("queries contradictions without deciding them", async () => {
    const { store, a, cells } = await twoPrefMemories();
    const events = store.count();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const q = harbor.queries(HUMAN);
    const all = q.findContradictions();
    expect(all.total).toBe(1);
    expect(all.items[0]!.resolution).toBe("UNRESOLVED");
    expect(all.items[0]!.class).toBe("V3-DERIVED");
    const bySource = q.findContradictions({ sourceMemoryId: a.identity.id });
    expect(bySource.total).toBe(1);
    const none = q.findContradictions({ resolution: "CONFIRM_A" });
    expect(none.total).toBe(0);
    expect(store.count()).toBe(events);
  });

  it("returns provenance that still points at canonical sources", async () => {
    const { a, b, cells } = await twoPrefMemories();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const q = harbor.queries(HUMAN);
    const mem = q.getDerivedProvenance(a.identity.id);
    expect(mem?.kind).toBe("epistemic");
    expect(mem?.sourceMemoryIds).toEqual([a.identity.id]);
    const contradictionId = q.findContradictions().items[0]!.id;
    const contra = q.getDerivedProvenance(contradictionId);
    expect(contra?.kind).toBe("contradiction");
    expect(contra?.sourceMemoryIds.sort()).toEqual([a.identity.id, b.identity.id].sort());
    expect(contra?.provenance?.class).toBe("V3-DERIVED");
    const reflectionId = [...harbor.reflections.keys()][0]!;
    const reflection = q.getDerivedProvenance(reflectionId);
    expect(reflection?.kind).toBe("reflection");
    expect(reflection?.sourceMemoryIds.sort()).toEqual([a.identity.id, b.identity.id].sort());
    expect(q.getDerivedProvenance("missing")).toBeNull();
  });

  it("query results survive process restart from the durable index", async () => {
    const { cells } = await twoPrefMemories();
    const dir = tmpPersist();
    const first = openHarbor(dir);
    first.rebuildFromCanonical(cells, HUMAN, NOW);
    const before = first.queries(HUMAN).listDerivedMemories();
    const contraBefore = first.queries(HUMAN).findContradictions();

    const reopened = openHarbor(dir);
    const after = reopened.queries(HUMAN).listDerivedMemories();
    expect(after.items).toEqual(before.items);
    expect(reopened.queries(HUMAN).findContradictions().items.map((c) => c.id)).toEqual(
      contraBefore.items.map((c) => c.id)
    );

    const disk = DerivedQueryService.fromIndex(dir);
    expect(disk.listDerivedMemories().items).toEqual(before.items);
    expect(disk.status().status).toBe("ready");
  });

  it("CLEAR → REBUILD → QUERY is equivalent and leaves EventStore untouched", async () => {
    const { store, cells } = await twoPrefMemories();
    const events = store.count();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const before = {
      list: harbor.queries(HUMAN).listDerivedMemories(),
      contradictions: harbor.queries(HUMAN).findContradictions(),
      bySource: harbor.queries(HUMAN).findDerivedBySource(cells[0]!.identity.id),
    };
    harbor.clearDerived(HUMAN);
    expect(harbor.queries(HUMAN).listDerivedMemories().total).toBe(0);
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const after = {
      list: harbor.queries(HUMAN).listDerivedMemories(),
      contradictions: harbor.queries(HUMAN).findContradictions(),
      bySource: harbor.queries(HUMAN).findDerivedBySource(cells[0]!.identity.id),
    };
    expect(after.list.items).toEqual(before.list.items);
    expect(after.contradictions.items.map((c) => c.id)).toEqual(
      before.contradictions.items.map((c) => c.id)
    );
    expect(after.bySource.items).toEqual(before.bySource.items);
    expect(store.count()).toBe(events);
  });

  it("query operations are read-only and do not persist mutations of returned objects", async () => {
    const { store, a, cells } = await twoPrefMemories();
    const events = store.count();
    const dir = tmpPersist();
    const harbor = openHarbor(dir);
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const fingerprint = harbor.currentFingerprint();
    const raw = readFileSync(path.join(dir, "index.json"), "utf8");

    const q = harbor.queries(HUMAN);
    const view = q.getDerivedMemory(a.identity.id)!;
    view.status = "REJECTED";
    view.confidence = 0;
    const listed = q.listDerivedMemories();
    listed.items[0]!.status = "SUPERSEDED";
    const hit = q.findDerivedBySource(a.identity.id).items[0]!;
    hit.sourceMemoryIds.push("injected");

    expect(harbor.epistemic.get(a.identity.id)?.status).toBe("FACT");
    expect(harbor.currentFingerprint()).toBe(fingerprint);
    expect(store.count()).toBe(events);
    expect(readFileSync(path.join(dir, "index.json"), "utf8")).toBe(raw);
    expect(q.getDerivedMemory(a.identity.id)?.status).toBe("FACT");
    expect(typeof (q as unknown as { persistDerived?: unknown }).persistDerived).toBe("undefined");
    expect(typeof (q as unknown as { rebuildFromCanonical?: unknown }).rebuildFromCanonical).toBe(
      "undefined"
    );
    expect(existsSync(path.join(dir, "rebuilding.marker"))).toBe(false);
  });

  it("corrupt or mismatched index stays queryable as a known empty state until rebuild", async () => {
    const { store, cells } = await twoPrefMemories();
    const events = store.count();
    const dir = tmpPersist();
    const first = openHarbor(dir);
    first.rebuildFromCanonical(cells, HUMAN, NOW);
    writeFileSync(path.join(dir, "index.json"), "{not-json", "utf8");

    const disk = DerivedQueryService.fromIndex(dir);
    expect(disk.status().status).toBe("corrupt");
    expect(disk.listDerivedMemories().total).toBe(0);
    expect(disk.getDerivedMemory(cells[0]!.identity.id)).toBeNull();
    expect(store.count()).toBe(events);

    const recovered = openHarbor(dir);
    expect(recovered.queries(HUMAN).status().status).toBe("corrupt");
    recovered.rebuildFromCanonical(cells, HUMAN, NOW);
    expect(recovered.queries(HUMAN).listDerivedMemories().total).toBe(2);
    expect(store.count()).toBe(events);
  });

  it("schema mismatch and interrupted index remain rebuildable after query", async () => {
    const { store, cells } = await twoPrefMemories();
    const events = store.count();
    const dir = tmpPersist();
    const first = openHarbor(dir);
    first.rebuildFromCanonical(cells, HUMAN, NOW);
    const previous = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
    previous.schemaVersion = "harbor-derived-index-v0";
    writeFileSync(path.join(dir, "index.json"), JSON.stringify(previous), "utf8");

    const mismatch = DerivedQueryService.fromIndex(dir);
    expect(mismatch.status().status).toBe("schema_mismatch");
    expect(mismatch.listDerivedMemories().total).toBe(0);

    const harbor = openHarbor(dir);
    expect(harbor.queries(HUMAN).status().status).toBe("schema_mismatch");
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    expect(harbor.queries(HUMAN).status().status).toBe("ready");

    new FileDerivedIndex(dir).markRebuilding();
    const interrupted = DerivedQueryService.fromIndex(dir);
    expect(interrupted.status().status).toBe("interrupted");
    expect(interrupted.listDerivedMemories().total).toBe(2);
    expect(store.count()).toBe(events);
  });

  it("import pipeline remains derived-only and queryable after WRITE", async () => {
    const store = new InMemoryEventStore();
    const events = store.count();
    const src = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: VAULT_SHA });
    src.epistemic.set("m-tea", {
      memoryId: "m-tea",
      status: "INFERRED",
      confidence: 0.71,
      evidenceEventIds: [],
      lastChangedAt: "2026-08-17T12:00:00.000Z",
      changedBy: AI,
      note: "user prefers tea",
      class: "V3-DERIVED",
    });
    const pkg = src.exportPackage(["m-tea"], HUMAN);
    const dst = openHarbor(tmpPersist());
    const scanned = dst.beginImport(pkg, HUMAN);
    dst.validateImport(scanned.id, HUMAN);
    const previewed = dst.previewImport(scanned.id, HUMAN);
    expect(previewed.preview?.wouldWriteCanonical).toBe(false);
    dst.detectImportConflicts(scanned.id, [], HUMAN);
    expect(dst.queries(HUMAN).getDerivedMemory("m-tea")).toBeNull();
    dst.confirmImport(scanned.id, HUMAN);
    expect(dst.queries(HUMAN).getDerivedMemory("m-tea")?.status).toBe("INFERRED");
    expect(dst.queries(HUMAN).findDerivedByStatus("INFERRED").total).toBe(1);
    expect(store.count()).toBe(events);
  });
});
