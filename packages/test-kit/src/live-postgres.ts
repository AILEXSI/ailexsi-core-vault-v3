/**
 * Live PostgreSQL for V2 acceptance suites.
 *
 * Lifecycle contract (Windows-critical):
 *   1. Prefer env CORE_DATABASE_URL when reachable.
 *   2. Else start ONE embedded-postgres cluster (persistent:true so the library
 *      does NOT rmdir dataDir on stop — that races Windows taskkill → EBUSY).
 *   3. Isolation across tests: newDatabase() on the SAME server.
 *   4. stop(): await pg.stop(), then best-effort rmdir with bounded EBUSY retry.
 *      Cleanup failure MUST NOT fail tests (orphan temp dirs are acceptable).
 *
 * Does not touch Core EventStore semantics or production runtime.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type LivePgHandle = {
  connectionString: string;
  mode: "env" | "embedded";
  stop: () => Promise<void>;
  /**
   * Create an isolated database on the same server (preferred isolation).
   * Env mode without CREATE DATABASE privilege may return the same URL.
   */
  newDatabase?: () => Promise<string>;
};

/** Bounded wait for Windows to release file locks after postgres process exit. */
async function rmDirWithBusyRetry(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  // Delays (ms): wait for OS handle release after taskkill — not a product sleep.
  const delaysMs = [0, 25, 50, 100, 200, 400, 800, 1600, 3200];
  let last: unknown;
  for (const wait of delaysMs) {
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      last = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      if (
        code !== "EBUSY" &&
        code !== "EPERM" &&
        code !== "ENOTEMPTY" &&
        code !== "EACCES"
      ) {
        // Unexpected cleanup error — log and abandon (do not fail tests)
        console.warn(
          `[live-postgres] cleanup non-busy error for ${dir}:`,
          e instanceof Error ? e.message : e
        );
        return;
      }
    }
  }
  console.warn(
    `[live-postgres] deferred temp cleanup abandoned (Windows lock) ${dir}:`,
    last instanceof Error ? last.message : last
  );
}

async function tryEnvUrl(envUrl: string): Promise<LivePgHandle | null> {
  if (!envUrl.startsWith("postgres")) return null;
  const postgres = (await import("postgres")).default;
  const sql = postgres(envUrl, { max: 1, connect_timeout: 3 });
  try {
    await sql`SELECT 1`;
    return {
      connectionString: envUrl,
      mode: "env",
      stop: async () => {},
      newDatabase: async () => envUrl,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[startLivePostgres] CORE_DATABASE_URL/DATABASE_URL not usable (${msg.slice(0, 120)}). Falling back to embedded-postgres.`
    );
    return null;
  } finally {
    try {
      await sql.end({ timeout: 2 });
    } catch {
      /* ignore */
    }
  }
}

async function startEmbedded(): Promise<LivePgHandle> {
  const EmbeddedPostgres = (await import("embedded-postgres")).default;
  const dataDir = mkdtempSync(path.join(tmpdir(), "ailexsi-v2-pg-"));
  const port = 55000 + Math.floor(Math.random() * 2000);
  const attempts = [
    { createPostgresUser: false as const },
    { createPostgresUser: true as const },
  ];

  let lastErr: unknown;
  for (const opts of attempts) {
    // persistent:true → library stop() does NOT fs.rm(dataDir).
    // We own cleanup after process exit (avoids EBUSY race on Windows).
    const pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "ailexsi_v2",
      password: "ailexsi_v2_dev",
      port,
      persistent: true,
      ...opts,
    });
    try {
      await pg.initialise();
      await pg.start();
      await pg.createDatabase("ailexsi_v2_core");
      let dbSeq = 0;
      const base = `postgres://ailexsi_v2:ailexsi_v2_dev@127.0.0.1:${port}`;
      const connectionString = `${base}/ailexsi_v2_core`;
      let stopped = false;

      return {
        connectionString,
        mode: "embedded",
        newDatabase: async () => {
          dbSeq += 1;
          const name = `ailexsi_v2_iso_${dbSeq}`;
          await pg.createDatabase(name);
          return `${base}/${name}`;
        },
        stop: async () => {
          if (stopped) return;
          stopped = true;
          try {
            await pg.stop();
          } catch (e) {
            // Stop may surface races; still attempt dataDir cleanup.
            console.warn(
              "[live-postgres] pg.stop() error:",
              e instanceof Error ? e.message : e
            );
          }
          // Own cleanup with EBUSY retry (library no longer deletes when persistent)
          await rmDirWithBusyRetry(dataDir);
        },
      };
    } catch (e) {
      lastErr = e;
      try {
        await pg.stop();
      } catch {
        /* ignore */
      }
      try {
        await rmDirWithBusyRetry(dataDir);
      } catch {
        /* ignore */
      }
    }
  }

  throw new Error(
    "VERIFICATION PENDING: cannot start live PostgreSQL " +
      "(set a working CORE_DATABASE_URL or run where embedded-postgres can start). " +
      `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

export async function startLivePostgres(): Promise<LivePgHandle> {
  const envUrl =
    process.env.CORE_DATABASE_URL || process.env.DATABASE_URL || "";
  if (envUrl) {
    const fromEnv = await tryEnvUrl(envUrl);
    if (fromEnv) return fromEnv;
  }
  return startEmbedded();
}
