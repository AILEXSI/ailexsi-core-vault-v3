/**
 * Deterministic cultivation proposals from OBSERVED reflections.
 * Not memories. Not EventStore. Not Derived Index. Not auto-accepted.
 */
import { createHash } from "node:crypto";
import { HARBOR_CLASS } from "./types.js";
import type { ArtifactProvenance, HarborActor, HarborProposalStatus } from "./types.js";
import type { ObservedReflection, ObservedReflectionType } from "./reflection-engine.js";

export const CULTIVATION_PROPOSAL_SCHEMA = "harbor-cultivation-proposal-v1" as const;

export type CultivationProposalType =
  | "review_preference"
  | "review_contradiction"
  | "review_unconfirmed"
  | "review_goal"
  | "review_project";

export type CultivationProposalStatus = Extract<
  HarborProposalStatus,
  "DRAFT" | "PROPOSED" | "ACCEPTED" | "EDITED" | "REJECTED" | "DEFERRED" | "SUPERSEDED"
>;

export interface CultivationProposal {
  proposalId: string;
  proposalType: CultivationProposalType;
  title: string;
  description: string;
  sourceReflectionIds: string[];
  sourceMemoryIds: string[];
  provenance: ArtifactProvenance;
  evidenceStrength: number;
  status: CultivationProposalStatus;
  createdAt: string;
  schemaVersion: typeof CULTIVATION_PROPOSAL_SCHEMA;
  decidedBy?: string;
  decidedAt?: string;
  class: typeof HARBOR_CLASS;
}

const SUPPORTED: ReadonlyArray<{
  reflection: ObservedReflectionType;
  proposalType: CultivationProposalType;
  title: string;
  description: string;
}> = [
  {
    reflection: "preference_change",
    proposalType: "review_preference",
    title: "Review preference records",
    description: "Review whether the newer preference should supersede the older one.",
  },
  {
    reflection: "unresolved_contradiction",
    proposalType: "review_contradiction",
    title: "Review contradictory records",
    description: "Review contradictory records.",
  },
  {
    reflection: "stale_derived",
    proposalType: "review_unconfirmed",
    title: "Review unconfirmed derived information",
    description: "Review unconfirmed derived information.",
  },
  {
    reflection: "repeated_goal",
    proposalType: "review_goal",
    title: "Review repeated goal",
    description: "Review whether this goal should remain active.",
  },
  {
    reflection: "repeated_project",
    proposalType: "review_project",
    title: "Review repeated project",
    description: "Review whether this project should remain active.",
  },
];

const TYPE_ORDER: CultivationProposalType[] = [
  "review_preference",
  "review_contradiction",
  "review_unconfirmed",
  "review_goal",
  "review_project",
];

function byId(a: string, b: string): number {
  return a.localeCompare(b);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function proposalId(type: CultivationProposalType, reflectionIds: string[], memoryIds: string[]): string {
  return createHash("sha256")
    .update(
      `${CULTIVATION_PROPOSAL_SCHEMA}|${type}|${[...reflectionIds].sort(byId).join(",")}|${[...memoryIds].sort(byId).join(",")}`
    )
    .digest("hex");
}

export function proposeFromReflections(
  reflections: ObservedReflection[],
  actor: HarborActor,
  now: string
): CultivationProposal[] {
  const out: CultivationProposal[] = [];
  for (const spec of SUPPORTED) {
    for (const reflection of reflections.filter((r) => r.type === spec.reflection)) {
      const sourceReflectionIds = [reflection.reflectionId];
      const sourceMemoryIds = [...reflection.sourceMemoryIds].sort(byId);
      out.push({
        proposalId: proposalId(spec.proposalType, sourceReflectionIds, sourceMemoryIds),
        proposalType: spec.proposalType,
        title: spec.title,
        description: spec.description,
        sourceReflectionIds,
        sourceMemoryIds,
        provenance: {
          sourceMemoryIds,
          sourceEventIds: [],
          agentId: actor.id,
          actorKind: actor.kind,
          createdAt: now,
          derivationType: "propose",
          confidence: reflection.evidenceStrength,
          class: HARBOR_CLASS,
        },
        evidenceStrength: reflection.evidenceStrength,
        status: "PROPOSED",
        createdAt: now,
        schemaVersion: CULTIVATION_PROPOSAL_SCHEMA,
        class: HARBOR_CLASS,
      });
    }
  }
  out.sort((a, b) => TYPE_ORDER.indexOf(a.proposalType) - TYPE_ORDER.indexOf(b.proposalType) || byId(a.proposalId, b.proposalId));
  return out.map((p) => clone(p));
}

export function applyCultivationDecision(
  current: CultivationProposal,
  status: Extract<CultivationProposalStatus, "ACCEPTED" | "EDITED" | "REJECTED" | "DEFERRED" | "SUPERSEDED">,
  actor: HarborActor,
  now: string,
  extras?: { title?: string; description?: string }
): CultivationProposal {
  if (current.status === "ACCEPTED" || current.status === "EDITED") {
    throw new Error("Proposal already decided");
  }
  return clone({
    ...current,
    status,
    title: extras?.title ?? current.title,
    description: extras?.description ?? current.description,
    decidedBy: actor.id,
    decidedAt: now,
  });
}
