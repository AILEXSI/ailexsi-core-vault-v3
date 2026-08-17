import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

describe("foundation acceptance markers", () => {
  it("documents baselines and contracts", () => {
    const baselines = JSON.parse(
      readFileSync(path.join(root, "config/baselines.json"), "utf8")
    );
    expect(baselines.core.sha).toBe(
      "652d01eb06dd0841c3b475023883675af6dcd698"
    );
    expect(baselines.vaultReference.sha).toBe(
      "061e444389090c54e431b0e8243e82764f2c198e"
    );
    expect(existsSync(path.join(root, "docs/SOURCE-OF-TRUTH.md"))).toBe(true);
    expect(existsSync(path.join(root, "docs/CORE-INTEGRATION.md"))).toBe(true);
    expect(existsSync(path.join(root, "docs/CONTINUITY.md"))).toBe(true);
    expect(existsSync(path.join(root, "docs/MIGRATION.md"))).toBe(true);
    expect(existsSync(path.join(root, "docs/ARCHITECTURE.md"))).toBe(true);
    expect(existsSync(path.join(root, "docs/BASELINES.md"))).toBe(true);
    expect(
      existsSync(path.join(root, "docs/adr/001-source-of-truth.md"))
    ).toBe(true);
    expect(
      existsSync(path.join(root, "packages/command-adapter/src/core-runtime.ts"))
    ).toBe(true);
  });

  it("env template separates CORE and V2 DB URLs without secrets", () => {
    const env = readFileSync(path.join(root, "config/env.example"), "utf8");
    expect(env).toContain("CORE_DATABASE_URL");
    expect(env).toContain("V2_DATABASE_URL");
    expect(env).not.toMatch(/password\s*=\s*[^\s]+/i);
  });

  it("SOURCE-OF-TRUTH forbids canonical FS store", () => {
    const sot = readFileSync(path.join(root, "docs/SOURCE-OF-TRUTH.md"), "utf8");
    expect(sot).toMatch(/No canonical V2 fact may be persisted outside the Core event path/);
    expect(sot).toMatch(/authoritative canonical store/i);
  });

  it("Core checkout is present at pinned SHA when .deps exists", () => {
    const core = path.join(root, ".deps/ailexsi-core");
    if (!existsSync(path.join(core, ".git"))) {
      // setup:core not run — report explicitly (not silent)
      expect.fail(
        "SKIPPED_WITH_REASON: Core checkout missing — run npm run setup:core"
      );
    }
    const head = execSync("git rev-parse HEAD", { cwd: core }).toString().trim();
    expect(head).toBe("652d01eb06dd0841c3b475023883675af6dcd698");
    const dirty = execSync("git status --porcelain", { cwd: core })
      .toString()
      .trim();
    expect(dirty).toBe("");
  });
});
