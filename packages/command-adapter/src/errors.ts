/**
 * V2 error surface — maps Core/EventStore failures to explicit categories.
 * Never collapse to "Something went wrong".
 */

import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  EventValidationError,
  OrderingViolationError,
} from "@ailexsi/contracts";
import { V2CommandValidationError } from "./types.js";

export type V2ErrorCode =
  | "VALIDATION"
  | "IDEMPOTENCY_CONFLICT"
  | "CONCURRENCY_CONFLICT"
  | "ORDERING_VIOLATION"
  | "PERSISTENCE"
  | "PROJECTION"
  | "CONNECTION"
  | "NOT_FOUND"
  | "UNKNOWN";

export interface ClassifiedV2Error {
  code: V2ErrorCode;
  message: string;
  causeName?: string;
}

export function classifyV2Error(err: unknown): ClassifiedV2Error {
  if (err instanceof V2CommandValidationError) {
    return {
      code: "VALIDATION",
      message: err.message,
      causeName: err.name,
    };
  }
  if (err instanceof EventValidationError) {
    return {
      code: "VALIDATION",
      message: err.message,
      causeName: err.name,
    };
  }
  if (err instanceof IdempotencyConflictError) {
    return {
      code: "IDEMPOTENCY_CONFLICT",
      message: err.message,
      causeName: err.name,
    };
  }
  if (err instanceof ConcurrencyConflictError) {
    return {
      code: "CONCURRENCY_CONFLICT",
      message: err.message,
      causeName: err.name,
    };
  }
  if (err instanceof OrderingViolationError) {
    return {
      code: "ORDERING_VIOLATION",
      message: err.message,
      causeName: err.name,
    };
  }

  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : undefined;

  if (/not found/i.test(msg)) {
    return { code: "NOT_FOUND", message: msg, causeName: name };
  }
  if (
    /ECONNREFUSED|ENOTFOUND|connect |timeout|CORE_DATABASE_URL|connection/i.test(
      msg
    )
  ) {
    return { code: "CONNECTION", message: msg, causeName: name };
  }
  if (/projection|rebuild/i.test(msg)) {
    return { code: "PROJECTION", message: msg, causeName: name };
  }
  if (/postgres|sql|persist|event.?store|append/i.test(msg)) {
    return { code: "PERSISTENCE", message: msg, causeName: name };
  }

  return { code: "UNKNOWN", message: msg, causeName: name };
}

export function formatV2Error(err: unknown): string {
  const c = classifyV2Error(err);
  return `[${c.code}] ${c.message}`;
}
