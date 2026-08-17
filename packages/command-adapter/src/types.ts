/**
 * V2 command boundary types.
 * Canonical mutations always flow into Core MemoryDomain.
 */

import type {
  MemoryContent,
  MemoryContext,
  MemoryMeaning,
  Provenance,
  Evidence,
  LifecycleState,
  UUID,
} from "@ailexsi/contracts";

export interface V2CreateMemoryCommand {
  content: MemoryContent;
  context?: MemoryContext;
  meaning?: MemoryMeaning;
  provenance: Provenance;
  evidence?: Evidence[];
  lifecycleState?: LifecycleState;
  idempotencyKey: string;
  correlationId?: UUID;
  causationId?: UUID;
  createdBy?: string;
  memoryId?: UUID;
}

export interface V2UpdateMemoryCommand {
  memoryId: UUID;
  content?: MemoryContent;
  context?: MemoryContext;
  meaning?: MemoryMeaning;
  provenance?: Provenance;
  evidence?: Evidence[];
  changeReason?: string;
  idempotencyKey: string;
  correlationId?: UUID;
  causationId?: UUID;
  createdBy?: string;
}

export interface V2LifecycleCommand {
  memoryId: UUID;
  reason?: string;
  idempotencyKey: string;
  correlationId?: UUID;
  causationId?: UUID;
  createdBy?: string;
}

export type V2CommandValidationIssue = {
  field: string;
  message: string;
};

export class V2CommandValidationError extends Error {
  readonly code = "V2_COMMAND_VALIDATION" as const;
  constructor(public readonly issues: V2CommandValidationIssue[]) {
    super(
      `V2 command validation failed: ${issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`
    );
    this.name = "V2CommandValidationError";
  }
}
