/**
 * Continuity is a DERIVED PORTABLE ARTIFACT.
 * It is NOT a replacement for Core event history.
 *
 * Field classes:
 *   CORE-CANONICAL — reconstructible from Core EventStore
 *   V2-DERIVED     — V2 computed/packaged knowledge
 *   V2-EPHEMERAL   — chat/UI state; not fully replayable as canonical
 */

export type ContinuityFieldClass =
  | "CORE-CANONICAL"
  | "V2-DERIVED"
  | "V2-EPHEMERAL";

export interface ContinuityFieldMeta {
  class: ContinuityFieldClass;
  description: string;
}

export interface ContinuityMemoryFact {
  memoryId: string;
  shortId: string;
  content: unknown;
  context: unknown;
  meaning?: unknown;
  provenance: unknown;
  lifecycle: unknown;
  currentVersion: number;
  timestamps: unknown;
  relationRefs: unknown;
  _meta: ContinuityFieldMeta;
}

export interface ContinuityPackage {
  schemaVersion: "v2.0.0-foundation";
  kind: "continuity-snapshot";
  createdAt: string;
  coreBaselineSha: string;
  vaultReferenceSha: string;
  /** CORE-CANONICAL facts projected from Memory. */
  canonicalMemories: ContinuityMemoryFact[];
  /** V2-DERIVED connectome edges (not a Core Relation aggregate). */
  derivedRelationships: Array<{
    fromMemoryId: string;
    toMemoryId: string;
    type: string;
    reason?: string;
    _meta: ContinuityFieldMeta;
  }>;
  /** V2-DERIVED cultivation context summary. */
  cultivationContext?: {
    sessionId?: string;
    summary: string;
    _meta: ContinuityFieldMeta;
  };
  /** V2-EPHEMERAL UI/session notes — not claimed replayable. */
  ephemeralNotes?: Array<{
    text: string;
    _meta: ContinuityFieldMeta;
  }>;
  metadata: {
    memoryCount: number;
    relationshipCount: number;
    _meta: ContinuityFieldMeta;
  };
}
