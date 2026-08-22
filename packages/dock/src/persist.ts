/**
 * Optional JSON dock index. Same atomic-write style as Harbor derived-index.
 * Never EventStore. Never Core Memory.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DOCK_INDEX_SCHEMA, type DockDiscoverResult } from "./types.js";

export function defaultDockIndexDir(): string {
  return path.resolve("data", "dock-index");
}

export function saveDockIndex(result: DockDiscoverResult, persistDir = defaultDockIndexDir()): void {
  mkdirSync(persistDir, { recursive: true });
  const file = path.join(persistDir, "index.json");
  const tmp = `${file}.tmp`;
  const body =
    JSON.stringify(
      {
        schemaVersion: DOCK_INDEX_SCHEMA,
        kind: "dock-index",
        class: "V3-DERIVED",
        note: "Not EventStore. Not Memory. Not a Grant.",
        source: result.source,
        items: result.items,
      },
      null,
      2
    ) + "\n";
  writeFileSync(tmp, body, "utf8");
  try {
    renameSync(tmp, file);
  } catch {
    if (existsSync(file)) unlinkSync(file);
    renameSync(tmp, file);
  }
}

export function loadDockIndex(persistDir = defaultDockIndexDir()): DockDiscoverResult | null {
  const file = path.join(persistDir, "index.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as DockDiscoverResult & {
      schemaVersion?: string;
    };
    if (parsed.schemaVersion && parsed.schemaVersion !== DOCK_INDEX_SCHEMA) return null;
    if (!parsed.source || !Array.isArray(parsed.items)) return null;
    return { source: parsed.source, items: parsed.items };
  } catch {
    return null;
  }
}
