import { describe, it, expect } from "vitest";
import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  EventValidationError,
} from "@ailexsi/contracts";
import {
  classifyV2Error,
  formatV2Error,
  V2CommandValidationError,
} from "@ailexsi/v2-command-adapter";

describe("V2 error classification", () => {
  it("maps validation errors", () => {
    expect(
      classifyV2Error(new V2CommandValidationError([{ field: "x", message: "bad" }]))
        .code
    ).toBe("VALIDATION");
    expect(
      classifyV2Error(new EventValidationError("nope")).code
    ).toBe("VALIDATION");
  });

  it("maps idempotency and concurrency", () => {
    expect(
      classifyV2Error(new IdempotencyConflictError("k")).code
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      classifyV2Error(new ConcurrencyConflictError("a", 2, 3)).code
    ).toBe("CONCURRENCY_CONFLICT");
  });

  it("maps connection failures", () => {
    expect(
      classifyV2Error(new Error("connect ECONNREFUSED 127.0.0.1:5433")).code
    ).toBe("CONNECTION");
  });

  it("format includes code", () => {
    expect(formatV2Error(new EventValidationError("x"))).toMatch(
      /^\[VALIDATION\]/
    );
  });
});
