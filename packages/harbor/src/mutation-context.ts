/**
 * Operation-bound Authorized Mutation Context.
 * Created only by AgencyBoundary.commitCanonical. Passed into execute.
 * Not ambient. Not serialized. One consume, then unusable.
 */
import { AgencyDeniedError } from "./agency.js";
import type { AuthorizationGrant } from "./agency.js";
import type { HarborActor } from "./types.js";

export interface AuthorizedMutationContext {
  readonly actor: HarborActor;
  readonly grant: AuthorizationGrant;
  readonly action: string;
  readonly target: string;
}

class BoundMutationContext implements AuthorizedMutationContext {
  readonly actor: HarborActor;
  readonly grant: AuthorizationGrant;
  readonly action: string;
  readonly target: string;
  #alive = true;
  #consumed = false;

  constructor(
    actor: HarborActor,
    grant: AuthorizationGrant,
    action: string,
    target: string
  ) {
    this.actor = actor;
    this.grant = grant;
    this.action = action;
    this.target = target;
  }

  consume(): void {
    if (!this.#alive || this.#consumed) {
      throw new AgencyDeniedError(
        this.actor,
        "CANONICAL_COMMIT",
        "Authorized Mutation Context missing, consumed, or invalidated",
        { code: "EVENTSTORE_WRITE_FORBIDDEN", action: this.action, target: this.target }
      );
    }
    this.#consumed = true;
  }

  invalidate(): void {
    this.#alive = false;
  }
}

export function createBoundMutationContext(
  actor: HarborActor,
  grant: AuthorizationGrant,
  action: string,
  target: string
): AuthorizedMutationContext {
  return new BoundMutationContext(actor, grant, action, target);
}

export function consumeBoundMutationContext(ctx: unknown): AuthorizedMutationContext {
  if (!(ctx instanceof BoundMutationContext)) {
    throw new AgencyDeniedError(
      { id: "unknown", kind: "system" },
      "CANONICAL_COMMIT",
      "Core Adapter Gate: no Authorized Mutation Context — EventStore write rejected",
      { code: "EVENTSTORE_WRITE_FORBIDDEN", action: "adapter" }
    );
  }
  ctx.consume();
  return ctx;
}

export function invalidateBoundMutationContext(ctx: unknown): void {
  if (ctx instanceof BoundMutationContext) ctx.invalidate();
}
