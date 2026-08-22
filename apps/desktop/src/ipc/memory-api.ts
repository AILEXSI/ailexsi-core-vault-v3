/**
 * Desktop command names shared by Tauri invoke, HTTP bridge, and DesktopHost.
 */

export type DesktopHostCommandName =
  | "memory.create"
  | "memory.get"
  | "memory.list"
  | "memory.update"
  | "memory.archive"
  | "memory.restore"
  | "memory.history"
  | "memory.retrieve"
  | "memory.context"
  | "cultivation.session.create"
  | "cultivation.session.get"
  | "cultivation.chat"
  | "cultivation.proposal.reject"
  | "cultivation.proposal.defer"
  | "cultivation.proposal.accept"
  | "harbor.snapshot"
  | "harbor.scan"
  | "harbor.context"
  | "harbor.reflect"
  | "harbor.contradiction.resolve"
  | "harbor.propose"
  | "harbor.proposal.decide"
  | "harbor.confirm"
  | "harbor.graph"
  | "harbor.export"
  | "harbor.import"
  | "harbor.import.validate"
  | "harbor.import.preview"
  | "harbor.import.conflicts"
  | "harbor.import.confirm"
  | "harbor.import.reject"
  | "harbor.rebuild"
  | "harbor.query.memory"
  | "harbor.query.list"
  | "harbor.query.source"
  | "harbor.query.status"
  | "harbor.query.contradictions"
  | "harbor.query.provenance"
  | "session.status"
  | "authorization.issue"
  | "dock.status"
  | "dock.discover"
  | "dock.preview"
  | "dock.segments"
  | "dock.candidates";

/** @deprecated alias — Memory-only surface retained for callers */
export type MemoryCommandName =
  | "memory.create"
  | "memory.get"
  | "memory.list"
  | "memory.update"
  | "memory.archive"
  | "memory.restore"
  | "memory.history";

/** Tauri command identifiers (snake_case). Only Memory CRUD is registered in Rust today. */
export const TAURI_MEMORY_COMMANDS = {
  create: "memory_create",
  get: "memory_get",
  list: "memory_list",
  update: "memory_update",
  archive: "memory_archive",
  restore: "memory_restore",
  history: "memory_history",
} as const;

export function toDesktopCommand(
  tauriName: (typeof TAURI_MEMORY_COMMANDS)[keyof typeof TAURI_MEMORY_COMMANDS]
): MemoryCommandName {
  switch (tauriName) {
    case "memory_create":
      return "memory.create";
    case "memory_get":
      return "memory.get";
    case "memory_list":
      return "memory.list";
    case "memory_update":
      return "memory.update";
    case "memory_archive":
      return "memory.archive";
    case "memory_restore":
      return "memory.restore";
    case "memory_history":
      return "memory.history";
  }
}
