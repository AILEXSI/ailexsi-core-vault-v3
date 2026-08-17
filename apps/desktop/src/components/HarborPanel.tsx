import { useState } from "react";
import {
  harborContext,
  harborExport,
  harborReflect,
  harborScan,
  harborSnapshot,
} from "../ipc/memory-client";

export function HarborPanel() {
  const [out, setOut] = useState<string>("Harbor is DERIVED. Core remains canonical. Scan / reflect / assemble require desktop:host.");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      setOut(`${label}\n${JSON.stringify(result, null, 2)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Cognitive Harbor</h2>
      <p>
        <span className="badge v2">V3-DERIVED</span>
        <span className="badge core">Core = canonical</span>
      </p>
      <p className="muted">
        Dock → see → retrieve → understand → reflect → propose → discuss →
        accept/edit/reject/defer → persist → verify → continue.
      </p>
      <p className="muted">
        AI default authority: READ_ONLY + DERIVED_WRITE + CANONICAL_PROPOSAL.
        Canonical commit requires a human. Inferences never become FACT silently.
      </p>
      <div className="memory-form">
        <button type="button" disabled={busy} onClick={() => run("snapshot", harborSnapshot)}>
          Snapshot
        </button>
        <button type="button" disabled={busy} onClick={() => run("scan", harborScan)}>
          Scan contradictions
        </button>
        <button type="button" disabled={busy} onClick={() => run("reflect", harborReflect)}>
          Reflect
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run("context", () => harborContext("prefers"))}
        >
          Assemble context
        </button>
        <button type="button" disabled={busy} onClick={() => run("export", harborExport)}>
          Export inspectable package
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <pre className="muted" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
        {out}
      </pre>
    </div>
  );
}
