/**
 * Unified Memory client for Desktop UI.
 *
 * Prefer order:
 *  1) Tauri invoke → Rust proxy → DesktopHost HTTP bridge
 *  2) Direct HTTP to DesktopHost bridge (Vite dev / fallback)
 *
 * Never stores canonical memory in UI state as authority.
 */

import { TAURI_MEMORY_COMMANDS, type DesktopHostCommandName } from "./memory-api";

export type MemoryDetailView = {
  id: string;
  shortId: string;
  content: { class: string; value: { type?: string; text?: string } };
  context?: {
    class: string;
    value: { tags?: string[]; project?: string; [k: string]: unknown };
  };
  lifecycle: { value: { state: string } };
  currentVersion: { value: number };
  displayTitle: { value: string };
  timestamps: { value: { confirmedAt?: string } };
};

export type MemoryListItem = {
  id: string;
  shortId: string;
  title: string;
  lifecycleState: string;
  version: number;
  tags: string[];
  project?: string;
  updatedAt: string;
};

export type MemoryVersionRow = {
  version: number;
  eventType?: string;
  eventId?: string;
  timestamp?: string;
  changeReason?: string;
  createdAt?: string;
  previousVersion?: number;
  content?: { type?: string; text?: string };
};

const DEFAULT_BRIDGE =
  (import.meta as { env?: Record<string, string> }).env?.VITE_DESKTOP_HOST_URL ||
  "http://127.0.0.1:17890";

