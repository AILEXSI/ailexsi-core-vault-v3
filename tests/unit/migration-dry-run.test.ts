import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanVault, buildMigrationDryRun } from "@ailexsi/v2-migration";

const root = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url)))
);
const fixture = path.join(root, "fixtures/migration/sample-vault");

describe("migration dry-run", () => {
  it("maps fixture notes to create drafts without Core writes", async () => {
    const report = await scanVault(fixture);
    const dry = buildMigrationDryRun(report);
    expect(dry.schemaVersion).toBe("migration-dry-run-v1");
    expect(dry.coreWrites).toBe(0);
    expect(dry.vaultMutations).toBe(0);
    expect(dry.totals.notes).toBe(2);
    expect(dry.totals.mapToCreate).toBeGreaterThanOrEqual(1);
    const creates = dry.items.filter(
      (i) => i.disposition === "map_to_create_memory"
    );
    for (const c of creates) {
      if (c.disposition !== "map_to_create_memory") continue;
      expect(c.draft.provenance.sourceType).toBe("import");
      expect(c.draft.content.type).toBe("text");
      expect(c.draft.idempotencyKey.startsWith("dry-run:")).toBe(true);
    }
  });
});
