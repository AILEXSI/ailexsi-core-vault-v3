/**
 * DesktopHost-only Session Actor bind. Not exported from @ailexsi/v3-harbor.
 */
import { AgencyDeniedError } from "./agency.js";
import type { AgencyBoundary } from "./agency-boundary.js";
import type { HarborActor } from "./types.js";

const BOUND = new WeakMap<AgencyBoundary, HarborActor>();

export function bindAgencySessionActor(boundary: AgencyBoundary, actor: HarborActor): void {
  if (BOUND.has(boundary)) {
    throw new AgencyDeniedError(
      actor,
      "CANONICAL_COMMIT",
      "Session Actor already attached",
      { code: "PERMISSION_ESCALATION_BLOCKED", action: "session" }
    );
  }
  BOUND.set(boundary, actor);
}

export function boundSessionActor(boundary: AgencyBoundary): HarborActor | null {
  return BOUND.get(boundary) ?? null;
}
