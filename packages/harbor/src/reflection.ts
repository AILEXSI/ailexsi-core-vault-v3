import type { HarborActor, ReflectionArtifact, ReflectionFinding } from "./types.js";
import { HARBOR_CLASS } from "./types.js";
import { extractPreference } from "./contradiction.js";
import type { ContradictionRecord } from "./types.js";

export type ReflectionMemory = {
  id: string;
  text: string;
  tags: string[];
  project?: string;
  lifecycle?: string;
  updatedAt?: string;
};

export function reflectOnMemories(opts: {
  memories: ReflectionMemory[];
  contradictions: ContradictionRecord[];
  actor: HarborActor;
  now: string;
  id: string;
}): ReflectionArtifact {
  const findings: ReflectionFinding[] = [];
  const tagHits = new Map<string, string[]>();
  const projects = new Map<string, string[]>();
  const prefs: Array<{ id: string; pref: string; at?: string }> = [];

  for (const m of opts.memories) {
    for (const t of m.tags) {
      const list = tagHits.get(t) ?? [];
      list.push(m.id);
      tagHits.set(t, list);
    }
    if (m.project) {
      const list = projects.get(m.project) ?? [];
      list.push(m.id);
      projects.set(m.project, list);
    }
    const pref = extractPreference(m.text);
    if (pref) prefs.push({ id: m.id, pref, at: m.updatedAt });
    if (m.lifecycle === "archived") {
      findings.push({
        kind: "abandoned_goal",
        statement: `Memory ${m.id} is archived.`,
        interpretation: "This may be an abandoned or completed thread.",
        confidence: 0.45,
        evidenceMemoryIds: [m.id],
      });
    }
  }

  for (const [tag, ids] of tagHits) {
    if (ids.length >= 3) {
      findings.push({
        kind: "pattern",
        statement: `Pattern "${tag}" appears across memories ${ids.join(", ")}.`,
        interpretation: "This may indicate a recurring theme.",
        confidence: Math.min(0.9, 0.4 + ids.length * 0.1),
        evidenceMemoryIds: ids,
      });
    }
  }

  for (const [project, ids] of projects) {
    findings.push({
      kind: "project_link",
      statement: `Project "${project}" links ${ids.length} memories.`,
      confidence: 0.8,
      evidenceMemoryIds: ids,
    });
  }

  const uniquePrefs = [...new Set(prefs.map((p) => p.pref))];
  if (uniquePrefs.length > 1) {
    findings.push({
      kind: "preference_shift",
      statement: `Preferences differ: ${uniquePrefs.join(" vs ")}.`,
      interpretation: "This may indicate change over time or contextual preference.",
      confidence: 0.66,
      evidenceMemoryIds: prefs.map((p) => p.id),
    });
  }

  for (const c of opts.contradictions.filter((x) => x.resolution === "UNRESOLVED")) {
    findings.push({
      kind: "contradiction",
      statement: `Unresolved contradiction ${c.id}: ${c.excerptA} vs ${c.excerptB}.`,
      interpretation: "Do not auto-decide. Human resolution required.",
      confidence: c.confidence,
      evidenceMemoryIds: [c.memoryIdA, c.memoryIdB],
    });
  }

  if (findings.length === 0) {
    findings.push({
      kind: "uncertainty",
      statement: "Insufficient evidence for a stronger reflection.",
      interpretation: "I don't know more than the listed memories show.",
      confidence: 0.3,
      evidenceMemoryIds: opts.memories.map((m) => m.id),
    });
  }

  return {
    id: opts.id,
    createdAt: opts.now,
    findings,
    provenance: {
      sourceMemoryIds: opts.memories.map((m) => m.id),
      sourceEventIds: [],
      agentId: opts.actor.id,
      actorKind: opts.actor.kind,
      createdAt: opts.now,
      derivationType: "reflect",
      confidence: findings.reduce((s, f) => s + f.confidence, 0) / findings.length,
      class: HARBOR_CLASS,
    },
    status: "DERIVED",
    class: HARBOR_CLASS,
  };
}
