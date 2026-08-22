import { readFile, stat } from "node:fs/promises";
import type { SourceItem } from "./types.js";
import { resolveUnderRoot } from "./path.js";

export const DEFAULT_PREVIEW_BYTES = 64_000;

export async function preview(
  rootPath: string,
  item: Pick<SourceItem, "locator" | "kind">,
  maxBytes = DEFAULT_PREVIEW_BYTES
): Promise<string | null> {
  if (item.kind !== "text") return null;
  const abs = resolveUnderRoot(rootPath, item.locator);
  const st = await stat(abs);
  const n = Math.max(0, Math.min(maxBytes, st.size));
  const buf = await readFile(abs);
  const slice = buf.subarray(0, n);
  return slice.toString("utf8");
}
