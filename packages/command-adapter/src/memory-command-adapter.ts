/**
 * V2 → Core Memory command adapter.
 *
 * Path:
 *   User/AI → V2 Command → Validation → IdempotencyKey → Core MemoryDomain
 *   → EventStore → Core Projection → V2 Read Model
 *
 * Core Adapter Gate: writes require an Authorized Mutation Context
 * created only by AgencyBoundary.commitCanonical. Direct create/update
 * is rejected. connectome-relation cells only via commitRelation.
 */

import type { MemoryCell, MemoryContent, MemoryVersion, UUID } from "@ailexsi/contracts";
import type { EventStore } from "@ailexsi/eventstore";
import { MemoryDomain } from "@ailexsi/memory";
import {
  AgencyDeniedError,
  consumeMutationContext,
  currentMutationContext,
  type AuthorizedMutationContext,
} from "@ailexsi/v3-harbor";
import type {
  V2CreateMemoryCommand,
  V2UpdateMemoryCommand,
  V2LifecycleCommand,
} from "./types.js";
import {
  validateCreateMemory,
  validateUpdateMemory,
  validateLifecycle,
} from "./validate.js";

export interface MemoryCommandAdapterOptions {
  store: EventStore;
  producer?: string;
  environment?: "development" | "test" | "production";
}

function isConnectomeRelationKind(content: MemoryContent | undefined): boolean {
  if (!content || content.type !== "structured") return false;
  const data = content.structuredData as { kind?: string };
  return data?.kind === "connectome-relation";
}

function denyWrite(
  ctx: AuthorizedMutationContext | null,
  action: string,
  reason: string
): never {
  throw new AgencyDeniedError(
    ctx?.actor ?? { id: "unknown", kind: "system" },
    "CANONICAL_COMMIT",
    reason,
    { code: "EVENTSTORE_WRITE_FORBIDDEN", action, target: ctx?.target }
  );
}

function requireContext(action: string): AuthorizedMutationContext {
  const ctx = currentMutationContext();
  if (!ctx) {
    denyWrite(
      null,
      action,
      "Core Adapter Gate: no Authorized Mutation Context — EventStore write rejected"
    );
  }
  return ctx;
}

/** JSON / ambient fields are not an Authorized Mutation Context. */
function rejectForgedContext(cmd: object, action: string): void {
  const rec = cmd as Record<string, unknown>;
  const nested = rec.context;
  const nestedAuth =
    nested !== null && typeof nested === "object" && (nested as { authorized?: unknown }).authorized === true;
  if (rec.authorized === true || rec.source === "agency" || rec.grantId != null || nestedAuth) {
    denyWrite(
      currentMutationContext(),
      action,
      "Core Adapter Gate: {authorized:true} / {source:agency} / grantId is not an Authorized Mutation Context"
    );
  }
}

export class MemoryCommandAdapter {
  /** Hidden. Only this adapter's authorized path may mutate MemoryDomain. */
  #domain: MemoryDomain;

