import { candidateIdFor } from "./ids.js";
import type { DerivedCandidate, Segment } from "./types.js";

export function candidatesFromSegments(segments: Segment[]): DerivedCandidate[] {
  return segments.map((s) => ({
    candidateId: candidateIdFor(s.segmentId),
    sourceId: s.sourceId,
    itemId: s.itemId,
    segmentId: s.segmentId,
    text: s.text,
    epistemicStatus: "UNCERTAIN",
    status: "DERIVED",
    provenance: {
      sourceId: s.sourceId,
      itemId: s.itemId,
      segmentId: s.segmentId,
      locator: s.locator,
      note: "Derived candidate from local source. Not recorded Memory. Not proof.",
    },
  }));
}
