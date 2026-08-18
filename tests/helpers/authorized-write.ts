/**
 * Test helper: seed writes go through AgencyBoundary.commitCanonical
 * so the Core Adapter Gate sees an Authorized Mutation Context.
 */
import { randomUUID } from "node:crypto";
import type { MemoryCell } from "@ailexsi/contracts";
import type { MemoryCommandAdapter } from "@ailexsi/v2-command-adapter";
import type {
  V2CreateMemoryCommand,
  V2LifecycleCommand,
  V2UpdateMemoryCommand,
} from "@ailexsi/v2-command-adapter";
import {
  HarborService,
  issueAuthorization,
  type HarborActor,
} from "@ailexsi/v3-harbor";

const CORE_PIN = "652d01eb06dd0841c3b475023883675af6dcd698";

export const TEST_SESSION_ACTOR: HarborActor = {
  id: "desktop-user",
  kind: "human",
  authorizeCanonical: true,
  authorizeExternal: true,
};

export const TEST_CHANNEL_TOKEN = "test-channel-token";

export const TEST_HUMAN: HarborActor = {
  id: "martin",
  kind: "human",
  authorizeCanonical: true,
  authorizeExternal: true,
};

export async function viaCanonicalCommit<T>(
  execute: () => Promise<T>,
  opts?: { actor?: HarborActor; action?: string; target?: string }
): Promise<T> {
  const actor = opts?.actor ?? TEST_HUMAN;
  const action = opts?.action ?? "memory.create";
  const target = opts?.target ?? `seed:${randomUUID()}`;
  const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "test" });
  const grant = issueAuthorization(actor, {
    grantedTo: { id: actor.id, kind: actor.kind },
    capability: "CANONICAL_COMMIT",
    action,
    target,
  });
  const { result } = await harbor.commitCanonical({
    actor,
    grant,
    action,
    target,
    execute: async () => {
      const result = await execute();
      return { result, eventIds: [] };
    },
  });
  return result;
}

export async function authorizedCreate(
  adapter: MemoryCommandAdapter,
  cmd: V2CreateMemoryCommand
): Promise<MemoryCell> {
  return viaCanonicalCommit(() => adapter.create(cmd), {
    action: "memory.create",
    target: cmd.idempotencyKey,
  });
}

export async function authorizedUpdate(
  adapter: MemoryCommandAdapter,
  cmd: V2UpdateMemoryCommand
): Promise<MemoryCell> {
  return viaCanonicalCommit(() => adapter.update(cmd), {
    action: "memory.update",
    target: String(cmd.memoryId),
  });
}

export async function authorizedArchive(
  adapter: MemoryCommandAdapter,
  cmd: V2LifecycleCommand
): Promise<MemoryCell> {
  return viaCanonicalCommit(() => adapter.archive(cmd), {
    action: "memory.archive",
    target: String(cmd.memoryId),
  });
}

export async function authorizedRestore(
  adapter: MemoryCommandAdapter,
  cmd: V2LifecycleCommand
): Promise<MemoryCell> {
  return viaCanonicalCommit(() => adapter.restore(cmd), {
    action: "memory.restore",
    target: String(cmd.memoryId),
  });
}
