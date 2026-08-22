import { segmentIdFor } from "./ids.js";
import type { Segment, SourceItem } from "./types.js";

const MAX_TXT_CHARS = 2000;

function linesOf(text: string): string[] {
  return text.split(/\r?\n/);
}

function pushBlock(
  out: Segment[],
  item: SourceItem,
  text: string,
  startLine: number,
  endLine: number
): void {
  const body = text.replace(/\s+$/, "");
  if (!body.trim()) return;
  out.push({
    segmentId: segmentIdFor(item.itemId, startLine, endLine, body),
    sourceId: item.sourceId,
    itemId: item.itemId,
    locator: item.locator,
    startLine,
    endLine,
    text: body,
  });
}

function segmentMarkdown(item: SourceItem, text: string): Segment[] {
  const lines = linesOf(text);
  const out: Segment[] = [];
  let buf: string[] = [];
  let start = 1;
  const flush = (end: number) => {
    pushBlock(out, item, buf.join("\n"), start, end);
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^#{1,6}\s+\S/.test(line);
    const blank = line.trim() === "";
    if (heading && buf.length) {
      flush(i);
      start = i + 1;
    }
    buf.push(line);
    if (heading) {
      flush(i + 1);
      start = i + 2;
    } else if (blank && buf.some((l) => l.trim())) {
      flush(i);
      start = i + 2;
    }
  }
  flush(lines.length);
  return out;
}

function segmentTxt(item: SourceItem, text: string): Segment[] {
  const lines = linesOf(text);
  const out: Segment[] = [];
  let buf: string[] = [];
  let start = 1;
  const flush = (end: number) => {
    let body = buf.join("\n");
    while (body.length > MAX_TXT_CHARS) {
      const chunk = body.slice(0, MAX_TXT_CHARS);
      pushBlock(out, item, chunk, start, end);
      body = body.slice(MAX_TXT_CHARS);
    }
    if (body.trim()) pushBlock(out, item, body, start, end);
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" && buf.some((l) => l.trim())) {
      flush(i);
      start = i + 2;
    } else {
      buf.push(line);
    }
  }
  flush(lines.length);
  return out;
}

function segmentJson(item: SourceItem, text: string): Segment[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Segment[] = [];
      let line = 1;
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const block = JSON.stringify({ [key]: value }, null, 2);
        const end = line + linesOf(block).length - 1;
        pushBlock(out, item, block, line, end);
        line = end + 1;
      }
      return out;
    }
  } catch {
    /* fall through to single block */
  }
  const lines = linesOf(text);
  return [
    {
      segmentId: segmentIdFor(item.itemId, 1, lines.length, text),
      sourceId: item.sourceId,
      itemId: item.itemId,
      locator: item.locator,
      startLine: 1,
      endLine: lines.length,
      text,
    },
  ];
}

export function segment(item: SourceItem, text: string): Segment[] {
  const ext = item.extension.toLowerCase();
  if (ext === "md") return segmentMarkdown(item, text);
  if (ext === "json") return segmentJson(item, text);
  return segmentTxt(item, text);
}
