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
import { AgencyDeniedError, type AuthorizedMutationContext } from "@ailexsi/v3-harbor";
import { consumeBoundMutationContext } from "../../harbor/src/mutation-context.js";
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

/** Relation citations come from the Authorized Mutation Context, not the caller. */
function stampRelationProvenance(
  content: MemoryContent,
  ctx: AuthorizedMutationContext
): MemoryContent {
  if (!isConnectomeRelationKind(content) || content.type !== "structured") return content;
  return {
    ...content,
    structuredData: {
      ...(content.structuredData as Record<string, unknown>),
      grantId: ctx.grant.grantId,
      authorizedById: ctx.actor.id,
    },
  };
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

function requireContext(ctx: unknown, action: string): AuthorizedMutationContext {
  try {
    return consumeBoundMutationContext(ctx);
  } catch (err) {
    if (err instanceof AgencyDeniedError) {
      denyWrite(null, action, err.message);
    }
    throw err;
  }
}

/** JSON / ambient fields are not an Authorized Mutation Context. */
function rejectForgedContext(cmd: object, action: string): void {
  const rec = cmd as Record<string, unknown>;
  const nested = rec.context;
  const nestedAuth =
    nested !== null && typeof nested === "object" && (nested as { authorized?: unknown }).authorized === true;
  if (rec.authorized === true || rec.source === "agency" || rec.grantId != null || nestedAuth) {
    denyWrite(
      null,
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

  async create(cmd: V2CreateMemoryCommand, mutation?: AuthorizedMutationContext): Promise<MemoryCell> {
    rejectForgedContext(cmd, "adapter.create");
    validateCreateMemory(cmd);
    const ctx = requireContext(mutation, "adapter.create");
    if (isConnectomeRelationKind(cmd.content)) {
      if (ctx.action !== "relation.commit") {
        denyWrite(
          ctx,
          ctx.action,
          "Connectome relation cells may only be written via commitRelation"
        );
      }
      await this.assertRelationEvidence(cmd.content, ctx);
    }
    const content = stampRelationProvenance(cmd.content, ctx);
    const cell = await this.#domain.create({
      content,
      context: cmd.context,
      meaning: cmd.meaning,
      provenance: cmd.provenance,
      evidence: cmd.evidence,
      lifecycleState: cmd.lifecycleState,
      idempotencyKey: cmd.idempotencyKey,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      createdBy: ctx.actor.id,
      memoryId: cmd.memoryId,
    });
    return cell;
  }

  async get(memoryId: UUID): Promise<MemoryCell | null> {
    return this.#domain.get(memoryId);
  }

  async update(cmd: V2UpdateMemoryCommand, mutation?: AuthorizedMutationContext): Promise<MemoryCell> {
    rejectForgedContext(cmd, "adapter.update");
    validateUpdateMemory(cmd);
    const ctx = requireContext(mutation, "adapter.update");
    if (isConnectomeRelationKind(cmd.content)) {
      if (ctx.action !== "relation.commit") {
        denyWrite(
          ctx,
          ctx.action,
          "Connectome relation cells may only be written via commitRelation"
        );
      }
      await this.assertRelationEvidence(cmd.content, ctx);
    }
    const content = stampRelationProvenance(cmd.content, ctx);
    const cell = await this.#domain.update(cmd.memoryId, {
      content,
      context: cmd.context,
      meaning: cmd.meaning,
      provenance: cmd.provenance,
      evidence: cmd.evidence,
      changeReason: cmd.changeReason,
      idempotencyKey: cmd.idempotencyKey,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      createdBy: ctx.actor.id,
    });
    return cell;
  }

  async archive(cmd: V2LifecycleCommand, mutation?: AuthorizedMutationContext): Promise<MemoryCell> {
    validateLifecycle(cmd);
    const ctx = requireContext(mutation, "adapter.archive");
    const cell = await this.#domain.archive(cmd.memoryId, {
      reason: cmd.reason,
      idempotencyKey: cmd.idempotencyKey,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      createdBy: ctx.actor.id,
    });
    return cell;
  }

  async restore(cmd: V2LifecycleCommand, mutation?: AuthorizedMutationContext): Promise<MemoryCell> {
    validateLifecycle(cmd);
    const ctx = requireContext(mutation, "adapter.restore");
    const cell = await this.#domain.restore(cmd.memoryId, {
      reason: cmd.reason,
      idempotencyKey: cmd.idempotencyKey,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      createdBy: ctx.actor.id,
    });
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
  private async assertRelationEvidence(
    content: MemoryContent,
    ctx: AuthorizedMutationContext
  ): Promise<void> {
    if (content.type !== "structured") {
      denyWrite(ctx, "relation.commit", "Relation cell must be structured");
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
        ctx,
        "relation.commit",
        "Relation evidence must include an existing Core Memory id that is not from/to"
      );
    }
    for (const id of thirdParty) {
      const cell = await this.#domain.get(id as UUID);
      if (!cell) {
        denyWrite(
          ctx,
          "relation.commit",
          `Relation evidence ${id} is not a retrievable Core Memory`
        );
      }
    }
  }
}
