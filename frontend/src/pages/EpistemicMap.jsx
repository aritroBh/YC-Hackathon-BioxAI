import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { getSessionNodes } from "../api/client";
import BagsPanel, { BAG_COLORS } from "../components/BagsPanel";
import ExperimentsPanel from "../components/ExperimentsPanel";
import InspectorPanel from "../components/InspectorPanel";
import MapCanvas from "../components/MapCanvas";
import OraclePanel from "../components/OraclePanel";
import ScoutAgent from "../components/ScoutAgent";

function createBagId() {
  return globalThis.crypto?.randomUUID?.() ?? `bag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function EpistemicMap() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [nodes, setNodes] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [inspectedNode, setInspectedNode] = useState(null);
  const [rightTab, setRightTab] = useState("oracle");
  const [bags, setBags] = useState([]);
  const [activeBagId, setActiveBagId] = useState(null);
  const [showCriticalOnly, setShowCriticalOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState("2D");
  const [scoutHighlightIds, setScoutHighlightIds] = useState([]);
  const [scoutHighlightColor, setScoutHighlightColor] = useState("#ffb340");
  const [viewportWidth, setViewportWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1440,
  );

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);

    getSessionNodes(sessionId)
      .then((data) => {
        if (!active) {
          return;
        }
        setNodes(data.nodes ?? []);
        setIsLoading(false);
      })
      .catch((loadError) => {
        if (!active) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [sessionId]);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const nodeMap = useMemo(
    () => Object.fromEntries(nodes.map((node) => [node.node_id, node])),
    [nodes],
  );

  const handleSelectNode = useCallback((node) => {
    setInspectedNode(node);
    setSelectedIds((currentIds) => (
      currentIds.includes(node.node_id)
        ? currentIds.filter((id) => id !== node.node_id)
        : [...currentIds, node.node_id]
    ));
  }, []);

  const handleMultiSelect = useCallback((ids) => {
    if (ids.length === 0) {
      setSelectedIds([]);
      return;
    }

    setSelectedIds((currentIds) => [...new Set([...currentIds, ...ids])]);
  }, []);

  const handleCreateBag = useCallback((nodeIds, name) => {
    const id = createBagId();
    const trimmedName = name.trim();

    setBags((currentBags) => [
      ...currentBags,
      {
        id,
        name: trimmedName || `Bag ${currentBags.length + 1}`,
        nodeIds: [...new Set(nodeIds)],
        color: BAG_COLORS[currentBags.length % BAG_COLORS.length],
        createdAt: Date.now(),
        metadata: {
          experimentNotes: [],
        },
      },
    ]);
    setActiveBagId(id);
    setRightTab("bags");
  }, []);

  const handleDeleteBag = useCallback((id) => {
    setBags((currentBags) => currentBags.filter((bag) => bag.id !== id));
    setActiveBagId((currentId) => (currentId === id ? null : currentId));
  }, []);

  const handleRenameBag = useCallback((id, name) => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    setBags((currentBags) => currentBags.map((bag) => (
      bag.id === id ? { ...bag, name: trimmedName } : bag
    )));
  }, []);

  const handleSaveToBag = useCallback((bagIdOrNote, maybeNote) => {
    const targetBagId = maybeNote === undefined ? activeBagId : bagIdOrNote;
    const note = maybeNote === undefined ? bagIdOrNote : maybeNote;

    if (!targetBagId || !note) {
      return false;
    }

    setBags((currentBags) => currentBags.map((bag) => (
      bag.id === targetBagId
        ? {
            ...bag,
            metadata: {
              ...(bag.metadata || {}),
              experimentNotes: [...(bag.metadata?.experimentNotes || []), note],
            },
          }
        : bag
    )));
    return true;
  }, [activeBagId]);

  const handleScoutHighlight = useCallback((nodeIds, color) => {
    setScoutHighlightIds([...new Set(nodeIds || [])]);
    setScoutHighlightColor(color || "#ffb340");
  }, []);

  const handleScoutCreateBag = useCallback((name, nodeIds) => {
    const bagNodeIds = nodes
      .filter((node) => nodeIds?.includes(node.node_id))
      .map((node) => node.node_id);

    if (bagNodeIds.length > 0) {
      handleCreateBag(bagNodeIds, name);
    }
  }, [handleCreateBag, nodes]);

  const handleScoutRunDiffDock = useCallback((nodeId) => {
    const node = nodes.find((candidate) => candidate.node_id === nodeId);
    if (node) {
      setInspectedNode(node);
      setSelectedIds([nodeId]);
      setRightTab("experiments");
    }
  }, [nodes]);

  const handleScoutSelectNode = useCallback((nodeId) => {
    const node = nodes.find((candidate) => candidate.node_id === nodeId);
    if (node) {
      setSelectedIds([nodeId]);
      setInspectedNode(node);
    }
  }, [nodes]);

  const activeBag = useMemo(
    () => bags.find((bag) => bag.id === activeBagId) ?? null,
    [activeBagId, bags],
  );

  const stats = useMemo(() => ({
    total: nodes.length,
    critical: nodes.filter((node) => (node.friction_score ?? 0) >= 0.85).length,
    high: nodes.filter((node) => (node.friction_score ?? 0) >= 0.6).length,
    contradicted: nodes.filter((node) => (node.contradicting_node_ids?.length ?? 0) > 0).length,
  }), [nodes]);

  const visibleNodes = useMemo(
    () => {
      const filteredByFriction = showCriticalOnly
        ? nodes.filter((node) => (node.friction_score ?? 0) >= 0.6)
        : nodes;
      const normalizedQuery = searchQuery.trim().toLowerCase();

      if (!normalizedQuery) {
        return filteredByFriction;
      }

      return filteredByFriction.filter((node) => (
        (node.claim_text || "").toLowerCase().includes(normalizedQuery)
        || (node.subject_name || "").toLowerCase().includes(normalizedQuery)
        || (node.object_name || "").toLowerCase().includes(normalizedQuery)
        || (node.cell_line || "").toLowerCase().includes(normalizedQuery)
        || (node.compound || "").toLowerCase().includes(normalizedQuery)
      ));
    },
    [nodes, searchQuery, showCriticalOnly],
  );

  const selectedNodes = useMemo(
    () => selectedIds.map((id) => nodeMap[id]).filter(Boolean),
    [nodeMap, selectedIds],
  );

  const isStackedLayout = viewportWidth < 1180;

  if (isLoading) {
    return (
      <div
        style={{
          height: "100vh",
          background: "#050608",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#6b7590",
          fontFamily: "'DM Mono',monospace",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            border: "2px solid #1e2430",
            borderTopColor: "#00e5a0",
            borderRadius: "50%",
            animation: "spin 0.8s linear infinite",
          }}
        />
        <div style={{ fontSize: 12 }}>Loading {sessionId?.substring(0, 8)}...</div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          height: "100vh",
          background: "#050608",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#ff3b5c",
          fontFamily: "'DM Mono',monospace",
          padding: 24,
          textAlign: "center",
        }}
      >
        Error: {error}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: isStackedLayout ? "column" : "row",
        height: isStackedLayout ? "auto" : "100vh",
        minHeight: "100vh",
        width: "100vw",
        background: "#050608",
        fontFamily: "'DM Mono',monospace",
        overflow: isStackedLayout ? "auto" : "hidden",
      }}
    >
      <aside
        style={{
          width: isStackedLayout ? "100%" : 220,
          flexShrink: 0,
          background: "#0c0e12",
          borderRight: isStackedLayout ? "none" : "1px solid #1e2430",
          borderBottom: isStackedLayout ? "1px solid #1e2430" : "none",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid #1e2430",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 18,
              height: 18,
              border: "1.5px solid #00e5a0",
              transform: "rotate(45deg)",
              flexShrink: 0,
            }}
          />
          <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 15 }}>
            Dia<span style={{ color: "#00e5a0" }}>lectic</span>
          </span>
        </div>

        <div style={{ padding: "14px 16px", borderBottom: "1px solid #1e2430" }}>
          <div style={lbl}>Session</div>
          <div
            style={{
              fontSize: 10,
              color: "#3a4055",
              marginBottom: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {sessionId?.substring(0, 16)}...
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {[
              [stats.total, "Nodes", "#e8eaf0"],
              [stats.contradicted, "Contradicted", "#ffb340"],
              [stats.critical, "Critical", "#ff3050"],
              [stats.high, "High Risk", "#ff8c00"],
            ].map(([value, label, color]) => (
              <div
                key={label}
                style={{
                  background: "#050608",
                  border: "1px solid #1e2430",
                  padding: "8px 10px",
                }}
              >
                <div
                  style={{
                    fontFamily: "'Syne',sans-serif",
                    fontSize: 18,
                    fontWeight: 700,
                    color,
                    lineHeight: 1,
                  }}
                >
                  {value}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    color: "#3a4055",
                    marginTop: 3,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                  }}
                >
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: "14px 16px", borderBottom: "1px solid #1e2430" }}>
          <div style={lbl}>Friction</div>
          {[
            ["#ff3050", "Critical >= 0.85"],
            ["#ff8c00", "High >= 0.60"],
            ["#c8e600", "Medium >= 0.30"],
            ["#8250ff", "Inhibits (low)"],
            ["#00c8ff", "Promotes (low)"],
            ["#00e5a0", "Neutral"],
          ].map(([color, text]) => (
            <div
              key={text}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "3px 0",
                fontSize: 11,
                color: "#6b7590",
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: color,
                  boxShadow: `0 0 4px ${color}`,
                  flexShrink: 0,
                }}
              />
              {text}
            </div>
          ))}
        </div>

        <div style={{ padding: "14px 16px", borderBottom: "1px solid #1e2430" }}>
          <ScoutAgent
            nodes={nodes}
            sessionId={sessionId}
            onHighlightNodes={handleScoutHighlight}
            onCreateBag={handleScoutCreateBag}
            onRunDiffDock={handleScoutRunDiffDock}
            onSelectNode={handleScoutSelectNode}
          />
        </div>

        <div style={{ padding: "14px 16px", borderBottom: "1px solid #1e2430" }}>
          <div style={lbl}>Source</div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "3px 0",
              fontSize: 11,
              color: "#6b7590",
            }}
          >
            <div style={{ width: 8, height: 8, border: "1px solid #6b7590", flexShrink: 0 }} />
            Private CSV
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "3px 0",
              fontSize: 11,
              color: "#6b7590",
            }}
          >
            <span style={{ width: 8, textAlign: "center", flexShrink: 0 }}>◫</span>
            Excel Data
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "3px 0",
              fontSize: 11,
              color: "#6b7590",
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                border: "1px solid #6b7590",
                flexShrink: 0,
              }}
            />
            Literature
          </div>
          {[
            ["◈", "PDF Document"],
            ["⬡", "Web URL"],
            ["▶", "YouTube"],
          ].map(([icon, label]) => (
            <div
              key={label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "3px 0",
                fontSize: 11,
                color: "#6b7590",
              }}
            >
              <span style={{ width: 8, textAlign: "center", flexShrink: 0 }}>{icon}</span>
              {label}
            </div>
          ))}
        </div>

        <div style={{ padding: "14px 16px" }}>
          <div style={lbl}>View</div>
          <button
            type="button"
            onClick={() => setShowCriticalOnly((current) => !current)}
            style={{
              width: "100%",
              textAlign: "left",
              background: "none",
              cursor: "pointer",
              border: `1px solid ${showCriticalOnly ? "#ff3050" : "#1e2430"}`,
              color: showCriticalOnly ? "#ff3050" : "#6b7590",
              fontFamily: "'DM Mono',monospace",
              fontSize: 11,
              padding: "7px 12px",
              marginBottom: 6,
            }}
          >
            {showCriticalOnly ? "[x]" : "[ ]"} High friction only
          </button>
          {selectedIds.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setSelectedIds([]);
                setInspectedNode(null);
              }}
              style={{
                width: "100%",
                textAlign: "left",
                background: "none",
                cursor: "pointer",
                border: "1px solid #1e2430",
                color: "#6b7590",
                fontFamily: "'DM Mono',monospace",
                fontSize: 11,
                padding: "7px 12px",
              }}
            >
              Clear {selectedIds.length} selected
            </button>
          ) : null}
        </div>

        <div style={{ marginTop: "auto", padding: "14px 16px", borderTop: "1px solid #1e2430" }}>
          <button
            type="button"
            onClick={() => navigate("/")}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#3a4055",
              fontFamily: "'DM Mono',monospace",
              fontSize: 11,
            }}
          >
            {"<-"} New analysis
          </button>
        </div>
      </aside>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: isStackedLayout ? "55vh" : "100%",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            right: 12,
            zIndex: 20,
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              background: "rgba(12,14,18,0.92)",
              border: "1px solid #1e2430",
              padding: "7px 14px",
              fontSize: 11,
              color: "#6b7590",
              backdropFilter: "blur(8px)",
              pointerEvents: "all",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ color: "#3a4055" }}>Session:</span>
            <span style={{ color: "#ffb340", fontWeight: 500 }}>
              {sessionId?.substring(0, 8)}...
            </span>
            <span style={{ color: "#1e2430" }}>|</span>
            <span style={{ color: "#e8eaf0" }}>{visibleNodes.length} nodes</span>
            {selectedIds.length > 0 ? (
              <>
                <span style={{ color: "#1e2430" }}>|</span>
                <span style={{ color: "#00e5a0" }}>{selectedIds.length} selected</span>
              </>
            ) : null}
            {activeBag ? (
              <>
                <span style={{ color: "#1e2430" }}>|</span>
                <span style={{ color: "#00e5a0" }}>Bag: {activeBag.name}</span>
              </>
            ) : null}
          </div>

          <div
            style={{
              background: "rgba(12,14,18,0.92)",
              border: "1px solid #1e2430",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 12px",
              backdropFilter: "blur(8px)",
              flex: 1,
              minWidth: 220,
              maxWidth: isStackedLayout ? "100%" : 400,
              pointerEvents: "all",
            }}
          >
            <span style={{ color: "#3a4055", fontSize: 12 }}>find</span>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search by compound, gene, cell line..."
              style={{
                background: "transparent",
                border: "none",
                color: "#e8eaf0",
                fontFamily: "'DM Mono',monospace",
                fontSize: 12,
                outline: "none",
                padding: "8px 0",
                width: "100%",
              }}
            />
            {searchQuery.trim() ? (
              <span style={{ color: "#6b7590", fontSize: 12, whiteSpace: "nowrap" }}>
                {visibleNodes.length} nodes
              </span>
            ) : null}
          </div>
        </div>

        <MapCanvas
          nodes={visibleNodes}
          allNodes={nodes}
          selectedIds={selectedIds}
          viewMode={viewMode}
          scoutHighlightIds={scoutHighlightIds}
          scoutHighlightColor={scoutHighlightColor}
          onSelectNode={handleSelectNode}
          onMultiSelect={handleMultiSelect}
          onNodeInspect={(node) => {
            setInspectedNode(node);
            if ((node.friction_score ?? 0) >= 0.85) {
              setRightTab("experiments");
            } else {
              setRightTab("inspector");
            }
          }}
        />

        <div
          style={{
            position: "absolute",
            bottom: 14,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 30,
            display: "flex",
            background: "rgba(12,14,18,0.92)",
            border: "1px solid #1e2430",
            borderRadius: 4,
            backdropFilter: "blur(8px)",
            overflow: "hidden",
          }}
        >
          {["2D", "2.5D", "3D"].map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              style={{
                background: viewMode === mode ? "rgba(0,229,160,0.15)" : "transparent",
                color: viewMode === mode ? "#00e5a0" : "#6b7590",
                border: "none",
                borderRight: mode !== "3D" ? "1px solid #1e2430" : "none",
                fontFamily: "'DM Mono',monospace",
                fontSize: 11,
                padding: "6px 16px",
                cursor: "pointer",
                transition: "all 0.2s",
              }}
            >
              {mode}
            </button>
          ))}
        </div>

        {nodes.length > 0 && selectedIds.length === 0 ? (
          <div
            style={{
              position: "absolute",
              bottom: 58,
              left: "50%",
              transform: "translateX(-50%)",
              background: "rgba(12,14,18,0.9)",
              border: "1px solid #1e2430",
              padding: "7px 16px",
              fontSize: 11,
              color: "#3a4055",
              backdropFilter: "blur(8px)",
              whiteSpace: "nowrap",
              zIndex: 20,
            }}
          >
            Click nodes to inspect / Lasso to multi-select / Save selections as Bags
          </div>
        ) : null}

        {selectedIds.length > 0 ? (
          <div
            style={{
              position: "absolute",
              bottom: 14,
              right: 14,
              zIndex: 20,
              display: "flex",
              gap: 8,
            }}
          >
            <button
              type="button"
              onClick={() => handleCreateBag(selectedIds, `Bag ${bags.length + 1}`)}
              style={{
                background: "rgba(0,229,160,0.1)",
                border: "1px solid rgba(0,229,160,0.3)",
                color: "#00e5a0",
                fontFamily: "'DM Mono',monospace",
                fontSize: 11,
                padding: "8px 16px",
                cursor: "pointer",
                backdropFilter: "blur(8px)",
              }}
            >
              + Save as Bag ({selectedIds.length} nodes)
            </button>
          </div>
        ) : null}
      </div>

      <div
        style={{
          width: isStackedLayout ? "100%" : 380,
          minHeight: isStackedLayout ? 540 : "100%",
          flexShrink: 0,
          background: "#0c0e12",
          borderLeft: isStackedLayout ? "none" : "1px solid #1e2430",
          borderTop: isStackedLayout ? "1px solid #1e2430" : "none",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", borderBottom: "1px solid #1e2430", flexShrink: 0 }}>
          {[
            { id: "inspector", icon: "I", label: "Inspector" },
            { id: "oracle", icon: "O", label: "Oracle" },
            { id: "bags", icon: "B", label: `Bags ${bags.length > 0 ? `(${bags.length})` : ""}` },
            { id: "experiments", icon: "⬡", label: "Lab" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setRightTab(tab.id)}
              style={{
                flex: 1,
                background: "none",
                cursor: "pointer",
                border: "none",
                borderBottom: `2px solid ${rightTab === tab.id ? "#00e5a0" : "transparent"}`,
                fontFamily: "'DM Mono',monospace",
                fontSize: 10,
                letterSpacing: 1,
                textTransform: "uppercase",
                padding: "11px 6px",
                color: rightTab === tab.id ? "#00e5a0" : "#3a4055",
                transition: "all 0.15s",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <span style={{ fontSize: 14 }}>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {rightTab === "inspector" ? (
            <InspectorPanel
              node={inspectedNode}
              allNodes={nodes}
              onClose={() => setInspectedNode(null)}
            />
          ) : null}

          {rightTab === "oracle" ? (
            <OraclePanel
              key={activeBag ? `oracle-bag-${sessionId}-${activeBag.id}` : `oracle-selection-${sessionId}`}
              selectedNodes={selectedNodes}
              sessionId={sessionId}
              activeBag={activeBag}
              allNodes={nodes}
              bags={bags}
            />
          ) : null}

          {rightTab === "bags" ? (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <BagsPanel
                bags={bags}
                activeBagId={activeBagId}
                onCreateBag={handleCreateBag}
                onSelectBag={setActiveBagId}
                onDeleteBag={handleDeleteBag}
                onRenameBag={handleRenameBag}
                selectedIds={selectedIds}
                nodes={nodes}
              />
              {activeBag ? (
                <div
                  style={{
                    flex: 1,
                    borderTop: "1px solid #1e2430",
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <OraclePanel
                    key={`bags-oracle-${sessionId}-${activeBag.id}`}
                    selectedNodes={[]}
                    sessionId={sessionId}
                    activeBag={activeBag}
                    allNodes={nodes}
                    bags={bags}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {rightTab === "experiments" ? (
            <ExperimentsPanel
              selectedNode={inspectedNode ?? selectedNodes[0] ?? null}
              nodes={nodes}
              sessionId={sessionId}
              activeBag={activeBag}
              bags={bags}
              onSaveToBag={handleSaveToBag}
            />
          ) : null}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

const lbl = {
  fontSize: 9,
  letterSpacing: 2,
  textTransform: "uppercase",
  color: "#3a4055",
  marginBottom: 10,
};
