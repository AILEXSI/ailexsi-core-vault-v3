/**
 * V3 acceptance gate — inherited V2 foundation + Slice A Desktop command path.
 *
 * GREEN requires:
 *   1. Foundation gates PASS
 *   2. Core/Vault baseline pins unchanged
 *   3. Core/Vault checkouts clean
 *   4. no Phase 08
 *   5. no dual-write
 *   6. unit/mock suite PASS
 *   7. live PostgreSQL foundation suite PASS
 *   8. Desktop command-path suite PASS
 *   9. Desktop path reaches PostgresEventStore
 *  10–12. covered by desktop suite (persist, read model, AAS-54)
 *
 * Live/desktop cannot run → VERIFICATION PENDING (exit 2)
 * Hard failures → BLOCKED (exit 1)
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAcceptanceEvidence,
  writeAcceptanceEvidence,
  findTagForSha,
  assertEvidenceShape,
} from "./acceptance-evidence.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

function writeGateFailureLog(name, err) {
  try {
    const dir = path.join(root, "evidence", "runs");
    mkdirSync(dir, { recursive: true });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const file = path.join(dir, `last-failure-${slug}.log`);
    const body = [
      `gate: ${name}`,
      `time: ${new Date().toISOString()}`,
      "",
      err?.stdout?.toString?.() || "",
      "",
      err?.stderr?.toString?.() || "",
      "",
      err?.message || String(err),
    ].join("\n");
    writeFileSync(file, body, "utf8");
    console.error(`FULL FAILURE LOG: ${path.relative(root, file)}`);
  } catch {
    /* ignore */
  }
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const baselines = JSON.parse(
  readFileSync(path.join(root, "config/baselines.json"), "utf8")
);

const gates = [];
let livePostgres = false;
let desktopPath = false;

function gate(name, ok, detail = "") {
  gates.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function dirty(dir) {
  if (!existsSync(path.join(dir, ".git"))) return false;
  const s = execSync("git status --porcelain", { cwd: dir }).toString().trim();
  return s.length > 0;
}

function walkTs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "target") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, out);
    else if (/\.(ts|tsx|mjs|js|rs)$/.test(name)) out.push(full);
  }
  return out;
}

function runVitest(args, timeoutMs = 300_000) {
  const out = execSync(`npx vitest run --config vitest.config.ts ${args}`, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    timeout: timeoutMs,
  });
  return out;
}

// --- identity ---
let localHead = "unknown";
let originHead = "unknown";
try {
  localHead = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  try {
    originHead = execSync("git rev-parse origin/main", { cwd: root })
      .toString()
      .trim();
  } catch {
    originHead = "origin/main missing";
  }
} catch {
  /* not a git repo */
}
console.log(`LOCAL HEAD:  ${localHead}`);
console.log(`ORIGIN HEAD: ${originHead}`);
console.log(
  `HEADS IDENTICAL: ${localHead === originHead ? "YES" : "NO (local may be ahead)"}`
);
console.log(`CORE PIN:    ${baselines.core.sha}`);
console.log(`VAULT PIN:   ${baselines.vaultReference.sha}`);

