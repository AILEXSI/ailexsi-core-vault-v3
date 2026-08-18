import { describe, it, expect, beforeEach } from "vitest";
import {
  DesktopHost,
  resetDesktopHostForTests,
  getDesktopHost,
  invokeDesktopCommand,
} from "@ailexsi/v2-command-adapter";

describe("DesktopHost boundary (Slice A)", () => {
  beforeEach(() => {
    resetDesktopHostForTests();
  });

  it("commands fail explicitly when host not started (no InMemory fallback)", async () => {
    const host = getDesktopHost();
    expect(host.isRunning).toBe(false);
    await expect(
      invokeDesktopCommand("memory.create", {
        content: { type: "text", text: "x" },
        provenance: {
          sourceType: "user",
          capturedAt: "2026-08-09T00:00:00.000Z",
          parentMemoryIds: [],
          evidenceIds: [],
        },
        idempotencyKey: "k",
      })
    ).rejects.toThrow(/not started|No silent InMemory|No session actor/i);
  });

  it("createCoreRuntime still refuses missing database URL", async () => {
    const host = new DesktopHost();
    const prevCore = process.env.CORE_DATABASE_URL;
    const prevDb = process.env.DATABASE_URL;
    delete process.env.CORE_DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(host.start({})).rejects.toThrow(/CORE_DATABASE_URL|required/i);
    } finally {
      if (prevCore !== undefined) process.env.CORE_DATABASE_URL = prevCore;
      if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
    }
  });
});
