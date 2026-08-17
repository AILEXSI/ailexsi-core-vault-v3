import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanVault } from "@ailexsi/v2-migration";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const fixture = path.join(root, "fixtures/migration/sample-vault");

describe("migration scanner", () => {
  it("fixture → scanner → normalized report (deterministic fingerprint)", async () => {
    const r1 = await scanVault(fixture);
    const r2 = await scanVault(fixture);

    expect(r1.schemaVersion).toBe("migration-report-v1");
    expect(r1.coreWrites).toBe(0);
    expect(r1.noteCount).toBe(2);
    expect(r1.relationCount).toBe(2);
    expect(r1.byType.fact).toBe(1);
    expect(r1.byType.insight).toBe(1);
    expect(r1.contentFingerprint).toBe(r2.contentFingerprint);
    expect(r1.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    // no production Core writes
    expect(r1.coreWrites).toBe(0);
  });
});
