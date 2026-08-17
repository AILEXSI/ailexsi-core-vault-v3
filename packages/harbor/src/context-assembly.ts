import { createHash } from "node:crypto";
import type {
  ContextPackage,
  ContextPackageItem,
  ContradictionRecord,
  EpistemicRecord,
  EpistemicStatus,
  InclusionReason,
} from "./types.js";
import { HARBOR_CLASS } from "./types.js";

export type ContextAssemblyInput = {
  query?: string;
  currentTask?: string;
  conversationContext?: string;
  selectedMemoryIds?: string[];
  projects?: string[];
  tags?: string[];
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

function excerptOf(text: string, n = 180): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function scoreRelevance(mem: ContextMemory, req: ContextAssemblyInput): { score: number; reason: InclusionReason; detail: string } {
  if (req.selectedMemoryIds?.includes(mem.id)) {
    return { score: 1, reason: "selected", detail: "User-selected memory" };
  }
  if (req.projects?.length && mem.project && req.projects.includes(mem.project)) {
    return { score: 0.85, reason: "project_match", detail: `project=${mem.project}` };
  }
  if (req.tags?.length && mem.tags.some((t) => req.tags!.includes(t))) {
    return { score: 0.8, reason: "tag_match", detail: `tags ∩ ${req.tags.join(",")}` };
  }
  const q = (req.query ?? req.currentTask ?? "").toLowerCase();
  if (q && mem.text.toLowerCase().includes(q)) {
    return { score: 0.75, reason: "retrieved", detail: "Query/task substring match" };
  }
  return { score: 0.2, reason: "retrieved", detail: "Included under remaining budget (weak match)" };
}

export function assembleContextPackage(opts: {
  request: ContextAssemblyInput;
  memories: ContextMemory[];
  epistemic: Map<string, EpistemicRecord>;
  contradictions: ContradictionRecord[];
  now: string;
}): ContextPackage {
  const req = opts.request;
  const ranked = opts.memories
    .map((m) => ({ m, ...scoreRelevance(m, req) }))
    .sort((a, b) => b.score - a.score || a.m.id.localeCompare(b.m.id));

  const items: ContextPackageItem[] = [];
  const exclusions: ContextPackage["exclusions"] = [];
  let charCount = 0;

  for (const row of ranked) {
    const epi = opts.epistemic.get(row.m.id);
    const status: EpistemicStatus = epi?.status ?? "FACT";
    if (status === "REJECTED") {
      exclusions.push({ memoryId: row.m.id, reason: "epistemic status REJECTED" });
      continue;
    }
    if (req.temporal?.from && row.m.updatedAt && row.m.updatedAt < req.temporal.from) {
      exclusions.push({ memoryId: row.m.id, reason: "outside temporal from" });
      continue;
    }
    if (req.temporal?.to && row.m.updatedAt && row.m.updatedAt > req.temporal.to) {
      exclusions.push({ memoryId: row.m.id, reason: "outside temporal to" });
      continue;
    }
    const item: ContextPackageItem = {
      memoryId: row.m.id,
      kind: status === "FACT" ? "canonical" : "derived",
      epistemicStatus: status,
      confidence: epi?.confidence ?? 1,
      relevance: row.score,
      reason: row.reason,
      reasonDetail: row.detail,
      excerpt: excerptOf(row.m.text),
      project: row.m.project,
      tags: row.m.tags,
      updatedAt: row.m.updatedAt,
      relationships: opts.contradictions
        .filter((c) => c.memoryIdA === row.m.id || c.memoryIdB === row.m.id)
        .map((c) => c.id),
    };
    const size = JSON.stringify(item).length;
    if (items.length >= req.maxItems || charCount + size > req.maxChars) {
      exclusions.push({ memoryId: row.m.id, reason: "context budget" });
      continue;
    }
    items.push(item);
    charCount += size;
  }

  const related = opts.contradictions.filter((c) =>
    items.some((i) => i.memoryId === c.memoryIdA || i.memoryId === c.memoryIdB)
  );

  const request = { ...req };
  const reproducibleKey = createHash("sha256")
    .update(JSON.stringify({ request, itemIds: items.map((i) => i.memoryId) }))
    .digest("hex");

  return {
    class: HARBOR_CLASS,
    request,
    assembledAt: opts.now,
    items,
    contradictions: related,
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
