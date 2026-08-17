import { describe, it, expect } from "vitest";
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
});
