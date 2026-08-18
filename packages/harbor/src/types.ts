/**
 * V3 Harbor derived types.
 * None of these are Core-canonical. They wrap or annotate Core Memory.
 */

export const HARBOR_CLASS = "V3-DERIVED" as const;
export type HarborClass = typeof HARBOR_CLASS;

export type HarborActorKind = "human" | "ai" | "system";

export interface HarborActor {
  id: string;
  kind: HarborActorKind;
  authorizeCanonical?: boolean;
  authorizeExternal?: boolean;
}

export type EpistemicStatus =
  | "FACT"
  | "USER_ASSERTED"
  | "AI_PROPOSED"
  | "DERIVED"
  | "INFERRED"
  | "UNCERTAIN"
  | "REJECTED"
  | "SUPERSEDED";

export type Capability =
  | "READ_ONLY"
  | "DERIVED_WRITE"
  | "PROPOSE"
  | "CANONICAL_PROPOSAL"
  | "CANONICAL_COMMIT"
  | "EXTERNAL_ACTION";

export type DerivationType =
  | "retrieve"
  | "infer"
  | "reflect"
  | "classify"
  | "propose"
  | "contradict"
  | "assemble"
  | "import"
  | "commit";

export interface ArtifactProvenance {
  sourceMemoryIds: string[];
  sourceEventIds: string[];
  originatingContext?: string;
  agentId: string;
  actorKind: HarborActorKind;
  provider?: string;
  model?: string;
  modelVersion?: string;
  createdAt: string;
  derivationType: DerivationType;
  confidence: number;
  class: HarborClass;
}

export interface EpistemicRecord {
  memoryId: string;
  status: EpistemicStatus;
  confidence: number;
  evidenceEventIds: string[];
  lastChangedAt: string;
  changedBy: HarborActor;
  note?: string;
  class: HarborClass;
}

export type ContradictionResolution =
  | "CONFIRM_A"
  | "CONFIRM_B"
  | "BOTH_CONTEXTUAL"
  | "SUPERSEDE_A"
  | "SUPERSEDE_B"
  | "UNRESOLVED";

export interface ContradictionRecord {
  id: string;
  memoryIdA: string;
  memoryIdB: string;
  excerptA: string;
  excerptB: string;
  detectedAt: string;
  timestamps: { a: string; b: string };
  provenance: ArtifactProvenance;
  confidence: number;
  possibleExplanations: string[];
  resolution: ContradictionResolution;
  resolvedAt?: string;
  resolvedBy?: HarborActor;
  class: HarborClass;
}

export interface TemporalValidity {
  memoryId: string;
  validFrom?: string;
  validUntil?: string;
  lastConfirmed?: string;
  reviewDue?: string;
  temporalStatus: "is_true" | "was_true" | "unknown";
  class: HarborClass;
}

export type InclusionReason =
  | "selected"
  | "retrieved"
  | "task_match"
  | "project_match"
  | "tag_match"
  | "temporal"
  | "related"
  | "contradiction"
  | "reflection"
  | "user_pinned"
  | "source_match"
  | "status_match";

export const CONTEXT_PACKAGE_SCHEMA = "harbor-context-package-v1" as const;

export interface ContextPackageItem {
  memoryId: string;
  kind: "canonical" | "derived";
  epistemicStatus: EpistemicStatus;
  confidence: number;
  relevance: number;
  reason: InclusionReason;
  reasonDetail: string;
  excerpt: string;
  project?: string;
  tags: string[];
  updatedAt?: string;
  relationships: string[];
  sourceMemoryIds: string[];
  provenance?: {
    sourceMemoryIds: string[];
    sourceEventIds: string[];
    changedBy?: HarborActor;
    class: HarborClass;
  };
}

export interface ContextPackageConstraints {
  selectedMemoryIds: string[];
  sourceMemoryIds: string[];
  projects: string[];
  tags: string[];
  statuses: EpistemicStatus[];
  temporal?: { from?: string; to?: string };
  maxItems: number;
  maxChars: number;
}

export interface ContextPackage {
  class: HarborClass;
  schemaVersion: typeof CONTEXT_PACKAGE_SCHEMA;
  packageId: string;
  query?: string;
  task?: string;
  request: Record<string, unknown>;
  assembledAt: string;
  items: ContextPackageItem[];
  selectedRecords: Array<{ id: string; kind: "epistemic"; reason: InclusionReason }>;
  sourceMemoryIds: string[];
  constraints: ContextPackageConstraints;
  contradictions: ContradictionRecord[];
  exclusions: Array<{ memoryId: string; reason: string }>;
  budget: {
    maxItems: number;
    maxChars: number;
    itemCount: number;
    charCount: number;
    truncated: boolean;
  };
  reproducibleKey: string;
}

export type HarborProposalStatus =
  | "DRAFT"
  | "PROPOSED"
  | "DISCUSSING"
  | "ACCEPTED"
  | "EDITED"
  | "REJECTED"
  | "DEFERRED"
  | "SUPERSEDED";

export type HarborProposalType =
  | "create_memory"
  | "update_memory"
  | "i_dont_know"
  | "insufficient_evidence"
  | "conflicting_evidence"
  | "no_action";

export interface HarborProposal {
  proposalId: string;
  agentId: string;
  modelId?: string;
  createdAt: string;
  contextIds: string[];
  sourceMemoryIds: string[];
  proposalType: HarborProposalType;
  content: string;
  reasoningSummary: string;
  confidence: number;
  riskLevel: "low" | "medium" | "high";
  status: HarborProposalStatus;
  acceptedBy?: string;
  acceptedAt?: string;
  resultingEventIds: string[];
  provenance: ArtifactProvenance;
  class: HarborClass;
}

export interface ReflectionFinding {
  kind:
    | "pattern"
    | "change"
    | "contradiction"
    | "unresolved"
    | "repeated_goal"
    | "abandoned_goal"
    | "interest"
    | "preference_shift"
    | "blind_spot"
    | "uncertainty"
    | "project_link";
  statement: string;
  interpretation?: string;
  confidence: number;
  evidenceMemoryIds: string[];
}

export interface ReflectionArtifact {
  id: string;
  createdAt: string;
  findings: ReflectionFinding[];
  provenance: ArtifactProvenance;
  status: "DERIVED";
  class: HarborClass;
}

export interface ProviderInvocation {
  id: string;
  provider: string;
  model: string;
  modelVersion: string;
  operation: string;
  timestamp: string;
  contextIds: string[];
  inputHash: string;
  outputHash: string;
  class: HarborClass;
}

export type ConnectomeOrigin =
  | "CANONICAL_REFERENCE"
  | "DERIVED"
  | "INFERRED"
  | "USER_CONFIRMED";

export type HarborNodeKind =
  | "MEMORY"
  | "PROJECT"
  | "PERSON"
  | "PLACE"
  | "CONCEPT"
  | "GOAL"
  | "DECISION"
  | "EVENT"
  | "ARTIFACT"
  | "QUESTION"
  | "PROPOSAL"
  | "REFLECTION";

export type HarborEdgeType =
  | "RELATES_TO"
  | "SUPPORTS"
  | "CONTRADICTS"
  | "DERIVED_FROM"
  | "PART_OF"
  | "PRECEDES"
  | "FOLLOWS"
  | "INFLUENCES"
  | "ABOUT"
  | "RELEVANT_TO";

export const HARBOR_VERSION = "0.1.0";
