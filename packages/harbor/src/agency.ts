import { randomUUID } from "node:crypto";
import { HARBOR_CLASS, type ArtifactProvenance, type Capability, type HarborActor, type HarborActorKind } from "./types.js";

export type DenialCode =
  | "MISSING_CAPABILITY"
  | "AI_SELF_GRANT_BLOCKED"
  | "HUMAN_AUTHORIZATION_REQUIRED"
  | "PROPOSAL_IS_NOT_COMMIT"
  | "EVIDENCE_IMMUTABLE"
  | "ACCEPTANCE_CRITERIA_IMMUTABLE"
  | "CANONICAL_HISTORY_IMMUTABLE"
  | "PERMISSION_ESCALATION_BLOCKED"
  | "EVENTSTORE_WRITE_FORBIDDEN"
  | "GRANT_INVALID"
  | "GRANT_CAPABILITY_MISMATCH"
  | "GRANT_ACTION_MISMATCH"
  | "GRANT_ALREADY_USED"
  | "ACTOR_KIND_CANNOT_HOLD_CAPABILITY";

export interface AgencyDenial {
  readonly allowed: false;
  readonly code: DenialCode;
  readonly reason: string;
  readonly actorId: string;
  readonly actorKind: HarborActorKind;
  readonly requestedCapability: Capability;
  readonly grantedCapabilities: readonly Capability[];
  readonly action: string;
  readonly target?: string;
  readonly stateModified: false;
  readonly inspectable: true;
  readonly timestamp: string;
}

export interface AgencyAuthority {
  readonly authorityId: string;
  readonly actorId: string;
  readonly actorKind: HarborActorKind;
  readonly capabilities: readonly Capability[];
  readonly issuedAt: string;
  readonly grantSource: "default";
}

export interface AuthorizationGrant {
  readonly grantId: string;
  readonly capability: "CANONICAL_COMMIT" | "EXTERNAL_ACTION";
  readonly grantedBy: { readonly id: string; readonly kind: "human" };
  readonly action: string;
  readonly target: string;
  readonly issuedAt: string;
  readonly provenance: {
    readonly source: "explicit-human-authorization";
    readonly notFromProposalAcceptance: true;
  };
}

export interface CanonicalActionRecord {
  readonly recordId: string;
  readonly actor: { readonly id: string; readonly kind: HarborActorKind };
  readonly authorization: {
    readonly grantId: string;
    readonly grantedBy: string;
    readonly capability: "CANONICAL_COMMIT" | "EXTERNAL_ACTION";
  };
  readonly action: string;
  readonly target: string;
  readonly timestamp: string;
  readonly resultingEventIds: readonly string[];
  readonly provenance: ArtifactProvenance;
  readonly class: typeof HARBOR_CLASS;
}

export interface AgencyDeniedFields {
  code?: DenialCode;
  action?: string;
  target?: string;
  grantedCapabilities?: readonly Capability[];
  timestamp?: string;
}

export class AgencyDeniedError extends Error {
  readonly denial: AgencyDenial;

  constructor(
    readonly actor: HarborActor,
    readonly capability: Capability,
    message?: string,
    fields: AgencyDeniedFields = {}
  ) {
    const reason = message ?? `Actor ${actor.id} (${actor.kind}) denied ${capability}`;
    super(reason);
    this.name = "AgencyDeniedError";
    this.denial = Object.freeze({
      allowed: false,
      code: fields.code ?? "MISSING_CAPABILITY",
      reason,
      actorId: actor.id,
      actorKind: actor.kind,
      requestedCapability: capability,
      grantedCapabilities: Object.freeze([...(fields.grantedCapabilities ?? [])]),
      action: fields.action ?? capability,
      target: fields.target,
      stateModified: false,
      inspectable: true,
      timestamp: fields.timestamp ?? nowIso(),
    });
  }
}

/** Official AI default. `CANONICAL_PROPOSAL` is the retained identifier for `PROPOSE`. */
const AI_DEFAULT: Capability[] = ["READ_ONLY", "DERIVED_WRITE", "CANONICAL_PROPOSAL"];
const HUMAN_DEFAULT: Capability[] = [
  "READ_ONLY",
  "DERIVED_WRITE",
  "CANONICAL_PROPOSAL",
  "CANONICAL_COMMIT",
  "EXTERNAL_ACTION",
];
const SYSTEM_DEFAULT: Capability[] = ["READ_ONLY", "DERIVED_WRITE"];

const ISSUED_GRANTS = new WeakSet<AuthorizationGrant>();

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

export function normalizeCapability(capability: Capability): Capability {
  return capability === "PROPOSE" ? "CANONICAL_PROPOSAL" : capability;
}

export function sealActor(actor: HarborActor): HarborActor {
  return Object.freeze({
    id: actor.id,
    kind: actor.kind,
    authorizeCanonical: actor.authorizeCanonical,
    authorizeExternal: actor.authorizeExternal,
  });
}

function snapshotActor(actor: HarborActor): HarborActor {
  return {
    id: actor.id,
    kind: actor.kind,
    authorizeCanonical: actor.authorizeCanonical,
    authorizeExternal: actor.authorizeExternal,
  };
}

function computeCapabilities(actor: HarborActor): Capability[] {
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
    return [...AI_DEFAULT];
  }
  return [...SYSTEM_DEFAULT];
}

