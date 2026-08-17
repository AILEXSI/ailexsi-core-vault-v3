import type { EpistemicRecord, EpistemicStatus, HarborActor } from "./types.js";
import { HARBOR_CLASS } from "./types.js";

const ALLOWED: Record<EpistemicStatus, EpistemicStatus[]> = {
  FACT: ["SUPERSEDED"],
  USER_ASSERTED: ["SUPERSEDED", "REJECTED"],
  AI_PROPOSED: ["USER_ASSERTED", "REJECTED", "SUPERSEDED", "UNCERTAIN"],
  DERIVED: ["INFERRED", "USER_ASSERTED", "REJECTED", "SUPERSEDED", "UNCERTAIN"],
  INFERRED: ["USER_ASSERTED", "REJECTED", "SUPERSEDED", "UNCERTAIN"],
  UNCERTAIN: ["USER_ASSERTED", "REJECTED", "INFERRED", "SUPERSEDED"],
  REJECTED: ["SUPERSEDED"],
  SUPERSEDED: [],
};

export class EpistemicTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpistemicTransitionError";
  }
}

export function defaultEpistemicForCoreMemory(memoryId: string, now: string): EpistemicRecord {
  return {
    memoryId,
    status: "FACT",
    confidence: 1,
    evidenceEventIds: [],
    lastChangedAt: now,
    changedBy: { id: "core", kind: "system" },
    note: "Default overlay: Core-backed memory is treated as FACT until Harbor records otherwise.",
    class: HARBOR_CLASS,
  };
}

export function inferredRecord(
  memoryId: string,
  actor: HarborActor,
  evidenceEventIds: string[],
  confidence: number,
  now: string,
  note?: string
): EpistemicRecord {
  return {
    memoryId,
    status: "INFERRED",
    confidence,
    evidenceEventIds,
    lastChangedAt: now,
    changedBy: actor,
    note,
    class: HARBOR_CLASS,
  };
}

/**
 * Human confirmation of an inference/proposal.
 * Never produces FACT. Silent conversion is forbidden.
 */
export function confirmAsUserAsserted(
  current: EpistemicRecord,
  actor: HarborActor,
  now: string
): EpistemicRecord {
  if (actor.kind !== "human") {
    throw new EpistemicTransitionError("Only a human may confirm an inference as USER_ASSERTED");
  }
  if (current.status === "FACT") {
    throw new EpistemicTransitionError("FACT is Core-canonical overlay; do not re-label via Harbor confirm");
  }
  if (current.status === "REJECTED" || current.status === "SUPERSEDED") {
    throw new EpistemicTransitionError(`Cannot confirm ${current.status} as USER_ASSERTED`);
  }
  if (!ALLOWED[current.status].includes("USER_ASSERTED") && current.status !== "USER_ASSERTED") {
    throw new EpistemicTransitionError(`Cannot transition ${current.status} → USER_ASSERTED`);
  }
  return {
    ...current,
    status: "USER_ASSERTED",
    lastChangedAt: now,
    changedBy: actor,
    note: "Explicit human confirmation. Not silently converted to FACT.",
    class: HARBOR_CLASS,
  };
}

export function rejectRecord(
  current: EpistemicRecord,
  actor: HarborActor,
  now: string
): EpistemicRecord {
  if (!ALLOWED[current.status].includes("REJECTED")) {
    throw new EpistemicTransitionError(`Cannot reject ${current.status}`);
  }
  return {
    ...current,
    status: "REJECTED",
    lastChangedAt: now,
    changedBy: actor,
    class: HARBOR_CLASS,
  };
}

export function assertNotSilentFact(from: EpistemicStatus, to: EpistemicStatus): void {
  if (to === "FACT" && from !== "FACT") {
    throw new EpistemicTransitionError("Never convert inference/proposal into FACT");
  }
}
