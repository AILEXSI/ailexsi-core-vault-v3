/**
 * In-memory EventStore double implementing the Core EventStore contract.
 * Used for V2 unit/integration tests without Postgres.
 *
 * Rules mirror Core AAS-Buch2 (as enforced by PostgresEventStore):
 * - same idempotencyKey + identical payload → return original, no append
 * - same idempotencyKey + different payload → IdempotencyConflictError
 * - aggregateVersion must be previous + 1
 *
 * This is a test harness, not a competing canonical store.
 */

import type { EventEnvelope } from "@ailexsi/contracts";
import {
  payloadsEqual,
  IdempotencyConflictError,
  ConcurrencyConflictError,
  OrderingViolationError,
  DomainEventSchema,
  EventValidationError,
} from "@ailexsi/contracts";
import type { EventStore, AppendResult } from "@ailexsi/eventstore";

export class InMemoryEventStore implements EventStore {
  private events: EventEnvelope[] = [];
  private byKey = new Map<string, EventEnvelope>();
  private nextSequence = 1;

  async append(envelope: EventEnvelope): Promise<AppendResult> {
    const parsed = DomainEventSchema.safeParse(envelope.event);
    if (!parsed.success) {
      throw new EventValidationError(
        `Invalid DomainEvent: ${parsed.error.message}`
      );
    }

    const existing = this.byKey.get(envelope.event.idempotencyKey);
    if (existing) {
      if (payloadsEqual(existing.event.payload, envelope.event.payload)) {
        return { appended: false, event: existing.event, envelope: existing };
      }
      throw new IdempotencyConflictError(envelope.event.idempotencyKey);
    }

    const currentVersion = await this.getCurrentVersion(
      envelope.event.aggregateId
    );
    const expectedNext = currentVersion + 1;
    if (envelope.event.aggregateVersion !== expectedNext) {
      if (envelope.event.aggregateVersion <= currentVersion) {
        throw new ConcurrencyConflictError(
          envelope.event.aggregateId,
          envelope.event.aggregateVersion,
          currentVersion
        );
      }
      throw new OrderingViolationError(
        envelope.event.aggregateId,
        envelope.event.aggregateVersion,
        expectedNext
      );
    }

    const stored: EventEnvelope = {
      ...envelope,
      sequenceId: this.nextSequence++,
    };
    this.events.push(stored);
    this.byKey.set(envelope.event.idempotencyKey, stored);
    return { appended: true, event: stored.event, envelope: stored };
  }

  async getCurrentVersion(aggregateId: string): Promise<number> {
    return this.events
      .filter((e) => e.event.aggregateId === aggregateId)
      .reduce((m, e) => Math.max(m, e.event.aggregateVersion), 0);
  }

  async getByAggregate(aggregateId: string): Promise<EventEnvelope[]> {
    return this.events
      .filter((e) => e.event.aggregateId === aggregateId)
      .sort((a, b) => a.event.aggregateVersion - b.event.aggregateVersion);
  }

  async getStream(options?: {
    afterSequence?: number;
    limit?: number;
  }): Promise<EventEnvelope[]> {
    const after = options?.afterSequence ?? 0;
    const limit = options?.limit ?? 1000;
    return this.events
      .filter((e) => (e.sequenceId ?? 0) > after)
      .sort((a, b) => (a.sequenceId ?? 0) - (b.sequenceId ?? 0))
      .slice(0, limit);
  }

  async getByEventId(eventId: string): Promise<EventEnvelope | null> {
    return this.events.find((e) => e.event.eventId === eventId) ?? null;
  }

  async getByIdempotencyKey(key: string): Promise<EventEnvelope | null> {
    return this.byKey.get(key) ?? null;
  }

  /** Test helper: all envelopes in append order. */
  all(): EventEnvelope[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
    this.byKey.clear();
    this.nextSequence = 1;
  }

  count(): number {
    return this.events.length;
  }
}
