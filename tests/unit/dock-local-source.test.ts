/**
 * Local-directory dock — discover/preview/segment/candidate.
 * Not Memory. Not EventStore. Not a Grant.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import { bridgeCommandStatus } from "@ailexsi/v2-command-adapter";
import {
  candidatesFromSegments,
  discover,
  itemFromRelative,
  preview,
  segment,
} from "@ailexsi/v3-dock";

describe("Dock local source", () => {
  function fixtureDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dock-src-"));
    writeFileSync(path.join(dir, "note.md"), "# Title\n\nHello dock.\n\nSecond para.\n", "utf8");
    writeFileSync(path.join(dir, "plain.txt"), "alpha\n\nbeta\n", "utf8");
    writeFileSync(path.join(dir, "data.json"), JSON.stringify({ a: 1, b: 2 }, null, 2), "utf8");
    writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 255, 0]));
    return dir;
  }

  it("A: discover is deterministic by path+hash", async () => {
    const dir = fixtureDir();
    try {
      const first = await discover(dir);
      const second = await discover(dir);
      expect(first.source.type).toBe("LOCAL_DIRECTORY");
      expect(first.source.id).toBe(second.source.id);
      expect(first.items.map((i) => i.itemId)).toEqual(second.items.map((i) => i.itemId));
      expect(first.items.map((i) => i.locator).sort()).toEqual(["blob.bin", "data.json", "note.md", "plain.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("B: binary is metadata only", async () => {
    const dir = fixtureDir();
    try {
      const { items } = await discover(dir);
      const bin = items.find((i) => i.filename === "blob.bin")!;
      expect(bin.kind).toBe("binary");
      const text = await preview(dir, bin);
      expect(text).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("C: preview is bounded", async () => {
    const dir = fixtureDir();
    try {
      const { items } = await discover(dir);
      const txt = items.find((i) => i.filename === "plain.txt")!;
      const bounded = await preview(dir, txt, 3);
      expect(bounded).not.toBeNull();
      expect(bounded!.length).toBeLessThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("D: same input → same segments", async () => {
    const dir = fixtureDir();
    try {
      const { items } = await discover(dir);
      const md = items.find((i) => i.filename === "note.md")!;
      const text = (await preview(dir, md))!;
      const a = segment(md, text);
      const b = segment(md, text);
      expect(a.map((s) => s.segmentId)).toEqual(b.map((s) => s.segmentId));
      expect(a.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("E: candidates are UNCERTAIN / DERIVED", async () => {
    const dir = fixtureDir();
    try {
      const { items } = await discover(dir);
      const md = items.find((i) => i.filename === "note.md")!;
      const text = (await preview(dir, md))!;
      const cands = candidatesFromSegments(segment(md, text));
      expect(cands.length).toBeGreaterThan(0);
      expect(cands.every((c) => c.epistemicStatus === "UNCERTAIN")).toBe(true);
      expect(cands.every((c) => c.status === "DERIVED")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F: discover does not append EventStore", async () => {
    const store = new InMemoryEventStore();
    const dir = fixtureDir();
    try {
      expect(store.count()).toBe(0);
      await discover(dir);
      expect(store.count()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("G: provenance chain candidate → segment → item → source", async () => {
    const dir = fixtureDir();
    try {
      const { source, items } = await discover(dir);
      const md = items.find((i) => i.filename === "note.md")!;
      const segs = segment(md, (await preview(dir, md))!);
      const [c] = candidatesFromSegments(segs);
      expect(c!.sourceId).toBe(source.id);
      expect(c!.itemId).toBe(md.itemId);
      expect(c!.segmentId).toBe(segs[0]!.segmentId);
      expect(c!.provenance.sourceId).toBe(source.id);
      expect(c!.provenance.itemId).toBe(md.itemId);
      expect(c!.provenance.segmentId).toBe(c!.segmentId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("H: dock does not require or issue a Grant", async () => {
    const src = readFileSync(path.join(process.cwd(), "packages/dock/src/index.ts"), "utf8");
    const host = readFileSync(
      path.join(process.cwd(), "packages/command-adapter/src/desktop-host.ts"),
      "utf8"
    );
    expect(src).not.toMatch(/issueAuthorization|AuthorizationGrant|commitCanonical/);
    const dockBlock = host.slice(host.indexOf("dockStatus"), host.indexOf("sessionStatus"));
    expect(dockBlock).not.toMatch(/issueAuthorization|requireProvidedGrant|memoryCreate/);
  });

  it("I: path traversal fails", async () => {
    const dir = fixtureDir();
    try {
      await expect(itemFromRelative(dir, "../secret.txt")).rejects.toThrow(/traversal/i);
      await expect(itemFromRelative(dir, "..\\secret.txt")).rejects.toThrow(/traversal/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("J: no raw filesystem HTTP command", () => {
    const bridge = readFileSync(
      path.join(process.cwd(), "packages/command-adapter/src/desktop-bridge-server.ts"),
      "utf8"
    );
    expect(bridge).toMatch(/dock\.discover/);
    expect(bridge).not.toMatch(/filesystem\.read/);
    expect(bridgeCommandStatus("filesystem.read", { "x-channel-token": "x" })).toBe(401);
    const prev = process.env.DESKTOP_HOST_TOKEN;
    process.env.DESKTOP_HOST_TOKEN = "dock-tok";
    try {
      expect(
        bridgeCommandStatus("filesystem.read", { "x-channel-token": "dock-tok" })
      ).toBe(404);
      expect(bridgeCommandStatus("dock.discover", { "x-channel-token": "dock-tok" })).toBe(200);
      expect(bridgeCommandStatus("grant.create", { "x-channel-token": "dock-tok" })).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.DESKTOP_HOST_TOKEN;
      else process.env.DESKTOP_HOST_TOKEN = prev;
    }
  });
});
