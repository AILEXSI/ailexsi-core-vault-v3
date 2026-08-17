/**
 * Cultivation service — proposal loop.
 *
 * Core-backed context → LLM → EPHEMERAL proposal → human decision →
 * acceptCanonical only → MemoryCommandAdapter → EventStore.
 *
 * Sessions and proposals are EPHEMERAL (in-process Map). Not a second SoT.
 */

import { randomUUID } from "node:crypto";
import type { MemoryCell, UUID } from "@ailexsi/contracts";
import type { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import type {
  CultivationMessage,
  CultivationProposal,
  CultivationSession,
  LlmProvider,
  MemoryMutationProposal,
  ProposalStatus,
} from "./types.js";

function nowTs(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

export type CultivationChatOptions = {
  /** Core-backed MemoryCell[] already resolved by caller (preferred). */
  contextMemories?: MemoryCell[];
  /** When set, draft is update_memory for this id. */
  targetMemoryId?: UUID;
  /** Proposal source label (mock | ollama | human). */
  source?: MemoryMutationProposal["source"];
};

export class CultivationService {
  private sessions = new Map<string, CultivationSession>();

  constructor(
    private readonly llm: LlmProvider,
    private readonly memoryAdapter?: MemoryCommandAdapter
  ) {}

  createSession(): CultivationSession {
    const session: CultivationSession = {
      id: randomUUID(),
      messages: [],
      proposals: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): CultivationSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Build AI context string from Core-backed cells (read-only presentation).
   * Caller must resolve cells via Core query/adapter — not a parallel SoT.
   */
  assembleContext(memories: MemoryCell[]): string {
    const lines = memories.map((m) => {
      const text =
        m.content.type === "text" ? m.content.text : JSON.stringify(m.content);
      return `- [${m.identity.shortId}] v${m.currentVersion} (${m.lifecycle.state}): ${text}`;
    });
    return [
      "You are AILEXSI Cultivation assistant.",
      "Propose memory updates only; never claim canonical writes.",
      "Known Core-backed memories:",
      ...lines,
    ].join("\n");
  }

  async chat(
    sessionId: string,
    userText: string,
    options: CultivationChatOptions | MemoryCell[] = {}
  ): Promise<{ message: CultivationMessage; proposal: MemoryMutationProposal }> {
    // Back-compat: third arg as MemoryCell[]
    const opts: CultivationChatOptions = Array.isArray(options)
      ? { contextMemories: options }
      : options;
    const contextMemories = opts.contextMemories ?? [];

    const session = this.requireSession(sessionId);
    const userMsg: CultivationMessage = {
      id: randomUUID(),
      role: "user",
      content: userText,
      createdAt: nowTs(),
      class: "EPHEMERAL",
    };
    session.messages.push(userMsg);

    const context = this.assembleContext(contextMemories);
    const raw = await this.llm.complete(userText, context);

    const assistantMsg: CultivationMessage = {
      id: randomUUID(),
      role: "assistant",
      content: raw,
      createdAt: nowTs(),
      class: "EPHEMERAL",
    };
    session.messages.push(assistantMsg);

    const source = opts.source ?? "mock";
    const isUpdate = !!opts.targetMemoryId;
    const proposal: MemoryMutationProposal = {
      id: randomUUID(),
      kind: isUpdate ? "update_memory" : "create_memory",
      status: "pending",
      createdAt: nowTs(),
      source,
      rationale: raw.slice(0, 500),
      draft: {
        memoryId: opts.targetMemoryId,
        content: { type: "text", text: raw.trim() || userText },
        provenance: {
          sourceType: "agent",
          sourceId: "cultivation",
          capturedAt: nowTs(),
          parentMemoryIds: contextMemories.map((m) => m.identity.id),
          evidenceIds: [],
        },
        changeReason: isUpdate ? "cultivation-proposal-update" : undefined,
      },
    };
    session.proposals.push(proposal);
    return { message: assistantMsg, proposal };
  }

  /**
   * Reject / defer without touching EventStore.
   * Cannot set accepted via this method.
   */
  setProposalStatus(
    sessionId: string,
    proposalId: string,
    status: Exclude<ProposalStatus, "accepted" | "edited">
  ): CultivationProposal {
    const session = this.requireSession(sessionId);
    const p = session.proposals.find((x) => x.id === proposalId);
    if (!p) throw new Error(`Proposal ${proposalId} not found`);
    if (p.status === "accepted" || p.status === "edited") {
      throw new Error(`Cannot change status of ${p.status} proposal`);
    }
    p.status = status;
    return p;
  }

  /**
   * Accept a memory mutation proposal → Core command path only.
   * Invalid/double accept throws and must not write.
   */
  async acceptCanonical(
    sessionId: string,
    proposalId: string,
    options?: { editedText?: string; idempotencyKey?: string }
  ): Promise<{ proposal: MemoryMutationProposal; cell: MemoryCell }> {
    if (!this.memoryAdapter) {
      throw new Error("MemoryCommandAdapter required for acceptCanonical");
    }
    const session = this.requireSession(sessionId);
    const p = session.proposals.find((x) => x.id === proposalId);
    if (!p || p.kind === "note") {
      throw new Error(`Memory mutation proposal ${proposalId} not found`);
    }
    if (p.status === "accepted" || p.status === "edited") {
      throw new Error("Proposal already accepted");
    }
    if (p.status === "rejected" || p.status === "deferred") {
      throw new Error(`Cannot accept proposal in status ${p.status}`);
    }
    if (p.status !== "pending") {
      throw new Error(`Cannot accept proposal in status ${p.status}`);
    }

    const text =
      options?.editedText ??
      (p.draft.content.type === "text" ? p.draft.content.text : "");
    const content =
      p.draft.content.type === "text"
        ? { type: "text" as const, text }
        : p.draft.content;

    const key = options?.idempotencyKey ?? randomUUID();
    let cell: MemoryCell;

    if (p.kind === "update_memory") {
      if (!p.draft.memoryId) {
        throw new Error("update_memory proposal missing draft.memoryId");
      }
      cell = await this.memoryAdapter.update({
        memoryId: p.draft.memoryId,
        content,
        changeReason: p.draft.changeReason ?? "cultivation-accepted",
        provenance: p.draft.provenance,
        idempotencyKey: key,
        createdBy: "cultivation",
      });
    } else {
      cell = await this.memoryAdapter.create({
        content,
        provenance: p.draft.provenance,
        idempotencyKey: key,
        createdBy: "cultivation",
      });
    }

    p.status = options?.editedText !== undefined ? "edited" : "accepted";
    p.acceptedCommandIdempotencyKey = key;
    p.acceptedMemoryId = cell.identity.id;
    return { proposal: p, cell };
  }

  private requireSession(id: string): CultivationSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session ${id} not found`);
    return s;
  }
}
