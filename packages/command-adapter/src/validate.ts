/**
 * V2-side command validation (pre-Core).
 * Core still validates Provenance / TemporalMetadata / EventStore rules.
 */

import {
  ProvenanceSchema,
  MemoryContentSchema,
} from "@ailexsi/contracts";
import type {
  V2CreateMemoryCommand,
  V2UpdateMemoryCommand,
  V2LifecycleCommand,
  V2CommandValidationIssue,
} from "./types.js";
import { V2CommandValidationError } from "./types.js";

function requireIdempotencyKey(
  key: string | undefined,
  issues: V2CommandValidationIssue[]
): void {
  if (!key || key.trim().length === 0) {
    issues.push({
      field: "idempotencyKey",
      message: "idempotencyKey is required and must be non-empty",
    });
  }
}

export function validateCreateMemory(cmd: V2CreateMemoryCommand): void {
  const issues: V2CommandValidationIssue[] = [];
  requireIdempotencyKey(cmd.idempotencyKey, issues);

  const content = MemoryContentSchema.safeParse(cmd.content);
  if (!content.success) {
    issues.push({
      field: "content",
      message: content.error.message,
    });
  }

  const prov = ProvenanceSchema.safeParse(cmd.provenance);
  if (!prov.success) {
    issues.push({
      field: "provenance",
      message: prov.error.message,
    });
  }

  if (issues.length > 0) throw new V2CommandValidationError(issues);
}

export function validateUpdateMemory(cmd: V2UpdateMemoryCommand): void {
  const issues: V2CommandValidationIssue[] = [];
  requireIdempotencyKey(cmd.idempotencyKey, issues);

  if (!cmd.memoryId || cmd.memoryId.trim().length === 0) {
    issues.push({ field: "memoryId", message: "memoryId is required" });
  }

  if (cmd.content !== undefined) {
    const content = MemoryContentSchema.safeParse(cmd.content);
    if (!content.success) {
      issues.push({ field: "content", message: content.error.message });
    }
  }

  if (cmd.provenance !== undefined) {
    const prov = ProvenanceSchema.safeParse(cmd.provenance);
    if (!prov.success) {
      issues.push({ field: "provenance", message: prov.error.message });
    }
  }

  if (issues.length > 0) throw new V2CommandValidationError(issues);
}

export function validateLifecycle(cmd: V2LifecycleCommand): void {
  const issues: V2CommandValidationIssue[] = [];
  requireIdempotencyKey(cmd.idempotencyKey, issues);
  if (!cmd.memoryId || cmd.memoryId.trim().length === 0) {
    issues.push({ field: "memoryId", message: "memoryId is required" });
  }
  if (issues.length > 0) throw new V2CommandValidationError(issues);
}
