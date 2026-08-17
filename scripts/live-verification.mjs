/**
 * AILEXSI Core Vault V3 — Live verification orchestrator (Windows-safe).
 *
 * One command: npm run verify:live
 *
 * Spawns existing npm scripts (does NOT reimplement tests/acceptance).
 * Captures stdout/stderr live, parses Vitest + acceptance summaries,
 * writes evidence/runs/<sha>.live-verification.json
 *
 * Failure policy: continue remaining suites after a failure (diagnostic),
 * but overall status is never GREEN if any suite failed/timed out.
 */

import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  stripAnsi,
  LineBuffer,
  parseVitestSummary,
  suiteStatusFromExit,
  parseAcceptanceOutput,
  overallFromSuites,
  DEFAULT_SUITE_ORDER,
} from "./live-verification-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const DEFAULT_TIMEOUT_MS = Number(process.env.LIVE_VERIFY_TIMEOUT_MS || 20 * 60 * 1000);
const ACCEPTANCE_TIMEOUT_MS = Number(
  process.env.LIVE_VERIFY_ACCEPTANCE_TIMEOUT_MS || 45 * 60 * 1000
);

function runGit(args) {
  try {
    return execSync(`git ${args}`, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch (e) {
    return `(git error: ${e.message})`;
  }
}

function npmVersion() {
  try {
    return execSync("npm -v", {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Spawn npm run <script> with live stream capture.
 */
function runNpmScript(script, { timeoutMs, index, total }) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode = null;
    let signal = null;
    let timedOut = false;
    let spawnError = null;

    const label = `[${index}/${total}]`;
    console.log(`${label} START ${script}`);
    console.log(`${label} RUNNING...`);

    const child = spawn("npm", ["run", script], {
      cwd: ROOT,
      env: process.env,
      shell: true,
      windowsHide: true,
    });

    const outBuf = new LineBuffer();
    const errBuf = new LineBuffer();

    const onLine = (line, stream) => {
      // Concise live visibility: pass through notable lines only
      const n = stripAnsi(line);
      if (
        /PASS |FAIL |Test Files|Tests\s+\d|FINAL STATUS|Duration |✓|×|FAIL\s+tests\//.test(
          n
        )
      ) {
        console.log(n);
      }
    };

    child.stdout?.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      stdout += s;
      for (const line of outBuf.push(s)) onLine(line, "out");
    });
    child.stderr?.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      stderr += s;
      for (const line of errBuf.push(s)) {
        // still show stderr highlights
        const n = stripAnsi(line);
        if (/error|FAIL|FATAL|EBUSY|ECONN|timeout/i.test(n)) {
          console.log(`[stderr] ${n}`);
        }
      }
    });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        // Windows fallback
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 3000);
      }, timeoutMs);
    }

    child.on("error", (err) => {
      spawnError = err;
    });

    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      for (const line of outBuf.flush()) onLine(line, "out");
      for (const line of errBuf.flush()) {
        /* keep buffered */
      }
      exitCode = code;
      signal = sig;
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - t0;
      const combined = stdout + "\n" + stderr;
      const vitest = parseVitestSummary(combined);
      let status;
      if (spawnError) status = "SPAWN_ERROR";
      else if (timedOut) status = "TIMEOUT";
      else status = suiteStatusFromExit(exitCode, vitest);

      console.log(
        `${label} COMPLETE ${status}` +
          (vitest.testsPassed != null
            ? ` tests=${vitest.testsPassed}${vitest.testsFailed != null ? ` failed=${vitest.testsFailed}` : ""}`
            : "") +
          ` exit=${exitCode} ${durationMs}ms`
      );

      resolve({
        name: script,
        status,
        exitCode,
        signal,
        timedOut,
        spawnError: spawnError ? String(spawnError.message || spawnError) : null,
        startedAt,
        finishedAt,
        durationMs,
        testFiles: vitest.testFiles ?? null,
        testsPassed: vitest.testsPassed ?? null,
        testsFailed: vitest.testsFailed ?? null,
        filesFailed: vitest.filesFailed ?? null,
        stdout,
        stderr,
      });
    });
  });
}