export function capabilitiesFor(actor: HarborActor): Capability[] {
  const snap = snapshotActor(actor);
  if (snap.kind === "ai" && snap.authorizeCanonical) {
    throw new AgencyDeniedError(
      snap,
      "CANONICAL_COMMIT",
      "AI cannot grant itself CANONICAL_COMMIT",
      { code: "AI_SELF_GRANT_BLOCKED", action: "escalate_permission", grantedCapabilities: AI_DEFAULT }
    );
  }
  if (snap.kind === "ai" && snap.authorizeExternal) {
    throw new AgencyDeniedError(
      snap,
      "EXTERNAL_ACTION",
      "AI cannot grant itself EXTERNAL_ACTION",
      { code: "AI_SELF_GRANT_BLOCKED", action: "escalate_permission", grantedCapabilities: AI_DEFAULT }
    );
  }
  return Object.freeze(computeCapabilities(snap)) as Capability[];
}

export function hasCapability(actor: HarborActor, capability: Capability): boolean {
  try {
    const want = normalizeCapability(capability);
    return capabilitiesFor(actor).some((c) => normalizeCapability(c) === want);
  } catch (err) {
    if (err instanceof AgencyDeniedError) return false;
    throw err;
  }
}

export function assertCapability(actor: HarborActor, capability: Capability): void {
  evaluateAccess(actor, capability, capability);
}

export function evaluateAccess(
  actor: HarborActor,
  capability: Capability,
  action: string,
  target?: string
): AgencyAuthority {
  const snap = snapshotActor(actor);
  let granted: readonly Capability[] = [];
  try {
    granted = capabilitiesFor(snap);
  } catch (err) {
    if (err instanceof AgencyDeniedError) {
      throw new AgencyDeniedError(snap, capability, err.message, {
        code: err.denial.code,
        action,
        target,
        grantedCapabilities: err.denial.grantedCapabilities,
      });
    }
    throw err;
  }
  const want = normalizeCapability(capability);
  if (!granted.some((c) => normalizeCapability(c) === want)) {
    throw new AgencyDeniedError(
      snap,
      capability,
      `Actor ${snap.id} (${snap.kind}) denied ${capability}`,
      {
        code:
          capability === "CANONICAL_COMMIT" || capability === "EXTERNAL_ACTION"
            ? "HUMAN_AUTHORIZATION_REQUIRED"
            : "MISSING_CAPABILITY",
        action,
        target,
        grantedCapabilities: granted,
      }
    );
  }
  return issueAuthority(snap);
}

export function issueAuthority(actor: HarborActor, now = nowIso()): AgencyAuthority {
  const snap = snapshotActor(actor);
  const capabilities = capabilitiesFor(snap);
  return Object.freeze({
    authorityId: `authority:${snap.kind}:${snap.id}:${now}`,
    actorId: snap.id,
    actorKind: snap.kind,
    capabilities: Object.freeze([...capabilities]),
    issuedAt: now,
    grantSource: "default" as const,
  });
}

export function issueAuthorization(
  granter: HarborActor,
  spec: {
    capability: "CANONICAL_COMMIT" | "EXTERNAL_ACTION";
    action: string;
    target: string;
    now?: string;
  }
): AuthorizationGrant {
  const snap = snapshotActor(granter);
  if (snap.kind !== "human") {
    throw new AgencyDeniedError(
      snap,
      spec.capability,
      "Authorization grants require an explicit human actor",
      {
        code: "HUMAN_AUTHORIZATION_REQUIRED",
        action: spec.action,
        target: spec.target,
        grantedCapabilities: hasCapability(snap, spec.capability) ? capabilitiesFor(snap) : [],
      }
    );
  }
  evaluateAccess(snap, spec.capability, spec.action, spec.target);
  const grant: AuthorizationGrant = Object.freeze({
    grantId: randomUUID(),
    capability: spec.capability,
    grantedBy: Object.freeze({ id: snap.id, kind: "human" as const }),
    action: spec.action,
    target: spec.target,
    issuedAt: spec.now ?? nowIso(),
    provenance: Object.freeze({
      source: "explicit-human-authorization" as const,
      notFromProposalAcceptance: true as const,
    }),
  });
  ISSUED_GRANTS.add(grant);
  return grant;
}

export function isIssuedGrant(grant: AuthorizationGrant): boolean {
  return ISSUED_GRANTS.has(grant);
}

export function isAuditableAction(capability: Capability): boolean {
  return capability === "CANONICAL_COMMIT" || capability === "EXTERNAL_ACTION";
}

export function buildCanonicalActionRecord(input: {
  actor: HarborActor;
  grant: AuthorizationGrant;
  action: string;
  target: string;
  resultingEventIds: readonly string[];
  now?: string;
}): CanonicalActionRecord {
  const snap = snapshotActor(input.actor);
  const timestamp = input.now ?? nowIso();
  const provenance: ArtifactProvenance = {
    sourceMemoryIds: input.resultingEventIds.length ? [] : [],
    sourceEventIds: [...input.resultingEventIds],
    agentId: snap.id,
    actorKind: snap.kind,
    createdAt: timestamp,
    derivationType: "commit",
    confidence: 1,
    class: HARBOR_CLASS,
    originatingContext: `authorization:${input.grant.grantId}`,
  };
  return Object.freeze({
    recordId: randomUUID(),
    actor: Object.freeze({ id: snap.id, kind: snap.kind }),
    authorization: Object.freeze({
      grantId: input.grant.grantId,
      grantedBy: input.grant.grantedBy.id,
      capability: input.grant.capability,
    }),
    action: input.action,
    target: input.target,
    timestamp,
    resultingEventIds: Object.freeze([...input.resultingEventIds]),
    provenance,
    class: HARBOR_CLASS,
  });
}
