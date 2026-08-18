/**
 * Production EventStore surface is read-only.
 * No WeakMap, no writer recovery, no append.
 */
import type { EventEnvelope } from "@ailexsi/contracts";
import type { EventStore } from "@ailexsi/eventstore";

export interface EventStoreRead {
  getCurrentVersion(aggregateId: string): Promise<number>;
  getByAggregate(aggregateId: string): Promise<EventEnvelope[]>;
  getStream(options?: { afterSequence?: number; limit?: number }): Promise<EventEnvelope[]>;
  getByEventId(eventId: string): Promise<EventEnvelope | null>;
  getByIdempotencyKey(key: string): Promise<EventEnvelope | null>;
}

/** Internal read facade. Not a production export. Does not retain a writer. */
export function asReadOnlyEventStore(store: EventStore): EventStoreRead {
  const view: EventStoreRead = {
    getCurrentVersion: (id) => store.getCurrentVersion(id),
    getByAggregate: (id) => store.getByAggregate(id),
    getStream: (opts) => store.getStream(opts),
    getByEventId: (id) => store.getByEventId(id),
    getByIdempotencyKey: (key) => store.getByIdempotencyKey(key),
  };
  Object.defineProperty(view, "constructor", { value: store.constructor });
  return view;
}
