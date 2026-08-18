/**
 * Enforceable agency / permission boundary.
 *
 * Core = Canonical Truth
 * Harbor = Derived Understanding
 * AI = Proposal
 * Human = Authority
 *
 * Proposal generation never writes EventStore. A proposal being accepted
 * does not mint CANONICAL_COMMIT and does not become a grant.
 */
import {
  AgencyDeniedError,
  buildCanonicalActionRecord,
  evaluateAccess,
  isIssuedGrant,
  sealActor,
  type AgencyAuthority,
  type AgencyDenial,
  type AuthorizationGrant,
  type CanonicalActionRecord,
} from "./agency.js";
import type { Capability, HarborActor } from "./types.js";

export interface CanonicalCommitRequest<T> {
  actor: HarborActor;
  grant: AuthorizationGrant;
  action: string;
  target: string;
  execute: () => Promise<{ result: T; eventIds: string[] }> | { result: T; eventIds: string[] };
  now?: string;
}

export interface ExternalActionRequest<T> {
  actor: HarborActor;
  grant: AuthorizationGrant;
  action: string;
  target: string;
  execute: () => Promise<T> | T;
  now?: string;
}

export class AgencyBoundary {
  private readonly denials: AgencyDenial[] = [];
  private readonly records: CanonicalActionRecord[] = [];
  private readonly usedGrants = new Set<string>();

  inspectDenials(): AgencyDenial[] {
    return this.denials.map((d) => structuredClone(d));
  }

  inspectCanonicalActions(): CanonicalActionRecord[] {
    return this.records.map((r) => structuredClone(r));
  }

  inspect(): {
    denials: AgencyDenial[];
    canonicalActions: CanonicalActionRecord[];
  } {
    return {
      denials: this.inspectDenials(),
      canonicalActions: this.inspectCanonicalActions(),
    };
  }

  require(
    actor: HarborActor,
    capability: Capability,
    action: string,
    target?: string
  ): AgencyAuthority {
    try {
      return evaluateAccess(actor, capability, action, target);
    } catch (err) {
      if (err instanceof AgencyDeniedError) {
        this.denials.push(err.denial);
      }
      throw err;
    }
  }

  async commitCanonical<T>(
    request: CanonicalCommitRequest<T>
  ): Promise<{ result: T; record: CanonicalActionRecord }> {
    const actor = sealActor(request.actor);
    this.require(actor, "CANONICAL_COMMIT", request.action, request.target);
    this.requireGrant(actor, request.grant, "CANONICAL_COMMIT", request.action, request.target);
    const executed = await request.execute();
    this.usedGrants.add(request.grant.grantId);
    const record = buildCanonicalActionRecord({
      actor,
      grant: request.grant,
      action: request.action,
      target: request.target,
      resultingEventIds: executed.eventIds,
      now: request.now,
    });
    this.records.push(record);
    return { result: executed.result, record };
  }

  async performExternal<T>(request: ExternalActionRequest<T>): Promise<{ result: T; record: CanonicalActionRecord }> {
    const actor = sealActor(request.actor);
    this.require(actor, "EXTERNAL_ACTION", request.action, request.target);
    this.requireGrant(actor, request.grant, "EXTERNAL_ACTION", request.action, request.target);
    const result = await request.execute();
    this.usedGrants.add(request.grant.grantId);
    const record = buildCanonicalActionRecord({
      actor,
      grant: request.grant,
      action: request.action,
      target: request.target,
      resultingEventIds: [],
      now: request.now,
    });
    this.records.push(record);
    return { result, record };
  }

  modifyEvidence(actor: HarborActor, target = "evidence"): never {
    throw this.deny(
      actor,
      "CANONICAL_COMMIT",
      "EVIDENCE_IMMUTABLE",
      "Evidence is immutable through the agency boundary",
      "modify_evidence",
      target
    );
  }

  modifyAcceptanceCriteria(actor: HarborActor, target = "acceptance"): never {
    throw this.deny(
      actor,
      "CANONICAL_COMMIT",
      "ACCEPTANCE_CRITERIA_IMMUTABLE",
      "Acceptance criteria cannot be modified through the agency boundary",
      "modify_acceptance_criteria",
      target
    );
  }

  deleteCanonicalHistory(actor: HarborActor, target = "eventstore"): never {
    throw this.deny(
      actor,
      "CANONICAL_COMMIT",
      "CANONICAL_HISTORY_IMMUTABLE",
      "Canonical history cannot be deleted",
      "delete_canonical_history",
      target
    );
  }

  escalate(actor: HarborActor, capability: Capability): never {
    throw this.deny(
      actor,
      capability,
      "PERMISSION_ESCALATION_BLOCKED",
      "Actors cannot grant or escalate their own permissions",
      "escalate_permission",
      capability
    );
  }

  convertProposalToCanonical(actor: HarborActor, proposalId: string): never {
    throw this.deny(
      actor,
      "CANONICAL_COMMIT",
      "PROPOSAL_IS_NOT_COMMIT",
      "Accepting a proposal does not grant canonical authority or mutate Core",
      "convert_proposal",
      proposalId
    );
  }

  writeEventStoreDirect(actor: HarborActor, target = "eventstore"): never {
    throw this.deny(
      actor,
      "CANONICAL_COMMIT",
      "EVENTSTORE_WRITE_FORBIDDEN",
      "Direct EventStore writes are forbidden; use an authorized canonical commit",
      "eventstore_write",
      target
    );
  }

  private requireGrant(
    actor: HarborActor,
    grant: AuthorizationGrant,
    capability: "CANONICAL_COMMIT" | "EXTERNAL_ACTION",
    action: string,
    target: string
  ): void {
    if (!isIssuedGrant(grant)) {
      throw this.deny(
        actor,
        capability,
        "GRANT_INVALID",
        "Authorization grant was not issued by the agency boundary",
        action,
        target
      );
    }
    if (grant.grantedBy.kind !== "human") {
      throw this.deny(
        actor,
        capability,
        "HUMAN_AUTHORIZATION_REQUIRED",
        "Authorization grant must be issued by a human",
        action,
        target
      );
    }
    if (!grant.provenance.notFromProposalAcceptance || grant.provenance.source !== "explicit-human-authorization") {
      throw this.deny(
        actor,
        capability,
        "PROPOSAL_IS_NOT_COMMIT",
        "A proposal acceptance is not a canonical authorization",
        action,
        target
      );
    }
    if (grant.capability !== capability) {
      throw this.deny(
        actor,
        capability,
        "GRANT_CAPABILITY_MISMATCH",
        `Grant ${grant.grantId} is for ${grant.capability}, not ${capability}`,
        action,
        target
      );
    }
    if (grant.action !== action || grant.target !== target) {
      throw this.deny(
        actor,
        capability,
        "GRANT_ACTION_MISMATCH",
        `Grant ${grant.grantId} does not cover ${action} on ${target}`,
        action,
        target
      );
    }
    if (this.usedGrants.has(grant.grantId)) {
      throw this.deny(
        actor,
        capability,
        "GRANT_ALREADY_USED",
        `Grant ${grant.grantId} has already been consumed`,
        action,
        target
      );
    }
  }

  private deny(
    actor: HarborActor,
    capability: Capability,
    code: AgencyDenial["code"],
    reason: string,
    action: string,
    target?: string
  ): AgencyDeniedError {
    const error = new AgencyDeniedError(sealActor(actor), capability, reason, {
      code,
      action,
      target,
    });
    this.denials.push(error.denial);
    return error;
  }
}
