/**
 * Local-directory dock types.
 * SOURCE / DISCOVERED / SEGMENT / DERIVED CANDIDATE.
 * Not Memory. Not EventStore. Not a Grant. Not truth.
 */

export const DOCK_INDEX_SCHEMA = "dock-index-v1" as const;

export interface LocalSource {
  id: string;
  type: "LOCAL_DIRECTORY";
  locator: string;
  displayName: string;
  discoveredAt: string;
}

export interface SourceItem {
  sourceId: string;
  itemId: string;
  locator: string;
  filename: string;
  extension: string;
  size: number;
  modifiedAt: string;
  contentHash?: string;
  kind: "text" | "binary" | "unsupported";
}

export interface Segment {
  segmentId: string;
  sourceId: string;
  itemId: string;
  locator: string;
  startLine?: number;
  endLine?: number;
  text: string;
}

export interface DerivedCandidate {
  candidateId: string;
  sourceId: string;
  itemId: string;
  segmentId: string;
  text: string;
  epistemicStatus: "UNCERTAIN";
  status: "DERIVED";
  provenance: {
    sourceId: string;
    itemId: string;
    segmentId: string;
    locator: string;
    note: "Derived candidate from local source. Not recorded Memory. Not proof.";
  };
}

export interface DockDiscoverResult {
  source: LocalSource;
  items: SourceItem[];
}

export interface DockStatus {
  ready: true;
  lastSource: LocalSource | null;
  itemCount: number;
  note: "LOCAL SOURCE → DISCOVER → PREVIEW → SEGMENT → DERIVED CANDIDATE. Not Memory. Not EventStore. Not Grant.";
}
