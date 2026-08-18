/**
 * Production EventStore surface is read-only.
 * append stays TEST_ONLY via testOnlyEventStore(), never runtime.store.
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

const WRITABLE = new WeakMap<object, EventStore>();

/** Production view: reads work; append always fails. */
export function asProductionStore(store: EventStore): EventStoreRead {
  const view: EventStoreRead & { append: EventStore["append"] } = {
    getCurrentVersion: (id) => store.getCurrentVersion(id),
    getByAggregate: (id) => store.getByAggregate(id),
    getStream: (opts) => store.getStream(opts),
    getByEventId: (id) => store.getByEventId(id),
    getByIdempotencyKey: (key) => store.getByIdempotencyKey(key),
    append: async () => {
      throw new Error("EventStore.append is TEST_ONLY — not a production write path");
    },
  };
  Object.defineProperty(view, "constructor", { value: store.constructor });
  WRITABLE.set(view, store);
  return view;
}

/**
 * TEST_ONLY harness. Not a production write path.
 * Production-shaped runtime.store.append is not this function.
 */
export function testOnlyEventStore(holder: { store: EventStoreRead } | EventStoreRead): EventStore {
  const key = "store" in holder ? holder.store : holder;
  const store = WRITABLE.get(key);
  if (!store) {
    throw new Error("TEST_ONLY EventStore harness: no writable store for this runtime");
  }
  return store;
}
