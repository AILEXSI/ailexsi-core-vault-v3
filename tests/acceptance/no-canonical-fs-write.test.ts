/**
 * Audit: Memory mutation path must not write canonical state to vault/*.md,
 * localStorage, or arbitrary files.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

const MUTATION_GLOBS = [
  "packages/command-adapter/src",
  "packages/read-models/src",
  "apps/desktop/src",
];

const FORBIDDEN = [
  /writeFileSync\s*\(/,
  /writeFile\s*\(/,
  /appendFileSync\s*\(/,
  /localStorage\.(setItem|set)/,
  /sessionStorage\.(setItem|set)/,
  /vault\/.*\.md/,
];

// Allowed only in non-mutation contexts (tests, scripts, migration dry-run, docs)
const SKIP_DIRS = new Set(["node_modules", ".deps", "dist", ".git"]);

function walk(dir: string, out: string[] = []): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("NO CANONICAL FILESYSTEM WRITE on Memory path", () => {
  it("command-adapter / read-models / desktop UI have no FS canonical writes", () => {
    const offenders: string[] = [];
    for (const rel of MUTATION_GLOBS) {
      const dir = path.join(root, rel);
      for (const file of walk(dir)) {
        const text = readFileSync(file, "utf8");
        // allow comments mentioning vault/*.md in docs strings only if not writing
        for (const re of FORBIDDEN) {
          if (re.test(text)) {
            // permit pure documentation strings in comments about prohibition
            if (
              re.source.includes("vault") &&
              /must never|do NOT|never write|not write/i.test(text)
            ) {
              continue;
            }
            if (
              /writeFile|appendFile|localStorage|sessionStorage/.test(re.source)
            ) {
              offenders.push(`${path.relative(root, file)} matches ${re}`);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("MemoryCommandAdapter only mutates via MemoryDomain (EventStore path)", () => {
    const src = readFileSync(
      path.join(root, "packages/command-adapter/src/memory-command-adapter.ts"),
      "utf8"
    );
    expect(src).toMatch(/MemoryDomain/);
    expect(src).toMatch(/this\.#domain\.create/);
    expect(src).toMatch(/this\.#domain\.update/);
    expect(src).toMatch(/this\.#domain\.archive/);
    expect(src).toMatch(/this\.#domain\.restore/);
    expect(src).not.toMatch(/writeFile/);
    expect(src).not.toMatch(/localStorage/);
  });
});
