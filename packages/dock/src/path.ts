import path from "node:path";

export function normalizeRoot(absDir: string): string {
  if (!absDir || typeof absDir !== "string") {
    throw new Error("dock requires an absolute directory path");
  }
  const resolved = path.resolve(absDir);
  if (!path.isAbsolute(resolved)) {
    throw new Error("dock rootPath must be absolute");
  }
  return resolved;
}

/** Resolve relativePath under root. Rejects traversal outside root. */
export function resolveUnderRoot(rootPath: string, relativePath = ""): string {
  const root = normalizeRoot(rootPath);
  const rel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel) return root;
  if (rel.split("/").includes("..")) {
    throw new Error("path traversal outside dock root");
  }
  const joined = path.resolve(root, ...rel.split("/"));
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (joined !== root && !joined.startsWith(prefix)) {
    throw new Error("path traversal outside dock root");
  }
  return joined;
}

export function toPosixRelative(rootPath: string, absFile: string): string {
  const root = normalizeRoot(rootPath);
  const rel = path.relative(root, absFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path traversal outside dock root");
  }
  return rel.split(path.sep).join("/");
}