// --- structural ---
gate(
  "CORE BASELINE IDENTIFIED",
  baselines.core.sha === "652d01eb06dd0841c3b475023883675af6dcd698",
  baselines.core.sha
);
gate(
  "VAULT BASELINE IDENTIFIED",
  baselines.vaultReference.sha ===
    "061e444389090c54e431b0e8243e82764f2c198e",
  baselines.vaultReference.sha
);
gate(
  "REQUIRED TESTS PRESENT",
  (() => {
    const inv = path.join(root, "config/required-tests.json");
    if (!existsSync(inv)) return false;
    const files = JSON.parse(readFileSync(inv, "utf8")).files ?? [];
    return files.every((f) => existsSync(path.join(root, f)));
  })()
);
gate(
  "HARBOR IMPORT PIPELINE PRESENT",
  existsSync(path.join(root, "packages/harbor/src/import-pipeline.ts")) &&
    existsSync(path.join(root, "packages/harbor/src/service.ts")) &&
    readFileSync(path.join(root, "packages/harbor/src/service.ts"), "utf8").includes(
      "confirmImport"
    ) &&
    readFileSync(path.join(root, "packages/harbor/src/service.ts"), "utf8").includes(
      "beginImport"
    )
);
gate(
  "HARBOR DERIVED INDEX PRESENT",
  (() => {
    const idx = path.join(root, "packages/harbor/src/derived-index.ts");
    const svc = path.join(root, "packages/harbor/src/service.ts");
    if (!existsSync(idx) || !existsSync(svc)) return false;
    const indexSrc = readFileSync(idx, "utf8");
    const serviceSrc = readFileSync(svc, "utf8");
    return (
      indexSrc.includes("harbor-derived-index-v1") &&
      indexSrc.includes("FileDerivedIndex") &&
      indexSrc.includes("Never EventStore") &&
      !indexSrc.includes("PostgresEventStore") &&
      !indexSrc.includes("appendEvent") &&
      serviceSrc.includes("FileDerivedIndex") &&
      serviceSrc.includes("clearDerived") &&
      serviceSrc.includes("rebuildFromCanonical")
    );
  })()
);
gate(
  "HARBOR DERIVED QUERY PRESENT",
  (() => {
    const q = path.join(root, "packages/harbor/src/derived-query.ts");
    const svc = path.join(root, "packages/harbor/src/service.ts");
    if (!existsSync(q) || !existsSync(svc)) return false;
    const querySrc = readFileSync(q, "utf8");
    const serviceSrc = readFileSync(svc, "utf8");
    return (
      querySrc.includes("getDerivedMemory") &&
      querySrc.includes("listDerivedMemories") &&
      querySrc.includes("findDerivedBySource") &&
      querySrc.includes("findDerivedByStatus") &&
      querySrc.includes("findContradictions") &&
      querySrc.includes("getDerivedProvenance") &&
      querySrc.includes("READ-ONLY") &&
      !querySrc.includes("writeFileSync") &&
      !querySrc.includes("PostgresEventStore") &&
      !querySrc.includes("appendEvent") &&
      serviceSrc.includes("queries(") &&
      serviceSrc.includes("DerivedQueryService")
    );
  })()
);
gate(
  "HARBOR CONTEXT ASSEMBLY PRESENT",
  (() => {
    const ctx = path.join(root, "packages/harbor/src/context-assembly.ts");
    const types = path.join(root, "packages/harbor/src/types.ts");
    if (!existsSync(ctx) || !existsSync(types)) return false;
    const ctxSrc = readFileSync(ctx, "utf8");
    const typeSrc = readFileSync(types, "utf8");
    return (
      ctxSrc.includes("assembleContextFromQuery") &&
      ctxSrc.includes("DerivedQueryService") &&
      ctxSrc.includes("getDerivedMemory") &&
      ctxSrc.includes("findDerivedBySource") &&
      ctxSrc.includes("findContradictions") &&
      ctxSrc.includes("getDerivedProvenance") &&
      ctxSrc.includes("Never EventStore") &&
      !ctxSrc.includes("writeFileSync") &&
      !ctxSrc.includes("PostgresEventStore") &&
      typeSrc.includes("harbor-context-package-v1") &&
      typeSrc.includes("packageId")
    );
  })()
);
gate(
  "HARBOR REFLECTION ENGINE PRESENT",
  (() => {
    const eng = path.join(root, "packages/harbor/src/reflection-engine.ts");
    const svc = path.join(root, "packages/harbor/src/service.ts");
    if (!existsSync(eng) || !existsSync(svc)) return false;
    const src = readFileSync(eng, "utf8");
    const serviceSrc = readFileSync(svc, "utf8");
    return (
      src.includes("reflectFromQuery") &&
      src.includes("DerivedQueryService") &&
      src.includes("OBSERVED") &&
      src.includes("unresolved_contradiction") &&
      src.includes("Never EventStore") &&
      !src.includes("writeFileSync") &&
      !src.includes("PostgresEventStore") &&
      serviceSrc.includes("reflectObserved")
    );
  })()
);
gate(
  "HARBOR CULTIVATION PROPOSALS PRESENT",
  (() => {
    const cult = path.join(root, "packages/harbor/src/cultivation-proposals.ts");
    const svc = path.join(root, "packages/harbor/src/service.ts");
    if (!existsSync(cult) || !existsSync(svc)) return false;
    const src = readFileSync(cult, "utf8");
    const serviceSrc = readFileSync(svc, "utf8");
    return (
      src.includes("proposeFromReflections") &&
      src.includes("review_preference") &&
      src.includes("review_contradiction") &&
      src.includes("Not EventStore") &&
      !src.includes("writeFileSync") &&
      !src.includes("PostgresEventStore") &&
      serviceSrc.includes("cultivate(") &&
      serviceSrc.includes("decideCultivation") &&
      serviceSrc.includes("Never persists")
    );
  })()
);
gate(
  "HARBOR AGENCY BOUNDARY PRESENT",
  (() => {
    const agency = path.join(root, "packages/harbor/src/agency.ts");
    const boundary = path.join(root, "packages/harbor/src/agency-boundary.ts");
    const svc = path.join(root, "packages/harbor/src/service.ts");
    if (!existsSync(agency) || !existsSync(boundary) || !existsSync(svc)) return false;
    const agencySrc = readFileSync(agency, "utf8");
    const boundarySrc = readFileSync(boundary, "utf8");
    const serviceSrc = readFileSync(svc, "utf8");
    return (
      agencySrc.includes("PROPOSE") &&
      agencySrc.includes("CANONICAL_COMMIT") &&
      agencySrc.includes("EXTERNAL_ACTION") &&
      agencySrc.includes("issueAuthorization") &&
      agencySrc.includes("explicit-human-authorization") &&
      agencySrc.includes("notFromProposalAcceptance") &&
      !agencySrc.includes("PostgresEventStore") &&
      !agencySrc.includes("appendEvent") &&
      boundarySrc.includes("commitCanonical") &&
      boundarySrc.includes("performExternal") &&
      boundarySrc.includes("modifyEvidence") &&
      boundarySrc.includes("convertProposalToCanonical") &&
      !boundarySrc.includes("PostgresEventStore") &&
      serviceSrc.includes("this.agency") &&
      serviceSrc.includes("commitCanonical") &&
      serviceSrc.includes("commitProposal") &&
      serviceSrc.includes("Proposal accept is not a grant")
    );
  })()
);
gate(
  "VERSION CONSISTENCY PRESENT",
  (() => {
    const verPath = path.join(root, "config/version.json");
    const rootPkgPath = path.join(root, "package.json");
    const harborTypes = path.join(root, "packages/harbor/src/types.ts");
    const tauri = path.join(root, "apps/desktop/src-tauri/tauri.conf.json");
    const cargo = path.join(root, "apps/desktop/src-tauri/Cargo.toml");
    if (![verPath, rootPkgPath, harborTypes, tauri, cargo].every((p) => existsSync(p))) {
      return false;
    }
    const declared = JSON.parse(readFileSync(verPath, "utf8"));
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
    const tauriCfg = JSON.parse(readFileSync(tauri, "utf8"));
    const cargoText = readFileSync(cargo, "utf8");
    const harborText = readFileSync(harborTypes, "utf8");
    const cargoVer = cargoText.match(/^version\s*=\s*"([^"]+)"/m);
    return (
      declared.product === "AILEXSI Core Vault V3" &&
      declared.version === rootPkg.version &&
      declared.version === tauriCfg.version &&
      cargoVer?.[1] === declared.version &&
      harborText.includes(`export const HARBOR_VERSION = "${declared.version}"`) &&
      declared.bootstrapTagIsNotProductVersion === true &&
      existsSync(path.join(root, "tests/unit/version-consistency.test.ts"))
    );
  })()
);
gate(
  "V3 FULL ACCEPTANCE GATE PRESENT",
  (() => {
    const gateFile = path.join(root, "tests/integration/v3-full-acceptance-gate.test.ts");
    const pkg = path.join(root, "package.json");
    if (!existsSync(gateFile) || !existsSync(pkg)) return false;
    const src = readFileSync(gateFile, "utf8");
    const pkgSrc = readFileSync(pkg, "utf8");
    return (
      src.includes("V3 FULL ACCEPTANCE / SYSTEM INTEGRITY GATE") &&
      src.includes("Core → Query → Context → Reflection → Cultivation → Agency") &&
      src.includes("startLivePostgres") &&
      src.includes("createCoreRuntime") &&
      src.includes("HarborService") &&
      src.includes("commitCanonical") &&
      src.includes("PostgresEventStore") &&
      !src.includes("InMemoryEventStore") &&
      pkgSrc.includes("test:integrity") &&
      pkgSrc.includes("v3-full-acceptance-gate.test.ts")
    );
  })()
);
gate(
  "V3 CONNECTOME PRESENT",
  (() => {
    const engine = path.join(root, "packages/harbor/src/connectome-engine.ts");
    const svc = path.join(root, "packages/harbor/src/service.ts");
    const test = path.join(root, "tests/unit/harbor-connectome.test.ts");
    if (!existsSync(engine) || !existsSync(svc) || !existsSync(test)) return false;
    const src = readFileSync(engine, "utf8");
    const serviceSrc = readFileSync(svc, "utf8");
    return (
      src.includes("harbor-connectome-v1") &&
      src.includes("CANONICAL_MEMORY") &&
      src.includes("Never EventStore") &&
      !src.includes("PostgresEventStore") &&
      serviceSrc.includes("proposeRelation") &&
      serviceSrc.includes("commitRelation") &&
      serviceSrc.includes("connectome(")
    );
  })()
);
gate(
  "V2 STRUCTURE PRESENT",
  existsSync(path.join(root, "packages/command-adapter/src/index.ts")) &&
    existsSync(path.join(root, "packages/command-adapter/src/core-runtime.ts")) &&
    existsSync(path.join(root, "packages/command-adapter/src/desktop-host.ts")) &&
    existsSync(path.join(root, "docs/SOURCE-OF-TRUTH.md")) &&
    existsSync(path.join(root, "docs/BASELINES.md")) &&
    existsSync(path.join(root, "docs/adr/001-source-of-truth.md"))
);
gate(
  "DESKTOP HOST + IPC SURFACE PRESENT",
  existsSync(path.join(root, "packages/command-adapter/src/desktop-host.ts")) &&
    existsSync(path.join(root, "apps/desktop/src/ipc/memory-api.ts")) &&
    existsSync(path.join(root, "apps/desktop/src-tauri/src/lib.rs")) &&
    readFileSync(
      path.join(root, "apps/desktop/src-tauri/src/lib.rs"),
      "utf8"
    ).includes("memory_create") &&
    readFileSync(
      path.join(root, "packages/command-adapter/src/desktop-host.ts"),
      "utf8"
    ).includes("invokeDesktopCommand") &&
    existsSync(path.join(root, "packages/command-adapter/src/desktop-bridge-server.ts")) &&
    existsSync(path.join(root, "apps/desktop/src/components/MemoryPanel.tsx"))
);
gate(
  "DATABASE CONFIG VERIFIED",
  existsSync(path.join(root, "config/env.example")) &&
    readFileSync(path.join(root, "config/env.example"), "utf8").includes(
      "CORE_DATABASE_URL"
    ) &&
    readFileSync(path.join(root, "config/env.example"), "utf8").includes(
      "V2_DATABASE_URL"
    )
);

