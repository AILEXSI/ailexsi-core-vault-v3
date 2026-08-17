/**
 * V2 → Core Memory command adapter.
 *
 * Path:
 *   User/AI → V2 Command → Validation → IdempotencyKey → Core MemoryDomain
 *   → EventStore → Core Projection → V2 Read Model
 *
 * V2 never writes canonical facts outside this path.
 */

import type { MemoryCell, MemoryVersion, UUID } from "@ailexsi/contracts";
import type { EventStore } from "@ailexsi/eventstore";
import { MemoryDomain } from "@ailexsi/memory";
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

export class MemoryCommandAdapter {
  readonly domain: MemoryDomain;

  constructor(options: MemoryCommandAdapterOptions) {
    this.domain = new MemoryDomain(
      options.store,
      options.producer ?? "v2-command-adapter",
      options.environment ?? "test"
    );
  }

  async create(cmd: V2CreateMemoryCommand): Promise<MemoryCell> {
    validateCreateMemory(cmd);
    return this.domain.create({
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
  }

  async get(memoryId: UUID): Promise<MemoryCell | null> {
    return this.domain.get(memoryId);
  }

  async update(cmd: V2UpdateMemoryCommand): Promise<MemoryCell> {
    validateUpdateMemory(cmd);
    return this.domain.update(cmd.memoryId, {
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
  }

  async archive(cmd: V2LifecycleCommand): Promise<MemoryCell> {
    validateLifecycle(cmd);
    return this.domain.archive(cmd.memoryId, {
      reason: cmd.reason,
      idempotencyKey: cmd.idempotencyKey,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      createdBy: cmd.createdBy ?? "v2",
    });
  }

  async restore(cmd: V2LifecycleCommand): Promise<MemoryCell> {
    validateLifecycle(cmd);
    return this.domain.restore(cmd.memoryId, {
      reason: cmd.reason,
      idempotencyKey: cmd.idempotencyKey,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      createdBy: cmd.createdBy ?? "v2",
    });
  }

  async getHistory(memoryId: UUID): Promise<MemoryVersion[]> {
    return this.domain.getHistory(memoryId);
  }

  /** Expose Core domain for AAS-54 CLEAR → REPLAY tests. */
  clearProjection(): void {
    this.domain.clearProjection();
  }

  rebuildFromEvents(
    envelopes: Parameters<MemoryDomain["rebuildFromEvents"]>[0]
  ): void {
    this.domain.rebuildFromEvents(envelopes);
  }
}
