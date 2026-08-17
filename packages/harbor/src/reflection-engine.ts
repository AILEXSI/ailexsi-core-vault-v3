/**
 * Deterministic OBSERVED reflection over Derived Query + optional ContextPackage.
 * READ-ONLY. Never EventStore. Never Core. Does not persist. Does not resolve contradictions.
 */
import { createHash } from "node:crypto";
import { extractPreference } from "./contradiction.js";
import type { ContextMemory } from "./context-assembly.js";
import type { ContextPackage } from "./types.js";
import type { DerivedQueryService } from "./derived-query.js";
import { HARBOR_CLASS } from "./types.js";
import type { ArtifactProvenance, HarborActor } from "./types.js";

export const REFLECTION_OBSERVATION_SCHEMA = "harbor-reflection-observation-v1" as const;

export type ObservedReflectionType =
  | "recurring_topic"
  | "repeated_goal"
  | "repeated_project"
  | "preference_change"
  | "unresolved_contradiction"
  | "stale_derived"
  | "frequent_reference"
  | "temporal_pattern"
  | "shared_source";

export interface ObservedReflection {
  reflectionId: string;
  schemaVersion: typeof REFLECTION_OBSERVATION_SCHEMA;
  type: ObservedReflectionType;
  observation: string;
  stance: "OBSERVED";
  sourceMemoryIds: string[];
  supportingDerivedIds: string[];
  provenance: ArtifactProvenance;
  temporalScope: { from?: string; to?: string };
  evidenceStrength: number;
  status: "DERIVED";
  class: typeof HARBOR_CLASS;
}

const TYPE_ORDER: ObservedReflectionType[] = [
  "recurring_topic",
  "repeated_goal",
  "repeated_project",
  "preference_change",
  "unresolved_contradiction",
  "stale_derived",
  "frequent_reference",
  "temporal_pattern",
  "shared_source",
];

const UNCONFIRMED: ReadonlySet<string> = new Set(["INFERRED", "UNCERTAIN", "AI_PROPOSED", "DERIVED"]);
const GOAL_LABEL = /\bgoal\s*:\s*([A-Za-z0-9][\w\s-]{0,80})/i;

