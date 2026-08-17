/**
 * Migration tooling foundation — scan / parse / validate / report only.
 * Does NOT write production Core events in foundation milestone.
 */

export type VaultNoteType =
  | "fact"
  | "insight"
  | "decision"
  | "question"
  | "tension"
  | "project"
  | "memory"
  | "reflection"
  | "pattern"
  | "narrative"
  | "chat"
  | "unknown";

export interface VaultRelation {
  target_id: string;
  relation_type: string;
  strength?: number;
  confidence?: number;
  reason?: string;
}

export interface NormalizedVaultNote {
  path: string;
  id?: string;
  type: VaultNoteType;
  title?: string;
  status?: string;
  project?: string;
  tags: string[];
  body: string;
  frontmatter: Record<string, unknown>;
  relations: VaultRelation[];
  parseErrors: string[];
}

export interface MigrationIssue {
  path: string;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
}

export interface MigrationReport {
  schemaVersion: "migration-report-v1";
  scannedAt: string;
  rootPath: string;
  noteCount: number;
  relationCount: number;
  byType: Record<string, number>;
  notes: NormalizedVaultNote[];
  issues: MigrationIssue[];
  /** Deterministic fingerprint of normalized content for test stability. */
  contentFingerprint: string;
  /** Explicit: no Core writes performed. */
  coreWrites: 0;
}
