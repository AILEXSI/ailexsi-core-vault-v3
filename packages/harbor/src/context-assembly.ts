/**
 * Deterministic Context Assembly over the Derived Query Service.
 * READ-ONLY. Never EventStore. Never Core. ContextPackage is not persisted.
 */
import { createHash } from "node:crypto";
import type {
  ContextPackage,
  ContextPackageConstraints,
  ContextPackageItem,
  EpistemicRecord,
  EpistemicStatus,
  InclusionReason,
} from "./types.js";
import { CONTEXT_PACKAGE_SCHEMA, HARBOR_CLASS } from "./types.js";
import {
  DERIVED_INDEX_SCHEMA,
  rebuildFingerprint,
} from "./derived-index.js";
import {
  DerivedQueryService,
  type DerivedMemoryView,
  type DerivedProvenanceView,
  type DerivedQuerySnapshot,
} from "./derived-query.js";
import type { ContradictionRecord } from "./types.js";

export type ContextAssemblyInput = {
  query?: string;
  currentTask?: string;
  conversationContext?: string;
  selectedMemoryIds?: string[];
  sourceMemoryIds?: string[];
  projects?: string[];
  tags?: string[];
  statuses?: EpistemicStatus[];
  temporal?: { from?: string; to?: string };
  maxItems: number;
  maxChars: number;
};

export type ContextMemory = {
  id: string;
  text: string;
  project?: string;
  tags: string[];
  updatedAt?: string;
  lifecycle?: string;
};

type Candidate = {
  id: string;
  score: number;
  reason: InclusionReason;
  detail: string;
};

const REASON_SCORE: Record<InclusionReason, number> = {
  selected: 100,
  user_pinned: 100,
  source_match: 90,
  status_match: 80,
  project_match: 70,
  tag_match: 65,
  task_match: 60,
  temporal: 50,
  contradiction: 40,
  related: 35,
  retrieved: 20,
  reflection: 15,
};

function excerptOf(text: string, n = 180): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function byId(a: string, b: string): number {
  return a.localeCompare(b);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort(byId);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
}

function consider(into: Map<string, Candidate>, id: string, reason: InclusionReason, detail: string): void {
  const score = REASON_SCORE[reason];
  const prev = into.get(id);
  if (!prev || score > prev.score || (score === prev.score && reason.localeCompare(prev.reason) < 0)) {
    into.set(id, { id, score, reason, detail });
  }
}

function timestampOf(view: DerivedMemoryView, catalog?: ContextMemory): string | undefined {
  return catalog?.updatedAt ?? view.lastChangedAt;
}

function hasExplicitSelector(req: ContextAssemblyInput): boolean {
  return Boolean(
    req.selectedMemoryIds?.length ||
      req.sourceMemoryIds?.length ||
      req.statuses?.length ||
      req.projects?.length ||
      req.tags?.length ||
      req.query ||
      req.currentTask
  );
}

function catalogById(catalog: ContextMemory[] | undefined): Map<string, ContextMemory> {
  const map = new Map<string, ContextMemory>();
  for (const mem of catalog ?? []) map.set(mem.id, mem);
  return map;
}

function collectCandidates(query: DerivedQueryService, req: ContextAssemblyInput, catalog: Map<string, ContextMemory>): Map<string, Candidate> {
  const candidates = new Map<string, Candidate>();

  for (const id of [...(req.selectedMemoryIds ?? [])].sort(byId)) {
    const view = query.getDerivedMemory(id);
    if (!view) continue;
    consider(candidates, id, "selected", "explicit memory ID");
  }

  for (const sourceId of [...(req.sourceMemoryIds ?? [])].sort(byId)) {
    for (const hit of query.findDerivedBySource(sourceId).items) {
      if (hit.kind === "epistemic") {
        consider(candidates, hit.id, "source_match", `sourceMemoryId=${sourceId}`);
      }
    }
  }

  for (const status of [...(req.statuses ?? [])].sort(byId)) {
    for (const item of query.findDerivedByStatus(status).items) {
      consider(candidates, item.id, "status_match", `status=${status}`);
    }
  }

  if (req.projects?.length) {
    for (const mem of catalog.values()) {
      if (mem.project && req.projects.includes(mem.project) && query.getDerivedMemory(mem.id)) {
        consider(candidates, mem.id, "project_match", `project=${mem.project}`);
      }
    }
  }

  if (req.tags?.length) {
    for (const mem of catalog.values()) {
      if (mem.tags.some((t) => req.tags!.includes(t)) && query.getDerivedMemory(mem.id)) {
        consider(candidates, mem.id, "tag_match", `tags ∩ ${[...req.tags].sort(byId).join(",")}`);
      }
    }
  }

  const task = (req.query ?? req.currentTask ?? "").trim();
  if (task) {
    const needle = task.toLowerCase();
    for (const mem of catalog.values()) {
      if (mem.text.toLowerCase().includes(needle) && query.getDerivedMemory(mem.id)) {
        consider(candidates, mem.id, "task_match", "query/task substring match");
      }
    }
  }

  if (!hasExplicitSelector(req)) {
    for (const item of query.listDerivedMemories().items) {
      consider(candidates, item.id, "retrieved", "listed from derived index");
    }
  }

  return candidates;
}

