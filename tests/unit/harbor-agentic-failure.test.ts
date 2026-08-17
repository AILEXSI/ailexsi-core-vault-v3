import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import {
  AgencyDeniedError,
  HarborService,
  capabilitiesFor,
} from "@ailexsi/v3-harbor";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HUMAN = { id: "martin", kind: "human" as const, authorizeCanonical: true };
const AI = { id: "agent", kind: "ai" as const };

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: "2026-08-17T12:00:00.000Z",
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

describe("Agentic failure model", () => {
  it("BLOCKED: agent cannot grant itself canonical write", () => {
    expect(() =>
      capabilitiesFor({ id: "agent", kind: "ai", authorizeCanonical: true })
    ).toThrow(AgencyDeniedError);
    const harbor = new HarborService({ corePin: "c", vaultReferenceSha: "v" });
    expect(() =>
      harbor.decideProposal("missing", "ACCEPTED", AI)
    ).toThrow();
  });

  it("BLOCKED: AI confirmImport never writes derived or canonical", async () => {
    const harbor = new HarborService({
      corePin: "652d01eb06dd0841c3b475023883675af6dcd698",
      vaultReferenceSha: "061e444",
    });
    const pkg = harbor.exportPackage([], HUMAN);
    const other = new HarborService({
      corePin: "652d01eb06dd0841c3b475023883675af6dcd698",
      vaultReferenceSha: "061e444",
    });
    const s = other.beginImport(pkg, AI);
    other.validateImport(s.id, AI);
    other.previewImport(s.id, AI);
    other.detectImportConflicts(s.id, [], AI);
    expect(() => other.confirmImport(s.id, AI)).toThrow(/human/i);
    expect(other.epistemic.size).toBe(0);
  });

  it("FLAGGED not canonicalized: AI proposal vs canonical preference", async () => {
    const store = new InMemoryEventStore();
    const adapter = new MemoryCommandAdapter({ store, environment: "test" });
    const cell = await adapter.create({
      content: { type: "text", text: "user prefers tea" },
      provenance: provenance(),
      idempotencyKey: randomUUID(),
    });
    const harbor = new HarborService({ corePin: "c", vaultReferenceSha: "v" });
    harbor.scan([cell], HUMAN);
    const p = await harbor.propose(AI, {
      text: "user prefers coffee — conflict",
      sourceMemoryIds: [cell.identity.id],
    });
    expect(p.proposalType).toBe("conflicting_evidence");
    expect(p.status).toBe("PROPOSED");
    expect(p.resultingEventIds).toEqual([]);
    expect(store.count()).toBe(1);
    const conflicts = harbor.scan(
      [
        cell,
        {
          ...cell,
          identity: { ...cell.identity, id: "ghost-coffee" },
          content: { type: "text", text: "user prefers coffee" },
        },
      ],
      HUMAN
    );
    expect(conflicts.some((c) => c.resolution === "UNRESOLVED")).toBe(true);
  });

  it("DETECTED: required security tests and acceptance contract still present", () => {
    const required = [
      "tests/unit/harbor-agentic-failure.test.ts",
      "tests/acceptance/dual-write-guard.test.ts",
      "tests/acceptance/no-canonical-fs-write.test.ts",
      "tests/acceptance/foundation-gate.test.ts",
      "scripts/acceptance-gate.mjs",
    ];
    for (const rel of required) {
      expect(existsSync(path.join(root, rel)), `missing ${rel}`).toBe(true);
    }
    const sot = readFileSync(path.join(root, "docs/SOURCE-OF-TRUTH.md"), "utf8");
    expect(sot).toMatch(/No canonical V2 fact may be persisted outside the Core event path/);
    const gate = readFileSync(path.join(root, "scripts/acceptance-gate.mjs"), "utf8");
    expect(gate).toMatch(/NO DUAL-WRITE PATH DETECTED/);
    expect(gate).not.toMatch(/\bit\.skip\(|\bdescribe\.skip\(|\bxit\(/);
  });

  it("BLOCKED: Harbor has no API to rewrite evidence runs", () => {
    const src = readFileSync(path.join(root, "packages/harbor/src/service.ts"), "utf8");
    expect(src).not.toMatch(/evidence\/runs/);
    expect(src).not.toMatch(/writeFileSync/);
    expect(src).not.toMatch(/unlinkSync|rmSync/);
  });

  it("INFERRED: derived connectome edge without evidence is not canonical", async () => {
    const { buildHarborConnectome } = await import("@ailexsi/v3-harbor");
    const graph = buildHarborConnectome({
      memories: [],
    });
    expect(graph.class).toBe("V3-DERIVED");
    expect(graph.edges.every((e) => e.origin !== "CANONICAL_REFERENCE" || e.evidence || e.type === "RELATES_TO")).toBe(
      true
    );
  });
});