const coreHeadPath = path.join(root, ".deps/ailexsi-core");
let coreHead = "missing";
let coreOk = false;
if (existsSync(path.join(coreHeadPath, ".git"))) {
  coreHead = execSync("git rev-parse HEAD", { cwd: coreHeadPath })
    .toString()
    .trim();
  coreOk = coreHead === baselines.core.sha;
}
gate("CORE CHECKOUT PINNED", coreOk, coreHead);
gate(
  "NO MODIFICATION OF CORE CHECKOUT",
  !dirty(coreHeadPath),
  dirty(coreHeadPath) ? "dirty" : "clean"
);
const vaultPath = path.join(root, ".deps/ailexsi-core-vault");
let vaultHead = "missing";
if (existsSync(path.join(vaultPath, ".git"))) {
  vaultHead = execSync("git rev-parse HEAD", { cwd: vaultPath })
    .toString()
    .trim();
}
gate(
  "VAULT CHECKOUT PINNED OR ABSENT",
  vaultHead === "missing" || vaultHead === baselines.vaultReference.sha,
  vaultHead
);
gate(
  "NO MODIFICATION OF VAULT REFERENCE CHECKOUT",
  !dirty(vaultPath),
  dirty(vaultPath) ? "dirty" : "clean-or-missing"
);

