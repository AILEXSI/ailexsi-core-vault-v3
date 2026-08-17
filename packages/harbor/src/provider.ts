import { createHash, randomUUID } from "node:crypto";
import type { ProviderInvocation } from "./types.js";
import { HARBOR_CLASS } from "./types.js";

export type HarborProviderOp =
  | "generateProposal"
  | "summarize"
  | "reflect"
  | "classify"
  | "embed"
  | "reasonAboutContext";

export interface HarborProvider {
  readonly name: string;
  readonly model: string;
  readonly modelVersion: string;
  invoke(op: HarborProviderOp, input: string, contextIds: string[]): Promise<string>;
}

export class MockHarborProvider implements HarborProvider {
  readonly name = "mock";
  readonly model: string;
  readonly modelVersion = "0";

  constructor(model = "harbor-mock") {
    this.model = model;
  }

  async invoke(op: HarborProviderOp, input: string, _contextIds: string[]): Promise<string> {
    if (op === "generateProposal") {
      const low = input.toLowerCase();
      if (low.includes("don't know") || low.includes("dont know")) {
        return "I don't know. Insufficient evidence to propose a memory mutation.";
      }
      if (low.includes("conflict")) {
        return "Conflicting evidence. No action recommended until the user resolves the contradiction.";
      }
      return `Derived proposal from: ${input.slice(0, 200)}`;
    }
    if (op === "embed") {
      return JSON.stringify([0.01, 0.02, 0.03]);
    }
    return `[${op}] ${input.slice(0, 240)}`;
  }
}

export function recordInvocation(
  provider: HarborProvider,
  op: HarborProviderOp,
  input: string,
  output: string,
  contextIds: string[],
  timestamp: string
): ProviderInvocation {
  return {
    id: randomUUID(),
    provider: provider.name,
    model: provider.model,
    modelVersion: provider.modelVersion,
    operation: op,
    timestamp,
    contextIds,
    inputHash: createHash("sha256").update(input).digest("hex"),
    outputHash: createHash("sha256").update(output).digest("hex"),
    class: HARBOR_CLASS,
  };
}
