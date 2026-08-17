import { useMemo, useState } from "react";
import { MemoryPanel } from "./components/MemoryPanel";
import { CultivationPanel } from "./components/CultivationPanel";

type DomainView =
  | "overview"
  | "memory"
  | "insights"
  | "decisions"
  | "questions"
  | "tensions"
  | "projects"
  | "connectome"
  | "continuity"
  | "cultivation";

const DOMAINS: Array<{
  id: DomainView;
  label: string;
  classification: "CORE-BACKED" | "V2-DERIVED" | "V2-LOCAL" | "FUTURE CORE DOMAIN";
  status: "VERIFIED" | "PARTIAL" | "PLANNED";
  blurb: string;
}> = [
  {
    id: "memory",
    label: "Memory",
    classification: "CORE-BACKED",
    status: "VERIFIED",
    blurb:
      "Canonical Memory via DesktopHost bridge → Core MemoryDomain. UI reads V2 read models only.",
  },
  {
    id: "insights",
    label: "Insights",
    classification: "V2-LOCAL",
    status: "PARTIAL",
    blurb:
      "Presentation label preserved from Vault reference. Not a Core aggregate in Phase 07.",
  },
  {
    id: "decisions",
    label: "Decisions",
    classification: "V2-LOCAL",
    status: "PARTIAL",
    blurb: "Conceptual surface only. Canonical writes require Core command path.",
  },
  {
    id: "questions",
    label: "Questions",
    classification: "V2-LOCAL",
    status: "PARTIAL",
    blurb: "Conceptual surface only.",
  },
  {
    id: "tensions",
    label: "Tensions",
    classification: "V2-LOCAL",
    status: "PARTIAL",
    blurb: "Conceptual surface only.",
  },
  {
    id: "projects",
    label: "Projects",
    classification: "V2-LOCAL",
    status: "PARTIAL",
    blurb: "Conceptual surface only.",
  },
  {
    id: "connectome",
    label: "Connectome",
    classification: "V2-DERIVED",
    status: "PARTIAL",
    blurb:
      "MVP graph from Memory relationRefs + provenance parents. No Core Relation aggregate (PLANNED).",
  },
  {
    id: "continuity",
    label: "Continuity",
    classification: "V2-DERIVED",
    status: "PARTIAL",
    blurb:
      "BACKEND GREEN (package/rehydrate). UI panel not exposed — host commands only.",
  },
  {
    id: "cultivation",
    label: "Cultivation",
    classification: "V2-LOCAL",
    status: "PARTIAL",
    blurb:
      "BACKEND GREEN + UI co-creation surface (pending DCS freeze). Mock LLM; human accept only.",
  },
];

export function App() {
  const [view, setView] = useState<DomainView>("overview");
  const active = useMemo(
    () => DOMAINS.find((d) => d.id === view) ?? null,
    [view]
  );

  return (
    <div className="app">
      <nav className="nav">
        <h1>Vault V3</h1>
        <button
          className={view === "overview" ? "active" : ""}
          onClick={() => setView("overview")}
        >
          Overview
        </button>
        {DOMAINS.map((d) => (
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
        {view === "overview" ? (
          <>
            <h2>AILEXSI Core Vault V3</h2>
            <p className="muted">
              Core is authoritative for canonical facts. This vault owns presentation,
              cultivation, retrieval, Continuity packaging, and derived cognition.
            </p>
            <div className="card">
              <h2>Baselines</h2>
              <p className="muted">
                <code>CORE 652d01eb06dd0841c3b475023883675af6dcd698</code>
                <br />
                <code>VAULT REF 061e444389090c54e431b0e8243e82764f2c198e</code>
              </p>
            </div>
            <div className="card">
              <h2>Desktop path (Slice A + Bridge)</h2>
              <p className="muted">
                UI → Tauri/HTTP Bridge → long-lived DesktopHost →
                MemoryCommandAdapter → PostgresEventStore → Projection → Read
                Model. Start host: <code>npm run desktop:host</code>
              </p>
            </div>
            <div className="card">
              <h2>Domain map</h2>
              {DOMAINS.map((d) => (
                <p key={d.id} className="muted">
                  <strong>{d.label}</strong>{" "}
                  <span className="badge core">{d.classification}</span>
                  <span className="badge v2">{d.status}</span>
                </p>
              ))}
            </div>
            <div className="card">
              <h2>Not implemented (honest)</h2>
              <p className="muted">
                <span className="badge planned">PLANNED</span> Physics · Knowledge ·
                Reflection · Learning · Trust · Scheduler · full Connectome ontology ·
                multi-agent cognition
              </p>
            </div>
          </>
        ) : active?.id === "memory" ? (
          <MemoryPanel />
        ) : active?.id === "cultivation" ? (
          <CultivationPanel />
        ) : (
          active && (
            <div className="card">
              <h2>{active.label}</h2>
              <p>
                <span className="badge core">{active.classification}</span>
                <span className="badge v2">{active.status}</span>
              </p>
              <p className="muted">{active.blurb}</p>
            </div>
          )
        )}
      </main>
    </div>
  );
}
