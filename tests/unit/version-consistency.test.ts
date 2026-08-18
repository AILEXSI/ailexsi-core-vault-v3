import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HARBOR_VERSION } from "@ailexsi/v3-harbor";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, rel), "utf8")) as Record<string, unknown>;
}

function cargoVersion(rel: string): string {
  const text = readFileSync(path.join(root, rel), "utf8");
  const m = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m?.[1]) throw new Error(`no version in ${rel}`);
  return m[1];
}

function workspacePackageJsonFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["packages", "apps"]) {
    const base = path.join(root, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const pkg = path.join(base, name, "package.json");
      if (existsSync(pkg) && statSync(pkg).isFile()) {
        out.push(path.relative(root, pkg).replaceAll("\\", "/"));
      }
    }
  }
  return out.sort();
}

describe("V3 product version consistency", () => {
  const declared = readJson("config/version.json");
  const version = declared.version;

  it("declares a single product version", () => {
    expect(declared.product).toBe("AILEXSI Core Vault V3");
    expect(declared.repository).toBe("AILEXSI/ailexsi-core-vault-v3");
    expect(declared.class).toBe("V3");
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(declared.bootstrapTagIsNotProductVersion).toBe(true);
    expect(declared.bootstrapTag).toBe("v3.0.0-v2-baseline");
    expect(String(declared.bootstrapTag)).not.toBe(`v${version}`);
  });

  it("root package.json matches the declared version", () => {
    expect(readJson("package.json").version).toBe(version);
    expect(readJson("package.json").name).toBe("ailexsi-core-vault-v3");
  });

  it("workspace package.json versions match the declared version", () => {
    const files = workspacePackageJsonFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      expect(readJson(rel).version, rel).toBe(version);
    }
  });

  it("desktop / Tauri / Cargo versions match the declared version", () => {
    expect(readJson("apps/desktop/package.json").version).toBe(version);
    expect(readJson("apps/desktop/src-tauri/tauri.conf.json").version).toBe(version);
    expect(cargoVersion("apps/desktop/src-tauri/Cargo.toml")).toBe(version);
  });

  it("Harbor HARBOR_VERSION matches the declared version", () => {
    expect(HARBOR_VERSION).toBe(version);
    const src = readFileSync(path.join(root, "packages/harbor/src/types.ts"), "utf8");
    expect(src).toContain(`export const HARBOR_VERSION = "${version}"`);
  });

  it("acceptance evidence reads v3Version from package.json", () => {
    const gate = readFileSync(path.join(root, "scripts/acceptance-gate.mjs"), "utf8");
    expect(gate).toMatch(/v3Version:\s*JSON\.parse\(readFileSync\(path\.join\(root,\s*"package\.json"/);
  });

  it("Core pin is identical in baselines, CURRENT-STATE, and version-adjacent docs", () => {
    const pin = "652d01eb06dd0841c3b475023883675af6dcd698";
    const baselines = readJson("config/baselines.json");
    expect((baselines.core as { sha: string }).sha).toBe(pin);
    const state = readFileSync(path.join(root, "docs/CURRENT-STATE.md"), "utf8");
    expect(state).toContain(pin);
    const readme = readFileSync(path.join(root, "docs/BASELINES.md"), "utf8");
    expect(readme).toContain(pin);
  });

  it("does not treat inherited v2 module names as a second product version", () => {
    expect(readJson("apps/desktop/package.json").name).toBe("@ailexsi/v2-desktop");
    expect(readJson("packages/command-adapter/package.json").name).toBe(
      "@ailexsi/v2-command-adapter"
    );
    expect(readJson("packages/harbor/package.json").name).toBe("@ailexsi/v3-harbor");
    const notes = declared.notes as string[];
    expect(notes.some((n) => n.includes("@ailexsi/v2-*"))).toBe(true);
  });
});
