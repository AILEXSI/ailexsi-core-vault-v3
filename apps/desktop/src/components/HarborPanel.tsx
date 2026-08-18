import { useEffect, useState } from "react";
import {
  bridgeHealth,
  harborContext,
  harborExport,
  harborReflect,
  harborScan,
  harborSnapshot,
} from "../ipc/memory-client";

type Focus = "home" | "context" | "reflection";

export function HarborPanel({ focus = "home" }: { focus?: Focus }) {
  const [health, setHealth] = useState<string>("checking host…");
  const [out, setOut] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    bridgeHealth()
      .then((h) => {
        setHealth(
          h.ok
            ? `host connected · store=${h.store ?? "unknown"}`
            : "host offline — live lists unavailable"
        );
      })
      .catch(() => setHealth("host offline — live lists unavailable"));
  }, []);

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

  const title =
    focus === "context" ? "Context" : focus === "reflection" ? "Reflection" : "Harbor";

  return (
    <div className="card">
      <h2>{title}</h2>
      <p>
        <span className="badge v2">V3-DERIVED</span>
        <span className="badge core">Core = recorded Memory</span>
      </p>
      <p className="muted">{health}</p>
      {focus === "home" && (
        <>
          <p className="muted">
            Safe docking around Core Memory. AI may propose. Humans accept.
            Import never writes without SCAN → VALIDATE → PREVIEW → CONFLICT → CONFIRM.
          </p>
          <p className="muted">
            Live memories, proposals and contradictions appear only from the
            desktop host. This view does not invent them.
          </p>
        </>
      )}
      <div className="row-actions">
        {focus !== "reflection" && focus !== "context" && (
          <>
            <button type="button" disabled={busy} onClick={() => run("snapshot", harborSnapshot)}>
              Snapshot
            </button>
            <button type="button" disabled={busy} onClick={() => run("scan", harborScan)}>
              Contradictions
            </button>
            <button type="button" disabled={busy} onClick={() => run("export", harborExport)}>
              Export
            </button>
          </>
        )}
        {focus !== "reflection" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run("context", () => harborContext("prefers"))}
          >
            Assemble context
          </button>
        )}
        {focus !== "context" && (
          <button type="button" disabled={busy} onClick={() => run("reflect", harborReflect)}>
            Reflect
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {out && (
        <pre className="content-block" style={{ marginTop: 12, fontSize: 12 }}>
          {out}
        </pre>
      )}
    </div>
  );
}
