/**
 * Read-only vault scanner.
 * CURRENT VAULT → scan → parse → validate → normalized report
 * Never mutates source vault. Never writes Core events (foundation).
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  MigrationIssue,
  MigrationReport,
  NormalizedVaultNote,
  VaultNoteType,
  VaultRelation,
} from "./types.js";

const KNOWN_TYPES = new Set<string>([
  "fact",
  "insight",
  "decision",
  "question",
  "tension",
  "project",
  "memory",
  "reflection",
  "pattern",
  "narrative",
  "chat",
]);

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      out.push(...(await walkMarkdown(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function splitFrontmatter(raw: string): {
  yaml: string | null;
  body: string;
} {
  if (!raw.startsWith("---")) {
    return { yaml: null, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return { yaml: null, body: raw };
  }
  const yaml = raw.slice(3, end).replace(/^\r?\n/, "");
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  return { yaml, body };
}

function asNoteType(v: unknown): VaultNoteType {
  if (typeof v === "string" && KNOWN_TYPES.has(v)) {
    return v as VaultNoteType;
  }
  return "unknown";
}

function parseRelations(raw: unknown): VaultRelation[] {
  if (!Array.isArray(raw)) return [];
  const out: VaultRelation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.target_id !== "string" || typeof r.relation_type !== "string") {
      continue;
    }
    out.push({
      target_id: r.target_id,
      relation_type: r.relation_type,
      strength: typeof r.strength === "number" ? r.strength : undefined,
      confidence: typeof r.confidence === "number" ? r.confidence : undefined,
      reason: typeof r.reason === "string" ? r.reason : undefined,
    });
  }
  return out;
}

export function parseVaultMarkdown(
  filePath: string,
  raw: string
): NormalizedVaultNote {
  const parseErrors: string[] = [];
  const { yaml, body } = splitFrontmatter(raw);
  let frontmatter: Record<string, unknown> = {};

  if (yaml === null) {
    parseErrors.push("missing_frontmatter");
  } else {
    try {
      const parsed = parseYaml(yaml);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      } else {
        parseErrors.push("frontmatter_not_object");
      }
    } catch (e) {
      parseErrors.push(
        `yaml_parse_error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((t): t is string => typeof t === "string")
    : [];

  return {
    path: filePath.replace(/\\/g, "/"),
    id: typeof frontmatter.id === "string" ? frontmatter.id : undefined,
    type: asNoteType(frontmatter.type),
    title: typeof frontmatter.title === "string" ? frontmatter.title : undefined,
    status:
      typeof frontmatter.status === "string" ? frontmatter.status : undefined,
    project:
      typeof frontmatter.project === "string" ? frontmatter.project : undefined,
    tags,
    body: body.trim(),
    frontmatter,
    relations: parseRelations(frontmatter.relations),
    parseErrors,
  };
}

export function validateNotes(notes: NormalizedVaultNote[]): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const ids = new Map<string, string>();

  for (const n of notes) {
    for (const err of n.parseErrors) {
      issues.push({
        path: n.path,
        severity: "error",
        code: err,
        message: `Parse issue: ${err}`,
      });
    }
    if (!n.id) {
      issues.push({
        path: n.path,
        severity: "warning",
        code: "missing_id",
        message: "Note has no id in frontmatter",
      });
    } else if (ids.has(n.id)) {
      issues.push({
        path: n.path,
        severity: "error",
        code: "duplicate_id",
        message: `Duplicate id ${n.id} also in ${ids.get(n.id)}`,
      });
    } else {
      ids.set(n.id, n.path);
    }
    if (n.type === "unknown") {
      issues.push({
        path: n.path,
        severity: "info",
        code: "unknown_type",
        message: `Unknown or missing type: ${String(n.frontmatter.type)}`,
      });
    }
    for (const rel of n.relations) {
      if (!rel.reason) {
        issues.push({
          path: n.path,
          severity: "warning",
          code: "relation_missing_reason",
          message: `Relation to ${rel.target_id} lacks reason`,
        });
      }
    }
  }

  // dangling relation targets
  for (const n of notes) {
    for (const rel of n.relations) {
      if (!ids.has(rel.target_id)) {
        issues.push({
          path: n.path,
          severity: "warning",
          code: "dangling_relation_target",
          message: `Relation target ${rel.target_id} not found in scanned set`,
        });
      }
    }
  }

  return issues.sort((a, b) =>
    `${a.path}:${a.code}`.localeCompare(`${b.path}:${b.code}`)
  );
}

function fingerprint(notes: NormalizedVaultNote[]): string {
  const normalized = notes
    .map((n) => ({
      path: path.basename(n.path),
      id: n.id ?? null,
      type: n.type,
      title: n.title ?? null,
      tags: [...n.tags].sort(),
      relations: n.relations
        .map((r) => ({
          target_id: r.target_id,
          relation_type: r.relation_type,
          reason: r.reason ?? null,
        }))
        .sort((a, b) =>
          `${a.target_id}:${a.relation_type}`.localeCompare(
            `${b.target_id}:${b.relation_type}`
          )
        ),
      bodyHash: createHash("sha256").update(n.body).digest("hex").slice(0, 16),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

export async function scanVault(rootPath: string): Promise<MigrationReport> {
  const abs = path.resolve(rootPath);
  const st = await stat(abs);
  if (!st.isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }

  const files = (await walkMarkdown(abs)).sort();
  const notes: NormalizedVaultNote[] = [];

  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const rel = path.relative(abs, file).replace(/\\/g, "/");
    notes.push(parseVaultMarkdown(rel, raw));
  }

  const issues = validateNotes(notes);
  const byType: Record<string, number> = {};
  let relationCount = 0;
  for (const n of notes) {
    byType[n.type] = (byType[n.type] ?? 0) + 1;
    relationCount += n.relations.length;
  }

  return {
    schemaVersion: "migration-report-v1",
    scannedAt: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    rootPath: abs.replace(/\\/g, "/"),
    noteCount: notes.length,
    relationCount,
    byType,
    notes,
    issues,
    contentFingerprint: fingerprint(notes),
    coreWrites: 0,
  };
}
