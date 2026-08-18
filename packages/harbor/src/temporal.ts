import type { TemporalValidity } from "./types.js";
import { HARBOR_CLASS } from "./types.js";

export function temporalFromMemory(input: {
  memoryId: string;
  createdAt?: string;
  confirmedAt?: string;
  archivedAt?: string;
  lifecycle?: string;
  superseded?: boolean;
}): TemporalValidity {
  const lastConfirmed = input.confirmedAt ?? input.createdAt;
  const validFrom = input.createdAt ?? input.confirmedAt;
  const ended = input.lifecycle === "archived" || input.superseded === true;
  const validUntil = ended ? input.archivedAt ?? lastConfirmed : undefined;
  return {
    memoryId: input.memoryId,
    validFrom,
    validUntil,
    lastConfirmed,
    reviewDue: undefined,
    // Lifecycle/timestamps are not truth. is_true/was_true are not derived from existence.
    temporalStatus: "unknown",
    class: HARBOR_CLASS,
  };
}
