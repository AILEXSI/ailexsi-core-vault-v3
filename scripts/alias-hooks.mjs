/**
 * Node ESM resolve hook — map @ailexsi/* to V2 packages + Core pin checkout.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = path.join(ROOT, ".deps", "ailexsi-core");

const aliases = {
  "@ailexsi/v2-command-adapter": path.join(
    ROOT,
    "packages/command-adapter/src/index.ts"
  ),
  "@ailexsi/v2-read-models": path.join(
    ROOT,
    "packages/read-models/src/index.ts"
  ),
  "@ailexsi/v2-test-kit": path.join(ROOT, "packages/test-kit/src/index.ts"),
  "@ailexsi/v2-connectome": path.join(ROOT, "packages/connectome/src/index.ts"),
  "@ailexsi/v3-harbor": path.join(ROOT, "packages/harbor/src/index.ts"),
  "@ailexsi/v3-dock": path.join(ROOT, "packages/dock/src/index.ts"),
  "@ailexsi/contracts": path.join(core, "packages/contracts/src/index.ts"),
  "@ailexsi/memory": path.join(core, "packages/core/memory/src/index.ts"),
  "@ailexsi/eventstore": path.join(
    core,
    "packages/infrastructure/eventstore/src/index.ts"
  ),
  "@ailexsi/persistence": path.join(
    core,
    "packages/infrastructure/persistence/src/index.ts"
  ),
  "@ailexsi/projections": path.join(
    core,
    "packages/infrastructure/projections/src/index.ts"
  ),
};

export async function resolve(specifier, context, nextResolve) {
  if (aliases[specifier]) {
    const target = aliases[specifier];
    if (!existsSync(target)) {
      return nextResolve(specifier, context);
    }
    return {
      shortCircuit: true,
      url: pathToFileURL(target).href,
    };
  }
  return nextResolve(specifier, context);
}
