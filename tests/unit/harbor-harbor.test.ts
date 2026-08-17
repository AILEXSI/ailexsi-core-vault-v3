import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import { InMemoryEventStore } from "@ailexsi/v2-test-kit";
import type { Provenance } from "@ailexsi/contracts";
import {
  AgencyDeniedError,
  EpistemicTransitionError,
  HarborService,
  MockHarborProvider,
  capabilitiesFor,
  confirmAsUserAsserted,
  defaultEpistemicForCoreMemory,
  verifyHarborExport,
} from "@ailexsi/v3-harbor";

function provenance(): Provenance {
  return {
    sourceType: "user",
    capturedAt: "2026-08-17T12:00:00.000Z",
    parentMemoryIds: [],
    evidenceIds: [],
  };
}

const HUMAN = { id: "martin", kind: "human" as const, authorizeCanonical: true };
const AI = { id: "grok", kind: "ai" as const };

async function twoPrefMemories() {
  const store = new InMemoryEventStore();
  const adapter = new MemoryCommandAdapter({ store, environment: "test" });
  const a = await adapter.create({
    content: { type: "text", text: "user prefers tea" },
    provenance: provenance(),
    idempotencyKey: randomUUID(),
  });
  const b = await adapter.create({
    content: { type: "text", text: "user prefers coffee" },
    provenance: provenance(),
    idempotencyKey: randomUUID(),
  });
  return { store, adapter, a, b };
}

describe("Harbor epistemic + agency", () => {
  it("never converts inference to FACT", () => {
    const rec = {
      ...defaultEpistemicForCoreMemory("m1", "2026-08-17T12:00:00.000Z"),
      status: "INFERRED" as const,
      confidence: 0.71,
    };
    expect(() => confirmAsUserAsserted(rec, HUMAN, "2026-08-17T12:01:00.000Z").status).not.toBe(
      "FACT"
    );
    const confirmed = confirmAsUserAsserted(rec, HUMAN, "2026-08-17T12:01:00.000Z");
    expect(confirmed.status).toBe("USER_ASSERTED");
    expect(() => confirmAsUserAsserted(rec, AI, "2026-08-17T12:01:00.000Z")).toThrow(
      EpistemicTransitionError
    );
  });

  it("AI cannot grant itself canonical or external authority", () => {
    expect(capabilitiesFor(AI)).toEqual([
      "READ_ONLY",
      "DERIVED_WRITE",
      "CANONICAL_PROPOSAL",
    ]);
    expect(() =>
      capabilitiesFor({ id: "rogue", kind: "ai", authorizeCanonical: true })
    ).toThrow(AgencyDeniedError);
  });
});

describe("Harbor contradictions + context + reflection", () => {
  it("detects preference contradiction without deciding", async () => {
    const { store, a, b } = await twoPrefMemories();
    const harbor = new HarborService({
      corePin: "652d01eb06dd0841c3b475023883675af6dcd698",
      vaultReferenceSha: "061e444389090c54e431b0e8243e82764f2c198e",
    });
    const cells = [a, b];
    const found = harbor.scan(cells, AI);
    expect(found).toHaveLength(1);
    expect(found[0]!.resolution).toBe("UNRESOLVED");
    expect(store.count()).toBe(2);

    expect(() => harbor.resolveContradiction(found[0]!.id, "CONFIRM_A", AI)).toThrow(
      /human/i
    );

    const resolved = harbor.resolveContradiction(found[0]!.id, "BOTH_CONTEXTUAL", HUMAN);
    expect(resolved.resolution).toBe("BOTH_CONTEXTUAL");
    expect(store.count()).toBe(2);
  });

  it("context package is inspectable with inclusion reasons", async () => {
    const { a, b } = await twoPrefMemories();
    const harbor = new HarborService({
      corePin: "652d01e",
      vaultReferenceSha: "061e444",
    });
    harbor.scan([a, b], HUMAN);
    const pack = harbor.assemble(
      [a, b],
      { query: "prefers", maxItems: 10, maxChars: 4000, selectedMemoryIds: [a.identity.id] },
      HUMAN
    );
    expect(pack.items.length).toBeGreaterThan(0);
    expect(pack.items.every((i) => i.reason && i.reasonDetail)).toBe(true);
    expect(pack.contradictions.length).toBe(1);
    expect(pack.reproducibleKey).toMatch(/^[a-f0-9]{64}$/);
    const again = harbor.assemble(
      [a, b],
      { query: "prefers", maxItems: 10, maxChars: 4000, selectedMemoryIds: [a.identity.id] },
      HUMAN
    );
    expect(again.reproducibleKey).toBe(pack.reproducibleKey);
  });

  it("reflection remains derived and cites evidence", async () => {
    const { a, b } = await twoPrefMemories();
    const harbor = new HarborService({ corePin: "c", vaultReferenceSha: "v" });
    harbor.scan([a, b], HUMAN);
    const r = harbor.reflect([a, b], HUMAN);
    expect(r.status).toBe("DERIVED");
    expect(r.findings.some((f) => f.kind === "contradiction" || f.kind === "preference_shift")).toBe(
      true
    );
    expect(r.findings.every((f) => f.evidenceMemoryIds.length > 0)).toBe(true);
  });
});

describe("Harbor proposals + export", () => {
  it("I don't know is a successful proposal type, not an error", async () => {
    const harbor = new HarborService(
      { corePin: "c", vaultReferenceSha: "v" },
      new MockHarborProvider()
    );
    const p = await harbor.propose(AI, {
      text: "I don't know what they want",
      sourceMemoryIds: [],
    });
    expect(p.proposalType).toBe("i_dont_know");
    expect(p.status).toBe("PROPOSED");
    expect(p.resultingEventIds).toEqual([]);
  });

  it("AI cannot accept a proposal; reject does not mint events", async () => {
    const harbor = new HarborService({ corePin: "c", vaultReferenceSha: "v" });
    const p = await harbor.propose(AI, { text: "remember tea", sourceMemoryIds: [] });
    expect(() => harbor.decideProposal(p.proposalId, "ACCEPTED", AI)).toThrow(AgencyDeniedError);
    const rejected = harbor.decideProposal(p.proposalId, "REJECTED", HUMAN);
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.resultingEventIds).toEqual([]);
  });

  it("export is inspectable; one-shot import does not write", () => {
    const harbor = new HarborService({
      corePin: "652d01eb06dd0841c3b475023883675af6dcd698",
      vaultReferenceSha: "061e444389090c54e431b0e8243e82764f2c198e",
    });
    const pkg = harbor.exportPackage(["mem-1"], HUMAN);
    expect(verifyHarborExport(pkg)).toBe(true);
    expect(pkg.integrity.sha256).toMatch(/^[a-f0-9]{64}$/);
    const other = new HarborService({ corePin: "x", vaultReferenceSha: "y" });
    const scanned = other.importPackage(pkg, HUMAN);
    expect(scanned.stage).toBe("SCANNED");
    expect(other.epistemic.size).toBe(0);
  });
});
