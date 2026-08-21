import { useCallback, useEffect, useState } from "react";
import {
  archiveMemory,
  bridgeHealth,
  createMemory,
  fetchSessionStatus,
  getHistory,
  getMemory,
  issueAuthorization,
  listMemories,
  restoreMemory,
  saveAcceptanceEvidence,
  updateMemory,
  type AuthorityGrant,
  type MemoryDetailView,
  type MemoryListItem,
  type MemoryVersionRow,
  type SessionStatus,
} from "../ipc/memory-client";

export function MemoryPanel() {
  const [text, setText] = useState("");
  const [tagsInput, setTagsInput] = useState("project");
  const [editText, setEditText] = useState("");
  const [headInput, setHeadInput] = useState("");
  const [items, setItems] = useState<MemoryListItem[]>([]);
  const [selected, setSelected] = useState<MemoryDetailView | null>(null);
  const [history, setHistory] = useState<MemoryVersionRow[]>([]);
  const [status, setStatus] = useState<string>("checking bridge…");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [store, setStore] = useState<string | null>(null);
  const [filterEvidence, setFilterEvidence] = useState(false);
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [grant, setGrant] = useState<AuthorityGrant | null>(null);
  const [grantState, setGrantState] = useState<"none" | "issued" | "consumed">("none");
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const parseTags = (raw: string) =>
    raw
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);

  const refreshHealth = useCallback(async () => {
    const h = await bridgeHealth();
    if (h.ok) {
      setStatus("DesktopHost connected");
      setStore(h.store);
      setError(null);
      try {
        setSession(await fetchSessionStatus());
      } catch {
        setSession({ bound: false, actor: null, note: "Session status unavailable" });
      }
    } else {
      setStatus("DesktopHost offline");
      setStore(null);
      setError(
        h.detail ||
          "DesktopHost offline. One command: npm run desktop (starts host + UI). Postgres: docker compose up -d"
      );
    }
    return h.ok;
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const list = await listMemories();
      setItems(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const ok = await refreshHealth();
      if (ok) await refreshList();
    })();
  }, [refreshHealth, refreshList]);

  async function onAuthorizeCreate() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const key = crypto.randomUUID();
      const issued = await issueAuthorization("memory.create", key);
      setPendingKey(key);
      setGrant(issued);
      setGrantState("issued");
    } catch (err) {
      setGrant(null);
      setPendingKey(null);
      setGrantState("none");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !grant || !pendingKey) return;
    setBusy(true);
    setError(null);
    try {
      const tags = parseTags(tagsInput);
      const view = await createMemory(text.trim(), {
        tags: tags.length ? tags : undefined,
        project: "ailexsi-core-vault-v2",
        grant,
        idempotencyKey: pendingKey,
      });
      setText("");
      setGrantState("consumed");
      setGrant(null);
      setPendingKey(null);
      setSelected(view);
      setEditText(view.content.value?.text ?? "");
      setHistory(await getHistory(view.id));
      await refreshList();
      await refreshHealth();
      setGrantState("none");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSaveEvidence() {
    setBusy(true);
    setError(null);
    try {
      const view = await saveAcceptanceEvidence({
        head: headInput.trim() || undefined,
      });
      setSelected(view);
      setEditText(view.content.value?.text ?? "");
      setHistory(await getHistory(view.id));
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSelect(id: string) {
    setBusy(true);
    setError(null);
    try {
      const view = await getMemory(id);
      setSelected(view);
      setEditText(view?.content.value?.text ?? "");
      if (view) {
        setHistory(await getHistory(view.id));
      } else {
        setHistory([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onUpdate() {
    if (!selected || !editText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const tags = selected.context?.value?.tags;
      const issued = await issueAuthorization("memory.update", selected.id);
      const view = await updateMemory(selected.id, editText.trim(), {
        changeReason: "ui-update",
        tags,
        project: selected.context?.value?.project as string | undefined,
        grant: issued,
      });
      setSelected(view);
      setEditText(view.content.value?.text ?? "");
      setHistory(await getHistory(view.id));
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onArchive() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const issued = await issueAuthorization("memory.archive", selected.id);
      const view = await archiveMemory(selected.id, "ui-archive", issued);
      setSelected(view);
      setHistory(await getHistory(view.id));
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRestore() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const issued = await issueAuthorization("memory.restore", selected.id);
      const view = await restoreMemory(selected.id, "ui-restore", issued);
      setSelected(view);
      setHistory(await getHistory(view.id));
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const visibleItems = filterEvidence
    ? items.filter((m) => m.tags?.includes("evidence"))
    : items;

  const lifecycle = selected?.lifecycle.value.state;

  return (
    <div className="memory-panel">
      <div className="card">
        <h2>Memory — Core-backed</h2>
        <p className="muted">
          Path: UI → Bridge → DesktopHost → PostgresEventStore → Read Model.
          Notes live in the Vault (Core Memory), not side files.
        </p>
        <p className="muted">
          Status: <strong>{status}</strong>
          {store ? (
            <>
              {" "}
              · store: <code>{store}</code>
            </>
          ) : null}
        </p>
        {error && <p className="error">{error}</p>}
      </div>

      <div className="card">
        <h2>Authority</h2>
        <p className="muted">
          Session:{" "}
          <strong>{session?.bound ? "bound" : "unbound"}</strong>
          {session?.actor ? (
            <>
              {" "}
              · {session.actor.kind}:{session.actor.id}
            </>
          ) : null}
        </p>
        <p className="muted">{session?.note}</p>
        <p className="muted">
          Grant: <strong>{grantState}</strong>
          {grant ? (
            <>
              {" "}
              · {grant.action} @ {grant.target}
            </>
          ) : null}
        </p>
      </div>

      <div className="card">
        <h2>Acceptance Evidence → Vault</h2>
        <p className="muted">
          Speichert den Gate-Stand als Core Memory mit Tags{" "}
          <code>evidence</code>, <code>acceptance</code> und project{" "}
          <code>ailexsi-core-vault-v2</code>.
        </p>
        <div className="memory-form">
          <input
            type="text"
            value={headInput}
            onChange={(e) => setHeadInput(e.target.value)}
            placeholder="git rev-parse HEAD (optional)"
            disabled={busy}
          />
          <button type="button" disabled={busy} onClick={() => void onSaveEvidence()}>
            {busy ? "Saving…" : "Acceptance-Evidence speichern"}
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Create</h2>
        <form onSubmit={onCreate} className="memory-form">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write a memory / note for the Vault…"
            rows={4}
            disabled={busy}
          />
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="tags (comma/space): project evidence …"
            disabled={busy}
          />
          <button
            type="button"
            disabled={busy || !text.trim() || !session?.bound}
            onClick={() => void onAuthorizeCreate()}
          >
            Authorize create
          </button>
          <button type="submit" disabled={busy || !text.trim() || grantState !== "issued"}>
            {busy ? "Saving…" : "Create (persist)"}
          </button>
        </form>
      </div>

      <div className="memory-grid">
        <div className="card">
          <div className="row-between">
            <h2>List</h2>
            <div className="row-actions">
              <label className="muted check">
                <input
                  type="checkbox"
                  checked={filterEvidence}
                  onChange={(e) => setFilterEvidence(e.target.checked)}
                />{" "}
                only evidence
              </label>
              <button
                type="button"
                className="ghost"
                onClick={() => void refreshList()}
                disabled={busy}
              >
                Refresh
              </button>
            </div>
          </div>
          {visibleItems.length === 0 ? (
            <p className="muted">No memories in read model yet.</p>
          ) : (
            <ul className="memory-list">
              {visibleItems.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className={
                      selected?.id === m.id ? "memory-item active" : "memory-item"
                    }
                    onClick={() => void onSelect(m.id)}
                  >
                    <span className="title">{m.title}</span>
                    <span className="meta">
                      v{m.version} · {m.lifecycleState} · {m.shortId}
                      {m.tags?.length ? ` · ${m.tags.join(", ")}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>Detail</h2>
          {!selected ? (
            <p className="muted">Select a memory to load via memory.get</p>
          ) : (
            <div className="detail">
              <p>
                <span className="badge core">RECORDED</span>
                <code>{selected.id}</code>
              </p>
              <p className="muted">
                version {selected.currentVersion.value} · lifecycle{" "}
                {lifecycle}
                {selected.context?.value?.tags?.length ? (
                  <>
                    {" "}
                    · tags: {selected.context.value.tags.join(", ")}
                  </>
                ) : null}
                {selected.context?.value?.project ? (
                  <>
                    {" "}
                    · project: {String(selected.context.value.project)}
                  </>
                ) : null}
              </p>
              <textarea
                className="edit-area"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={8}
                disabled={busy || lifecycle === "archived"}
              />
              <div className="row-actions">
                <button
                  type="button"
                  disabled={busy || lifecycle === "archived" || !editText.trim()}
                  onClick={() => void onUpdate()}
                >
                  Update
                </button>
                {lifecycle === "archived" ? (
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void onRestore()}
                  >
                    Restore
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ghost danger"
                    disabled={busy}
                    onClick={() => void onArchive()}
                  >
                    Archive
                  </button>
                )}
              </div>
              <h3 className="subhead">History (Core EventStore)</h3>
              <p className="muted">
                Source: Core aggregate stream — not UI state.
              </p>
              {history.length === 0 ? (
                <p className="muted">No history rows.</p>
              ) : (
                <ul className="history-list">
                  {history.map((h) => (
                    <li key={`${h.version}-${h.eventType ?? ""}-${h.eventId ?? ""}`}>
                      <strong>v{h.version}</strong>
                      {h.eventType ? (
                        <span className="badge core"> {h.eventType}</span>
                      ) : null}
                      {h.changeReason ? ` — ${h.changeReason}` : ""}
                      {h.content && "text" in h.content && h.content.text ? (
                        <div className="muted hist-snip">
                          {String(h.content.text).length > 120
                            ? `${String(h.content.text).slice(0, 117)}…`
                            : String(h.content.text)}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
