import type { Capability, HarborActor } from "./types.js";

export class AgencyDeniedError extends Error {
  constructor(
    readonly actor: HarborActor,
    readonly capability: Capability,
    message?: string
  ) {
    super(message ?? `Actor ${actor.id} (${actor.kind}) denied ${capability}`);
    this.name = "AgencyDeniedError";
  }
}

const AI_DEFAULT: Capability[] = ["READ_ONLY", "DERIVED_WRITE", "CANONICAL_PROPOSAL"];
const HUMAN_DEFAULT: Capability[] = [
  "READ_ONLY",
  "DERIVED_WRITE",
  "CANONICAL_PROPOSAL",
  "CANONICAL_COMMIT",
  "EXTERNAL_ACTION",
];
const SYSTEM_DEFAULT: Capability[] = ["READ_ONLY", "DERIVED_WRITE"];

export function capabilitiesFor(actor: HarborActor): Capability[] {
  if (actor.kind === "human") {
    const caps = [...HUMAN_DEFAULT];
    if (actor.authorizeCanonical === false) {
      return caps.filter((c) => c !== "CANONICAL_COMMIT");
    }
    if (actor.authorizeExternal === false) {
      return caps.filter((c) => c !== "EXTERNAL_ACTION");
    }
    return caps;
  }
  if (actor.kind === "ai") {
    const caps = [...AI_DEFAULT];
    if (actor.authorizeCanonical) {
      throw new AgencyDeniedError(
        actor,
        "CANONICAL_COMMIT",
        "AI cannot grant itself CANONICAL_COMMIT"
      );
    }
    if (actor.authorizeExternal) {
      throw new AgencyDeniedError(
        actor,
        "EXTERNAL_ACTION",
        "AI cannot grant itself EXTERNAL_ACTION"
      );
    }
    return caps;
  }
  return [...SYSTEM_DEFAULT];
}

export function assertCapability(actor: HarborActor, capability: Capability): void {
  const caps = capabilitiesFor(actor);
  if (!caps.includes(capability)) {
    throw new AgencyDeniedError(actor, capability);
  }
}

export function isAuditableAction(capability: Capability): boolean {
  return capability === "CANONICAL_COMMIT" || capability === "EXTERNAL_ACTION";
}
