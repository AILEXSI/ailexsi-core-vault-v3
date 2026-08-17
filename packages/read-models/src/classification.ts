/**
 * Read-model classification.
 *
 * CANONICAL  — mirrors Core projection facts (rebuildable from EventStore)
 * DERIVED    — V2-computed views (rebuildable from canonical + rules)
 * CACHED     — performance materialization (disposable)
 * EPHEMERAL  — UI/session-only (not replayable as canonical)
 */

export type FactClass = "CANONICAL" | "DERIVED" | "CACHED" | "EPHEMERAL";

export interface ClassifiedField<T> {
  value: T;
  class: FactClass;
  source: string;
}

export function classify<T>(
  value: T,
  factClass: FactClass,
  source: string
): ClassifiedField<T> {
  return { value, class: factClass, source };
}
