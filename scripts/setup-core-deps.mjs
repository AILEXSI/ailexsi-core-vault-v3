/**
 * Clone pinned Core (+ optional Vault reference) into .deps/ (gitignored).
 * Does not modify those repositories; detached HEAD at baseline SHA.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const baselines = JSON.parse(
  readFileSync(path.join(root, "config/baselines.json"), "utf8")
);

const deps = path.join(root, ".deps");
mkdirSync(deps, { recursive: true });

function ensureRepo(name, repo, sha) {
  const dir = path.join(deps, name);
  if (!existsSync(path.join(dir, ".git"))) {
    console.log(`Cloning ${repo}...`);
    execSync(`git clone --depth 1 https://github.com/${repo}.git "${dir}"`, {
      stdio: "inherit",
    });
  }
  console.log(`Checking out ${name} @ ${sha}...`);
  execSync(`git fetch --depth 1 origin ${sha}`, { cwd: dir, stdio: "inherit" });
  execSync(`git checkout ${sha}`, { cwd: dir, stdio: "inherit" });
  const head = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
  if (head !== sha) {
    throw new Error(`${name} HEAD ${head} != expected ${sha}`);
  }
  console.log(`OK ${name} = ${head}`);
}

ensureRepo("ailexsi-core", baselines.core.repository, baselines.core.sha);
ensureRepo(
  "ailexsi-core-vault",
  baselines.vaultReference.repository,
  baselines.vaultReference.sha
);

console.log("Core dependency ready (READ ONLY checkout under .deps/).");