function exclusionFor(
  view: DerivedMemoryView | null,
  req: ContextAssemblyInput,
  catalog: ContextMemory | undefined
): string | null {
  if (!view) return "not in derived index";
  if (view.status === "REJECTED") return "epistemic status REJECTED";
  if (req.statuses?.length && !req.statuses.includes(view.status)) {
    return `status ${view.status} not in filter`;
  }
  const ts = timestampOf(view, catalog);
  if (req.temporal?.from && ts && ts < req.temporal.from) return "outside temporal from";
  if (req.temporal?.to && ts && ts > req.temporal.to) return "outside temporal to";
  if (req.projects?.length) {
    if (!catalog?.project) return "project unknown for project filter";
    if (!req.projects.includes(catalog.project)) return `project ${catalog.project} not in filter`;
  }
  if (req.tags?.length) {
    if (!catalog) return "tags unknown for tag filter";
    if (!catalog.tags.some((t) => req.tags!.includes(t))) return "no matching tag";
  }
  return null;
}

function constraintsOf(req: ContextAssemblyInput): ContextPackageConstraints {
  return {
    selectedMemoryIds: [...(req.selectedMemoryIds ?? [])].sort(byId),
    sourceMemoryIds: [...(req.sourceMemoryIds ?? [])].sort(byId),
    projects: [...(req.projects ?? [])].sort(byId),
    tags: [...(req.tags ?? [])].sort(byId),
    statuses: [...(req.statuses ?? [])].sort(byId),
    temporal: req.temporal,
    maxItems: req.maxItems,
    maxChars: req.maxChars,
  };
}

function itemFrom(
  view: DerivedMemoryView,
  candidate: Candidate,
  catalog: ContextMemory | undefined,
  provenance: DerivedProvenanceView | null,
  contradictionIds: string[]
): ContextPackageItem {
  const sourceMemoryIds = provenance?.sourceMemoryIds?.length ? [...provenance.sourceMemoryIds] : [view.memoryId];
  return {
    memoryId: view.memoryId,
    kind: view.status === "FACT" ? "canonical" : "derived",
    epistemicStatus: view.status,
    confidence: view.confidence,
    relevance: candidate.score / 100,
    reason: candidate.reason,
    reasonDetail: candidate.detail,
    excerpt: excerptOf(catalog?.text ?? view.note ?? view.memoryId),
    project: catalog?.project,
    tags: catalog?.tags ?? [],
    updatedAt: timestampOf(view, catalog),
    relationships: contradictionIds,
    sourceMemoryIds,
    provenance: provenance
      ? {
          sourceMemoryIds: [...provenance.sourceMemoryIds],
          sourceEventIds: [...provenance.sourceEventIds],
          changedBy: provenance.changedBy,
          class: HARBOR_CLASS,
        }
      : undefined,
  };
}

