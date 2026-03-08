import { useCallback, useEffect, useRef, useState } from "react";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY?.trim();

const SCOUT_SYSTEM_PROMPT = `You are the Dialectic Scout Agent — a proactive
autonomous research assistant scanning a biological claim map for a pharma scientist.

Your job is to find patterns the scientist hasn't noticed yet. You scan ALL nodes
and surface the most scientifically significant findings.

For each scan, you MUST return ONLY valid JSON, no preamble, no markdown:
{
  "scan_id": "scout-{timestamp}",
  "findings": [
    {
      "id": "finding-1",
      "type": "contradiction_cluster" | "ic50_variance" | "cell_line_conflict" | "outlier_node" | "consensus_risk" | "missing_data",
      "severity": "critical" | "high" | "medium",
      "title": "short title max 8 words",
      "description": "2 sentences explaining what you found and why it matters clinically",
      "node_ids": ["id1", "id2"],
      "suggested_bag_name": "name for auto-created bag",
      "action": "what a scientist would do next (1 sentence)",
      "run_diffdock": true | false
    }
  ],
  "summary": "1 sentence overall map health summary",
  "top_risk": "the single highest risk finding in 10 words",
  "scientist_next_step": "the single most important thing to do right now"
}

Rules:
- Always return 3-5 findings
- Mark run_diffdock: true only for findings with friction >= 0.85
- suggested_bag_name must be short and scientific (e.g. "KRAS Resistance Cluster")
- Be specific about compound names, IC50 values, cell lines
- severity critical = friction >= 0.85, high = friction >= 0.6, medium = rest
- Find patterns a human would miss by reading nodes one at a time`;

const VISION_SYSTEM_PROMPT = `You are the Dialectic Scout Agent analyzing
a screenshot of a biological epistemic map.

Each dot on the map is a biological claim. Colors mean:
- Red/orange dots = high contradiction (friction >= 0.6)
- Purple dots = inhibitory claims
- Cyan/teal dots = activating claims
- Green dots = consensus nodes
- Dashed lines between dots = contradictions
- Constellation lines = cluster membership

Find visual patterns the data analysis might miss:
- Unusual spatial clustering or isolation
- Visual "bridges" between clusters (nodes connecting two groups)
- Dense red zones indicating contradiction hotspots
- Lone outlier nodes far from any cluster
- Asymmetric clusters (one side red, other side green)
- Any other visually striking pattern

Return ONLY valid JSON, no preamble, no markdown:
{
  "visual_findings": [
    {
      "id": "visual-1",
      "type": "spatial_cluster" | "bridge_node" | "outlier" | "hotspot" | "asymmetric_cluster" | "visual_anomaly",
      "severity": "critical" | "high" | "medium",
      "title": "short title max 8 words",
      "description": "2 sentences: what you see visually and what it means scientifically",
      "map_region": "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center" | "edge",
      "approximate_node_count": number,
      "action": "what to investigate next"
    }
  ],
  "visual_summary": "1 sentence describing the overall visual shape and health of the map",
  "most_striking_visual": "the single most visually unusual thing you see"
}

Be specific about what you see — colors, positions, density, shapes.
Return 2-4 visual findings.`;

const severityOrder = {
  critical: 0,
  high: 1,
  medium: 2,
};

