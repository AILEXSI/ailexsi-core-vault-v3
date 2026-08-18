/**
 * Pure parsing helpers for live-verification orchestrator.
 * No process spawning — unit-testable on any OS.
 */

/** Strip ANSI CSI / OSC sequences for semantic matching. */
export function stripAnsi(text) {
  if (!text) return "";
  return String(text)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}

/**
 * Line buffer: fragments may split mid-line.
 */
export class LineBuffer {
  constructor() {
    this.partial = "";
  }
  /** @returns {string[]} complete lines (no trailing newline) */
  push(chunk) {
    const s = this.partial + String(chunk);
    const parts = s.split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    return parts;
  }
  flush() {
    if (!this.partial) return [];
    const last = this.partial;
    this.partial = "";
    return [last];
  }
}

/**
 * Parse Vitest-ish summary from normalized text.
 * @returns {{ testFiles?: number, testsPassed?: number, testsFailed?: number, filesFailed?: number }}
 */
export function parseVitestSummary(normalizedText) {
  const text = stripAnsi(normalizedText);
  const out = {};
  // Test Files  1 passed (1)  |  Test Files  1 failed | 1 passed (2)
  const filesPass = text.match(/Test Files\s+(\d+)\s+passed/i);
  const filesFail = text.match(/Test Files\s+(\d+)\s+failed/i);
  if (filesPass) out.testFiles = Number(filesPass[1]);
  if (filesFail) out.filesFailed = Number(filesFail[1]);
  // Tests  7 passed (7)
  const testsPass = text.match(/\bTests\s+(\d+)\s+passed/i);
  const testsFail = text.match(/\bTests\s+(\d+)\s+failed/i);
  if (testsPass) out.testsPassed = Number(testsPass[1]);
  if (testsFail) out.testsFailed = Number(testsFail[1]);
  // Duration  4.2s
  const dur = text.match(/Duration\s+([\d.]+)\s*s/i);
  if (dur) out.reportedDurationSec = Number(dur[1]);
  return out;
}

/**
 * Derive suite status from exit code + optional vitest parse.
 * TIMEOUT / SPAWN_ERROR are set by orchestrator, not here.
 */
export function suiteStatusFromExit(exitCode, vitest = {}) {
  if (exitCode === 0) {
    if ((vitest.testsFailed ?? 0) > 0 || (vitest.filesFailed ?? 0) > 0) {
      return "FAIL";
    }
    return "PASS";
  }
  if (exitCode == null) return "UNKNOWN";
  return "FAIL";
}

/**
 * Parse acceptance-gate.mjs console summary.
 */
export function parseAcceptanceOutput(normalizedText) {
  const text = stripAnsi(normalizedText);
  const result = {
    finalStatus: null,
    livePostgres: null,
    desktopPath: null,
    failedGates: null,
    phase08Present: null,
    gates: {},
  };

  const final =
    text.match(/FINAL STATUS:\s*(GREEN|VERIFICATION PENDING|FAIL|BLOCKED)/i) ||
    text.match(/FINAL STATUS:\s*([A-Z _]+)/i);
  if (final) {
    result.finalStatus = final[1].trim().toUpperCase().replace(/\s+/g, " ");
  }

  const live = text.match(/LIVE POSTGRES:\s*(yes|no|true|false)/i);
  if (live) result.livePostgres = /yes|true/i.test(live[1]);

  const desk = text.match(/DESKTOP PATH:\s*(yes|no|true|false)/i);
  if (desk) result.desktopPath = /yes|true/i.test(desk[1]);

  const failed = text.match(/Failed gates:\s*(\d+)/i);
  if (failed) result.failedGates = Number(failed[1]);

  const p08 = text.match(/PHASE 08 CODE PRESENT:\s*(YES|NO)/i);
  if (p08) result.phase08Present = p08[1].toUpperCase() === "YES";

  const gateNames = [
    "QUERY GATE",
    "DESKTOP E2E GATE",
    "RETRIEVAL GATE",
    "CONTINUITY GATE",
    "CULTIVATION GATE",
    "DESKTOP CO-CREATION GATE",
    "READ MODEL GATE",
    "REPLAY GATE",
    "MEMORY FOUNDATION",
  ];
  for (const name of gateNames) {
    const re = new RegExp(
      name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":\\s*(PASS|FAIL|PENDING)",
      "i"
    );
    const m = text.match(re);
    if (m) result.gates[name] = m[1].toUpperCase();
  }

  return result;
}

export function overallFromSuites(suites, acceptanceParsed) {
  const anyTimeout = suites.some((s) => s.status === "TIMEOUT");
  const anySpawn = suites.some((s) => s.status === "SPAWN_ERROR");
  const anyFail = suites.some((s) => s.status === "FAIL");
  if (anySpawn) return "FAIL";
  if (anyTimeout || anyFail) return "VERIFICATION PENDING";
  if (acceptanceParsed?.finalStatus === "GREEN") return "GREEN";
  if (acceptanceParsed?.finalStatus === "VERIFICATION PENDING") {
    return "VERIFICATION PENDING";
  }
  if (acceptanceParsed?.finalStatus === "FAIL" || acceptanceParsed?.finalStatus === "BLOCKED") {
    return "FAIL";
  }
  // All npm suites passed but acceptance ambiguous
  return "VERIFICATION PENDING";
}

export const DEFAULT_SUITE_ORDER = [
  "test:dcs",
  "test:foundation",
  "test:query",
  "test:desktop-e2e",
  "test:retrieval",
  "test:continuity",
  "test:cultivation",
  "test:integrity",
  "test:connectome",
  "acceptance",
];