function byId(a: string, b: string): number {
  return a.localeCompare(b);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function strength(n: number, cap = 8): number {
  return Math.min(1, Math.round((n / cap) * 1000) / 1000);
}

function dayOf(ts?: string): string | undefined {
  if (!ts) return undefined;
  const day = ts.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

function scopeOf(timestamps: Array<string | undefined>): { from?: string; to?: string } {
  const times = timestamps.filter((t): t is string => Boolean(t)).sort(byId);
  if (times.length === 0) return {};
  return { from: times[0], to: times[times.length - 1] };
}

function reflectionId(type: ObservedReflectionType, sourceMemoryIds: string[], extra = ""): string {
  return createHash("sha256")
    .update(`${REFLECTION_OBSERVATION_SCHEMA}|${type}|${[...sourceMemoryIds].sort(byId).join(",")}|${extra}`)
    .digest("hex");
}

function makeObservation(
  type: ObservedReflectionType,
  observation: string,
  sourceMemoryIds: string[],
  supportingDerivedIds: string[],
  timestamps: Array<string | undefined>,
  actor: HarborActor,
  now: string,
  extra = ""
): ObservedReflection {
  const sources = [...new Set(sourceMemoryIds)].sort(byId);
  const supporting = [...new Set(supportingDerivedIds)].sort(byId);
  const evidenceStrength = strength(Math.max(sources.length, supporting.length, 1));
  return {
    reflectionId: reflectionId(type, sources, extra),
    schemaVersion: REFLECTION_OBSERVATION_SCHEMA,
    type,
    observation,
    stance: "OBSERVED",
    sourceMemoryIds: sources,
    supportingDerivedIds: supporting,
    provenance: {
      sourceMemoryIds: sources,
      sourceEventIds: [],
      agentId: actor.id,
      actorKind: actor.kind,
      createdAt: now,
      derivationType: "reflect",
      confidence: evidenceStrength,
      class: HARBOR_CLASS,
    },
    temporalScope: scopeOf(timestamps),
    evidenceStrength,
    status: "DERIVED",
    class: HARBOR_CLASS,
  };
}

function catalogMap(catalog: ContextMemory[] | undefined): Map<string, ContextMemory> {
  const map = new Map<string, ContextMemory>();
  for (const mem of catalog ?? []) map.set(mem.id, mem);
  return map;
}

export function reflectFromQuery(opts: {
  query: DerivedQueryService;
  actor: HarborActor;
  now: string;
  catalog?: ContextMemory[];
  context?: ContextPackage;
}): ObservedReflection[] {
  const catalog = catalogMap(opts.catalog);
  const scoped = opts.context
    ? opts.context.items.map((i) => i.memoryId)
    : opts.query.listDerivedMemories().items.map((i) => i.id);
  const ids = [...new Set(scoped)].sort(byId);
  const out: ObservedReflection[] = [];

  const tagHits = new Map<string, string[]>();
  const projectHits = new Map<string, string[]>();
  const goalHits = new Map<string, string[]>();
  const prefs: Array<{ id: string; pref: string; at?: string }> = [];
  const byDay = new Map<string, string[]>();

  for (const id of ids) {
    const mem = catalog.get(id);
    const view = opts.query.getDerivedMemory(id);
    const ts = mem?.updatedAt ?? view?.lastChangedAt;
    const day = dayOf(ts);
    if (day) {
      const list = byDay.get(day) ?? [];
      list.push(id);
      byDay.set(day, list);
    }
    for (const tag of mem?.tags ?? []) {
      const list = tagHits.get(tag) ?? [];
      list.push(id);
      tagHits.set(tag, list);
      if (tag.toLowerCase() === "goal") {
        const goals = goalHits.get("tag:goal") ?? [];
        goals.push(id);
        goalHits.set("tag:goal", goals);
      }
    }
    if (mem?.project) {
      const list = projectHits.get(mem.project) ?? [];
      list.push(id);
      projectHits.set(mem.project, list);
    }
    if (mem?.text) {
      const pref = extractPreference(mem.text);
      if (pref) prefs.push({ id, pref, at: ts });
      const goal = mem.text.match(GOAL_LABEL);
      if (goal?.[1]) {
        const key = goal[1].trim().toLowerCase();
        const list = goalHits.get(key) ?? [];
        list.push(id);
        goalHits.set(key, list);
      }
    }
  }

  for (const [tag, members] of [...tagHits.entries()].sort((a, b) => byId(a[0], b[0]))) {
    if (members.length < 2) continue;
    const times = members.map((id) => catalog.get(id)?.updatedAt ?? opts.query.getDerivedMemory(id)?.lastChangedAt);
    const span = scopeOf(times);
    out.push(
      makeObservation(
        "recurring_topic",
        `Tag "${tag}" is referenced by ${members.length} records between ${span.from ?? "unknown"} and ${span.to ?? "unknown"}.`,
        members,
        [],
        times,
        opts.actor,
        opts.now,
        tag
      )
    );
  }

  for (const [goal, members] of [...goalHits.entries()].sort((a, b) => byId(a[0], b[0]))) {
    if (members.length < 2) continue;
    const times = members.map((id) => catalog.get(id)?.updatedAt ?? opts.query.getDerivedMemory(id)?.lastChangedAt);
    const span = scopeOf(times);
    const label = goal === "tag:goal" ? "goal" : goal;
    out.push(
      makeObservation(
        "repeated_goal",
        `Goal "${label}" is referenced by ${members.length} records between ${span.from ?? "unknown"} and ${span.to ?? "unknown"}.`,
        members,
        [],
        times,
        opts.actor,
        opts.now,
        goal
      )
    );
  }

  for (const [project, members] of [...projectHits.entries()].sort((a, b) => byId(a[0], b[0]))) {
    if (members.length < 2) continue;
    const times = members.map((id) => catalog.get(id)?.updatedAt ?? opts.query.getDerivedMemory(id)?.lastChangedAt);
    const span = scopeOf(times);
    out.push(
      makeObservation(
        "repeated_project",
        `Project "${project}" is referenced by ${members.length} records between ${span.from ?? "unknown"} and ${span.to ?? "unknown"}.`,
        members,
        [],
        times,
        opts.actor,
        opts.now,
        project
      )
    );
  }

  const uniquePrefs = [...new Set(prefs.map((p) => p.pref))].sort(byId);
  if (uniquePrefs.length > 1) {
    const ordered = [...prefs].sort((a, b) => byId(a.at ?? "", b.at ?? "") || byId(a.id, b.id));
    const detail = ordered.map((p) => `${p.pref} at ${p.at ?? "unknown"} (${p.id})`).join(", ");
    out.push(
      makeObservation(
        "preference_change",
        `Preference values recorded: ${detail}.`,
        ordered.map((p) => p.id),
        [],
        ordered.map((p) => p.at),
        opts.actor,
        opts.now,
        uniquePrefs.join("|")
      )
    );
  }

  for (const rec of opts.query.findContradictions({ resolution: "UNRESOLVED" }).items) {
    const sources = [rec.memoryIdA, rec.memoryIdB].filter((id) => ids.includes(id));
    if (sources.length === 0) continue;
    out.push(
      makeObservation(
        "unresolved_contradiction",
        `Unresolved contradiction ${rec.id}: ${rec.excerptA} vs ${rec.excerptB}.`,
        [rec.memoryIdA, rec.memoryIdB],
        [rec.id],
        [rec.detectedAt, rec.timestamps.a, rec.timestamps.b],
        opts.actor,
        opts.now,
        rec.id
      )
    );
  }

  const unconfirmedByStatus = new Map<string, string[]>();
  for (const id of ids) {
    const view = opts.query.getDerivedMemory(id);
    if (!view || !UNCONFIRMED.has(view.status)) continue;
    const list = unconfirmedByStatus.get(view.status) ?? [];
    list.push(id);
    unconfirmedByStatus.set(view.status, list);
  }
  for (const [status, members] of [...unconfirmedByStatus.entries()].sort((a, b) => byId(a[0], b[0]))) {
    const times = members.map((id) => opts.query.getDerivedMemory(id)?.lastChangedAt);
    const span = scopeOf(times);
    out.push(
      makeObservation(
        "stale_derived",
        `${members.length} memories have unconfirmed derived status ${status} (last changed from ${span.from ?? "unknown"} to ${span.to ?? "unknown"}).`,
        members,
        [],
        times,
        opts.actor,
        opts.now,
        status
      )
    );
  }

  for (const id of ids) {
    const hits = opts.query.findDerivedBySource(id).items.filter((h) => h.kind !== "epistemic");
    if (hits.length < 2) continue;
    const view = opts.query.getDerivedMemory(id);
    out.push(
      makeObservation(
        "frequent_reference",
        `Memory ${id} is referenced by ${hits.length} derived records.`,
        [id],
        hits.map((h) => h.id),
        [view?.lastChangedAt, catalog.get(id)?.updatedAt],
        opts.actor,
        opts.now,
        String(hits.length)
      )
    );
  }

  for (const [day, members] of [...byDay.entries()].sort((a, b) => byId(a[0], b[0]))) {
    if (members.length < 2) continue;
    out.push(
      makeObservation(
        "temporal_pattern",
        `${members.length} records share date ${day}.`,
        members,
        [],
        members.map((id) => catalog.get(id)?.updatedAt ?? opts.query.getDerivedMemory(id)?.lastChangedAt),
        opts.actor,
        opts.now,
        day
      )
    );
  }

  const snapHits = new Map<string, string[]>();
  for (const id of ids) {
    for (const hit of opts.query.findDerivedBySource(id).items) {
      if (hit.kind === "epistemic") continue;
      const key = [...hit.sourceMemoryIds].sort(byId).join(",");
      if (!key) continue;
      const list = snapHits.get(key) ?? [];
      if (!list.includes(hit.id)) list.push(hit.id);
      snapHits.set(key, list);
    }
  }
  for (const [key, derivedIds] of [...snapHits.entries()].sort((a, b) => byId(a[0], b[0]))) {
    if (derivedIds.length < 2) continue;
    const sources = key.split(",").filter(Boolean);
    out.push(
      makeObservation(
        "shared_source",
        `${derivedIds.length} derived records share source set ${sources.join(", ")}.`,
        sources,
        derivedIds,
        sources.map((id) => catalog.get(id)?.updatedAt ?? opts.query.getDerivedMemory(id)?.lastChangedAt),
        opts.actor,
        opts.now,
        key
      )
    );
  }

  out.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || byId(a.reflectionId, b.reflectionId));
  return out.map((item) => clone(item));
}
