import { describe, it, expect } from "vitest";
import {
  createCoreRuntime,
  resolveCoreDatabaseUrl,
} from "@ailexsi/v2-command-adapter";

describe("core runtime boundary", () => {
  it("resolveCoreDatabaseUrl prefers CORE_DATABASE_URL", () => {
    const prevCore = process.env.CORE_DATABASE_URL;
    const prevDb = process.env.DATABASE_URL;
    process.env.CORE_DATABASE_URL = "postgres://core/db";
    process.env.DATABASE_URL = "postgres://legacy/db";
    expect(resolveCoreDatabaseUrl()).toBe("postgres://core/db");
    process.env.CORE_DATABASE_URL = prevCore;
    process.env.DATABASE_URL = prevDb;
  });

  it("createCoreRuntime refuses to start without connection string", async () => {
    const prevCore = process.env.CORE_DATABASE_URL;
    const prevDb = process.env.DATABASE_URL;
    delete process.env.CORE_DATABASE_URL;
    delete process.env.DATABASE_URL;
    await expect(createCoreRuntime({ connectionString: undefined })).rejects.toThrow(
      /CORE_DATABASE_URL/
    );
    process.env.CORE_DATABASE_URL = prevCore;
    process.env.DATABASE_URL = prevDb;
  });

  it("createCoreRuntime does not fall back to InMemoryEventStore", async () => {
    // Explicit empty must not silently use a fake production store
    await expect(
      createCoreRuntime({ connectionString: "" })
    ).rejects.toThrow(/required for createCoreRuntime/);
  });
});
