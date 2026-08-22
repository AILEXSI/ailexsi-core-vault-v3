import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { itemIdFor, sha256, sourceIdFor } from "./ids.js";
import { normalizeRoot, resolveUnderRoot, toPosixRelative } from "./path.js";
import type { DockDiscoverResult, LocalSource, SourceItem } from "./types.js";

const TEXT_EXT = new Set([".txt", ".md", ".json"]);
const SKIP_DIRS = new Set([".git", "node_modules"]);

function kindOf(ext: string): SourceItem["kind"] {
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

async function walkFiles(dir: string, recursive: boolean): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error(`dock discover cannot read directory: ${dir}`);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!recursive) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walkFiles(full, true)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export async function itemFromRelative(
  absDir: string,
  relativePath: string
): Promise<{ source: LocalSource; item: SourceItem }> {
  const root = normalizeRoot(absDir);
  const abs = resolveUnderRoot(root, relativePath);
  const st = await stat(abs);
  if (!st.isFile()) throw new Error("dock preview/segment requires a file under root");
  const rel = toPosixRelative(root, abs);
  const ext = path.extname(abs).toLowerCase();
  const kind = kindOf(ext);
  const contentHash =
    kind === "text" ? sha256(await readFile(abs)) : sha256(`${rel}|${st.size}|${st.mtimeMs}`);
  const source: LocalSource = {
    id: sourceIdFor(root.split(path.sep).join("/")),
    type: "LOCAL_DIRECTORY",
    locator: root,
    displayName: path.basename(root) || root,
    discoveredAt: new Date().toISOString(),
  };
  return {
    source,
    item: {
      sourceId: source.id,
      itemId: itemIdFor(source.id, rel, contentHash),
      locator: rel,
      filename: path.basename(abs),
      extension: ext.replace(/^\./, ""),
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
      contentHash,
      kind: kind === "text" ? "text" : "binary",
    },
  };
}

export async function discover(
  absDir: string,
  options: { recursive?: boolean } = {}
): Promise<DockDiscoverResult> {
  const root = normalizeRoot(absDir);
  const recursive = options.recursive !== false;
  const files = (await walkFiles(root, recursive)).sort((a, b) =>
    toPosixRelative(root, a).localeCompare(toPosixRelative(root, b))
  );
  const discoveredAt = new Date().toISOString();
  const source: LocalSource = {
    id: sourceIdFor(root.split(path.sep).join("/")),
    type: "LOCAL_DIRECTORY",
    locator: root,
    displayName: path.basename(root) || root,
    discoveredAt,
  };
  const items: SourceItem[] = [];
  for (const abs of files) {
    const st = await stat(abs);
    const rel = toPosixRelative(root, abs);
    const ext = path.extname(abs).toLowerCase();
    const kind = kindOf(ext);
    let contentHash: string | undefined;
    if (kind === "text") {
      const buf = await readFile(abs);
      contentHash = sha256(buf);
    } else {
      contentHash = sha256(`${rel}|${st.size}|${st.mtimeMs}`);
    }
    items.push({
      sourceId: source.id,
      itemId: itemIdFor(source.id, rel, contentHash),
      locator: rel,
      filename: path.basename(abs),
      extension: ext.replace(/^\./, ""),
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
      contentHash,
      kind: kind === "text" ? "text" : "binary",
    });
  }
  return { source, items };
}
