/**
 * Production-ish Core runtime for V2.
 *
 * Uses Core packages only:
 *   createDb + migrate (@ailexsi/persistence)
 *   PostgresEventStore (@ailexsi/eventstore)
 *   MemoryDomain via MemoryCommandAdapter
 *   MemoryProjection + ProjectionEngine (@ailexsi/projections)
 *
 * InMemoryEventStore is for unit tests only — never the production path.
 */

import { createDb, migrate, type Database } from "@ailexsi/persistence";
import { PostgresEventStore } from "@ailexsi/eventstore";
import type { EventStore } from "@ailexsi/eventstore";
import { MemoryProjection, ProjectionEngine } from "@ailexsi/projections";
import { MemoryCommandAdapter } from "./memory-command-adapter.js";
import { MemoryQueryService } from "./memory-query-service.js";
import { ContinuityService } from "./continuity-service.js";
import { MemoryReadModel } from "@ailexsi/v2-read-models";

export interface CoreRuntime {
  database: Database;
  store: EventStore;
  adapter: MemoryCommandAdapter;
  memoryProjection: MemoryProjection;
  projectionEngine: ProjectionEngine;
  readModel: MemoryReadModel;
  /** Core-backed query surface (read-only). */
  queries: MemoryQueryService;
  continuity: ContinuityService;
  /** Close Postgres client. */
  close: () => Promise<void>;
  /**
   * Rebuild projections from EventStore (AAS-54 path) and sync V2 read model.
   */
  rebuildAll: () => Promise<void>;
}

export interface CreateCoreRuntimeOptions {
  /**
   * Core EventStore connection string.
   * Defaults to CORE_DATABASE_URL (never invent production credentials).
   */
  connectionString?: string;
  producer?: string;
  environment?: "development" | "test" | "production";
  /** When false, skip migrate() (caller already migrated). Default true. */
  migrate?: boolean;
  /** Continuity package provenance pins (defaults: env or well-known freeze pins). */
  coreBaselineSha?: string;
  vaultReferenceSha?: string;
}

export function resolveCoreDatabaseUrl(
  explicit?: string
): string | undefined {
  return (
    explicit ??
    process.env.CORE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    undefined
  );
}

/**
 * Create a Core-backed runtime. Throws if no connection string is available.
 * This is the only supported production mutation path for V2 Memory.
 */
export async function createCoreRuntime(
  options: CreateCoreRuntimeOptions = {}
): Promise<CoreRuntime> {
  const url = resolveCoreDatabaseUrl(options.connectionString);
  if (!url) {
    throw new Error(
      "CORE_DATABASE_URL (or DATABASE_URL) is required for createCoreRuntime. " +
        "InMemoryEventStore is test-only and must not be used as production path."
    );
  }

  const database = createDb(url);
  // Connectivity probe
  await database.client`SELECT 1`;

  if (options.migrate !== false) {
    await migrate(database.client);
  }

  const store = new PostgresEventStore(database);
  const env =
    options.environment ??
    (process.env.AILEXSI_ENV === "production"
      ? "production"
      : process.env.AILEXSI_ENV === "development"
        ? "development"
        : "test");

  const adapter = new MemoryCommandAdapter({
    store,
    producer: options.producer ?? "v2-command-adapter",
    environment: env,
  });

  const memoryProjection = new MemoryProjection();
  const projectionEngine = new ProjectionEngine();
  projectionEngine.register(memoryProjection);

  const readModel = new MemoryReadModel();

  async function rebuildAll(): Promise<void> {
    await projectionEngine.rebuildFromEventStore(store);
    readModel.rebuildFromCoreProjection(memoryProjection);
    // Also rebuild MemoryDomain internal projection for command consistency
    const stream: Awaited<ReturnType<EventStore["getStream"]>> = [];
    let after = 0;
    for (;;) {
      const page = await store.getStream({ afterSequence: after, limit: 1000 });
      if (page.length === 0) break;
      stream.push(...page);
      const last = page[page.length - 1]!;
      after = last.sequenceId ?? after + page.length;
      if (page.length < 1000) break;
    }
    adapter.rebuildFromEvents(stream);
  }

  const queries = new MemoryQueryService({
    store,
    adapter,
    readModel,
    rebuildAll,
  });

  const coreBaselineSha =
    options.coreBaselineSha ??
    process.env.AILEXSI_CORE_PIN ??
    "652d01eb06dd0841c3b475023883675af6dcd698";
  const vaultReferenceSha =
    options.vaultReferenceSha ??
    process.env.AILEXSI_VAULT_PIN ??
    "061e444389090c54e431b0e8243e82764f2c198e";

  const continuity = new ContinuityService({
    queries,
    coreBaselineSha,
    vaultReferenceSha,
  });

  return {
    database,
    store,
    adapter,
    memoryProjection,
    projectionEngine,
    readModel,
    queries,
    continuity,
    close: async () => {
      await database.client.end({ timeout: 5 });
    },
    rebuildAll,
  };
}

/**
 * Probe whether live Core Postgres is reachable without leaving connections open.
 */
export async function probeCoreDatabase(
  connectionString?: string
): Promise<{ ok: boolean; detail: string }> {
  const url = resolveCoreDatabaseUrl(connectionString);
  if (!url) {
    return {
      ok: false,
      detail: "CORE_DATABASE_URL not set",
    };
  }
  const safe = url.replace(/:[^:@/]+@/, ":***@");
  try {
    const database = createDb(url);
    await database.client`SELECT 1`;
    await database.client.end({ timeout: 2 });
    return { ok: true, detail: safe };
  } catch (e) {
    return {
      ok: false,
      detail: `${safe} — ${e instanceof Error ? e.message : String(e)}`.slice(
        0,
        240
      ),
    };
  }
}
