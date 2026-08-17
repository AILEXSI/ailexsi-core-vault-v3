import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import {
  DERIVED_INDEX_SCHEMA,
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "harbor-derived-"));
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

describe("Durable rebuildable derived index", () => {
  it("persists derived state across restart/reopen", async () => {
    const { store, cells } = await twoPrefMemories();
    const events = store.count();
    const dir = tmpPersist();
    const first = openHarbor(dir);
    first.rebuildFromCanonical(cells, HUMAN, NOW);
    const fingerprint = first.currentFingerprint();
    expect(first.derivedIndexInfo().status).toBe("ready");
    expect(existsSync(path.join(dir, "index.json"))).toBe(true);

    const reopened = openHarbor(dir);
    expect(reopened.derivedIndexInfo().status).toBe("ready");
    expect(reopened.currentFingerprint()).toBe(fingerprint);
    expect([...reopened.epistemic.keys()].sort()).toEqual([...first.epistemic.keys()].sort());
    expect([...reopened.contradictions.keys()].sort()).toEqual(
      [...first.contradictions.keys()].sort()
    );
    expect([...reopened.reflections.keys()].sort()).toEqual([...first.reflections.keys()].sort());
    expect(store.count()).toBe(events);
  });

  it("CLEAR DERIVED → REPLAY CANONICAL → REBUILD is deterministic", async () => {
    const { store, cells } = await twoPrefMemories();
    const events = store.count();
    const dir = tmpPersist();
    const harbor = openHarbor(dir);
    const first = harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    const ids = {
      contradictions: [...harbor.contradictions.keys()].sort(),
      reflections: [...harbor.reflections.keys()].sort(),
      epistemic: [...harbor.epistemic.keys()].sort(),
    };
    harbor.clearDerived(HUMAN);
    expect(harbor.epistemic.size).toBe(0);
    expect(harbor.derivedIndexInfo().status).toBe("empty");
    expect(existsSync(path.join(dir, "index.json"))).toBe(false);
    expect(store.count()).toBe(events);

    const second = harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect([...harbor.contradictions.keys()].sort()).toEqual(ids.contradictions);
    expect([...harbor.reflections.keys()].sort()).toEqual(ids.reflections);
    expect([...harbor.epistemic.keys()].sort()).toEqual(ids.epistemic);
    expect(store.count()).toBe(events);
  });

  it("two independent rebuilds produce identical fingerprints and stable IDs", async () => {
    const { cells } = await twoPrefMemories();
    const a = openHarbor(tmpPersist());
    const b = openHarbor(tmpPersist());
    const r1 = a.rebuildFromCanonical(cells, HUMAN, NOW);
    const r2 = b.rebuildFromCanonical(cells, HUMAN, NOW);
    expect(r1.fingerprint).toBe(r2.fingerprint);
    expect([...a.contradictions.keys()].sort()).toEqual([...b.contradictions.keys()].sort());
    expect([...a.reflections.keys()].sort()).toEqual([...b.reflections.keys()].sort());
    const reflectionId = [...a.reflections.keys()][0];
    expect(reflectionId).toMatch(/^rebuild:/);
    expect(reflectionId).toBe([...b.reflections.keys()][0]);
  });

  it("preserves provenance pointing at canonical sources", async () => {
    const { a, b, cells } = await twoPrefMemories();
    const harbor = openHarbor(tmpPersist());
    harbor.rebuildFromCanonical(cells, HUMAN, NOW);
    for (const rec of harbor.epistemic.values()) {
      expect([a.identity.id, b.identity.id]).toContain(rec.memoryId);
      expect(rec.class).toBe("V3-DERIVED");
    }
    for (const rec of harbor.contradictions.values()) {
      expect(rec.provenance.sourceMemoryIds.sort()).toEqual(
        [a.identity.id, b.identity.id].sort()
      );
      expect(rec.provenance.class).toBe("V3-DERIVED");
      expect(rec.provenance.derivationType).toBe("contradict");
    }
    for (const rec of harbor.reflections.values()) {
      expect(rec.provenance.sourceMemoryIds.sort()).toEqual(
        [a.identity.id, b.identity.id].sort()
      );
      expect(rec.provenance.derivationType).toBe("reflect");
      expect(rec.class).toBe("V3-DERIVED");
    }
  });

  it("missing derived index rebuilds without touching EventStore", async () => {
    const { store, cells } = await twoPrefMemories();
    const events = store.count();
    const dir = tmpPersist();
    const first = openHarbor(dir);
    const rebuilt = first.rebuildFromCanonical(cells, HUMAN, NOW);
    unlinkSync(path.join(dir, "index.json"));
    const missing = openHarbor(dir);
    expect(missing.derivedIndexInfo().status).toBe("empty");
    expect(missing.epistemic.size).toBe(0);
    const again = missing.rebuildFromCanonical(cells, HUMAN, NOW);
    expect(again.fingerprint).toBe(rebuilt.fingerprint);
    expect(store.count()).toBe(events);
  });

  it("corrupted derived index is a known state and rebuilds without touching EventStore", async () => {
    const { store, cells } = await twoPrefMemories();
    const events = store.count();
    const dir = tmpPersist();
    const first = openHarbor(dir);
    const rebuilt = first.rebuildFromCanonical(cells, HUMAN, NOW);
    writeFileSync(path.join(dir, "index.json"), "{not-json", "utf8");
    const corrupt = openHarbor(dir);
    expect(corrupt.derivedIndexInfo().status).toBe("corrupt");
    expect(corrupt.epistemic.size).toBe(0);
    expect(existsSync(path.join(dir, "index.json"))).toBe(true);
    expect(store.count()).toBe(events);
    const again = corrupt.rebuildFromCanonical(cells, HUMAN, NOW);
    expect(again.fingerprint).toBe(rebuilt.fingerprint);
    expect(corrupt.derivedIndexInfo().status).toBe("ready");
    expect(store.count()).toBe(events);
    const parsed = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
    expect(parsed.schemaVersion).toBe(DERIVED_INDEX_SCHEMA);
  });

  it("schema mismatch refuses ready, keeps the file, rebuilds to current schema", async () => {
    const { store, cells } = await twoPrefMemories();
    const events = store.count();
    const dir = tmpPersist();
    const first = openHarbor(dir);
    first.rebuildFromCanonical(cells, HUMAN, NOW);
    const previous = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
    previous.schemaVersion = "harbor-derived-index-v0";
    writeFileSync(path.join(dir, "index.json"), JSON.stringify(previous, null, 2), "utf8");

    const mismatch = openHarbor(dir);
    expect(mismatch.derivedIndexInfo().status).toBe("schema_mismatch");
    expect(mismatch.epistemic.size).toBe(0);
    const kept = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
    expect(kept.schemaVersion).toBe("harbor-derived-index-v0");
    expect(store.count()).toBe(events);

    mismatch.rebuildFromCanonical(cells, HUMAN, NOW);
    expect(mismatch.derivedIndexInfo().status).toBe("ready");
    const current = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
    expect(current.schemaVersion).toBe(DERIVED_INDEX_SCHEMA);
    expect(store.count()).toBe(events);
  });

  it("interrupted rebuild retains last ready snapshot and finishes deterministically", async () => {
    const { store, cells } = await twoPrefMemories();
    const events = store.count();
    const dir = tmpPersist();
    const first = openHarbor(dir);
    const rebuilt = first.rebuildFromCanonical(cells, HUMAN, NOW);
    const index = new FileDerivedIndex(dir);
    index.markRebuilding();
    expect(existsSync(path.join(dir, "rebuilding.marker"))).toBe(true);

    const interrupted = openHarbor(dir);
    expect(interrupted.derivedIndexInfo().status).toBe("interrupted");
    expect(interrupted.currentFingerprint()).toBe(rebuilt.fingerprint);
    expect(interrupted.epistemic.size).toBe(first.epistemic.size);
    expect(store.count()).toBe(events);

    const finished = interrupted.rebuildFromCanonical(cells, HUMAN, NOW);
    expect(finished.fingerprint).toBe(rebuilt.fingerprint);
    expect(interrupted.derivedIndexInfo().status).toBe("ready");
    expect(existsSync(path.join(dir, "rebuilding.marker"))).toBe(false);
    expect(store.count()).toBe(events);
  });

  it("interrupted rebuild without a snapshot is a known empty state", async () => {
    const { store, cells } = await twoPrefMemories();
    const events = store.count();
    const dir = tmpPersist();
    const index = new FileDerivedIndex(dir);
    index.markRebuilding();
    const opened = openHarbor(dir);
    expect(opened.derivedIndexInfo().status).toBe("interrupted");
    expect(opened.epistemic.size).toBe(0);
    opened.rebuildFromCanonical(cells, HUMAN, NOW);
    expect(opened.derivedIndexInfo().status).toBe("ready");
    expect(store.count()).toBe(events);
  });

  it("import remains derived-only and persists without EventStore writes", async () => {
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

    const dir = tmpPersist();
    const dst = openHarbor(dir);
    const scanned = dst.beginImport(pkg, HUMAN);
    expect(scanned.stage).toBe("SCANNED");
    dst.validateImport(scanned.id, HUMAN);
    const previewed = dst.previewImport(scanned.id, HUMAN);
    expect(previewed.preview?.wouldWriteCanonical).toBe(false);
    dst.detectImportConflicts(scanned.id, [], HUMAN);
    expect(() => dst.confirmImport(scanned.id, AI)).toThrow(/human/i);
    expect(dst.epistemic.size).toBe(0);
    const applied = dst.confirmImport(scanned.id, HUMAN);
    expect(applied.stage).toBe("APPLIED");
    expect(dst.epistemic.get("m-tea")?.status).toBe("INFERRED");
    expect(store.count()).toBe(events);

    const reopened = openHarbor(dir);
    expect(reopened.epistemic.get("m-tea")?.status).toBe("INFERRED");
    expect(reopened.epistemic.get("m-tea")?.memoryId).toBe("m-tea");
    expect(store.count()).toBe(events);
  });

  it("derived index document is never classed as canonical", async () => {
    const { cells } = await twoPrefMemories();
    const dir = tmpPersist();
    openHarbor(dir).rebuildFromCanonical(cells, HUMAN, NOW);
    const doc = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
    expect(doc.class).toBe("V3-DERIVED");
    expect(doc.kind).toBe("derived-index");
    expect(doc.schemaVersion).toBe(DERIVED_INDEX_SCHEMA);
    expect(doc.corePin).toBe(CORE_PIN);
    expect(doc).not.toHaveProperty("eventStore");
  });
});
