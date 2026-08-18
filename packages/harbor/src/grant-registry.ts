/**
 * Durable Grant Registry — persistDir JSON of the full AuthorizationGrant.
 * Reload restores history. Does not issueAuthorization. Does not mint ids.
 * Memory structuredData grantId/authorizedById are citations, not grants.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HarborActorKind } from "./types.js";
import type { CanonicalActionRecord } from "./agency.js";

export interface DurableGrantRecord {
  grantId: string;
  grantedBy: { id: string; kind: "human" };
  grantedTo: { id: string; kind: HarborActorKind };
  capability: "CANONICAL_COMMIT" | "EXTERNAL_ACTION";
  action: string;
  target: string;
  issuedAt: string;
  consumed: boolean;
}

export interface GrantIdentity {
  grantId: string;
  grantedBy: { id: string; kind: "human" };
  grantedTo: { id: string; kind: HarborActorKind };
  capability: "CANONICAL_COMMIT" | "EXTERNAL_ACTION";
  action: string;
  target: string;
  issuedAt: string;
  consumed?: boolean;
}

const REGISTRY_FILE = "grants.json";

export function grantRecordsEqual(stored: DurableGrantRecord, grant: GrantIdentity): boolean {
  const consumed = grant.consumed ?? false;
  return (
    stored.grantId === grant.grantId &&
    stored.grantedBy.id === grant.grantedBy.id &&
    stored.grantedBy.kind === grant.grantedBy.kind &&
    stored.grantedTo.id === grant.grantedTo.id &&
    stored.grantedTo.kind === grant.grantedTo.kind &&
    stored.capability === grant.capability &&
    stored.action === grant.action &&
    stored.target === grant.target &&
    stored.issuedAt === grant.issuedAt &&
    stored.consumed === consumed
  );
}

function identityEqual(stored: DurableGrantRecord, grant: GrantIdentity): boolean {
  return (
    stored.grantId === grant.grantId &&
    stored.grantedBy.id === grant.grantedBy.id &&
    stored.grantedBy.kind === grant.grantedBy.kind &&
    stored.grantedTo.id === grant.grantedTo.id &&
    stored.grantedTo.kind === grant.grantedTo.kind &&
    stored.capability === grant.capability &&
    stored.action === grant.action &&
    stored.target === grant.target &&
    stored.issuedAt === grant.issuedAt
  );
}

export class DurableGrantRegistry {
  private records: DurableGrantRecord[] = [];
  private actions: CanonicalActionRecord[] = [];

  constructor(readonly persistDir?: string) {
    if (persistDir) this.restore();
  }

  issuedCount(): number {
    return this.records.length;
  }

  snapshot(): DurableGrantRecord[] {
    return this.records.map(cloneRecord);
  }

  recordIssued(grant: GrantIdentity): void {
    this.records.push({
      grantId: grant.grantId,
      grantedBy: { id: grant.grantedBy.id, kind: grant.grantedBy.kind },
      grantedTo: { id: grant.grantedTo.id, kind: grant.grantedTo.kind },
      capability: grant.capability,
      action: grant.action,
      target: grant.target,
      issuedAt: grant.issuedAt,
      consumed: false,
    });
    this.persist();
  }

  /** Whole-record compare including consumed. grantId membership alone is not enough. */
  isIssuedGrant(grant: GrantIdentity): boolean {
    return this.records.some((r) => grantRecordsEqual(r, grant));
  }

  findIdentity(grant: GrantIdentity): DurableGrantRecord | undefined {
    return this.records.find((r) => identityEqual(r, grant));
  }

  isConsumed(grant: GrantIdentity): boolean {
    return Boolean(this.findIdentity(grant)?.consumed);
  }

  markConsumed(grant: GrantIdentity): void {
    const rec = this.findIdentity(grant);
    if (!rec) return;
    rec.consumed = true;
    this.persist();
  }

  recordCanonicalAction(record: CanonicalActionRecord): void {
    this.actions.push(structuredClone(record));
    this.persist();
  }

  canonicalActions(): CanonicalActionRecord[] {
    return this.actions.map((r) => structuredClone(r));
  }

  /**
   * Restore history from persistDir. Does not issueAuthorization. Does not mint ids.
   */
  private restore(): void {
    if (!this.persistDir) return;
    const file = path.join(this.persistDir, REGISTRY_FILE);
    if (!existsSync(file)) {
      this.records = [];
      this.actions = [];
      return;
    }
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      grants?: DurableGrantRecord[];
      records?: CanonicalActionRecord[];
    };
    this.records = Array.isArray(raw.grants) ? raw.grants.map(cloneRecord) : [];
    this.actions = Array.isArray(raw.records) ? raw.records.map((r) => structuredClone(r)) : [];
  }

  private persist(): void {
    if (!this.persistDir) return;
    mkdirSync(this.persistDir, { recursive: true });
    const file = path.join(this.persistDir, REGISTRY_FILE);
    const tmp = `${file}.tmp`;
    const body = JSON.stringify({ grants: this.records, records: this.actions }, null, 2) + "\n";
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, file);
  }
}

function cloneRecord(r: DurableGrantRecord): DurableGrantRecord {
  return {
    grantId: r.grantId,
    grantedBy: { id: r.grantedBy.id, kind: r.grantedBy.kind },
    grantedTo: { id: r.grantedTo.id, kind: r.grantedTo.kind },
    capability: r.capability,
    action: r.action,
    target: r.target,
    issuedAt: r.issuedAt,
    consumed: r.consumed,
  };
}

let defaultRegistry: DurableGrantRegistry | undefined;

export function getDefaultGrantRegistry(): DurableGrantRegistry {
  if (!defaultRegistry) defaultRegistry = new DurableGrantRegistry();
  return defaultRegistry;
}