export function assembleContextFromQuery(opts: {
  query: DerivedQueryService;
  request: ContextAssemblyInput;
  catalog?: ContextMemory[];
  now: string;
}): ContextPackage {
  const req = opts.request;
  const catalog = catalogById(opts.catalog);
  const candidates = collectCandidates(opts.query, req, catalog);
  const exclusions: ContextPackage["exclusions"] = [];
  const eligible: Array<{ candidate: Candidate; view: DerivedMemoryView }> = [];

  const considered = new Set<string>([...candidates.keys()]);
  for (const id of [...(req.selectedMemoryIds ?? []), ...(req.sourceMemoryIds ?? [])]) {
    considered.add(id);
  }

  for (const id of [...considered].sort(byId)) {
    const view = opts.query.getDerivedMemory(id);
    const why = exclusionFor(view, req, catalog.get(id));
    if (why || !view) {
      exclusions.push({ memoryId: id, reason: why ?? "not in derived index" });
      continue;
    }
    const candidate = candidates.get(id);
    if (!candidate) continue;
    eligible.push({ candidate, view });
  }

  eligible.sort(
    (a, b) => b.candidate.score - a.candidate.score || byId(a.candidate.id, b.candidate.id)
  );

  const items: ContextPackageItem[] = [];
  let charCount = 0;
  for (const row of eligible) {
    const provenance = opts.query.getDerivedProvenance(row.view.memoryId);
    const contradictionIds = opts.query
      .findContradictions({ sourceMemoryId: row.view.memoryId })
      .items.map((c) => c.id)
      .sort(byId);
    const item = itemFrom(row.view, row.candidate, catalog.get(row.view.memoryId), provenance, contradictionIds);
    const size = JSON.stringify(item).length;
    if (items.length >= req.maxItems || charCount + size > req.maxChars) {
      exclusions.push({ memoryId: row.view.memoryId, reason: "context budget" });
      continue;
    }
    items.push(item);
    charCount += size;
  }

  const contradictionById = new Map<string, ContradictionRecord>();
  for (const item of items) {
    for (const rec of opts.query.findContradictions({ sourceMemoryId: item.memoryId }).items) {
      contradictionById.set(rec.id, rec);
    }
  }
  const contradictions = [...contradictionById.values()].sort((a, b) => byId(a.id, b.id));

  const request = { ...req };
  const constraints = constraintsOf(req);
  const itemIds = items.map((i) => i.memoryId);
  const reproducibleKey = createHash("sha256")
    .update(JSON.stringify({ request, itemIds }))
    .digest("hex");
  const packageId = createHash("sha256")
    .update(
      stableStringify({
        schemaVersion: CONTEXT_PACKAGE_SCHEMA,
        request,
        itemIds,
        contradictionIds: contradictions.map((c) => c.id),
        exclusionIds: exclusions.map((e) => e.memoryId),
      })
    )
    .digest("hex");

  const allSourceIds = [...new Set(items.flatMap((i) => i.sourceMemoryIds))].sort(byId);

  return {
    class: HARBOR_CLASS,
    schemaVersion: CONTEXT_PACKAGE_SCHEMA,
    packageId,
    query: req.query,
    task: req.currentTask,
    request,
    assembledAt: opts.now,
    items,
    selectedRecords: items.map((i) => ({ id: i.memoryId, kind: "epistemic" as const, reason: i.reason })),
    sourceMemoryIds: allSourceIds,
    constraints,
    contradictions,
    exclusions,
    budget: {
      maxItems: req.maxItems,
      maxChars: req.maxChars,
      itemCount: items.length,
      charCount,
      truncated: exclusions.some((e) => e.reason === "context budget"),
    },
    reproducibleKey,
  };
}

export function assembleContextPackage(opts: {
  request: ContextAssemblyInput;
  memories: ContextMemory[];
  epistemic: Map<string, EpistemicRecord>;
  contradictions: ContradictionRecord[];
  now: string;
}): ContextPackage {
  const epistemic = [...opts.epistemic.values()];
  const snapshot: DerivedQuerySnapshot = {
    status: "ready",
    persistDir: null,
    durable: false,
    fingerprint: rebuildFingerprint({
      epistemic,
      contradictions: opts.contradictions,
      reflections: [],
    }),
    rebuildGeneration: 0,
    corePin: "",
    vaultReferenceSha: "",
    schemaVersion: DERIVED_INDEX_SCHEMA,
    epistemic,
    contradictions: opts.contradictions,
    reflections: [],
    proposals: [],
  };
  return assembleContextFromQuery({
    query: DerivedQueryService.fromSnapshot(snapshot),
    request: opts.request,
    catalog: opts.memories,
    now: opts.now,
  });
}
