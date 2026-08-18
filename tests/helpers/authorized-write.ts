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
  invokeDesktopCommand,
  type DesktopHost,
  type DesktopMemoryCommand,
} from "@ailexsi/v2-command-adapter";
import { issueTestAuthorization } from "@ailexsi/v2-test-kit";
import {
  HarborService,
  type AuthorizationGrant,
  type AuthorizedMutationContext,
  type HarborActor,
} from "@ailexsi/v3-harbor";

const CORE_PIN = "652d01eb06dd0841c3b475023883675af6dcd698";

export const TEST_CHANNEL_TOKEN = "test-channel-token";

export const TEST_HUMAN: HarborActor = {
  id: "martin",
  kind: "human",
  authorizeCanonical: true,
  authorizeExternal: true,
};

export const TEST_SESSION_ACTOR: HarborActor = {
  id: "desktop-user",
  kind: "human",
  authorizeCanonical: true,
  authorizeExternal: true,
};

export const TEST_HUMAN_A: HarborActor = {
  id: "test-human-a",
  kind: "human",
  authorizeCanonical: true,
  authorizeExternal: true,
};

export const TEST_HUMAN_B: HarborActor = {
  id: "test-human-b",
  kind: "human",
  authorizeCanonical: true,
  authorizeExternal: true,
};

export const TEST_AI: HarborActor = {
  id: "test-ai",
  kind: "ai",
};

const CANONICAL_WRITE_COMMANDS = new Set([
  "memory.create",
  "memory.update",
  "memory.archive",
  "memory.restore",
  "cultivation.proposal.accept",
]);

export function grantActionTarget(
  command: string,
  args: Record<string, unknown>
): { action: string; target: string } {
  switch (command) {
    case "memory.create":
      return { action: "memory.create", target: String(args.idempotencyKey ?? "") };
    case "memory.update":
      return { action: "memory.update", target: String(args.memoryId ?? "") };
    case "memory.archive":
      return { action: "memory.archive", target: String(args.memoryId ?? "") };
    case "memory.restore":
      return { action: "memory.restore", target: String(args.memoryId ?? "") };
    case "cultivation.proposal.accept":
      return { action: "cultivation.accept", target: String(args.proposalId ?? "") };
    default:
      throw new Error(`no AuthorizationGrant mapping for ${command}`);
  }
}

/** Explicit host grant. Not auto-grant — caller must invoke this before mutate. */
export function issueHostGrant(
  host: DesktopHost,
  action: string,
  target: string
): AuthorizationGrant {
  const actor = host.getSessionActor();
  if (!actor) {
    throw new Error("issueHostGrant requires an active Session Actor");
  }
  return host.issueAuthorization({
    grantedTo: { id: actor.id, kind: actor.kind },
    capability: "CANONICAL_COMMIT",
    action,
    target,
  });
}

export function withHostGrant<T extends Record<string, unknown>>(
  host: DesktopHost,
  command: string,
  args: T
): T & { grant: AuthorizationGrant } {
  const { action, target } = grantActionTarget(command, args);
  return { ...args, grant: issueHostGrant(host, action, target) };
}

export async function invokeAuthorized(
  host: DesktopHost,
  command: DesktopMemoryCommand,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  if (!CANONICAL_WRITE_COMMANDS.has(command)) {
    return invokeDesktopCommand(command, args);
  }
  return invokeDesktopCommand(command, withHostGrant(host, command, args));
}

export async function viaCanonicalCommit<T>(
  execute: (ctx: AuthorizedMutationContext) => Promise<T>,
  opts?: { actor?: HarborActor; action?: string; target?: string }
): Promise<T> {
  const actor = opts?.actor ?? TEST_HUMAN;
  const action = opts?.action ?? "memory.create";
  const target = opts?.target ?? `seed:${randomUUID()}`;
  const harbor = new HarborService({ corePin: CORE_PIN, vaultReferenceSha: "test" });
  const grant = issueTestAuthorization(actor, {
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
    execute: async (ctx) => {
      const result = await execute(ctx);
      return { result, eventIds: [] };
    },
  });
  return result;
}

export async function authorizedCreate(
  adapter: MemoryCommandAdapter,
  cmd: V2CreateMemoryCommand
): Promise<MemoryCell> {
  return viaCanonicalCommit((ctx) => adapter.create(cmd, ctx), {
    action: "memory.create",
    target: cmd.idempotencyKey,
  });
}

export async function authorizedUpdate(
  adapter: MemoryCommandAdapter,
  cmd: V2UpdateMemoryCommand
): Promise<MemoryCell> {
  return viaCanonicalCommit((ctx) => adapter.update(cmd, ctx), {
    action: "memory.update",
    target: String(cmd.memoryId),
  });
}

export async function authorizedArchive(
  adapter: MemoryCommandAdapter,
  cmd: V2LifecycleCommand
): Promise<MemoryCell> {
  return viaCanonicalCommit((ctx) => adapter.archive(cmd, ctx), {
    action: "memory.archive",
    target: String(cmd.memoryId),
  });
}

export async function authorizedRestore(
  adapter: MemoryCommandAdapter,
  cmd: V2LifecycleCommand
): Promise<MemoryCell> {
  return viaCanonicalCommit((ctx) => adapter.restore(cmd, ctx), {
    action: "memory.restore",
    target: String(cmd.memoryId),
  });
}
