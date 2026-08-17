import { describe, it, expect } from "vitest";
import {
  validateCreateMemory,
  validateUpdateMemory,
  validateLifecycle,
  V2CommandValidationError,
} from "@ailexsi/v2-command-adapter";
import type { Provenance } from "@ailexsi/contracts";

const goodProvenance: Provenance = {
  sourceType: "user",
  capturedAt: "2026-08-09T12:00:00.000Z",
  parentMemoryIds: [],
  evidenceIds: [],
};

describe("command validation", () => {
  it("accepts valid create", () => {
    expect(() =>
      validateCreateMemory({
        content: { type: "text", text: "hello" },
        provenance: goodProvenance,
        idempotencyKey: "k1",
      })
    ).not.toThrow();
  });

  it("rejects create without idempotencyKey", () => {
    expect(() =>
      validateCreateMemory({
        content: { type: "text", text: "hello" },
        provenance: goodProvenance,
        idempotencyKey: "",
      })
    ).toThrow(V2CommandValidationError);
  });

  it("rejects create with invalid provenance", () => {
    expect(() =>
      validateCreateMemory({
        content: { type: "text", text: "hello" },
        provenance: {
          sourceType: "user",
          capturedAt: "not-a-ts",
          parentMemoryIds: [],
          evidenceIds: [],
        },
        idempotencyKey: "k2",
      })
    ).toThrow(V2CommandValidationError);
  });

  it("rejects update without memoryId", () => {
    expect(() =>
      validateUpdateMemory({
        memoryId: "",
        content: { type: "text", text: "x" },
        idempotencyKey: "k3",
      })
    ).toThrow(V2CommandValidationError);
  });

  it("rejects lifecycle without key", () => {
    expect(() =>
      validateLifecycle({
        memoryId: "11111111-1111-4111-8111-111111111111",
        idempotencyKey: "  ",
      })
    ).toThrow(V2CommandValidationError);
  });
});
