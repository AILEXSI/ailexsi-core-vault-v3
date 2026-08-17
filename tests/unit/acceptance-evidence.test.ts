/**
 * Phase 4.1 — evidence emission unit tests (no live PG, no EventStore).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const modUrl = pathToFileURL(
  path.join(process.cwd(), "scripts/acceptance-evidence.mjs")
).href;

// dynamic import ESM from scripts/
const {
  buildAcceptanceEvidence,
  writeAcceptanceEvidence,
  assertEvidenceShape,
  SCHEMA_VERSION,
  GENERATED_BY,
} = await import(modUrl);

describe("Phase 4.1 acceptance evidence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "ailexsi-ev-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const baseGates = [
    { name: "A", ok: true, detail: "ok" },
    { name: "LIVE SOFT", ok: true, detail: "" },
  ];

  it("EVIDENCE-01/02/03: builds artifact with testedSha and gates", () => {
    const payload = buildAcceptanceEvidence({
      status: "GREEN",
      exitCode: 0,
      testedSha: "a".repeat(40),
      originMainSha: "a".repeat(40),
      corePin: "652d01eb06dd0841c3b475023883675af6dcd698",
      vaultPin: "061e444389090c54e431b0e8243e82764f2c198e",
      livePostgres: true,
      desktopPath: true,
      gates: baseGates,
      softLiveNames: ["LIVE SOFT"],
      phase: "4",
      generatedAt: "2026-08-09T00:00:00.000Z",
      tag: "v2.2.0-retrieval-context-green",
    });
    assertEvidenceShape(payload);
    expect(payload.schemaVersion).toBe(SCHEMA_VERSION);
    expect(payload.testedSha).toBe("a".repeat(40));
    expect(payload.gates).toHaveLength(2);
    expect(payload.gates[0]!.ok).toBe(true);
    expect(payload.generatedBy).toBe(GENERATED_BY);
    expect(payload.auditOnly.generatedAt).toBe("2026-08-09T00:00:00.000Z");
  });

  it("EVIDENCE-04/05/06: env + pins", () => {
    const payload = buildAcceptanceEvidence({
      status: "GREEN",
      exitCode: 0,
      testedSha: "b".repeat(40),
      originMainSha: "b".repeat(40),
      corePin: "652d01eb06dd0841c3b475023883675af6dcd698",
      vaultPin: "061e444389090c54e431b0e8243e82764f2c198e",
      livePostgres: true,
      desktopPath: false,
      gates: [{ name: "X", ok: true }],
      softLiveNames: [],
      generatedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(payload.environment.livePostgres).toBe(true);
    expect(payload.environment.desktopPath).toBe(false);
    expect(payload.environment.platform).toBeTruthy();
    expect(payload.corePin).toMatch(/^652d01eb/);
    expect(payload.vaultPin).toMatch(/^061e444/);
  });

  it("EVIDENCE-07: non-zero exit cannot remain GREEN", () => {
    const payload = buildAcceptanceEvidence({
      status: "GREEN", // malicious / bug input
      exitCode: 2,
      testedSha: "c".repeat(40),
      originMainSha: "c".repeat(40),
      corePin: "core",
      vaultPin: "vault",
      livePostgres: false,
      desktopPath: false,
      gates: [{ name: "LIVE", ok: false, detail: "pending" }],
      softLiveNames: ["LIVE"],
      generatedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(payload.status).not.toBe("GREEN");
    expect(payload.exitCode).toBe(2);
    expect(() =>
      writeAcceptanceEvidence(tmp, {
        ...payload,
        status: "GREEN", // force illegal write
        exitCode: 2,
      })
    ).toThrow(/REFUSED|GREEN/);
  });

  it("writes GREEN only under evidence/runs with bare sha name", () => {
    const payload = buildAcceptanceEvidence({
      status: "GREEN",
      exitCode: 0,
      testedSha: "d".repeat(40),
      originMainSha: "d".repeat(40),
      corePin: "core",
      vaultPin: "vault",
      livePostgres: true,
      desktopPath: true,
      gates: [{ name: "G", ok: true }],
      softLiveNames: [],
      generatedAt: "2026-08-09T00:00:00.000Z",
    });
    const { path: out } = writeAcceptanceEvidence(tmp, payload);
    expect(out.includes(`${path.sep}evidence${path.sep}runs${path.sep}`)).toBe(
      true
    );
    expect(path.basename(out)).toBe(`${"d".repeat(40)}.acceptance.json`);
    const disk = JSON.parse(readFileSync(out, "utf8"));
    expect(disk.status).toBe("GREEN");
    expect(disk.testedSha).toBe("d".repeat(40));
  });

  it("pending/blocked get status-qualified filenames (not bare GREEN)", () => {
    const pending = buildAcceptanceEvidence({
      status: "VERIFICATION PENDING",
      exitCode: 2,
      testedSha: "e".repeat(40),
      originMainSha: "e".repeat(40),
      corePin: "core",
      vaultPin: "vault",
      livePostgres: false,
      desktopPath: false,
      gates: [{ name: "LIVE", ok: false }],
      softLiveNames: ["LIVE"],
      generatedAt: "2026-08-09T00:00:00.000Z",
    });
    const { path: p1 } = writeAcceptanceEvidence(tmp, pending);
    expect(path.basename(p1)).toContain("verification-pending");
    expect(path.basename(p1)).not.toBe(`${"e".repeat(40)}.acceptance.json`);

    const blocked = buildAcceptanceEvidence({
      status: "BLOCKED",
      exitCode: 1,
      testedSha: "f".repeat(40),
      originMainSha: "f".repeat(40),
      corePin: "core",
      vaultPin: "vault",
      livePostgres: false,
      desktopPath: false,
      gates: [{ name: "HARD", ok: false }],
      softLiveNames: [],
      generatedAt: "2026-08-09T00:00:00.000Z",
    });
    const { path: p2 } = writeAcceptanceEvidence(tmp, blocked);
    expect(path.basename(p2)).toContain("blocked");
  });

  it("EVIDENCE-09: identical inputs (fixed generatedAt) → equal payload except write", () => {
    const input = {
      status: "GREEN" as const,
      exitCode: 0,
      testedSha: "1".repeat(40),
      originMainSha: "1".repeat(40),
      corePin: "core",
      vaultPin: "vault",
      livePostgres: true,
      desktopPath: true,
      gates: [{ name: "G", ok: true, detail: "d" }],
      softLiveNames: [] as string[],
      generatedAt: "2026-01-01T00:00:00.000Z",
    };
    const a = buildAcceptanceEvidence(input);
    const b = buildAcceptanceEvidence(input);
    expect(a).toEqual(b);
  });

  it("EVIDENCE-08/10: path confined to evidence/runs (Windows-safe relative)", () => {
    const payload = buildAcceptanceEvidence({
      status: "GREEN",
      exitCode: 0,
      testedSha: "9".repeat(40),
      originMainSha: "9".repeat(40),
      corePin: "core",
      vaultPin: "vault",
      livePostgres: false,
      desktopPath: false,
      gates: [{ name: "G", ok: true }],
      softLiveNames: [],
      generatedAt: "2026-08-09T00:00:00.000Z",
    });
    const { path: out } = writeAcceptanceEvidence(tmp, payload);
    const rel = path.relative(path.join(tmp, "evidence", "runs"), out);
    expect(rel.startsWith("..")).toBe(false);
    expect(path.isAbsolute(rel)).toBe(false);
  });

  it("schema file exists in repo", () => {
    const schema = path.join(
      process.cwd(),
      "evidence/schema/acceptance-run.schema.json"
    );
    expect(existsSync(schema)).toBe(true);
    const j = JSON.parse(readFileSync(schema, "utf8"));
    expect(j.required).toContain("testedSha");
    expect(j.required).toContain("gates");
  });
});