  constructor(options: MemoryCommandAdapterOptions) {
    this.#domain = new MemoryDomain(
      options.store,
      options.producer ?? "v2-command-adapter",
      options.environment ?? "test"
    );
  }

  async create(cmd: V2CreateMemoryCommand): Promise<MemoryCell> {
    rejectForgedContext(cmd, "adapter.create");
    validateCreateMemory(cmd);
    const ctx = requireContext("adapter.create");
    if (isConnectomeRelationKind(cmd.content)) {
      if (ctx.action !== "relation.commit") {
        denyWrite(
          ctx,
          ctx.action,
          "Connectome relation cells may only be written via commitRelation"
        );
      }
      await this.assertRelationEvidence(cmd.content);
    }
    const cell = await this.#domain.create({
      content: cmd.content,
      context: cmd.context,
      meaning: cmd.meaning,
      provenance: cmd.provenance,
      evidence: cmd.evidence,
      lifecycleState: cmd.lifecycleState,
      idempotencyKey: cmd.idempotencyKey,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      createdBy: cmd.createdBy ?? "v2",
      memoryId: cmd.memoryId,
    });
    consumeMutationContext();
    return cell;
  }

  async get(memoryId: UUID): Promise<MemoryCell | null> {
    return this.#domain.get(memoryId);
  }

  async update(cmd: V2UpdateMemoryCommand): Promise<MemoryCell> {
    rejectForgedContext(cmd, "adapter.update");
    validateUpdateMemory(cmd);
    const ctx = requireContext("adapter.update");
    if (isConnectomeRelationKind(cmd.content)) {
      if (ctx.action !== "relation.commit") {
        denyWrite(
          ctx,
          ctx.action,
          "Connectome relation cells may only be written via commitRelation"
        );
      }
      await this.assertRelationEvidence(cmd.content);
    }
    const cell = await this.#domain.update(cmd.memoryId, {
      content: cmd.content,
      context: cmd.context,
      meaning: cmd.meaning,
      provenance: cmd.provenance,
      evidence: cmd.evidence,
      changeReason: cmd.changeReason,
      idempotencyKey: cmd.idempotencyKey,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      createdBy: cmd.createdBy ?? "v2",
    });
    consumeMutationContext();
    return cell;
  }

  async archive(cmd: V2LifecycleCommand): Promise<MemoryCell> {
    validateLifecycle(cmd);
    requireContext("adapter.archive");
    const cell = await this.#domain.archive(cmd.memoryId, {
      reason: cmd.reason,
      idempotencyKey: cmd.idempotencyKey,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      createdBy: cmd.createdBy ?? "v2",
    });
    consumeMutationContext();
    return cell;
  }

  async restore(cmd: V2LifecycleCommand): Promise<MemoryCell> {
    validateLifecycle(cmd);
    requireContext("adapter.restore");
    const cell = await this.#domain.restore(cmd.memoryId, {
      reason: cmd.reason,
      idempotencyKey: cmd.idempotencyKey,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      createdBy: cmd.createdBy ?? "v2",
    });
    consumeMutationContext();
    return cell;
  }

  async getHistory(memoryId: UUID): Promise<MemoryVersion[]> {
    return this.#domain.getHistory(memoryId);
  }

  /** Expose Core domain for AAS-54 CLEAR → REPLAY tests. */
  clearProjection(): void {
    this.#domain.clearProjection();
  }

  rebuildFromEvents(
    envelopes: Parameters<MemoryDomain["rebuildFromEvents"]>[0]
  ): void {
    this.#domain.rebuildFromEvents(envelopes);
  }

  /**
   * Evidence must include at least one existing Core Memory id that is not from/to.
   * Existence of from/to is not proof. Do not treat citations as grants.
   */
  private async assertRelationEvidence(content: MemoryContent): Promise<void> {
    if (content.type !== "structured") {
      denyWrite(currentMutationContext(), "relation.commit", "Relation cell must be structured");
    }
    const data = content.structuredData as {
      from?: string;
      to?: string;
      evidenceMemoryIds?: string[];
    };
    const from = data.from ?? "";
    const to = data.to ?? "";
    const evidence = Array.isArray(data.evidenceMemoryIds) ? data.evidenceMemoryIds : [];
    const thirdParty = evidence.filter((id) => id && id !== from && id !== to);
    if (thirdParty.length === 0) {
      denyWrite(
        currentMutationContext(),
        "relation.commit",
        "Relation evidence must include an existing Core Memory id that is not from/to"
      );
    }
    for (const id of thirdParty) {
      const cell = await this.#domain.get(id as UUID);
      if (!cell) {
        denyWrite(
          currentMutationContext(),
          "relation.commit",
          `Relation evidence ${id} is not a retrievable Core Memory`
        );
      }
    }
  }
}
