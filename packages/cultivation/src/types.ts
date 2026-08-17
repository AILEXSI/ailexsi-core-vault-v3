/**
 * Cultivation Chat types.
 *
 * AI output is NEVER automatically canonical.
 * Only accepted proposals may become Core commands.
 */

import type { MemoryContent, Provenance, UUID } from "@ailexsi/contracts";

export type ProposalStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "edited"
  | "deferred";

export type ProposalKind = "create_memory" | "update_memory" | "note";

export interface CultivationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  /** EPHEMERAL — chat turns are not Core events. */
  class: "EPHEMERAL";
}

export interface MemoryMutationProposal {
  id: string;
  kind: "create_memory" | "update_memory";
  status: ProposalStatus;
  createdAt: string;
  source: "ollama" | "mock" | "human";
  rationale: string;
  /** Proposed payload — not yet canonical. */
  draft: {
    memoryId?: UUID;
    content: MemoryContent;
    provenance: Provenance;
    changeReason?: string;
  };
  /** Set when accepted/edited and a Core command was issued. */
  acceptedCommandIdempotencyKey?: string;
  acceptedMemoryId?: UUID;
}

export interface ChatProposal {
  id: string;
  kind: "note";
  status: ProposalStatus;
  createdAt: string;
  source: "ollama" | "mock" | "human";
  text: string;
}

export type CultivationProposal = MemoryMutationProposal | ChatProposal;

export interface LlmProvider {
  complete(prompt: string, context: string): Promise<string>;
}

export interface CultivationSession {
  id: string;
  messages: CultivationMessage[];
  proposals: CultivationProposal[];
}