const severityColor = {
  critical: "#ff3050",
  high: "#ff8c00",
  medium: "#c8e600",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseScoutPayload(text) {
  const clean = String(text ?? "").replace(/```json|```/g, "").trim();
  return JSON.parse(clean || "{}");
}

export default function ScoutAgent({
  nodes,
  sessionId,
  onHighlightNodes,
  onCreateBag,
  onRunDiffDock,
  onSelectNode,
  mapCanvasRef,
}) {
  const [status, setStatus] = useState("idle");
  const [findings, setFindings] = useState([]);
  const [summary, setSummary] = useState("");
  const [visionSummary, setVisionSummary] = useState("");
  const [topRisk, setTopRisk] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [scanCount, setScanCount] = useState(0);
  const [takeoverInput, setTakeoverInput] = useState("");
  const [takeoverInstructions, setTakeoverInstructions] = useState("");
  const [log, setLog] = useState([]);
  const [expandedFinding, setExpandedFinding] = useState(null);
  const isPaused = useRef(false);
  const abortRef = useRef(null);
  const scanTokenRef = useRef(0);

  const addLog = useCallback((message) => {
    setLog((previous) => [...previous.slice(-20), `${new Date().toLocaleTimeString()} ${message}`]);
  }, []);

  useEffect(() => () => {
    abortRef.current?.abort();
  }, []);

  const finalizePausedState = useCallback(() => {
    setStatus("paused");
  }, []);

  const runVisionScan = useCallback(async (signal) => {
    if (!mapCanvasRef?.current) {
      addLog("◌ No canvas ref — skipping vision scan.");
      return { visual_findings: [] };
    }

    addLog("► Pass 2: Capturing map screenshot for vision analysis...");

    try {
      const canvas = mapCanvasRef.current;
      const imageData = canvas.toDataURL("image/png");
      const base64 = imageData.split(",")[1];

      addLog("► Sending map image to Claude Vision...");

      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1000,
          system: VISION_SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: base64,
                },
              },
              {
                type: "text",
                text: "Analyze this biological epistemic map screenshot. Find visual cluster patterns, outliers, and anomalies that raw data analysis would miss.",
              },
            ],
          }],
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = await response.json();
      const parsed = parseScoutPayload(data.content?.[0]?.text || "{}");
      addLog(`✓ Vision found ${parsed.visual_findings?.length || 0} visual patterns.`);
      return parsed;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }

      addLog(`✗ Vision scan failed: ${error.message}`);
      return { visual_findings: [] };
    }
  }, [addLog, mapCanvasRef]);

  const runScan = useCallback(async (customInstructions = "") => {
    if (!nodes?.length) {
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    scanTokenRef.current = Date.now();
    const currentScanToken = scanTokenRef.current;

    isPaused.current = false;
    setStatus("scanning");
    setExpandedFinding(null);
    setVisionSummary("");
    onHighlightNodes?.([], "#ffff00");
    addLog("► Scout scan initiated...");

    const nodeSlim = nodes
      .filter((n) => n.umap_x != null)
      .sort((a, b) => (b.friction_score || 0) - (a.friction_score || 0))
      .slice(0, 50)
      .map((n) => ({
        id: n.node_id?.slice(0, 8),
        s: n.subject_name?.slice(0, 20),
        o: n.object_name?.slice(0, 20),
        f: n.friction_score,
        p: n.polarity,
        src: n.source_type === "private_csv" ? "priv" : "pub",
        ic50: n.quantitative_value,
        cl: n.cell_line?.slice(0, 15),
        cx: n.contradicting_node_ids?.length || 0,
      }));

    const userPrompt = customInstructions
      ? `Session: ${sessionId}\nCustom focus: ${customInstructions}\n\nMap data (${nodes.length} nodes):\n${JSON.stringify(nodeSlim)}`
      : `Session: ${sessionId}\nScan this biological claim map and find the most important patterns.\nMap data (${nodes.length} nodes):\n${JSON.stringify(nodeSlim)}`;

    try {
      if (!ANTHROPIC_API_KEY) {
        throw new Error("Missing VITE_ANTHROPIC_API_KEY.");
      }

      addLog(`► Pass 1: Analyzing ${nodes.length} nodes...`);
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1500,
          system: SCOUT_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = await response.json();
      const parsed = parseScoutPayload(data.content?.[0]?.text || "{}");

      if (scanTokenRef.current !== currentScanToken) {
        return;
      }

      if (isPaused.current) {
        finalizePausedState();
        return;
      }

      const dataFindings = Array.isArray(parsed.findings) ? parsed.findings.slice(0, 5) : [];
      addLog(`✓ Found ${dataFindings.length} data patterns.`);
      addLog("► Pass 1 complete (data analysis). Starting Pass 2 (vision)...");

      const visionResult = await runVisionScan(controller.signal);

      if (scanTokenRef.current !== currentScanToken) {
        return;
      }

      if (isPaused.current) {
        finalizePausedState();
        return;
      }

      const visualFindings = (visionResult.visual_findings || []).map((finding, index) => ({
        ...finding,
        id: finding.id || `visual-${Date.now()}-${index}`,
        node_ids: [],
        suggested_bag_name: null,
        run_diffdock: false,
        source: "vision",
      }));

      const allFindings = [
        ...dataFindings.map((finding) => ({ ...finding, source: "data" })),
        ...visualFindings,
      ].sort((left, right) => (
        (severityOrder[left.severity] ?? 3) - (severityOrder[right.severity] ?? 3)
      ));

      const flaggedIds = [...new Set(allFindings.flatMap((finding) => finding.node_ids || []).filter(Boolean))];

      setFindings(allFindings);
      setSummary(parsed.summary || "");
      setTopRisk(parsed.top_risk || visionResult.most_striking_visual || "");
      setNextStep(parsed.scientist_next_step || "");
      setVisionSummary(visionResult.visual_summary || "");
      setScanCount((count) => count + 1);

      if (flaggedIds.length > 0 && onHighlightNodes) {
        onHighlightNodes(flaggedIds, "#ffff00");
        addLog(`► Highlighted ${flaggedIds.length} nodes on map.`);
      }

      if (scanTokenRef.current !== currentScanToken) {
        return;
      }

      if (isPaused.current) {
        finalizePausedState();
        return;
      }

      for (const finding of allFindings) {
        if (scanTokenRef.current !== currentScanToken) {
          return;
        }

        if (isPaused.current) {
          finalizePausedState();
          return;
        }

        if (finding.node_ids?.length > 0 && finding.suggested_bag_name && onCreateBag) {
          onCreateBag(finding.suggested_bag_name, finding.node_ids);
          addLog(`► Created bag: "${finding.suggested_bag_name}"`);
          await sleep(300);
        }
      }

      for (const finding of allFindings) {
        if (scanTokenRef.current !== currentScanToken) {
          return;
        }

        if (isPaused.current) {
          finalizePausedState();
          return;
        }

        if (finding.run_diffdock && finding.node_ids?.[0] && onRunDiffDock) {
          addLog(`► Submitting DiffDock for critical node: ${finding.node_ids[0].slice(0, 8)}...`);
          onRunDiffDock(finding.node_ids[0]);
          await sleep(500);
        }
      }

      if (scanTokenRef.current !== currentScanToken) {
        return;
      }

      if (isPaused.current) {
        finalizePausedState();
        return;
      }

      addLog("✓ Scout scan complete.");
      setStatus("active");
    } catch (error) {
      if (error?.name === "AbortError") {
        if (scanTokenRef.current === currentScanToken && isPaused.current) {
          finalizePausedState();
        }
        return;
      }

      if (scanTokenRef.current !== currentScanToken) {
        return;
      }

      addLog(`✗ Scout error: ${error.message}`);
      setStatus("idle");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [
    addLog,
    finalizePausedState,
    nodes,
    onCreateBag,
    onHighlightNodes,
    onRunDiffDock,
    runVisionScan,
    sessionId,
  ]);

  const handlePause = () => {
    isPaused.current = true;
    abortRef.current?.abort();
    setStatus("paused");
    addLog("◌ Scout paused by human.");
  };

  const handleTakeover = () => {
    isPaused.current = true;
    abortRef.current?.abort();
    setStatus("takeover");
    addLog("◈ Human takeover initiated.");
  };

  const handleTakeoverSubmit = async () => {
    if (!takeoverInput.trim()) {
      return;
    }

    const instructions = takeoverInput.trim();
    setTakeoverInstructions(instructions);
    setTakeoverInput("");
    addLog(`◈ Resuming with instructions: "${instructions}"`);
    await runScan(instructions);
  };

  const handleResumeAutonomy = () => {
    isPaused.current = false;
    setTakeoverInstructions("");
    setStatus(findings.length > 0 ? "active" : "idle");
    addLog("► Resumed autonomous mode.");
  };

  const isActive = status === "active";
  const isScanning = status === "scanning";
  const isPausedState = status === "paused";
  const isTakeover = status === "takeover";
  const hasTakeoverFocus = Boolean(takeoverInstructions);

  return (
    <div
      style={{
        border: isActive
          ? "1px solid rgba(0,229,160,0.5)"
          : isPausedState
            ? "1px solid rgba(255,179,64,0.3)"
            : isTakeover
              ? "1px solid rgba(77,124,255,0.3)"
              : "1px solid #1e2430",
        borderRadius: 2,
        boxShadow: isActive ? "0 0 12px rgba(0,229,160,0.12)" : "none",
        animation: isActive ? "scoutBorderPulse 1.8s ease-in-out infinite" : "none",
        marginBottom: 12,
        transition: "all 0.3s",
        overflow: "hidden",
        background: "#0c0e12",
      }}
    >
      <div
        style={{
          padding: "8px 10px",
          background: isActive
            ? "rgba(0,229,160,0.05)"
            : isPausedState
              ? "rgba(255,179,64,0.05)"
              : isTakeover
                ? "rgba(77,124,255,0.05)"
                : "#0c0e12",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid #1e2430",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: isActive
                ? "#00e5a0"
                : isScanning
                  ? "#ffb340"
                  : isPausedState
                    ? "#ff8c00"
                    : isTakeover
                      ? "#4d7cff"
                      : "#3a4055",
              boxShadow: isActive ? "0 0 6px #00e5a0" : "none",
              animation: isScanning ? "scoutDotPulse 1s infinite" : "none",
            }}
          />
          <span
            style={{
              fontFamily: "Syne, sans-serif",
              fontSize: 11,
              color: "#e8eaf0",
              letterSpacing: 0.5,
            }}
          >
            Scout Agent
          </span>
          {scanCount > 0 ? (
            <span
              style={{
                fontSize: 8,
                color: "#6b7590",
                background: "#1e2430",
                padding: "1px 5px",
              }}
            >
              {scanCount} scan{scanCount > 1 ? "s" : ""}
            </span>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 4 }}>
          {(status === "idle" || status === "active") ? (
            <button
              type="button"
              onClick={() => runScan(takeoverInstructions)}
              style={{
                background: "rgba(0,229,160,0.1)",
                border: "1px solid rgba(0,229,160,0.4)",
                color: "#00e5a0",
                fontSize: 9,
                fontFamily: "'DM Mono',monospace",
                padding: "3px 8px",
                cursor: "pointer",
              }}
            >
              ► Scan
            </button>
          ) : null}
          {isScanning ? (
            <button
              type="button"
              onClick={handlePause}
              style={{
                background: "rgba(255,179,64,0.1)",
                border: "1px solid rgba(255,179,64,0.4)",
                color: "#ffb340",
                fontSize: 9,
                fontFamily: "'DM Mono',monospace",
                padding: "3px 8px",
                cursor: "pointer",
              }}
            >
              ◌ Pause
            </button>
          ) : null}
          {isActive ? (
            <button
              type="button"
              onClick={handleTakeover}
              style={{
                background: "rgba(77,124,255,0.1)",
                border: "1px solid rgba(77,124,255,0.4)",
                color: "#4d7cff",
                fontSize: 9,
                fontFamily: "'DM Mono',monospace",
                padding: "3px 8px",
                cursor: "pointer",
              }}
            >
              ◈ Take Over
            </button>
          ) : null}
          {isPausedState ? (
            <button
              type="button"
              onClick={() => runScan(takeoverInstructions)}
              style={{
                background: "rgba(0,229,160,0.1)",
                border: "1px solid rgba(0,229,160,0.4)",
                color: "#00e5a0",
                fontSize: 9,
                fontFamily: "'DM Mono',monospace",
                padding: "3px 8px",
                cursor: "pointer",
              }}
            >
              ► Resume
            </button>
          ) : null}
        </div>
      </div>

      {isScanning ? (
        <div
          style={{
            padding: "6px 10px",
            fontSize: 9,
            color: "#ffb340",
            background: "rgba(255,179,64,0.03)",
            borderBottom: "1px solid #1e2430",
            fontFamily: "'DM Mono',monospace",
            lineHeight: 1.5,
          }}
        >
          ◈ Pass 1: Analyzing {nodes?.length || 0} nodes...
          <br />
          then Pass 2: Claude Vision map analysis
        </div>
      ) : null}

      {isTakeover ? (
        <div
          style={{
            padding: 10,
            background: "rgba(77,124,255,0.04)",
            borderBottom: "1px solid #1e2430",
          }}
        >
          <div
            style={{
              fontSize: 9,
              color: "#4d7cff",
              letterSpacing: 1.5,
              marginBottom: 6,
            }}
          >
            ◈ HUMAN TAKEOVER — Tell Scout what to focus on:
          </div>
          <input
            value={takeoverInput}
            onChange={(event) => setTakeoverInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void handleTakeoverSubmit();
              }
            }}
            placeholder='e.g. "focus on adagrasib only" or "ignore cell line conflicts"'
            style={{
              width: "100%",
              background: "#080a0e",
              border: "1px solid #4d7cff",
              color: "#e8eaf0",
              fontFamily: "'DM Mono',monospace",
              fontSize: 10,
              padding: "6px 8px",
              marginBottom: 6,
              boxSizing: "border-box",
            }}
            autoFocus
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={() => void handleTakeoverSubmit()}
              style={{
                flex: 1,
                background: "rgba(77,124,255,0.1)",
                border: "1px solid #4d7cff",
                color: "#4d7cff",
                fontFamily: "'DM Mono',monospace",
                fontSize: 10,
                padding: "5px 0",
                cursor: "pointer",
              }}
            >
              ► Run with Instructions
            </button>
            <button
              type="button"
              onClick={handleResumeAutonomy}
              style={{
                background: "transparent",
                border: "1px solid #1e2430",
                color: "#6b7590",
                fontFamily: "'DM Mono',monospace",
                fontSize: 10,
                padding: "5px 8px",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {topRisk && isActive ? (
        <div
          style={{
            padding: "5px 10px",
            fontSize: 9,
            background: "rgba(255,48,80,0.06)",
            borderBottom: "1px solid rgba(255,48,80,0.15)",
            color: "#ff3050",
            fontFamily: "'DM Mono',monospace",
          }}
        >
          ⚠ Top risk: {topRisk}
        </div>
      ) : null}

      {summary ? (
        <div
          style={{
            padding: "5px 10px",
            fontSize: 9,
            color: "#6b7590",
            borderBottom: "1px solid #1e2430",
            fontFamily: "'DM Mono',monospace",
            lineHeight: 1.5,
          }}
        >
          {summary}
        </div>
      ) : null}

      {visionSummary ? (
        <div
          style={{
            padding: "5px 10px",
            fontSize: 9,
            color: "#4d7cff",
            borderBottom: "1px solid #1e2430",
            fontFamily: "'DM Mono',monospace",
            lineHeight: 1.5,
            background: "rgba(77,124,255,0.03)",
          }}
        >
          👁 Visual: {visionSummary}
        </div>
      ) : null}

      {hasTakeoverFocus && isActive ? (
        <div
          style={{
            padding: "6px 10px",
            borderBottom: "1px solid #1e2430",
            background: "rgba(77,124,255,0.04)",
            color: "#4d7cff",
            fontSize: 8,
            fontFamily: "'DM Mono',monospace",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span>◈ Takeover focus active: {takeoverInstructions}</span>
          <button
            type="button"
            onClick={handleResumeAutonomy}
            style={{
              background: "transparent",
              border: "1px solid rgba(77,124,255,0.35)",
              color: "#4d7cff",
              fontSize: 8,
              fontFamily: "'DM Mono',monospace",
              padding: "2px 6px",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Resume Autonomy
          </button>
        </div>
      ) : null}

      {findings.length > 0 ? (
        <div style={{ maxHeight: 280, overflowY: "auto" }}>
          {findings.map((finding, index) => (
            <div
              key={finding.id || index}
              style={{
                borderBottom: "1px solid #1e2430",
                padding: "8px 10px",
                background: expandedFinding === index ? "rgba(255,179,64,0.04)" : "transparent",
                cursor: "pointer",
              }}
              onClick={() => setExpandedFinding(expandedFinding === index ? null : index)}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                  <div
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: severityColor[finding.severity] || "#6b7590",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 10,
                      color: "#e8eaf0",
                      fontFamily: "'DM Mono',monospace",
                    }}
                  >
                    {finding.title}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                  <span
                    style={{
                      fontSize: 8,
                      color: severityColor[finding.severity] || "#6b7590",
                      textTransform: "uppercase",
                      letterSpacing: 1,
                    }}
                  >
                    {finding.severity}
                  </span>
                  {finding.source === "vision" ? (
                    <span
                      style={{
                        fontSize: 7,
                        color: "#4d7cff",
                        background: "rgba(77,124,255,0.1)",
                        border: "1px solid rgba(77,124,255,0.2)",
                        padding: "1px 4px",
                        letterSpacing: 1,
                        textTransform: "uppercase",
                        marginLeft: 4,
                        flexShrink: 0,
                      }}
                    >
                      👁 Vision
                    </span>
                  ) : null}
                  {finding.source === "data" ? (
                    <span
                      style={{
                        fontSize: 7,
                        color: "#6b7590",
                        background: "rgba(100,100,100,0.1)",
                        border: "1px solid rgba(100,100,100,0.2)",
                        padding: "1px 4px",
                        letterSpacing: 1,
                        textTransform: "uppercase",
                        marginLeft: 4,
                        flexShrink: 0,
                      }}
                    >
                      ◈ Data
                    </span>
                  ) : null}
                </div>
              </div>

              {expandedFinding === index ? (
                <div style={{ marginTop: 8, paddingLeft: 10 }}>
                  <div
                    style={{
                      fontSize: 10,
                      color: "#c0c4d0",
                      lineHeight: 1.6,
                      marginBottom: 6,
                      fontFamily: "'DM Mono',monospace",
                    }}
                  >
                    {finding.description}
                  </div>
                  <div
                    style={{
                      fontSize: 9,
                      color: "#6b7590",
                      marginBottom: 6,
                    }}
                  >
                    → {finding.action}
                  </div>
                  <div
                    style={{
                      fontSize: 8,
                      color: "#3a4055",
                      marginBottom: 8,
                    }}
                  >
                    {finding.source === "vision"
                      ? `${finding.map_region || "region unknown"} · approx ${finding.approximate_node_count ?? "?"} nodes`
                      : `${finding.node_ids?.length || 0} nodes · bag: "${finding.suggested_bag_name}"`}
                    {finding.run_diffdock ? (
                      <span style={{ color: "#ffb340", marginLeft: 6 }}>
                        ⬡ DiffDock queued
                      </span>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", gap: 5 }}>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (finding.node_ids?.[0] && onSelectNode) {
                          onSelectNode(finding.node_ids[0]);
                        }
                        window.dispatchEvent(new CustomEvent("dialectic:open-tab", {
                          detail: { tab: "experiments" },
                        }));
                      }}
                      style={{
                        background: "transparent",
                        border: "1px solid #1e2430",
                        color: "#6b7590",
                        fontSize: 9,
                        fontFamily: "'DM Mono',monospace",
                        padding: "3px 8px",
                        cursor: finding.node_ids?.[0] ? "pointer" : "default",
                        opacity: finding.node_ids?.[0] ? 1 : 0.45,
                      }}
                      disabled={!finding.node_ids?.[0]}
                    >
                      Investigate →
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (finding.node_ids?.length > 0 && onHighlightNodes) {
                          onHighlightNodes(finding.node_ids, "#ffff00");
                        }
                      }}
                      style={{
                        background: "transparent",
                        border: "1px solid #1e2430",
                        color: "#6b7590",
                        fontSize: 9,
                        fontFamily: "'DM Mono',monospace",
                        padding: "3px 8px",
                        cursor: finding.node_ids?.length > 0 ? "pointer" : "default",
                        opacity: finding.node_ids?.length > 0 ? 1 : 0.45,
                      }}
                      disabled={!finding.node_ids?.length}
                    >
                      Highlight
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {nextStep && isActive ? (
        <div
          style={{
            padding: "6px 10px",
            fontSize: 9,
            borderTop: "1px solid #1e2430",
            color: "#00e5a0",
            fontFamily: "'DM Mono',monospace",
            background: "rgba(0,229,160,0.03)",
          }}
        >
          ▶ Scout recommends: {nextStep}
        </div>
      ) : null}

      {log.length > 0 ? (
        <details style={{ borderTop: "1px solid #1e2430" }}>
          <summary
            style={{
              padding: "4px 10px",
              fontSize: 8,
              color: "#3a4055",
              cursor: "pointer",
              fontFamily: "'DM Mono',monospace",
              listStyle: "none",
            }}
          >
            ◈ Agent log ({log.length})
          </summary>
          <div
            style={{
              background: "#030405",
              padding: "6px 10px",
              maxHeight: 80,
              overflowY: "auto",
            }}
          >
            {log.map((line, index) => (
              <div
                key={`${line}-${index}`}
                style={{
                  fontSize: 8,
                  color: "#3a4055",
                  fontFamily: "'DM Mono',monospace",
                }}
              >
                {line}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <style>{`
        @keyframes scoutBorderPulse {
          0% { box-shadow: 0 0 6px rgba(0,229,160,0.08); }
          50% { box-shadow: 0 0 16px rgba(0,229,160,0.18); }
          100% { box-shadow: 0 0 6px rgba(0,229,160,0.08); }
        }

        @keyframes scoutDotPulse {
          0% { opacity: 0.55; transform: scale(0.9); }
          50% { opacity: 1; transform: scale(1.1); }
          100% { opacity: 0.55; transform: scale(0.9); }
        }
      `}</style>
    </div>
  );
}
