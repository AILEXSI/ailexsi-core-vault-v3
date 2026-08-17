/**
 * Migration dry-run: map normalized vault notes → Core Memory command drafts.
 * Does NOT append to EventStore. Does NOT mutate legacy vault.
 */

import type { NormalizedVaultNote, MigrationReport } from "./types.js";

export type DryRunDisposition =
  | "map_to_create_memory"
  | "quarantine_weak_provenance"
  | "skip_non_memory";

export interface MemoryCreateDraft {
  disposition: "map_to_create_memory";
  sourcePath: string;
  sourceId?: string;
  /** Proposed Core create payload (not executed). */
  draft: {
    content: { type: "text"; text: string };
    context: {
      project?: string;
      tags?: string[];
      domain?: string;
    };
    meaning?: { summary?: string };
    provenance: {
      sourceType: "import";
      sourceId?: string;
      capturedAt: string;
      parentMemoryIds: string[];
      evidenceIds: string[];
    };
    /** Placeholder — real key generated only at write time. */
    idempotencyKey: string;
    memoryId?: string;
  };
  notes: string[];
}

export interface QuarantineEntry {
  disposition: "quarantine_weak_provenance";
  sourcePath: string;
  sourceId?: string;
  reasons: string[];
}

export interface SkipEntry {
  disposition: "skip_non_memory";
  sourcePath: string;
  sourceId?: string;
  reasons: string[];
}

export type DryRunItem = MemoryCreateDraft | QuarantineEntry | SkipEntry;

export interface MigrationDryRunReport {
  schemaVersion: "migration-dry-run-v1";
  generatedAt: string;
  sourceFingerprint: string;
  totals: {
    notes: number;
    mapToCreate: number;
    quarantine: number;
    skip: number;
  };
  items: DryRunItem[];
  /** Explicit: no Core EventStore writes. */
  coreWrites: 0;
  /** Explicit: no mutation of legacy vault paths. */
  vaultMutations: 0;
}

const MEMORY_LIKE = new Set([
  "fact",
  "insight",
  "decision",
  "question",
  "tension",
  "memory",
  "project",
  "reflection",
  "pattern",
  "narrative",
]);

function isoOrNow(v: unknown): string {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    // Normalize to Core timestamp shape with ms if possible
    const d = new Date(v.endsWith("Z") ? v : `${v}Z`);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().replace(/\.\d{3}Z$/, ".000Z");
    }
  }
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function isUuid(s: string | undefined): s is string {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      s
    )
  );
}

export function mapNoteToDryRun(note: NormalizedVaultNote): DryRunItem {
  if (note.parseErrors.length > 0) {
    return {
      disposition: "quarantine_weak_provenance",
      sourcePath: note.path,
      sourceId: note.id,
      reasons: note.parseErrors.map((e) => `parse:${e}`),
    };
  }

  if (!MEMORY_LIKE.has(note.type)) {
    return {
      disposition: "skip_non_memory",
      sourcePath: note.path,
      sourceId: note.id,
      reasons: [`type_not_mapped:${note.type}`],
    };
  }

  const quarantineReasons: string[] = [];
  if (!note.id) quarantineReasons.push("missing_id");
  if (!note.title && !note.body) quarantineReasons.push("empty_content");
  if (!note.body && note.title) {
    // still mappable using title
  }

  // Weak provenance: no author and no source document and no body
  const author = note.frontmatter.author;
  const source = note.frontmatter.source;
  if (!author && !source && note.body.trim().length < 8) {
    quarantineReasons.push("weak_provenance_short_body");
  }

  if (quarantineReasons.length > 0) {
    return {
      disposition: "quarantine_weak_provenance",
      sourcePath: note.path,
      sourceId: note.id,
      reasons: quarantineReasons,
    };
  }

  const textParts = [note.title ? `# ${note.title}` : "", note.body]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const parentIds = note.relations
    .map((r) => r.target_id)
    .filter(isUuid);

  const capturedAt = isoOrNow(
    note.frontmatter.created_at ?? note.frontmatter.updated_at
  );

  const draftNotes: string[] = [];
  if (!isUuid(note.id)) {
    draftNotes.push(
      "source id is not UUID — Core will allocate new identity at write time"
    );
  }
  if (note.relations.some((r) => !r.reason)) {
    draftNotes.push("some relations lack reason — relationRefs not written in foundation dry-run");
  }

  return {
    disposition: "map_to_create_memory",
    sourcePath: note.path,
    sourceId: note.id,
    draft: {
      content: { type: "text", text: textParts },
      context: {
        project: note.project,
        tags: note.tags.length ? note.tags : undefined,
        domain: note.type,
      },
      meaning: note.title ? { summary: note.title } : undefined,
      provenance: {
        sourceType: "import",
        sourceId: note.path,
        capturedAt,
        parentMemoryIds: parentIds,
        evidenceIds: [],
      },
      // Deterministic dry-run placeholder only — not used for EventStore append
      idempotencyKey: `dry-run:import:${note.id ?? note.path}`,
      memoryId: isUuid(note.id) ? note.id : undefined,
    },
    notes: draftNotes,
  };
}

export function buildMigrationDryRun(
  report: MigrationReport
): MigrationDryRunReport {
  const items = report.notes.map(mapNoteToDryRun);
  const totals = {
    notes: items.length,
    mapToCreate: items.filter((i) => i.disposition === "map_to_create_memory")
      .length,
    quarantine: items.filter(
      (i) => i.disposition === "quarantine_weak_provenance"
    ).length,
    skip: items.filter((i) => i.disposition === "skip_non_memory").length,
  };

  return {
    schemaVersion: "migration-dry-run-v1",
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    sourceFingerprint: report.contentFingerprint,
    totals,
    items,
    coreWrites: 0,
    vaultMutations: 0,
  };
}
