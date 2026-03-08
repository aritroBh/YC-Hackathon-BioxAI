import { useState } from "react";

export default function BagsPanel({
  bags,
  activeBagId,
  onCreateBag,
  onSelectBag,
  onDeleteBag,
  onRenameBag,
  selectedIds,
  nodes,
}) {
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const activeBag = bags.find((bag) => bag.id === activeBagId);

  const commitRename = (bag) => {
    const nextName = renameValue.trim() || bag.name;
    onRenameBag(bag.id, nextName);
    setRenamingId(null);
    setRenameValue("");
  };

  return (
    <div style={s.panel}>
      <div style={s.header}>
        <span style={s.title}>Bags</span>
        <button
          type="button"
          style={{
            ...s.createBtn,
            opacity: selectedIds.length === 0 ? 0.45 : 1,
            cursor: selectedIds.length === 0 ? "not-allowed" : "pointer",
          }}
          disabled={selectedIds.length === 0}
          onClick={() => {
            const defaultName = `Bag ${bags.length + 1}`;
            onCreateBag(selectedIds, defaultName);
          }}
        >
          + Save selection ({selectedIds.length})
        </button>
      </div>

      {bags.length === 0 ? (
        <div style={s.empty}>
          Lasso or click nodes, then save as a bag.
          <br />
          Ask the Oracle questions about a bag.
        </div>
      ) : null}

      <div style={s.bagList}>
        {bags.map((bag) => {
          const isActive = bag.id === activeBagId;
          const bagNodes = bag.nodeIds
            .map((id) => nodes.find((node) => node.node_id === id))
            .filter(Boolean);
          const avgFriction = bagNodes.length
            ? bagNodes.reduce((sum, node) => sum + (node.friction_score ?? 0), 0) / bagNodes.length
            : 0;
          const critCount = bagNodes.filter((node) => (node.friction_score ?? 0) >= 0.85).length;

          return (
            <div
              key={bag.id}
              style={{ ...s.bagCard, ...(isActive ? s.bagCardActive : {}) }}
              onClick={() => onSelectBag(isActive ? null : bag.id)}
            >
              <div style={{ ...s.bagDot, background: bag.color, color: bag.color }} />

              <div style={{ flex: 1, minWidth: 0 }}>
                {renamingId === bag.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    style={s.renameInput}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        commitRename(bag);
                      }
                      if (event.key === "Escape") {
                        setRenamingId(null);
                        setRenameValue("");
                      }
                    }}
                    onBlur={() => commitRename(bag)}
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : (
                  <div style={s.bagName}>{bag.name}</div>
                )}
                <div style={s.bagMeta}>
                  {bag.nodeIds.length} nodes | avg friction {(avgFriction * 100).toFixed(0)}%
                  {critCount > 0 ? (
                    <span style={{ color: "#ff3050" }}> | {critCount} critical</span>
                  ) : null}
                </div>
              </div>

              <div style={s.bagActions} onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  style={s.iconBtn}
                  title="Rename"
                  onClick={() => {
                    setRenamingId(bag.id);
                    setRenameValue(bag.name);
                  }}
                >
                  edit
                </button>
                <button
                  type="button"
                  style={s.iconBtn}
                  title="Delete"
                  onClick={() => onDeleteBag(bag.id)}
                >
                  del
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {activeBag ? (
        <div style={s.activeSummary}>
          <div style={s.summaryLabel}>Active: {activeBag.name}</div>
          <div style={s.summaryText}>
            Oracle will answer questions grounded to this bag&apos;s {activeBag.nodeIds.length} nodes.
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const BAG_COLORS = [
  "#00e5a0",
  "#4d7cff",
  "#ffb340",
  "#ff3b5c",
  "#8250ff",
  "#00c8ff",
  "#c8e600",
  "#ff6432",
];

const s = {
  panel: {
    display: "flex",
    flexDirection: "column",
    fontFamily: "'DM Mono',monospace",
    borderTop: "1px solid #1e2430",
  },
  header: {
    padding: "10px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderBottom: "1px solid #1e2430",
  },
  title: { fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#3a4055" },
  createBtn: {
    fontSize: 10,
    background: "rgba(0,229,160,0.08)",
    border: "1px solid rgba(0,229,160,0.2)",
    color: "#00e5a0",
    fontFamily: "'DM Mono',monospace",
    padding: "5px 10px",
    transition: "all 0.15s",
  },
  empty: { padding: "16px", fontSize: 11, color: "#3a4055", lineHeight: 1.7 },
  bagList: { padding: "8px", display: "flex", flexDirection: "column", gap: 4 },
  bagCard: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    border: "1px solid #1e2430",
    cursor: "pointer",
    transition: "all 0.15s",
    background: "transparent",
  },
  bagCardActive: { borderColor: "#00e5a0", background: "rgba(0,229,160,0.04)" },
  bagDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0, boxShadow: "0 0 6px currentColor" },
  bagName: {
    fontSize: 12,
    color: "#e8eaf0",
    marginBottom: 2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  bagMeta: { fontSize: 10, color: "#3a4055" },
  bagActions: { display: "flex", gap: 4, flexShrink: 0 },
  iconBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#3a4055",
    fontSize: 13,
    padding: "2px 4px",
    transition: "color 0.15s",
    fontFamily: "'DM Mono',monospace",
  },
  renameInput: {
    background: "transparent",
    border: "none",
    borderBottom: "1px solid #00e5a0",
    color: "#e8eaf0",
    fontFamily: "'DM Mono',monospace",
    fontSize: 12,
    outline: "none",
    width: "100%",
    padding: "0 0 2px",
  },
  activeSummary: {
    margin: "8px",
    padding: "10px 12px",
    background: "rgba(0,229,160,0.04)",
    border: "1px solid rgba(0,229,160,0.15)",
  },
  summaryLabel: { fontSize: 10, color: "#00e5a0", marginBottom: 4 },
  summaryText: { fontSize: 11, color: "#6b7590", lineHeight: 1.5 },
};
