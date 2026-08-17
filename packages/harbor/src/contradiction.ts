import { createHash } from "node:crypto";
import type { ContradictionRecord, HarborActor } from "./types.js";
import { HARBOR_CLASS } from "./types.js";

export type MemoryText = {
  id: string;
  text: string;
  updatedAt?: string;
};

const PREFERS = /\b(?:user\s+)?prefers\s+([A-Za-z0-9][\w-]*)/i;

export function extractPreference(text: string): string | null {
  const m = text.match(PREFERS);
  return m?.[1] ? m[1].toLowerCase() : null;
}

export function detectContradictions(
  memories: MemoryText[],
  actor: HarborActor,
  now: string
): ContradictionRecord[] {
  const byKey = new Map<string, MemoryText[]>();
  for (const mem of memories) {
    const pref = extractPreference(mem.text);
    if (!pref) continue;
    const list = byKey.get("prefers") ?? [];
    list.push({ ...mem, text: pref });
    byKey.set("prefers", list);
  }
  const prefs = byKey.get("prefers") ?? [];
  const out: ContradictionRecord[] = [];
  for (let i = 0; i < prefs.length; i++) {
    for (let j = i + 1; j < prefs.length; j++) {
      const a = prefs[i]!;
      const b = prefs[j]!;
      if (a.text === b.text) continue;
      const ids = [a.id, b.id].sort();
      const id = createHash("sha256").update(ids.join("|")).digest("hex").slice(0, 16);
      out.push({
        id,
        memoryIdA: a.id,
        memoryIdB: b.id,
        excerptA: `prefers ${a.text}`,
        excerptB: `prefers ${b.text}`,
        detectedAt: now,
        timestamps: { a: a.updatedAt ?? now, b: b.updatedAt ?? now },
        provenance: {
          sourceMemoryIds: ids,
          sourceEventIds: [],
          agentId: actor.id,
          actorKind: actor.kind,
          createdAt: now,
          derivationType: "contradict",
          confidence: 0.7,
          class: HARBOR_CLASS,
        },
        confidence: 0.7,
        possibleExplanations: [
          "Preferences may be contextual (time, project, domain).",
          "One statement may have superseded the other.",
          "The subject of preference may differ despite similar phrasing.",
        ],
        resolution: "UNRESOLVED",
        class: HARBOR_CLASS,
      });
    }
  }
  return out;
}

export function resolveContradiction(
  record: ContradictionRecord,
  resolution: ContradictionRecord["resolution"],
  actor: HarborActor,
  now: string
): ContradictionRecord {
  if (resolution === "UNRESOLVED") {
    return { ...record, resolution, resolvedAt: undefined, resolvedBy: undefined };
  }
  if (actor.kind !== "human") {
    throw new Error("Only a human may resolve a contradiction");
  }
  return {
    ...record,
    resolution,
    resolvedAt: now,
    resolvedBy: actor,
  };
}
