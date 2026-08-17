/**
 * Resolve a Postgres URL for the desktop host.
 * 1) CORE_DATABASE_URL / DATABASE_URL if reachable
 * 2) embedded-postgres (same as live tests)
 */

import { startLivePostgres, type LivePgHandle } from "./live-postgres.js";

export type DesktopDbHandle = {
  connectionString: string;
  mode: "env" | "embedded";
  stop: () => Promise<void>;
};

export async function resolveDesktopDatabase(): Promise<DesktopDbHandle> {
  const live = await startLivePostgres();
  return {
    connectionString: live.connectionString,
    mode: live.mode,
    stop: live.stop,
  };
}

export type { LivePgHandle };
