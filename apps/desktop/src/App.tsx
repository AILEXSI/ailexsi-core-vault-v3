import { useMemo, useState } from "react";
import { MemoryPanel } from "./components/MemoryPanel";
import { CultivationPanel } from "./components/CultivationPanel";
import { HarborPanel } from "./components/HarborPanel";
import { DockPanel } from "./components/DockPanel";

type DomainView =
  | "harbor"
  | "memory"
  | "context"
  | "reflection"
  | "cultivation"
  | "connectome"
  | "continuity"
  | "evidence"
  | "settings"
  | "dock";

const NAV: Array<{
  id: DomainView;
  label: string;
  classification: "CORE-BACKED" | "V2-DERIVED" | "V3-DERIVED" | "V2-LOCAL";
  status: "VERIFIED" | "PARTIAL" | "PLANNED";
  blurb: string;
}> = [
  {
    id: "harbor",
    label: "Home / Harbor",
    classification: "V3-DERIVED",
    status: "PARTIAL",
    blurb: "Docking view. Derived overlays around Core Memory. Host required for live state.",
  },
  {
    id: "memory",
    label: "Memory",
    classification: "CORE-BACKED",
    status: "VERIFIED",
    blurb: "Canonical Memory via DesktopHost → Core MemoryDomain.",
  },
  {
    id: "context",
    label: "Context",
    classification: "V3-DERIVED",
    status: "PARTIAL",
    blurb: "Context packages with inclusion reasons. Uses existing retrieval plus Harbor assembly.",
  },
  {
    id: "reflection",
    label: "Reflection",
    classification: "V3-DERIVED",
    status: "PARTIAL",
    blurb: "Derived observations with evidence IDs. Not canonical until a human confirms.",
  },
  {
    id: "cultivation",
    label: "Cultivation",
    classification: "V2-LOCAL",
    status: "PARTIAL",
    blurb: "Proposals remain derived. Human accept / reject / defer only.",
  },
  {
    id: "connectome",
    label: "Connectome",
    classification: "V2-DERIVED",
    status: "PARTIAL",
    blurb: "Presentation graph. No Core Relation aggregate.",
  },
  {
    id: "continuity",
    label: "Continuity",
    classification: "V2-DERIVED",
    status: "PARTIAL",
    blurb: "Portable packages via host commands. Harbor export is inspectable JSON.",
  },
  {
    id: "evidence",
    label: "Evidence",
    classification: "V3-DERIVED",
    status: "PARTIAL",
    blurb: "Acceptance evidence lives on disk from scripts/acceptance-gate.mjs. The UI does not invent GREEN.",
  },
  {
    id: "settings",
    label: "Settings",
    classification: "V2-LOCAL",
    status: "PARTIAL",
    blurb: "Pins, agency defaults, honest connection mode.",
  },
  {
    id: "dock",
    label: "Dock",
    classification: "V3-DERIVED",
    status: "PARTIAL",
    blurb: "Local directory discover/preview/segment. Not recorded Memory. Not a Grant.",
  },
];

export function App() {
  const [view, setView] = useState<DomainView>("harbor");
  const active = useMemo(() => NAV.find((d) => d.id === view) ?? null, [view]);

  return (
    <div className="app">
      <nav className="nav">
        <h1>Vault Harbor</h1>
        {NAV.map((d) => (
          <button
            key={d.id}
            className={view === d.id ? "active" : ""}
            onClick={() => setView(d.id)}
          >
            {d.label}
          </button>
        ))}
      </nav>
      <main className="main">
        {view === "harbor" ? (
          <HarborPanel />
        ) : view === "memory" ? (
          <MemoryPanel />
        ) : view === "cultivation" ? (
          <CultivationPanel />
        ) : view === "context" ? (
          <HarborPanel focus="context" />
        ) : view === "reflection" ? (
          <HarborPanel focus="reflection" />
        ) : view === "evidence" ? (
          <EvidenceHonesty />
        ) : view === "settings" ? (
          <SettingsHonesty />
        ) : view === "dock" ? (
          <DockPanel />
        ) : (
          active && (
            <div className="card">
              <h2>{active.label}</h2>
              <p>
                <span className="badge core">{active.classification}</span>
                <span className="badge v2">{active.status}</span>
              </p>
              <p className="muted">{active.blurb}</p>
              <p className="muted">
                No simulated graph or continuity preview. Use the host commands
                when the desktop host is running.
              </p>
            </div>
          )
        )}
      </main>
    </div>
  );
}

function EvidenceHonesty() {
  return (
    <div className="card">
      <h2>Evidence</h2>
      <p>
        <span className="badge v2">on disk</span>
        <span className="badge core">not invented here</span>
      </p>
      <p className="muted">
        Machine-readable acceptance lives in <code>evidence/runs/&lt;sha&gt;.acceptance.json</code>
        after <code>npm run acceptance</code>. This screen does not rewrite those
        files and does not display a GREEN badge unless that file exists on the
        machine running the gate.
      </p>
      <p className="muted">
        Required fields include tested SHA, Core pin, gates, and status. Harbor
        cannot delete or edit evidence runs.
      </p>
    </div>
  );
}

function SettingsHonesty() {
  return (
    <div className="card">
      <h2>Settings</h2>
      <p className="muted">
        Core pin <code>652d01eb06dd0841c3b475023883675af6dcd698</code>
      </p>
      <p className="muted">
        AI default capabilities: READ_ONLY, DERIVED_WRITE, CANONICAL_PROPOSAL.
        Canonical commit and external action require a human.
      </p>
      <p className="muted">
        Desktop host: <code>npm run desktop:host</code> — without it, Memory and
        Harbor live calls fail honestly.
      </p>
    </div>
  );
}
