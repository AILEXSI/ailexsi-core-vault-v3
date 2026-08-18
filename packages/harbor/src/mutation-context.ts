/**
 * Authorized Mutation Context — created only by AgencyBoundary.commitCanonical.
 * One operation, then consumed. Not constructible from command JSON.
 */
import type { AuthorizationGrant } from "./agency.js";
import type { HarborActor } from "./types.js";

export interface AuthorizedMutationContext {
  readonly actor: HarborActor;
  readonly grant: AuthorizationGrant;
  readonly action: string;
  readonly target: string;
}

type Slot = {
  ctx: AuthorizedMutationContext;
  consumed: boolean;
};

let slot: Slot | null = null;

export function installMutationContext(ctx: AuthorizedMutationContext): void {
  if (slot && !slot.consumed) {
    throw new Error("Authorized Mutation Context already active");
  }
  slot = { ctx, consumed: false };
}

export function currentMutationContext(): AuthorizedMutationContext | null {
  if (!slot || slot.consumed) return null;
  return slot.ctx;
}

export function consumeMutationContext(): AuthorizedMutationContext {
  if (!slot || slot.consumed) {
    throw new Error("Authorized Mutation Context missing or already consumed");
  }
  slot.consumed = true;
  return slot.ctx;
}

export function clearMutationContext(): void {
  slot = null;
}
