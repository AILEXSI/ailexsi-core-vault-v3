import { createHash } from "node:crypto";

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sourceIdFor(locator: string): string {
  return sha256(`LOCAL_DIRECTORY|${locator}`);
}

export function itemIdFor(sourceId: string, relativePath: string, contentHash: string): string {
  return sha256(`${sourceId}|${relativePath}|${contentHash}`);
}

export function segmentIdFor(
  itemId: string,
  startLine: number | undefined,
  endLine: number | undefined,
  text: string
): string {
  return sha256(`${itemId}|${startLine ?? ""}|${endLine ?? ""}|${sha256(text)}`);
}

export function candidateIdFor(segmentId: string): string {
  return sha256(`${segmentId}|UNCERTAIN|DERIVED`);
}
