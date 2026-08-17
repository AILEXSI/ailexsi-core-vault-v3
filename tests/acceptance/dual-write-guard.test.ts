/**
 * Dual-write guard: fail if V2 source invents a co-equal canonical FS store.
 * Heuristic static scan — not a full security audit.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url)))
);

const SCAN_DIRS = ["packages", "apps", "scripts"];
const EXT = new Set([".ts", ".tsx", ".mjs", ".js"]);

// Patterns that strongly suggest dual-write / FS-as-canonical
const FORBIDDEN = [
  /writeFileSync\s*\([^)]*canonical/i,
  /canonicalStore\s*=\s*['"`].*\.md/i,
  /dualWrite\s*\(/i,
  /saveCanonicalToFs\s*\(/i,
  /persistCanonicalMarkdown\s*\(/i,
  /EventStore.*writeFile|writeFile.*EventStore/i,
];

function walk(dir: string, out: string[] = []): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "target") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.has(path.extname(name))) out.push(full);
  }
  return out;
}

describe("dual-write guard", () => {
  it("finds no dual-write / FS-canonical patterns in V2 source", () => {
    const hits: string[] = [];
    for (const d of SCAN_DIRS) {
      const dir = path.join(root, d);
      for (const file of walk(dir)) {
        const text = readFileSync(file, "utf8");
        for (const re of FORBIDDEN) {
          if (re.test(text)) {
            hits.push(`${path.relative(root, file)} ~ ${re}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("SOURCE-OF-TRUTH forbids dual-write", () => {
    const sot = readFileSync(path.join(root, "docs/SOURCE-OF-TRUTH.md"), "utf8");
    expect(sot).toMatch(/No hidden dual-write/i);
    expect(sot).toMatch(/Core event path/i);
  });
});
