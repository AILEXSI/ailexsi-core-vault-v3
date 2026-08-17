import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(root, ".deps", "ailexsi-core");

export default defineConfig({
  resolve: {
    alias: {
      "@ailexsi/v2-command-adapter": path.join(root, "packages/command-adapter/src/index.ts"),
      "@ailexsi/v2-read-models": path.join(root, "packages/read-models/src/index.ts"),
      "@ailexsi/v2-cultivation": path.join(root, "packages/cultivation/src/index.ts"),
      "@ailexsi/v2-continuity": path.join(root, "packages/continuity/src/index.ts"),
      "@ailexsi/v2-migration": path.join(root, "packages/migration/src/index.ts"),
      "@ailexsi/v2-connectome": path.join(root, "packages/connectome/src/index.ts"),
      "@ailexsi/v2-test-kit": path.join(root, "packages/test-kit/src/index.ts"),
      // Core baseline (READ ONLY checkout) — not vendored into V3 source
      "@ailexsi/contracts": path.join(core, "packages/contracts/src/index.ts"),
      "@ailexsi/memory": path.join(core, "packages/core/memory/src/index.ts"),
      "@ailexsi/eventstore": path.join(core, "packages/infrastructure/eventstore/src/index.ts"),
      "@ailexsi/persistence": path.join(
        core,
        "packages/infrastructure/persistence/src/index.ts"
      ),
      "@ailexsi/projections": path.join(
        core,
        "packages/infrastructure/projections/src/index.ts"
      ),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
