import { useState } from "react";

export default function InspectorPanel({ node, allNodes = [], onClose }) {
  const [tab, setTab] = useState("details");

  if (!node) {
    return (
      <div style={s.empty}>
        <div style={s.emptyIcon}>[]</div>
        <div style={s.emptyText}>Hover to explore</div>
        <div style={{ ...s.emptyText, marginTop: 4, fontSize: 10, color: "#252d3d" }}>
          Click a node to inspect
        </div>
      </div>
    );
  }

  const contradictingNodes = (node.contradicting_node_ids ?? [])
    .map((id) => allNodes.find((candidate) => candidate.node_id === id))
    .filter(Boolean);

  const frictionLabel = node.friction_score >= 0.85 ? ["CRITICAL", "#ff3050"]
    : node.friction_score >= 0.6 ? ["HIGH RISK", "#ff8c00"]
    : node.friction_score >= 0.3 ? ["MEDIUM", "#c8e600"]
    : ["LOW", "#00e5a0"];

  const provenance = node.source_type === "private_csv"
    ? `Row ${node.row_index ?? "?"} | ${node.file_name ?? "private file"}`
    : `${node.sentence_id ?? node.paper_id ?? "unknown"} | ${node.citation_count ?? 0} citations`;

  return (
    <div style={s.panel}>
      <div style={s.header}>
        <div style={{ flex: 1 }}>
          <div
            style={{
              ...s.badge,
              color: node.source_type === "private_csv" ? "#4d7cff" : "#ffb340",
              borderColor: node.source_type === "private_csv"
                ? "rgba(77,124,255,0.3)"
                : "rgba(255,179,64,0.3)",
            }}
          >
            {node.source_type === "private_csv" ? "PRIVATE" : "LITERATURE"}
          </div>
          <div style={s.nodeId}>{node.node_id?.substring(0, 8)}...</div>
        </div>
        <button type="button" onClick={onClose} style={s.closeBtn}>x</button>
      </div>

      <div style={s.frictionRow}>
        <span style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#3a4055" }}>
          Friction
        </span>
        <div style={s.frictionBar}>
          <div
            style={{
              ...s.frictionFill,
              width: `${(node.friction_score ?? 0) * 100}%`,
              background: frictionLabel[1],
            }}
          />
        </div>
        <span style={{ fontSize: 11, color: frictionLabel[1], fontWeight: 600 }}>
          {frictionLabel[0]}
        </span>
      </div>

      <div style={s.tabs}>
        {["details", "contradictions"].map((currentTab) => (
          <button
            key={currentTab}
            type="button"
            onClick={() => setTab(currentTab)}
            style={{ ...s.tab, ...(tab === currentTab ? s.tabActive : {}) }}
          >
            {currentTab === "details" ? "Details" : `Contradictions (${contradictingNodes.length})`}
          </button>
        ))}
      </div>

      <div style={s.content}>
        {tab === "details" ? (
          <>
            <div style={s.sectionLabel}>Claim</div>
            <div style={s.claimText}>{node.claim_text}</div>

            <div style={s.fieldGrid}>
              {[
                ["Subject", node.subject_name],
                ["Object", node.object_name],
                ["Polarity", node.polarity],
                ["Cell Line", node.cell_line],
                ["Organism", node.organism],
                ["Assay", node.predicate_relation],
                [
                  "Value",
                  node.quantitative_value
                    ? `${node.quantitative_value} ${node.quantitative_unit ?? ""}`.trim()
                    : null,
                ],
                ["Debate State", node.debate_state],
              ].filter(([, value]) => value).map(([key, value]) => (
                <div key={key} style={s.field}>
                  <span style={s.fieldKey}>{key}</span>
                  <span
                    style={{
                      ...s.fieldVal,
                      color: key === "Polarity"
                        ? (value === "inhibits" ? "#8250ff" : value === "promotes" ? "#00c8ff" : "#6b7590")
                        : "#e8eaf0",
                    }}
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>

            <div style={s.sectionLabel}>Provenance</div>
            <div style={s.provenanceBox}>
              <span style={{ color: "#6b7590", fontSize: 11 }}>{provenance}</span>
              {node.abstract_url ? (
                <a
                  href={node.abstract_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "block",
                    marginTop: 6,
                    fontSize: 10,
                    color: "#4d7cff",
                    textDecoration: "none",
                  }}
                >
                  View paper link
                </a>
              ) : null}
            </div>

            {node.skeptic_rationale ? (
              <>
                <div style={s.sectionLabel}>Skeptic Rationale</div>
                <div
                  style={{
                    ...s.provenanceBox,
                    borderColor: "rgba(255,59,92,0.2)",
                    background: "rgba(255,59,92,0.04)",
                    color: "#e8eaf0",
                    fontSize: 11,
                    lineHeight: 1.6,
                  }}
                >
                  {node.skeptic_rationale}
                </div>
              </>
            ) : null}

            {node.tamarind_verdict && node.tamarind_verdict.verdict !== "skipped" && (
              <div style={{ marginTop: 12 }}>
                <div style={s.sectionLabel}>⬡ Tamarind Structural Verdict</div>
                {node.tamarind_verdict.mock && (
                  <div style={{ fontSize: 9, color: "#3a4055", marginBottom: 6, letterSpacing: 1 }}>
                    DEMO MODE — connect API key for live docking
                  </div>
                )}
                <div
                  style={{
                    background: "rgba(255,179,64,0.04)",
                    border: "1px solid rgba(255,179,64,0.3)",
                    padding: 12,
                  }}
                >
                  <div
                    style={{
                      display: "inline-block", fontSize: 9, letterSpacing: 2,
                      textTransform: "uppercase", padding: "3px 8px", marginBottom: 10,
                      background: "rgba(255,179,64,0.1)",
                      border: "1px solid rgba(255,179,64,0.4)",
                      color: "#ffb340",
                    }}
                  >
                    {node.tamarind_verdict.verdict.replace(/_/g, " ")}
                  </div>
                  <div style={{ fontSize: 11, color: "#e8eaf0", lineHeight: 1.6, marginBottom: 10 }}>
                    {node.tamarind_verdict.structural_rationale}
                  </div>
                  <div
                    style={{
                      display: "flex", gap: 12, fontSize: 10, color: "#6b7590",
                      borderTop: "1px solid rgba(255,179,64,0.15)", paddingTop: 8,
                    }}
                  >
                    {node.tamarind_verdict.compound_a && node.tamarind_verdict.binding_affinity_a != null && (
                      <span>{node.tamarind_verdict.compound_a}: <span style={{ color: "#ffb340" }}>
                        score: {node.tamarind_verdict.binding_affinity_a.toFixed(2)}
                      </span></span>
                    )}
                    {node.tamarind_verdict.compound_b && node.tamarind_verdict.binding_affinity_b != null && (
                      <span>{node.tamarind_verdict.compound_b}: <span style={{ color: "#ffb340" }}>
                        score: {node.tamarind_verdict.binding_affinity_b.toFixed(2)}
                      </span></span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 9, color: "#3a4055", marginTop: 8, display: "flex", justifyContent: "space-between",
                    }}
                  >
                    <span>Confidence: {((node.tamarind_verdict.confidence ?? 0) * 100).toFixed(0)}%</span>
                    {node.tamarind_verdict.tamarind_job_id && (
                      <span>Job: {node.tamarind_verdict.tamarind_job_id}</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {contradictingNodes.length === 0 ? (
              <div style={{ color: "#3a4055", fontSize: 12, padding: "12px 0" }}>
                No direct contradictions found for this node.
              </div>
            ) : contradictingNodes.map((contra) => (
              <div key={contra.node_id} style={s.contraCard}>
                <div
                  style={{
                    ...s.badge,
                    color: contra.source_type === "private_csv" ? "#4d7cff" : "#ffb340",
                    borderColor: contra.source_type === "private_csv"
                      ? "rgba(77,124,255,0.3)"
                      : "rgba(255,179,64,0.3)",
                    marginBottom: 8,
                  }}
                >
                  {contra.source_type === "private_csv" ? "PRIVATE" : "LITERATURE"}
                </div>
                <div style={{ fontSize: 11, color: "#e8eaf0", lineHeight: 1.5, marginBottom: 8 }}>
                  {contra.claim_text?.substring(0, 200)}
                  {contra.claim_text?.length > 200 ? "..." : ""}
                </div>
                <div style={{ display: "flex", gap: 12, fontSize: 10, color: "#6b7590" }}>
                  <span>
                    Friction: <span style={{ color: "#ff8c00" }}>{((contra.friction_score ?? 0) * 100).toFixed(0)}%</span>
                  </span>
                  {contra.citation_count ? (
                    <span>
                      Citations: <span style={{ color: "#e8eaf0" }}>{contra.citation_count}</span>
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

const s = {
  panel: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    background: "#0c0e12",
    fontFamily: "'DM Mono',monospace",
    overflowY: "auto",
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: 8,
  },
  emptyIcon: { fontSize: 28, color: "#1e2430" },
  emptyText: { fontSize: 12, color: "#3a4055" },
  header: {
    padding: "14px 16px",
    borderBottom: "1px solid #1e2430",
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
  },
  badge: {
    fontSize: 9,
    letterSpacing: 2,
    textTransform: "uppercase",
    border: "1px solid",
    padding: "2px 7px",
    display: "inline-block",
    marginBottom: 6,
  },
  nodeId: { fontSize: 10, color: "#3a4055", fontFamily: "'DM Mono',monospace" },
  closeBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#3a4055",
    fontSize: 18,
    lineHeight: 1,
    padding: 0,
    flexShrink: 0,
    marginLeft: "auto",
  },
  frictionRow: {
    padding: "10px 16px",
    borderBottom: "1px solid #1e2430",
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  frictionBar: { flex: 1, height: 3, background: "#1e2430", overflow: "hidden" },
  frictionFill: { height: "100%", transition: "width 0.3s" },
  tabs: { display: "flex", borderBottom: "1px solid #1e2430" },
  tab: {
    flex: 1,
    background: "none",
    border: "none",
    cursor: "pointer",
    fontFamily: "'DM Mono',monospace",
    fontSize: 10,
    letterSpacing: 1,
    textTransform: "uppercase",
    padding: "10px 8px",
    color: "#3a4055",
    borderBottom: "2px solid transparent",
    transition: "all 0.15s",
  },
  tabActive: { color: "#00e5a0", borderBottomColor: "#00e5a0" },
  content: { flex: 1, padding: "14px 16px", overflowY: "auto" },
  sectionLabel: {
    fontSize: 9,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: "#3a4055",
    marginBottom: 8,
    marginTop: 14,
  },
  claimText: {
    fontSize: 12,
    color: "#e8eaf0",
    lineHeight: 1.7,
    background: "#050608",
    border: "1px solid #1e2430",
    padding: "10px 12px",
  },
  fieldGrid: { display: "flex", flexDirection: "column", gap: 4, marginTop: 4 },
  field: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "4px 0",
    borderBottom: "1px solid rgba(30,36,48,0.5)",
    fontSize: 11,
    gap: 12,
  },
  fieldKey: { color: "#3a4055", minWidth: 80 },
  fieldVal: { color: "#e8eaf0", textAlign: "right", fontSize: 11 },
  provenanceBox: {
    background: "#050608",
    border: "1px solid #1e2430",
    padding: "10px 12px",
    fontSize: 11,
    color: "#6b7590",
    lineHeight: 1.6,
  },
  contraCard: {
    background: "#050608",
    border: "1px solid #1e2430",
    padding: "12px",
    marginBottom: 8,
  },
};
