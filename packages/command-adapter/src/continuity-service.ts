/**
 * Continuity Foundation v1 — orchestration over MemoryQueryService.
 * READ/DERIVED only. Never appends to EventStore.
 */

import {
  buildContinuityPackageV1,
  parseContinuityV1,
  serializeContinuityV1,
  packagesIdentityEqual,
  inspectContinuityV1,
  type ContinuityPackageV1,
  type ContinuitySelection,
  type ContinuityRetrieveParams,
  type ContinuityContextParams,
  type ContinuityInspectionItem,
} from "@ailexsi/v2-continuity";
import type { MemoryQueryService } from "./memory-query-service.js";
import type { RetrieveMemoriesQuery } from "./memory-retrieval.js";
import type { UUID } from "@ailexsi/contracts";

export type ContinuityExportSpec = {
  selection: ContinuitySelection;
  /** ISO audit timestamp; omitted from identity equality if present */
  generatedAt?: string;
  includeInspection?: boolean;
};

export type ContinuityRehydrateResult = {
  ok: boolean;
  orderedMemoryIds: string[];
  missingIds: string[];
  retrieveMatch?: boolean;
  contextMatch?: boolean;
  errors: string[];
};

export interface ContinuityServiceDeps {
  queries: MemoryQueryService;
  coreBaselineSha: string;
  vaultReferenceSha: string;
}

export class ContinuityService {
  constructor(private readonly deps: ContinuityServiceDeps) {}

  /**
   * Export DERIVED package from current Core-backed read path.
   */
  async exportPackage(spec: ContinuityExportSpec): Promise<ContinuityPackageV1> {
    const ordered = await this.resolveOrderedIds(spec.selection);
    let inspection: ContinuityInspectionItem[] | undefined;

    if (spec.includeInspection !== false) {
      inspection = [];
      for (const id of ordered) {
        const view = await this.deps.queries.getMemory(id as UUID);
        if (!view) {
          throw new Error(`export: memory not found in Core: ${id}`);
        }
        inspection.push({
          id: view.id,
          shortId: view.shortId,
          version: view.currentVersion.value,
          lifecycleState: view.lifecycle.value.state,
          title: view.displayTitle.value,
          updatedAt: view.timestamps.value.confirmedAt,
          tags: view.context.value.tags ?? [],
          project: view.context.value.project,
          _meta: { class: "CORE-CANONICAL" },
        });
      }
    }

    return buildContinuityPackageV1({
      coreBaselineSha: this.deps.coreBaselineSha,
      vaultReferenceSha: this.deps.vaultReferenceSha,
      selection: spec.selection,
      orderedMemoryIds: ordered,
      inspectionMemories: inspection,
      generatedAt: spec.generatedAt,
    });
  }

  inspect(pkg: ContinuityPackageV1 | string) {
    const p = typeof pkg === "string" ? parseContinuityV1(pkg) : pkg;
    return inspectContinuityV1(p);
  }

  serialize(pkg: ContinuityPackageV1): string {
    return serializeContinuityV1(pkg);
  }

  parse(json: string): ContinuityPackageV1 {
    return parseContinuityV1(json);
  }

  identityEqual(a: ContinuityPackageV1, b: ContinuityPackageV1): boolean {
    return packagesIdentityEqual(a, b);
  }

  /**
   * Verify package against Core via query path. Does not import cells as authority.
   */
  async rehydrateVerify(
    pkg: ContinuityPackageV1 | string
  ): Promise<ContinuityRehydrateResult> {
    const p = typeof pkg === "string" ? parseContinuityV1(pkg) : pkg;
    const errors: string[] = [];
    const missingIds: string[] = [];

    if (p.coreBaselineSha !== this.deps.coreBaselineSha) {
      errors.push(
        `core pin mismatch: package=${p.coreBaselineSha} runtime=${this.deps.coreBaselineSha}`
      );
    }
    if (p.vaultReferenceSha !== this.deps.vaultReferenceSha) {
      errors.push(
        `vault pin mismatch: package=${p.vaultReferenceSha} runtime=${this.deps.vaultReferenceSha}`
      );
    }

    for (const id of p.orderedMemoryIds) {
      const view = await this.deps.queries.getMemory(id as UUID);
      if (!view) missingIds.push(id);
    }

    let retrieveMatch: boolean | undefined;
    if (p.selection.mode === "retrieve" && p.selection.retrieve) {
      const page = await this.deps.queries.retrieveMemories(
        p.selection.retrieve as RetrieveMemoriesQuery
      );
      const got = page.items.map((i) => i.id);
      retrieveMatch =
        got.length === p.orderedMemoryIds.length &&
        got.every((id, i) => id === p.orderedMemoryIds[i]);
      if (!retrieveMatch) {
        errors.push("retrieve reapplication order/ids mismatch");
      }
    }

    let contextMatch: boolean | undefined;
    if (p.selection.context) {
      const ctxParams = p.selection.context;
      const bundle = await this.deps.queries.assembleContext({
        memoryIds: p.orderedMemoryIds as UUID[],
        maxItems: ctxParams.maxItems,
        maxChars: ctxParams.maxChars,
        includeHistory: ctxParams.includeHistory,
        maxHistoryEvents: ctxParams.maxHistoryEvents,
      });
      const ctxIds = bundle.items.map((i) => i.id);
      const expected = p.orderedMemoryIds.slice(0, ctxParams.maxItems);
      // context may truncate by chars; compare prefix of package order within budget
      contextMatch = ctxIds.every((id, i) => id === expected[i]);
      if (ctxIds.length > expected.length) contextMatch = false;
      if (!contextMatch) {
        // soft: still ok if all ctx ids are in package order prefix
        const prefix = p.orderedMemoryIds.slice(0, ctxIds.length);
        contextMatch = ctxIds.every((id, i) => id === prefix[i]);
      }
      if (!contextMatch) errors.push("context reapplication mismatch");
    }

    const ok =
      errors.length === 0 &&
      missingIds.length === 0 &&
      (retrieveMatch === undefined || retrieveMatch) &&
      (contextMatch === undefined || contextMatch);

    return {
      ok,
      orderedMemoryIds: [...p.orderedMemoryIds],
      missingIds,
      retrieveMatch,
      contextMatch,
      errors,
    };
  }

  private async resolveOrderedIds(
    selection: ContinuitySelection
  ): Promise<string[]> {
    if (selection.mode === "ids") {
      const ids = selection.memoryIds ?? [];
      if (ids.length === 0) {
        throw new Error("selection.mode=ids requires memoryIds");
      }
      // validate existence; preserve input order
      for (const id of ids) {
        const view = await this.deps.queries.getMemory(id as UUID);
        if (!view) throw new Error(`unknown memory id: ${id}`);
      }
      return [...ids];
    }

    if (selection.mode === "retrieve") {
      if (!selection.retrieve) {
        throw new Error("selection.mode=retrieve requires retrieve params");
      }
      const page = await this.deps.queries.retrieveMemories(
        selection.retrieve as RetrieveMemoriesQuery
      );
      return page.items.map((i) => i.id);
    }

    throw new Error(`unknown selection mode: ${(selection as ContinuitySelection).mode}`);
  }
}

export type { ContinuityRetrieveParams, ContinuityContextParams, ContinuityPackageV1 };