async function main() {
  process.chdir(ROOT);
  const startedAt = new Date().toISOString();
  const testedSha = runGit("rev-parse HEAD");
  const originMain = runGit("rev-parse origin/main");
  const worktree = runGit("status --short");

  console.log("========================================");
  console.log("AILEXSI LIVE VERIFICATION");
  console.log("========================================");
  console.log(`HEAD:         ${testedSha}`);
  console.log(`ORIGIN/MAIN:  ${originMain}`);
  console.log(`WORKTREE:     ${worktree || "(clean)"}`);
  console.log(`NODE:         ${process.version}`);
  console.log(`NPM:          ${npmVersion()}`);
  console.log(`PLATFORM:     ${process.platform}`);
  console.log(`FAILURE POLICY: continue remaining suites; overall never GREEN if any fail/timeout`);
  console.log("========================================");

  if (testedSha !== originMain && !String(originMain).startsWith("(git error")) {
    console.warn(
      "WARNING: HEAD != origin/main. Not auto-pulling. Overall cannot be GREEN until aligned."
    );
  }

  const suites = [];
  const order = DEFAULT_SUITE_ORDER;
  for (let i = 0; i < order.length; i++) {
    const script = order[i];
    const timeoutMs =
      script === "acceptance" ? ACCEPTANCE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const result = await runNpmScript(script, {
      timeoutMs,
      index: i + 1,
      total: order.length,
    });
    suites.push(result);
    // Continue after failure (diagnostic collection). Documented policy.
  }

  const acceptanceSuite = suites.find((s) => s.name === "acceptance");
  const acceptanceParsed = acceptanceSuite
    ? parseAcceptanceOutput(acceptanceSuite.stdout + "\n" + acceptanceSuite.stderr)
    : { finalStatus: null };

  let overall = overallFromSuites(suites, acceptanceParsed);
  if (testedSha !== originMain && overall === "GREEN") {
    overall = "VERIFICATION PENDING";
  }

  const finishedAt = new Date().toISOString();
  const evidence = {
    schemaVersion: 1,
    repository: "AILEXSI/ailexsi-core-vault-v3",
    testedSha,
    originMainSha: originMain,
    worktreeShort: worktree,
    startedAt,
    finishedAt,
    platform: {
      os: process.platform,
      arch: process.arch,
      shell: process.platform === "win32" ? "PowerShell-compatible (npm shell:true)" : process.env.SHELL || "sh",
      node: process.version,
      npm: npmVersion(),
    },
    failurePolicy:
      "continue-after-failure; overall GREEN only if all suites PASS and acceptance GREEN and HEAD==origin/main",
    suites: suites.map((s) => ({
      name: s.name,
      status: s.status,
      exitCode: s.exitCode,
      signal: s.signal,
      timedOut: s.timedOut,
      spawnError: s.spawnError,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      durationMs: s.durationMs,
      testFiles: s.testFiles,
      testsPassed: s.testsPassed,
      testsFailed: s.testsFailed,
      filesFailed: s.filesFailed,
      stdout: s.stdout,
      stderr: s.stderr,
    })),
    acceptance: {
      finalStatus: acceptanceParsed.finalStatus,
      livePostgres: acceptanceParsed.livePostgres,
      desktopPath: acceptanceParsed.desktopPath,
      failedGates: acceptanceParsed.failedGates,
      phase08Present: acceptanceParsed.phase08Present,
      gates: acceptanceParsed.gates,
      rawOutput: acceptanceSuite
        ? acceptanceSuite.stdout + "\n" + acceptanceSuite.stderr
        : "",
    },
    overallStatus: overall,
  };

  const runsDir = join(ROOT, "evidence", "runs");
  mkdirSync(runsDir, { recursive: true });
  const evidencePath = join(runsDir, `${testedSha}.live-verification.json`);
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");

  console.log("");
  console.log("========================================");
  console.log("AILEXSI LIVE VERIFICATION — SUMMARY");
  console.log("========================================");
  console.log(`HEAD:\n${testedSha}`);
  console.log(`ORIGIN/MAIN:\n${originMain}`);
  for (const s of suites) {
    const counts =
      s.testsPassed != null
        ? ` ${s.testsPassed}${s.testsFailed ? `/${s.testsPassed + s.testsFailed}` : ""}`
        : "";
    console.log(`[${s.status}] ${s.name}${counts} exit=${s.exitCode} ${s.durationMs}ms`);
  }
  console.log(
    `ACCEPTANCE: ${acceptanceParsed.finalStatus ?? "UNKNOWN"} failedGates=${acceptanceParsed.failedGates ?? "?"}`
  );
  const failedList = suites.filter((s) => s.status !== "PASS").map((s) => s.name);
  console.log(`FAILED SUITES: ${failedList.length ? failedList.join(", ") : "0"}`);
  console.log(`OVERALL:\n${overall}`);
  console.log(`EVIDENCE:\n${evidencePath}`);
  console.log("GREEN NOT CLAIMED by orchestrator (evidence only; freeze is human-authorized).");
  console.log("========================================");

  process.exit(overall === "GREEN" ? 0 : 2);
}

main().catch((e) => {
  console.error("ORCHESTRATOR FATAL:", e);
  process.exit(1);
});