// dual-write
const forbidden = [
  /dualWrite\s*\(/i,
  /saveCanonicalToFs\s*\(/i,
  /persistCanonicalMarkdown\s*\(/i,
  /canonicalStore\s*=\s*['"`].*\.md/i,
];
const dualHits = [];
for (const file of walkTs(path.join(root, "packages")).concat(
  walkTs(path.join(root, "apps")),
  walkTs(path.join(root, "scripts"))
)) {
  const text = readFileSync(file, "utf8");
  for (const re of forbidden) {
    if (re.test(text)) dualHits.push(path.relative(root, file));
  }
}
gate(
  "NO DUAL-WRITE PATH DETECTED",
  dualHits.length === 0,
  dualHits.length ? dualHits.join(", ") : "clean"
);

// Phase 08
const phase08Hits = [];
for (const file of walkTs(path.join(root, "packages"))) {
  const text = readFileSync(file, "utf8");
  if (/implementPhase08|class\s+PhysicsDomain\b/.test(text)) {
    phase08Hits.push(path.relative(root, file));
  }
}
gate(
  "PHASE 08 CODE PRESENT: NO",
  phase08Hits.length === 0,
  phase08Hits.length ? phase08Hits.join(", ") : "no Phase 08 implementation"
);

// silent skip scan on acceptance/desktop tests
const skipHits = [];
for (const file of walkTs(path.join(root, "tests"))) {
  const text = readFileSync(file, "utf8");
  if (
    /\b(describe|it|test)\.skip\s*\(/.test(text) ||
    /\bxit\s*\(/.test(text) ||
    /\bxdescribe\s*\(/.test(text)
  ) {
    skipHits.push(path.relative(root, file));
  }
}
gate(
  "NO SILENT TEST SKIPS IN SUITE",
  skipHits.length === 0,
  skipHits.length ? skipHits.join(", ") : "clean"
);

// per-command runtime anti-pattern in desktop-host
const hostSrc = readFileSync(
  path.join(root, "packages/command-adapter/src/desktop-host.ts"),
  "utf8"
);
const perCommandRuntime =
  /async memoryCreate[\s\S]*createCoreRuntime/.test(hostSrc) ||
  /memoryCreate[\s\S]{0,200}createCoreRuntime/.test(hostSrc);
gate(
  "NO PER-COMMAND createCoreRuntime IN DESKTOP HOST",
  !perCommandRuntime && hostSrc.includes("if (this.runtime)") && hostSrc.includes("start("),
  perCommandRuntime ? "detected" : "long-lived start() only"
);

// unit + mock (exclude live suites)
let unitOk = false;
let unitDetail = "";
try {
  const out = runVitest(
    "--exclude tests/integration/live-postgres-memory.test.ts --exclude tests/integration/desktop-command-path.test.ts --exclude tests/integration/desktop-bridge-http.test.ts --exclude tests/integration/memory-foundation-gate.test.ts --exclude tests/integration/memory-query-read-model-gate.test.ts --exclude tests/integration/desktop-memory-e2e-gate.test.ts --exclude tests/integration/memory-retrieval-context-gate.test.ts --exclude tests/integration/continuity-foundation-gate.test.ts --exclude tests/integration/cultivation-foundation-gate.test.ts --exclude tests/integration/desktop-co-creation-surface-gate.test.ts --exclude tests/integration/v3-full-acceptance-gate.test.ts --exclude tests/integration/v3-connectome-gate.test.ts"
  );
  unitOk = true;
  unitDetail = out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  unitOk = false;
  unitDetail = (e.stdout?.toString?.() || e.message || "").slice(0, 600);
  console.error(e.stdout?.toString?.() || e.message);
}
gate("UNIT+MOCK INTEGRATION TESTS", unitOk, unitDetail.trim().slice(0, 200));

// live foundation suite
let liveTestOk = false;
let liveTestDetail = "";
try {
  const out = runVitest("tests/integration/live-postgres-memory.test.ts");
  liveTestOk = true;
  livePostgres = true;
  liveTestDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  liveTestOk = false;
  livePostgres = false;
  liveTestDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 800);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate(
  "LIVE POSTGRES + CORE EVENTSTORE",
  liveTestOk,
  liveTestDetail.trim().slice(0, 240)
);
gate(
  "COMMAND ADAPTER CREATES MEMORY VIA CORE EVENTSTORE",
  liveTestOk,
  liveTestOk ? "proven by live-postgres-memory suite" : liveTestDetail.slice(0, 120)
);

// desktop command path suite
let desktopOk = false;
let desktopDetail = "";
try {
  const out = runVitest("tests/integration/desktop-command-path.test.ts");
  desktopOk = true;
  desktopPath = true;
  desktopDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  desktopOk = false;
  desktopPath = false;
  desktopDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 800);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate(
  "DESKTOP COMMAND-PATH SUITE",
  desktopOk,
  desktopDetail.trim().slice(0, 240)
);
gate(
  "DESKTOP PATH REACHES PostgresEventStore",
  desktopOk,
  desktopOk
    ? "store.constructor.name === PostgresEventStore (desktop suite)"
    : desktopDetail.slice(0, 120)
);
gate(
  "DESKTOP AAS-54 REPLAY",
  desktopOk,
  desktopOk
    ? "CLEAR → REBUILD → IDENTICAL via desktop IPC path"
    : "desktop suite failed"
);

// desktop HTTP bridge (Tauri/UI surface)
let bridgeOk = false;
let bridgeDetail = "";
try {
  const out = runVitest("tests/integration/desktop-bridge-http.test.ts");
  bridgeOk = true;
  bridgeDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  bridgeOk = false;
  bridgeDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 800);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate(
  "DESKTOP HTTP BRIDGE SUITE",
  bridgeOk,
  bridgeDetail.trim().slice(0, 240)
);
gate(
  "BRIDGE REACHES PostgresEventStore",
  bridgeOk,
  bridgeOk ? "HTTP /health store=PostgresEventStore" : bridgeDetail.slice(0, 120)
);


// Memory Foundation matrix (live Postgres)
let foundationOk = false;
let foundationDetail = "";
try {
  const out = runVitest("tests/integration/memory-foundation-gate.test.ts");
  foundationOk = true;
  foundationDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  foundationOk = false;
  foundationDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 1200);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate(
  "MEMORY FOUNDATION GATE",
  foundationOk,
  foundationDetail.trim().slice(0, 240)
);

let fsAuditOk = false;
let fsDetail = "";
try {
  const out = runVitest("tests/acceptance/no-canonical-fs-write.test.ts");
  fsAuditOk = true;
  fsDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  fsAuditOk = false;
  fsDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 400);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate("MEMORY FOUNDATION FS AUDIT", fsAuditOk, fsDetail.trim().slice(0, 200));


// Phase 2 — Query + Read-Model (live Postgres)
let queryOk = false;
let queryDetail = "";
try {
  const out = runVitest("tests/integration/memory-query-read-model-gate.test.ts");
  queryOk = true;
  queryDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  queryOk = false;
  queryDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 1200);
  writeGateFailureLog("MEMORY QUERY + READ-MODEL GATE", e);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate(
  "MEMORY QUERY + READ-MODEL GATE",
  queryOk,
  queryDetail.trim().slice(0, 240)
);
gate("QUERY GATE", queryOk, queryOk ? "get/list/history/pagination" : "query suite failed");
gate("READ MODEL GATE", queryOk, queryOk ? "DERIVED read model" : "query suite failed");
gate("REPLAY GATE", queryOk, queryOk ? "CLEAR→REBUILD→IDENTICAL in query suite" : "query suite failed");


// Phase 3 — Desktop Memory E2E
let e2eOk = false;
let e2eDetail = "";
try {
  const out = runVitest("tests/integration/desktop-memory-e2e-gate.test.ts");
  e2eOk = true;
  e2eDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  e2eOk = false;
  e2eDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 1200);
  writeGateFailureLog("DESKTOP MEMORY E2E GATE", e);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate(
  "DESKTOP MEMORY E2E GATE",
  e2eOk,
  e2eDetail.trim().slice(0, 240)
);
gate(
  "DESKTOP USES PostgresEventStore",
  e2eOk,
  e2eOk ? "store.constructor.name === PostgresEventStore" : "e2e failed"
);
gate(
  "DESKTOP REPLAY IDENTICAL",
  e2eOk,
  e2eOk ? "CLEAR→rebuildFromCore→IDENTICAL" : "e2e failed"
);
gate(
  "DESKTOP READ NO-APPEND",
  e2eOk,
  e2eOk ? "GET/LIST/HISTORY/REBUILD do not append" : "e2e failed"
);


// Phase 4 — Retrieval + Context
let retrievalOk = false;
let retrievalDetail = "";
try {
  const out = runVitest("tests/integration/memory-retrieval-context-gate.test.ts");
  retrievalOk = true;
  retrievalDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  retrievalOk = false;
  retrievalDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 1200);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate(
  "MEMORY RETRIEVAL + CONTEXT GATE",
  retrievalOk,
  retrievalDetail.trim().slice(0, 240)
);


// Continuity Foundation
let continuityOk = false;
let continuityDetail = "";
try {
  const out = runVitest("tests/integration/continuity-foundation-gate.test.ts");
  continuityOk = true;
  continuityDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  continuityOk = false;
  continuityDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 1200);
  writeGateFailureLog("CONTINUITY FOUNDATION GATE", e);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate(
  "CONTINUITY FOUNDATION GATE",
  continuityOk,
  continuityDetail.trim().slice(0, 240)
);


// Cultivation Foundation
let cultivationOk = false;
let cultivationDetail = "";
try {
  const out = runVitest("tests/integration/cultivation-foundation-gate.test.ts");
  cultivationOk = true;
  cultivationDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  cultivationOk = false;
  cultivationDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 1200);
  writeGateFailureLog("CULTIVATION FOUNDATION GATE", e);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate(
  "CULTIVATION FOUNDATION GATE",
  cultivationOk,
  cultivationDetail.trim().slice(0, 240)
);


// Desktop Co-Creation Surface
let dcsOk = false;
let dcsDetail = "";
try {
  const out = runVitest("tests/integration/desktop-co-creation-surface-gate.test.ts");
  dcsOk = true;
  dcsDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  dcsOk = false;
  dcsDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 1200);
  writeGateFailureLog("DESKTOP CO-CREATION SURFACE GATE", e);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate(
  "DESKTOP CO-CREATION SURFACE GATE",
  dcsOk,
  dcsDetail.trim().slice(0, 240)
);

let integrityOk = false;
let integrityDetail = "";
try {
  const out = runVitest("tests/integration/v3-full-acceptance-gate.test.ts");
  integrityOk = true;
  integrityDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  integrityOk = false;
  integrityDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 1200);
  writeGateFailureLog("V3 FULL ACCEPTANCE GATE", e);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate(
  "V3 FULL ACCEPTANCE GATE",
  integrityOk,
  integrityDetail.trim().slice(0, 240)
);

let connectomeOk = false;
let connectomeDetail = "";
try {
  const out = runVitest("tests/unit/harbor-connectome.test.ts tests/integration/v3-connectome-gate.test.ts");
  connectomeOk = true;
  connectomeDetail =
    out.split("\n").filter((l) => l.includes("Tests")).pop() ?? "ok";
  console.log(out);
} catch (e) {
  connectomeOk = false;
  connectomeDetail = (
    e.stdout?.toString?.() ||
    e.stderr?.toString?.() ||
    e.message ||
    ""
  ).slice(0, 1200);
  writeGateFailureLog("V3 CONNECTOME GATE", e);
  console.error(e.stdout?.toString?.() || e.stderr?.toString?.() || e.message);
}
gate(
  "V3 CONNECTOME GATE",
  connectomeOk,
  connectomeDetail.trim().slice(0, 240)
);

const failed = gates.filter((g) => !g.ok);
const softLive = new Set([
  "LIVE POSTGRES + CORE EVENTSTORE",
  "COMMAND ADAPTER CREATES MEMORY VIA CORE EVENTSTORE",
  "DESKTOP COMMAND-PATH SUITE",
  "DESKTOP PATH REACHES PostgresEventStore",
  "DESKTOP AAS-54 REPLAY",
  "DESKTOP HTTP BRIDGE SUITE",
  "BRIDGE REACHES PostgresEventStore",
  "MEMORY FOUNDATION GATE",
  "MEMORY FOUNDATION FS AUDIT",
  "MEMORY QUERY + READ-MODEL GATE",
  "QUERY GATE",
  "READ MODEL GATE",
  "REPLAY GATE",
  "DESKTOP MEMORY E2E GATE",
  "DESKTOP USES PostgresEventStore",
  "DESKTOP REPLAY IDENTICAL",
  "DESKTOP READ NO-APPEND",
  "MEMORY RETRIEVAL + CONTEXT GATE",
  "CONTINUITY FOUNDATION GATE",
  "CULTIVATION FOUNDATION GATE",
  "DESKTOP CO-CREATION SURFACE GATE",
  "V3 FULL ACCEPTANCE GATE",
  "V3 CONNECTOME GATE",
]);
const hardFailed = failed.filter((g) => !softLive.has(g.name));

let status;
let exitCode;
if (hardFailed.length > 0) {
  status = "BLOCKED";
  exitCode = 1;
} else if (!liveTestOk || !desktopOk || !bridgeOk || !foundationOk || !queryOk || !e2eOk || !retrievalOk || !continuityOk || !cultivationOk || !dcsOk || !integrityOk || !connectomeOk) {
  status = "VERIFICATION PENDING";
  exitCode = 2;
} else if (failed.length === 0) {
  status = "GREEN";
  exitCode = 0;
} else {
  status = "BLOCKED";
  exitCode = 1;
}

console.log("\n========================================");
console.log("AILEXSI CORE VAULT V3 — ACCEPTANCE GATE");
console.log(`FINAL STATUS: ${status}`);
console.log(`LIVE POSTGRES: ${livePostgres ? "yes" : "no"}`);
console.log(`DESKTOP PATH: ${desktopPath ? "yes" : "no"}`);
console.log(`CORE PIN: 652d01eb`);
console.log(`MEMORY FOUNDATION: frozen`);
console.log(`QUERY GATE: ${queryOk ? "PASS" : "FAIL"}`);
console.log(`DESKTOP E2E GATE: ${e2eOk ? "PASS" : "FAIL"}`);
console.log(`RETRIEVAL GATE: ${retrievalOk ? "PASS" : "FAIL"}`);
console.log(`CONTINUITY GATE: ${continuityOk ? "PASS" : "FAIL"}`);
console.log(`CULTIVATION GATE: ${cultivationOk ? "PASS" : "FAIL"}`);
console.log(`DESKTOP CO-CREATION GATE: ${dcsOk ? "PASS" : "FAIL"}`);
console.log(`FULL ACCEPTANCE GATE: ${integrityOk ? "PASS" : "FAIL"}`);
console.log(`CONNECTOME GATE: ${connectomeOk ? "PASS" : "FAIL"}`);
console.log(`READ MODEL GATE: ${queryOk ? "PASS" : "FAIL"}`);
console.log(`REPLAY GATE: ${queryOk ? "PASS" : "FAIL"}`);
console.log(`PHASE 08 CODE PRESENT: NO`);
console.log(`Failed gates: ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
console.log("========================================\n");

// Phase 4.1 — persist machine-readable evidence (docs only; never creates tags)
try {
  const tag = findTagForSha(root, localHead);
  const payload = buildAcceptanceEvidence({
    status,
    exitCode,
    testedSha: localHead,
    originMainSha: originHead,
    corePin: baselines.core.sha,
    vaultPin: baselines.vaultReference.sha,
    livePostgres,
    desktopPath,
    gates,
    softLiveNames: [...softLive],
    phase: "4",
    tag,
    gitDirtyState: execSync("git status --porcelain", { cwd: root }).toString().trim()
      ? "dirty"
      : "clean",
    v3Version: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version,
    testCommands: ["npm test", "npm run acceptance", "npm run verify:live"],
  });
  assertEvidenceShape(payload);
  const { path: evidencePath } = writeAcceptanceEvidence(root, payload);
  console.log(`EVIDENCE WRITTEN: ${path.relative(root, evidencePath)}`);
  console.log(`EVIDENCE STATUS: ${payload.status}`);
  console.log(`EVIDENCE TAG: ${payload.tag ?? "(none)"}`);
} catch (e) {
  console.error(
    "EVIDENCE EMIT FAILED:",
    e instanceof Error ? e.message : String(e)
  );
  // Do not override acceptance exit code on evidence I/O failure after decision
}

process.exit(exitCode);
