import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  LineBuffer,
  parseVitestSummary,
  suiteStatusFromExit,
  parseAcceptanceOutput,
  overallFromSuites,
} from "../../scripts/live-verification-lib.mjs";

describe("live-verification parser", () => {
  it("strips ANSI sequences", () => {
    const raw = "\u001b[32mPASS\u001b[0m tests/foo.test.ts";
    expect(stripAnsi(raw)).toBe("PASS tests/foo.test.ts");
  });

  it("LineBuffer handles fragmented chunks", () => {
    const b = new LineBuffer();
    expect(b.push("hel")).toEqual([]);
    expect(b.push("lo\nwor")).toEqual(["hello"]);
    expect(b.push("ld\r\n")).toEqual(["world"]);
    expect(b.flush()).toEqual([]);
  });

  it("parses PASS Vitest output", () => {
    const text = `
 ✓ tests/a.test.ts (2 tests) 10ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  1.2s
`;
    const v = parseVitestSummary(text);
    expect(v.testFiles).toBe(1);
    expect(v.testsPassed).toBe(2);
    expect(suiteStatusFromExit(0, v)).toBe("PASS");
  });

  it("parses FAIL Vitest output", () => {
    const text = `
 FAIL  tests/a.test.ts
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
`;
    const v = parseVitestSummary(text);
    expect(v.filesFailed).toBe(1);
    expect(v.testsFailed).toBe(1);
    expect(suiteStatusFromExit(1, v)).toBe("FAIL");
  });

  it("non-zero exit is FAIL even if summary incomplete", () => {
    expect(suiteStatusFromExit(1, {})).toBe("FAIL");
  });

  it("exit 0 with testsFailed is FAIL", () => {
    expect(suiteStatusFromExit(0, { testsFailed: 2 })).toBe("FAIL");
  });

  it("parses acceptance GREEN", () => {
    const text = `
FINAL STATUS: GREEN
LIVE POSTGRES: yes
DESKTOP PATH: yes
QUERY GATE: PASS
CONTINUITY GATE: PASS
Failed gates: 0
PHASE 08 CODE PRESENT: NO
`;
    const a = parseAcceptanceOutput(text);
    expect(a.finalStatus).toBe("GREEN");
    expect(a.livePostgres).toBe(true);
    expect(a.desktopPath).toBe(true);
    expect(a.failedGates).toBe(0);
    expect(a.phase08Present).toBe(false);
    expect(a.gates["QUERY GATE"]).toBe("PASS");
  });

  it("parses acceptance VERIFICATION PENDING", () => {
    const text = `
FINAL STATUS: VERIFICATION PENDING
Failed gates: 2
CONTINUITY GATE: FAIL
`;
    const a = parseAcceptanceOutput(text);
    expect(a.finalStatus).toBe("VERIFICATION PENDING");
    expect(a.failedGates).toBe(2);
    expect(a.gates["CONTINUITY GATE"]).toBe("FAIL");
  });

  it("overallFromSuites: timeout never GREEN", () => {
    const suites = [
      { status: "PASS" },
      { status: "TIMEOUT" },
    ];
    expect(
      overallFromSuites(suites, { finalStatus: "GREEN" })
    ).toBe("VERIFICATION PENDING");
  });

  it("overallFromSuites: all pass + GREEN acceptance", () => {
    const suites = [
      { status: "PASS" },
      { status: "PASS" },
    ];
    expect(overallFromSuites(suites, { finalStatus: "GREEN" })).toBe("GREEN");
  });

  it("overallFromSuites: spawn error is FAIL", () => {
    expect(
      overallFromSuites([{ status: "SPAWN_ERROR" }], { finalStatus: "GREEN" })
    ).toBe("FAIL");
  });

  it("ANSI-colored Vitest still parses", () => {
    const text =
      "\u001b[32mTest Files\u001b[0m  \u001b[1m1 passed\u001b[0m (1)\n" +
      "     Tests  5 passed (5)\n";
    const v = parseVitestSummary(text);
    expect(v.testFiles).toBe(1);
    expect(v.testsPassed).toBe(5);
  });
});