function bridgeBase(): string {
  return (
    (import.meta as { env?: Record<string, string> }).env
      ?.VITE_DESKTOP_HOST_URL || DEFAULT_BRIDGE
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tauriInvoke(cmd: string, args: Record<string, any>): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const core = w.__TAURI__?.core ?? w.__TAURI_INTERNALS__;
  if (!core?.invoke) {
    throw new Error("Tauri invoke not available");
  }
  return core.invoke(cmd, args);
}

export async function isTauri(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return Boolean(w.__TAURI__ || w.__TAURI_INTERNALS__);
}

export async function bridgeHealth(): Promise<{
  ok: boolean;
  store: string | null;
  running: boolean;
  detail?: string;
}> {
  try {
    const res = await fetch(`${bridgeBase()}/health`);
    const body = await res.json();
    return {
      ok: Boolean(body.ok),
      store: body.store ?? null,
      running: Boolean(body.running),
      detail: body.path,
    };
  } catch (e) {
    return {
      ok: false,
      store: null,
      running: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function httpCommand(
  command: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any> = {}
): Promise<unknown> {
  const token =
    (import.meta as { env?: Record<string, string> }).env?.VITE_DESKTOP_HOST_TOKEN;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-channel-token"] = token;
  const res = await fetch(`${bridgeBase()}/commands/${command}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  const body = await res.json();
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `bridge ${command} failed (${res.status})`);
  }
  return body.result;
}

/**
 * Invoke any allowlisted DesktopHost command via Tauri (memory CRUD only)
 * or HTTP bridge (full surface including retrieve/context/cultivation).
 */
export async function hostCommand(
  command: DesktopHostCommandName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any> = {}
): Promise<unknown> {
  if (await isTauri()) {
    const map: Partial<Record<DesktopHostCommandName, string>> = {
      "memory.create": TAURI_MEMORY_COMMANDS.create,
      "memory.get": TAURI_MEMORY_COMMANDS.get,
      "memory.list": TAURI_MEMORY_COMMANDS.list,
      "memory.update": TAURI_MEMORY_COMMANDS.update,
      "memory.archive": TAURI_MEMORY_COMMANDS.archive,
      "memory.restore": TAURI_MEMORY_COMMANDS.restore,
      "memory.history": TAURI_MEMORY_COMMANDS.history,
    };
    const tauriCmd = map[command];
    if (tauriCmd) {
      try {
        const raw = await tauriInvoke(tauriCmd, {
          payload: args,
          memoryId: args.memoryId,
          memory_id: args.memoryId,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = raw as any;
        if (r && typeof r === "object" && "result" in r) return r.result;
        return raw;
      } catch {
        /* HTTP fallback */
      }
    }
  }
  return httpCommand(command, args);
}

/** @deprecated prefer hostCommand — Memory CRUD subset */
export async function memoryCommand(
  command:
    | "memory.create"
    | "memory.get"
    | "memory.list"
    | "memory.update"
    | "memory.archive"
    | "memory.restore"
    | "memory.history",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any> = {}
): Promise<unknown> {
  return hostCommand(command, args);
}

export type AuthorityGrant = {
  grantId: string;
  capability: "CANONICAL_COMMIT" | "EXTERNAL_ACTION";
  grantedBy: { id: string; kind: "human" };
  grantedTo: { id: string; kind: string };
  action: string;
  target: string;
  issuedAt: string;
  provenance: { source: "explicit-human-authorization"; notFromProposalAcceptance: true };
};

export type SessionStatus = {
  bound: boolean;
  actor: { id: string; kind: string } | null;
  note: string;
};

export type CreateMemoryOptions = {
  tags?: string[];
  project?: string;
  createdBy?: string;
  grant: AuthorityGrant;
  idempotencyKey: string;
};

export async function fetchSessionStatus(): Promise<SessionStatus> {
  return (await hostCommand("session.status", {})) as SessionStatus;
}

export async function issueAuthorization(
  action: string,
  target: string
): Promise<AuthorityGrant> {
  return (await hostCommand("authorization.issue", {
    action,
    target,
    capability: "CANONICAL_COMMIT",
  })) as AuthorityGrant;
}

export async function createMemory(
  text: string,
  opts: CreateMemoryOptions
): Promise<MemoryDetailView> {
  if (!opts.grant) {
    throw new Error("canonical mutation requires an already-issued AuthorizationGrant");
  }
  if (!opts.idempotencyKey) {
    throw new Error("memory.create requires an explicit target/idempotencyKey");
  }
  const now = new Date().toISOString();
  const tags = opts.tags?.length ? opts.tags : undefined;
  const project = opts.project;
  return (await memoryCommand("memory.create", {
    content: { type: "text", text },
    context:
      tags || project
        ? {
            tags,
            project,
          }
        : undefined,
    provenance: {
      sourceType: "user",
      capturedAt: now,
      parentMemoryIds: [],
      evidenceIds: [],
    },
    createdBy: opts.createdBy,
    grant: opts.grant,
    idempotencyKey: opts.idempotencyKey,
  })) as MemoryDetailView;
}

export async function getMemory(id: string): Promise<MemoryDetailView | null> {
  return (await memoryCommand("memory.get", {
    memoryId: id,
  })) as MemoryDetailView | null;
}

export async function listMemories(): Promise<MemoryListItem[]> {
  return (await memoryCommand("memory.list", {
    includeArchived: true,
  })) as MemoryListItem[];
}

export async function updateMemory(
  memoryId: string,
  text: string,
  opts: {
    changeReason?: string;
    tags?: string[];
    project?: string;
    grant: AuthorityGrant;
  }
): Promise<MemoryDetailView> {
  if (!opts.grant) {
    throw new Error("canonical mutation requires an already-issued AuthorizationGrant");
  }
  return (await memoryCommand("memory.update", {
    memoryId,
    content: { type: "text", text },
    changeReason: opts.changeReason ?? "ui-update",
    context:
      opts.tags || opts.project
        ? { tags: opts.tags, project: opts.project }
        : undefined,
    grant: opts.grant,
  })) as MemoryDetailView;
}

export async function archiveMemory(
  memoryId: string,
  reason = "ui-archive",
  grant?: AuthorityGrant
): Promise<MemoryDetailView> {
  if (!grant) {
    throw new Error("canonical mutation requires an already-issued AuthorizationGrant");
  }
  return (await memoryCommand("memory.archive", {
    memoryId,
    reason,
    grant,
  })) as MemoryDetailView;
}

export async function restoreMemory(
  memoryId: string,
  reason = "ui-restore",
  grant?: AuthorityGrant
): Promise<MemoryDetailView> {
  if (!grant) {
    throw new Error("canonical mutation requires an already-issued AuthorizationGrant");
  }
  return (await memoryCommand("memory.restore", {
    memoryId,
    reason,
    grant,
  })) as MemoryDetailView;
}

export async function getHistory(memoryId: string): Promise<MemoryVersionRow[]> {
  const rows = (await memoryCommand("memory.history", {
    memoryId,
  })) as MemoryVersionRow[];
  return Array.isArray(rows) ? rows : [];
}

/**
 * Persist acceptance evidence as a Core Memory (Vault note — no side files).
 * Tags: evidence, acceptance · project: ailexsi-core-vault-v2
 */
export async function saveAcceptanceEvidence(options?: {
  head?: string;
  extra?: string;
}): Promise<MemoryDetailView> {
  const health = await bridgeHealth();
  const head =
    options?.head?.trim() ||
    (import.meta as { env?: Record<string, string> }).env?.VITE_V2_HEAD ||
    "(set VITE_V2_HEAD or pass head — git rev-parse HEAD)";
  const lines = [
    "AILEXSI Core Vault V2 — Acceptance Evidence",
    `RecordedAt: ${new Date().toISOString()}`,
    `HEAD: ${head}`,
    `Bridge: ${health.ok ? "connected" : "offline"}`,
    `Store: ${health.store ?? "unknown"}`,
    "Desktop path: UI → Bridge → DesktopHost → PostgresEventStore",
    "Phase 08: ABSENT",
    "Notes: stored as Core Memory (tags: evidence, acceptance) — no side files.",
  ];
  if (options?.extra?.trim()) {
    lines.push("", options.extra.trim());
  }
  const idempotencyKey = crypto.randomUUID();
  const grant = await issueAuthorization("memory.create", idempotencyKey);
  return createMemory(lines.join("\n"), {
    tags: ["evidence", "acceptance"],
    project: "ailexsi-core-vault-v2",
    grant,
    idempotencyKey,
  });
}


// ---- Co-creation surface (HTTP bridge / hostCommand) ----

export async function retrieveMemories(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: Record<string, any> = {}
): Promise<unknown> {
  return hostCommand("memory.retrieve", query);
}

export async function assembleMemoryContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>
): Promise<unknown> {
  return hostCommand("memory.context", args);
}

export async function cultivationSessionCreate(): Promise<{ id: string }> {
  return (await hostCommand("cultivation.session.create", {})) as { id: string };
}

export async function cultivationSessionGet(
  sessionId: string
): Promise<unknown> {
  return hostCommand("cultivation.session.get", { sessionId });
}

export async function cultivationChat(args: {
  sessionId: string;
  text: string;
  memoryIds?: string[];
  targetMemoryId?: string;
}): Promise<unknown> {
  return hostCommand("cultivation.chat", args);
}

export async function cultivationProposalReject(
  sessionId: string,
  proposalId: string
): Promise<unknown> {
  return hostCommand("cultivation.proposal.reject", { sessionId, proposalId });
}

export async function cultivationProposalDefer(
  sessionId: string,
  proposalId: string
): Promise<unknown> {
  return hostCommand("cultivation.proposal.defer", { sessionId, proposalId });
}

export async function cultivationProposalAccept(args: {
  sessionId: string;
  proposalId: string;
  editedText?: string;
  idempotencyKey?: string;
}): Promise<unknown> {
  return hostCommand("cultivation.proposal.accept", args);
}

export async function harborSnapshot(): Promise<unknown> {
  return hostCommand("harbor.snapshot", { actorKind: "human" });
}

export async function harborScan(): Promise<unknown> {
  return hostCommand("harbor.scan", { actorKind: "human" });
}

export async function harborReflect(): Promise<unknown> {
  return hostCommand("harbor.reflect", { actorKind: "human" });
}

export async function harborContext(query: string): Promise<unknown> {
  return hostCommand("harbor.context", {
    actorKind: "human",
    query,
    maxItems: 12,
    maxChars: 8000,
  });
}

export async function harborExport(): Promise<unknown> {
  return hostCommand("harbor.export", { actorKind: "human", selectedCanonicalMemoryIds: [] });
}

export async function dockStatus(): Promise<unknown> {
  return hostCommand("dock.status", {});
}

export async function dockDiscover(rootPath: string, recursive = true): Promise<unknown> {
  return hostCommand("dock.discover", { rootPath, recursive });
}

export async function dockPreview(rootPath: string, relativePath: string): Promise<unknown> {
  return hostCommand("dock.preview", { rootPath, relativePath });
}

export async function dockSegments(rootPath: string, relativePath: string): Promise<unknown> {
  return hostCommand("dock.segments", { rootPath, relativePath });
}

export async function dockCandidates(rootPath: string, relativePath: string): Promise<unknown> {
  return hostCommand("dock.candidates", { rootPath, relativePath });
}
