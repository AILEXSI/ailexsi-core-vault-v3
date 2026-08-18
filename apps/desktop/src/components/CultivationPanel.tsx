/**
 * Cultivation co-creation surface — operational, minimal.
 *
 * Core-backed memory IDs → cultivation.chat → pending proposal →
 * reject/defer (no write) | accept/edit → MemoryCommandAdapter only.
 * UI never writes EventStore or filesystem canonical state.
 */

import { useCallback, useEffect, useState } from "react";
import {
  bridgeHealth,
  listMemories,
  retrieveMemories,
  cultivationSessionCreate,
  cultivationChat,
  cultivationProposalReject,
  cultivationProposalDefer,
  cultivationProposalAccept,
  getMemory,
  type MemoryListItem,
  type MemoryDetailView,
} from "../ipc/memory-client";

type ProposalView = {
  id: string;
  status: string;
  kind: string;
  rationale?: string;
  draft?: { content?: { type?: string; text?: string } };
  acceptedMemoryId?: string;
};

export function CultivationPanel() {
  const [health, setHealth] = useState<string>("…");
  const [memories, setMemories] = useState<MemoryListItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chatText, setChatText] = useState("");
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [editText, setEditText] = useState("");
  const [result, setResult] = useState<MemoryDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshHealth = useCallback(async () => {
    const h = await bridgeHealth();
    setHealth(
      h.ok
        ? `DesktopHost connected · store: ${h.store ?? "?"}`
        : `offline: ${h.detail ?? "no bridge"}`
    );
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const list = await listMemories();
      setMemories(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    void refreshList();
  }, [refreshHealth, refreshList]);

  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    const s = await cultivationSessionCreate();
    setSessionId(s.id);
    return s.id;
  }

  async function onChat() {
    setError(null);
    setBusy(true);
    try {
      // Optional retrieve smoke — uses host path, not a UI ranking engine
      if (selected.size === 0) {
        await retrieveMemories({ pageSize: 5 });
      }
      const sid = await ensureSession();
      const out = (await cultivationChat({
        sessionId: sid,
        text: chatText || "Propose a memory",
        memoryIds: [...selected],
      })) as { proposal: ProposalView };
      setProposal(out.proposal);
      const draftText =
        out.proposal.draft?.content?.type === "text"
          ? out.proposal.draft.content.text ?? ""
          : "";
      setEditText(draftText);
      setResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReject() {
    if (!sessionId || !proposal) return;
    setBusy(true);
    setError(null);
    try {
      await cultivationProposalReject(sessionId, proposal.id);
      setProposal({ ...proposal, status: "rejected" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDefer() {
    if (!sessionId || !proposal) return;
    setBusy(true);
    setError(null);
    try {
      await cultivationProposalDefer(sessionId, proposal.id);
      setProposal({ ...proposal, status: "deferred" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onAccept() {
    if (!sessionId || !proposal) return;
    setBusy(true);
    setError(null);
    try {
      const out = (await cultivationProposalAccept({
        sessionId,
        proposalId: proposal.id,
        editedText: editText || undefined,
      })) as {
        proposal: ProposalView;
        cell: { identity: { id: string } };
      };
      setProposal(out.proposal);
      const mem = await getMemory(out.cell.identity.id);
      setResult(mem);
      await refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Cultivation — Co-creation</h2>
      <p className="muted">
        Core-backed IDs → Mock LLM proposal → human accept/reject. No auto-write.
        Bridge: {health}
      </p>
      {error && <p className="error">{error}</p>}

      <h3>1. Select Core memories (context IDs)</h3>
      <button type="button" onClick={() => void refreshList()} disabled={busy}>
        Refresh list
      </button>
      <ul className="memory-list">
        {memories.slice(0, 30).map((m) => (
          <li key={m.id}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={() => toggle(m.id)}
              />{" "}
              {m.title || m.shortId}{" "}
              <span className="muted">v{m.version}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="muted">Selected: {selected.size}</p>

      <h3>2. Chat → pending proposal</h3>
      <textarea
        value={chatText}
        onChange={(e) => setChatText(e.target.value)}
        rows={3}
        placeholder="Ask the cultivation assistant…"
        style={{ width: "100%" }}
      />
      <button type="button" onClick={() => void onChat()} disabled={busy}>
        Chat (proposal)
      </button>
      {sessionId && (
        <p className="muted">
          Session: <code>{sessionId.slice(0, 8)}…</code> (EPHEMERAL)
        </p>
      )}

      {proposal && (
        <>
          <h3>3. Proposal</h3>
          <p>
            status: <strong>{proposal.status}</strong> · kind: {proposal.kind}
          </p>
          <p className="muted">{proposal.rationale?.slice(0, 280)}</p>
          <label>
            Edit before accept
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={4}
              style={{ width: "100%" }}
              disabled={
                proposal.status === "accepted" ||
                proposal.status === "edited" ||
                proposal.status === "rejected" ||
                proposal.status === "deferred"
              }
            />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              onClick={() => void onReject()}
              disabled={busy || proposal.status !== "pending"}
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => void onDefer()}
              disabled={busy || proposal.status !== "pending"}
            >
              Defer
            </button>
            <button
              type="button"
              onClick={() => void onAccept()}
              disabled={busy || proposal.status !== "pending"}
            >
              Accept and persist
            </button>
          </div>
        </>
      )}

      {result && (
        <>
          <h3>4. Recorded Memory</h3>
          <p>
            <code>{result.id}</code> · v{result.currentVersion.value} ·{" "}
            {result.lifecycle.value.state}
          </p>
          <p>
            {(result.content.value as { text?: string })?.text ??
              JSON.stringify(result.content.value)}
          </p>
        </>
      )}
    </div>
  );
}
