import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  hostCommand,
  retrieveMemories,
  assembleMemoryContext,
  cultivationSessionCreate,
  cultivationChat,
  cultivationProposalReject,
  cultivationProposalDefer,
  cultivationProposalAccept,
} from "../../apps/desktop/src/ipc/memory-client";
import type { DesktopHostCommandName } from "../../apps/desktop/src/ipc/memory-api";

describe("Desktop co-creation client surface", () => {
  it("exports hostCommand and cultivation helpers", () => {
    expect(typeof hostCommand).toBe("function");
    expect(typeof retrieveMemories).toBe("function");
    expect(typeof assembleMemoryContext).toBe("function");
    expect(typeof cultivationSessionCreate).toBe("function");
    expect(typeof cultivationChat).toBe("function");
    expect(typeof cultivationProposalReject).toBe("function");
    expect(typeof cultivationProposalDefer).toBe("function");
    expect(typeof cultivationProposalAccept).toBe("function");
  });

  it("command name union includes co-creation surface", () => {
    const names: DesktopHostCommandName[] = [
      "memory.retrieve",
      "memory.context",
      "cultivation.session.create",
      "cultivation.chat",
      "cultivation.proposal.accept",
    ];
    expect(names.length).toBe(5);
  });

  it("Memory UI does not present recorded Core Memory as CANONICAL", () => {
    const root = path.join(process.cwd());
    const memory = readFileSync(
      path.join(root, "apps/desktop/src/components/MemoryPanel.tsx"),
      "utf8"
    );
    const harbor = readFileSync(
      path.join(root, "apps/desktop/src/components/HarborPanel.tsx"),
      "utf8"
    );
    const cult = readFileSync(
      path.join(root, "apps/desktop/src/components/CultivationPanel.tsx"),
      "utf8"
    );
    expect(memory).toMatch(/badge core">RECORDED</);
    expect(memory).not.toMatch(/badge core">CANONICAL</);
    expect(harbor).toMatch(/Core = recorded Memory/);
    expect(harbor).not.toMatch(/Core = canonical/);
    expect(cult).toMatch(/Recorded Memory/);
    expect(cult).not.toMatch(/Canonical Memory \(Core\)/);
    expect(cult).toMatch(/Accept and persist/);
  });
});
