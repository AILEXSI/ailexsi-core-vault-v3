/**
 * Single-terminal Desktop launcher:
 *   DesktopHost (Core bridge) + Vite UI
 *
 *   npm run desktop
 *
 * Env: CORE_DATABASE_URL (or .env). Docker default:
 *   postgres://ailexsi_v2:ailexsi_v2_dev@127.0.0.1:5433/ailexsi_v2_core
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

function loadDotEnv() {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json();
        if (body.ok) return body;
      }
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  return null;
}

function spawnNode(args, name) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const prefix = `[${name}] `;
  child.stdout?.on("data", (d) => {
    process.stdout.write(prefix + d.toString().replace(/\n/g, "\n" + prefix));
  });
  child.stderr?.on("data", (d) => {
    process.stderr.write(prefix + d.toString().replace(/\n/g, "\n" + prefix));
  });
  return child;
}

function spawnNpm(args, name) {
  const cmd = isWin ? "npm.cmd" : "npm";
  const child = spawn(cmd, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWin,
    windowsHide: true,
  });
  const prefix = `[${name}] `;
  child.stdout?.on("data", (d) => {
    process.stdout.write(prefix + d.toString().replace(/\n/g, "\n" + prefix));
  });
  child.stderr?.on("data", (d) => {
    process.stderr.write(prefix + d.toString().replace(/\n/g, "\n" + prefix));
  });
  return child;
}

loadDotEnv();

// Host resolves DB: reachable CORE_DATABASE_URL → else embedded-postgres
console.log(
  "[desktop] DesktopHost will use CORE_DATABASE_URL if reachable, else embedded-postgres (no Docker required)"
);

const hostPort = process.env.DESKTOP_HOST_PORT || "17890";
const healthUrl = `http://127.0.0.1:${hostPort}/health`;

const children = [];

function shutdown(code = 0) {
  for (const c of children) {
    try {
      if (isWin && c.pid) {
        spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], {
          stdio: "ignore",
          shell: true,
        });
      } else {
        c.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("[desktop] starting DesktopHost bridge…");
const host = spawnNode(
  [
    "--import",
    "./scripts/register-aliases.mjs",
    "--import",
    "tsx",
    "scripts/desktop-host-entry.ts",
  ],
  "host"
);
children.push(host);

host.on("exit", (code) => {
  if (code && code !== 0) {
    console.error(
      `[desktop] DesktopHost exited (${code}). Host failed — check log above (embedded PG or CORE_DATABASE_URL)`
    );
    shutdown(code);
  }
});

const health = await waitForHealth(healthUrl);
if (!health) {
  console.error(
    `[desktop] DesktopHost did not become healthy at ${healthUrl}`
  );
  console.error(
    "[desktop] Fix CORE_DATABASE_URL and ensure Postgres runs (docker compose up -d)."
  );
  shutdown(1);
}

console.log(
  `[desktop] host OK — store=${health.store}  generation path ready`
);
console.log("[desktop] starting Vite UI on http://localhost:1420 …");

const ui = spawnNpm(["run", "dev", "--prefix", "apps/desktop"], "ui");
children.push(ui);

ui.on("exit", (code) => {
  console.log(`[desktop] UI exited (${code ?? 0})`);
  shutdown(code ?? 0);
});
