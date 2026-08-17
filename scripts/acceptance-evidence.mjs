/**
 * Phase 4.1 — acceptance evidence emission (documentation tooling only).
 *
 * Does NOT: create tags, touch EventStore, Memory, Core, Vault, or runtime packages.
 * Authority remains scripts/acceptance-gate.mjs exit code + gates[].
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export const SCHEMA_VERSION = 1;
export const GENERATED_BY = "scripts/acceptance-gate.mjs";

/** Known freeze tags (immutable historical anchors). Do not invent new ones. */
export const KNOWN_GREEN_TAGS = [
  "v2.0.0-memory-foundation-green",
  "v2.1.0-desktop-memory-green",
  "v2.2.0-retrieval-context-green",
];

/**
 * Resolve annotated tag → peeled commit SHA. Returns null if missing/unresolvable.
 */
export function resolveTagCommit(repoRoot, tagName) {
  try {
    const sha = execSync(`git rev-parse ${tagName}^{}`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return sha.length === 40 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * If testedSha matches a known GREEN tag^{}, return that tag name; else null.
 */
export function findTagForSha(repoRoot, testedSha) {
  if (!testedSha || testedSha === "unknown") return null;
  for (const tag of KNOWN_GREEN_TAGS) {
    const peeled = resolveTagCommit(repoRoot, tag);
    if (peeled === testedSha) return tag;
  }
  return null;
}

/**
 * Build evidence payload from gate in-process state.
 * @param {object} input
 */
export function buildAcceptanceEvidence(input) {
  const {
    status,
    exitCode,
    testedSha,
    originMainSha,
    corePin,
    vaultPin,
    livePostgres,
    desktopPath,
    gates,
    softLiveNames,
    phase = "4.1",
    generatedAt = new Date().toISOString(),
    tag = null,
  } = input;

  if (!Array.isArray(gates)) {
    throw new Error("gates must be an array");
  }

  const failedGates = gates.filter((g) => !g.ok);
  const softSet = new Set(softLiveNames ?? []);
  const hardFailed = failedGates.filter((g) => !softSet.has(g.name));
  const softLiveFailed = failedGates.filter((g) => softSet.has(g.name));

  // CRITICAL: never label GREEN if exitCode !== 0
  let evidenceStatus = status;
  if (exitCode !== 0 && evidenceStatus === "GREEN") {
    evidenceStatus = "BLOCKED";
  }
  if (exitCode === 0 && failedGates.length > 0) {
    evidenceStatus = "BLOCKED";
  }

  const headsIdentical =
    typeof testedSha === "string" &&
    typeof originMainSha === "string" &&
    testedSha === originMainSha &&
    testedSha !== "unknown";

  return {
    schemaVersion: SCHEMA_VERSION,
    phase,
    status: evidenceStatus,
    exitCode,
    testedSha: testedSha ?? "unknown",
    originMainSha: originMainSha ?? "unknown",
    headsIdentical,
    tag: tag ?? null,
    corePin: corePin ?? null,
    vaultPin: vaultPin ?? null,
    environment: {
      platform: process.platform,
      livePostgres: !!livePostgres,
      desktopPath: !!desktopPath,
    },
    gates: gates.map((g) => ({
      name: g.name,
      ok: !!g.ok,
      detail: g.detail ?? "",
    })),
    summary: {
      failedGates: failedGates.length,
      hardFailed: hardFailed.length,
      softLiveFailed: softLiveFailed.length,
      totalGates: gates.length,
    },
    generatedBy: GENERATED_BY,
    auditOnly: {
      generatedAt,
    },
  };
}

/**
 * Write path under evidence/runs only. Never GREEN filename for non-zero exit.
 * @returns {{ path: string, payload: object }}
 */
export function writeAcceptanceEvidence(repoRoot, payload) {
  if (payload.status === "GREEN" && payload.exitCode !== 0) {
    throw new Error(
      "REFUSED: cannot write GREEN evidence when exitCode !== 0"
    );
  }

  const runsDir = path.join(repoRoot, "evidence", "runs");
  mkdirSync(runsDir, { recursive: true });

  const sha =
    typeof payload.testedSha === "string" && payload.testedSha.length >= 7
      ? payload.testedSha
      : "unknown";

  // Always write status-qualified name for non-GREEN; GREEN may use bare sha
  let fileName;
  if (payload.status === "GREEN" && payload.exitCode === 0) {
    fileName = `${sha}.acceptance.json`;
  } else {
    const slug = String(payload.status)
      .toLowerCase()
      .replace(/\s+/g, "-");
    fileName = `${sha}.${slug}.acceptance.json`;
  }

  const outPath = path.join(runsDir, fileName);
  // Safety: only under evidence/runs
  const resolved = path.resolve(outPath);
  const runsResolved = path.resolve(runsDir);
  const rel = path.relative(runsResolved, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("REFUSED: evidence path escapes evidence/runs");
  }

  writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return { path: outPath, payload };
}

/**
 * Optional: load schema file text for docs/tests (no ajv dependency).
 */
export function loadSchemaText(repoRoot) {
  const p = path.join(
    repoRoot,
    "evidence",
    "schema",
    "acceptance-run.schema.json"
  );
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

/**
 * Structural checks without ajv (Windows-friendly, zero deps).
 */
export function assertEvidenceShape(payload) {
  const required = [
    "schemaVersion",
    "phase",
    "status",
    "testedSha",
    "originMainSha",
    "headsIdentical",
    "corePin",
    "vaultPin",
    "environment",
    "gates",
    "summary",
    "generatedBy",
  ];
  for (const k of required) {
    if (!(k in payload)) throw new Error(`missing field: ${k}`);
  }
  if (!payload.environment || typeof payload.environment !== "object") {
    throw new Error("environment must be object");
  }
  for (const k of ["platform", "livePostgres", "desktopPath"]) {
    if (!(k in payload.environment)) {
      throw new Error(`environment missing: ${k}`);
    }
  }
  if (!Array.isArray(payload.gates)) throw new Error("gates must be array");
  if (!payload.summary || typeof payload.summary !== "object") {
    throw new Error("summary must be object");
  }
  for (const k of ["failedGates", "hardFailed", "softLiveFailed"]) {
    if (typeof payload.summary[k] !== "number") {
      throw new Error(`summary.${k} must be number`);
    }
  }
  if (payload.status === "GREEN" && payload.exitCode !== 0) {
    throw new Error("GREEN requires exitCode 0");
  }
  return true;
}
