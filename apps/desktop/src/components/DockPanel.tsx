/**
 * Local-directory dock — SOURCE → DISCOVER → PREVIEW → SEGMENT → DERIVED CANDIDATE.
 * Not recorded Memory. No Import-to-Memory. No Grant. No EventStore write.
 */
import { useState } from "react";
import {
  dockCandidates,
  dockDiscover,
  dockPreview,
  dockSegments,
} from "../ipc/memory-client";

type SourceItem = {
  itemId: string;
  locator: string;
  filename: string;
  kind: "text" | "binary" | "unsupported";
  size: number;
};

export function DockPanel() {
  const [rootPath, setRootPath] = useState("");
  const [items, setItems] = useState<SourceItem[]>([]);
  const [selected, setSelected] = useState<SourceItem | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [segments, setSegments] = useState<Array<{ segmentId: string; text: string }>>([]);
  const [candidates, setCandidates] = useState<
    Array<{ candidateId: string; epistemicStatus: string; status: string; text: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onDiscover() {
    if (!rootPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const out = (await dockDiscover(rootPath.trim(), true)) as {
        items: SourceItem[];
      };
      setItems(out.items ?? []);
      setSelected(null);
      setPreview(null);
      setSegments([]);
      setCandidates([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSelect(item: SourceItem) {
    setSelected(item);
    setBusy(true);
    setError(null);
    try {
      const prev = (await dockPreview(rootPath.trim(), item.locator)) as { text: string | null };
      setPreview(prev.text);
      const segs = (await dockSegments(rootPath.trim(), item.locator)) as {
        segments: Array<{ segmentId: string; text: string }>;
      };
      setSegments(segs.segments ?? []);
      const cands = (await dockCandidates(rootPath.trim(), item.locator)) as {
        candidates: Array<{
          candidateId: string;
          epistemicStatus: string;
          status: string;
          text: string;
        }>;
      };
      setCandidates(cands.candidates ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Dock</h2>
      <p>
        <span className="badge v2">SOURCE</span>{" "}
        <span className="badge v2">DISCOVERED</span>{" "}
        <span className="badge v2">SEGMENT</span>{" "}
        <span className="badge v2">DERIVED CANDIDATE</span>
      </p>
      <p className="muted">NOT RECORDED MEMORY. Discovery is not authorization. Candidates are UNCERTAIN.</p>
      {error && <p className="error">{error}</p>}
      <div className="memory-form">
        <input
          type="text"
          value={rootPath}
          onChange={(e) => setRootPath(e.target.value)}
          placeholder="Absolute local directory…"
          disabled={busy}
        />
        <button type="button" disabled={busy || !rootPath.trim()} onClick={() => void onDiscover()}>
          Discover
        </button>
      </div>
      <ul className="memory-list">
        {items.map((it) => (
          <li key={it.itemId}>
            <button
              type="button"
              className={selected?.itemId === it.itemId ? "memory-item active" : "memory-item"}
              onClick={() => void onSelect(it)}
            >
              <span className="title">{it.locator}</span>
              <span className="meta">
                {it.kind === "text" ? "text" : "binary"} · {it.size} bytes
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <>
          <h3>Preview (bounded)</h3>
          <pre className="muted" style={{ whiteSpace: "pre-wrap" }}>
            {preview ?? "(binary / unsupported — metadata only)"}
          </pre>
          <h3>Segments</h3>
          <ul>
            {segments.map((s) => (
              <li key={s.segmentId}>
                <code>{s.segmentId.slice(0, 12)}</code> {s.text.slice(0, 80)}
              </li>
            ))}
          </ul>
          <h3>Derived candidates (UNCERTAIN)</h3>
          <ul>
            {candidates.map((c) => (
              <li key={c.candidateId}>
                {c.status} / {c.epistemicStatus} — {c.text.slice(0, 80)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
