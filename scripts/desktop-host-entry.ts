/**
 * Entry: long-lived DesktopHost HTTP bridge for UI / Tauri.
 * Run: npm run desktop:host   or   npm run desktop
 *
 * Database resolution (same helper as live tests):
 *   1) CORE_DATABASE_URL / DATABASE_URL if reachable
 *   2) embedded-postgres (no Docker required)
 *
 * No InMemory EventStore on this path.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startDesktopBridgeServer,
  getDesktopHost,
} from "@ailexsi/v2-command-adapter";
import { startLivePostgres } from "@ailexsi/v2-test-kit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(): void {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function redactUrl(url: string): string {
  return url.replace(/:([^:@/]+)@/, ":***@");
}

loadDotEnv();

if (!process.env.HARBOR_DERIVED_INDEX_PATH) {
  process.env.HARBOR_DERIVED_INDEX_PATH = path.join(root, "data", "derived-index");
}

const port = Number(process.env.DESKTOP_HOST_PORT || 17890);

console.log(
  "[host] resolving PostgreSQL (env URL if reachable, else embedded-postgres)…"
);

let live;
try {
  live = await startLivePostgres();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[host] cannot start PostgreSQL: ${msg}`);
  console.error(
    "[host] Options: docker compose up -d  OR  fix CORE_DATABASE_URL  OR  allow embedded-postgres"
  );
  process.exit(1);
}

console.log(
  `[host] database mode=${live.mode}  url=${redactUrl(live.connectionString)}`
);

let server;
try {
  server = await startDesktopBridgeServer({
    connectionString: live.connectionString,
    port,
    environment:
      process.env.AILEXSI_ENV === "production" ? "production" : "development",
    producer: "v2-desktop-host-server",
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[host] Failed to start DesktopHost: ${msg}`);
  try {
    await live.stop();
  } catch {
    /* ignore */
  }
  process.exit(1);
}

console.log(`DesktopHost bridge listening on ${server.url}`);
console.log(`store: ${getDesktopHost().storeConstructorName()}`);
console.log(
  `derived-index: ${process.env.HARBOR_DERIVED_INDEX_PATH} (V3-DERIVED, rebuildable, not EventStore)`
);
console.log(
  "Commands: POST /commands/memory.create|get|list|update|archive|restore|history"
);
console.log("Health:   GET  /health");
if (live.mode === "embedded") {
  console.log(
    "[host] using embedded-postgres (ephemeral — data lost on stop). For persistent data: docker compose up -d + CORE_DATABASE_URL"
  );
}

const shutdown = async () => {
  console.log("shutting down…");
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  try {
    await getDesktopHost().stop();
  } catch {
    /* ignore */
  }
  try {
    await live.stop();
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
