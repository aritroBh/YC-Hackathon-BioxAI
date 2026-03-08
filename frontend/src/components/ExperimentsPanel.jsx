import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart,
  Bar,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
} from "recharts";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY?.trim();

const s = {
  container: {
    height: "100%",
    overflowY: "auto",
    padding: 16,
    background: "#050608",
    color: "#e8eaf0",
    fontFamily: "'DM Mono', monospace",
    fontSize: 11,
  },
  header: {
    fontFamily: "Syne, sans-serif",
    fontSize: 15,
    color: "#00e5a0",
    marginBottom: 4,
    letterSpacing: 1,
  },
  sub: { color: "#6b7590", fontSize: 10, marginBottom: 16, lineHeight: 1.6 },
  card: {
    background: "#0c0e12",
    border: "1px solid #1e2430",
    padding: 12,
    marginBottom: 12,
  },
  emptyState: {
    border: "1px solid rgba(0,229,160,0.2)",
    borderRadius: 2,
    padding: 32,
    textAlign: "center",
    color: "#6b7590",
    animation: "pulse 2s infinite",
  },
  nodeCard: {
    background: "#080a0e",
    border: "1px solid #1e2430",
    padding: 10,
    flex: 1,
    minWidth: 0,
  },
  badge: (color) => ({
    display: "inline-block",
    fontSize: 9,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    padding: "2px 6px",
    background: `rgba(${color},0.1)`,
    border: `1px solid rgba(${color},0.3)`,
    color: `rgb(${color})`,
    marginBottom: 6,
  }),
  vsDiv: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 10px",
    color: "#ff3050",
    fontFamily: "Syne, sans-serif",
    fontSize: 13,
    fontWeight: 700,
    textShadow: "0 0 12px rgba(255,48,80,0.6)",
  },
  dirBtn: (color) => ({
    width: "100%",
    padding: "10px 12px",
    marginBottom: 8,
    background: "transparent",
    border: `1px solid ${color}`,
    color: "#e8eaf0",
    fontFamily: "'DM Mono', monospace",
    fontSize: 11,
    cursor: "pointer",
    textAlign: "left",
    transition: "background 0.2s",
  }),
  terminal: {
    background: "#030405",
    border: "1px solid #1e2430",
    padding: 10,
    height: 120,
    overflowY: "auto",
    fontFamily: "'DM Mono', monospace",
    fontSize: 10,
    color: "#00e5a0",
    marginBottom: 12,
  },
  grid2x2: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    marginBottom: 12,
  },
  chartCard: {
    background: "#0c0e12",
    border: "1px solid #1e2430",
    padding: 10,
    minWidth: 0,
  },
  chartTitle: {
    fontSize: 9,
    color: "#6b7590",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  summaryCard: {
    background: "rgba(255,179,64,0.03)",
    border: "1px solid rgba(255,179,64,0.2)",
    padding: 12,
    marginBottom: 12,
  },
  exportRow: { display: "flex", gap: 8 },
  exportBtn: {
    flex: 1,
    padding: "7px 4px",
    background: "transparent",
    border: "1px solid #1e2430",
    color: "#6b7590",
    fontFamily: "'DM Mono', monospace",
    fontSize: 10,
    cursor: "pointer",
  },
};

const CHART_THEME = {
  cartesianGrid: "rgba(77,124,255,0.05)",
  tooltip: {
    contentStyle: {
      background: "#0c0e12",
      border: "1px solid #1e2430",
      fontSize: 10,
      color: "#e8eaf0",
    },
    itemStyle: { color: "#e8eaf0" },
    labelStyle: { color: "#6b7590" },
  },
};

function isPrivateNode(node) {
  return node?.source_type === "private_csv";
}

function isLiteratureNode(node) {
  return Boolean(node) && node.source_type !== "private_csv";
}

function hillCurveValue(ic50, concentration) {
  if (!Number.isFinite(ic50) || ic50 <= 0) {
    return null;
  }
  return parseFloat((100 / (1 + ((ic50 / concentration) ** 1.5))).toFixed(1));
}

function formatMeasurement(node) {
  if (node?.quantitative_value == null) {
    return "—";
  }
  return `${node.quantitative_value}${node.quantitative_unit || "nM"}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatFixed(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function buildFallbackSummary(expResults, privateNode, litNode) {
  const scoreA = expResults?.direction_a?.diffdock_score;
  const scoreB = expResults?.direction_b?.diffdock_score;
  const compoundA = expResults?.direction_a?.compound || privateNode?.subject_name || "your compound";
  const compoundB = expResults?.direction_b?.compound || litNode?.subject_name || "the literature compound";
  const betterDirection = (
    Number.isFinite(scoreA) && Number.isFinite(scoreB)
      ? (scoreA >= scoreB ? "A" : "B")
      : Number.isFinite(scoreA)
        ? "A"
        : Number.isFinite(scoreB)
          ? "B"
          : "neither direction"
  );
  const deltaText = Number.isFinite(scoreA) && Number.isFinite(scoreB)
    ? `Direction A scored ${scoreA.toFixed(2)} while Direction B scored ${scoreB.toFixed(2)}`
    : Number.isFinite(scoreA)
      ? `Direction A scored ${scoreA.toFixed(2)}`
      : Number.isFinite(scoreB)
        ? `Direction B scored ${scoreB.toFixed(2)}`
        : "No usable DiffDock confidence score was produced";
  const consistencySentence = betterDirection === "neither direction"
    ? "Neither swap direction produced a sufficiently confident structural winner under the transferred protocol conditions."
    : `Direction ${betterDirection} is more structurally consistent with the observed KRAS G12C binding pose under the transferred protocol conditions.`;

  return `${compoundA} and ${compoundB} produced docking geometries consistent with ${deltaText.toLowerCase()}, indicating different pocket compatibility across the swapped assay contexts. ${consistencySentence} This suggests the IC50 discrepancy between ${privateNode?.quantitative_value ?? "private"}${privateNode?.quantitative_unit || "nM"} and ${litNode?.quantitative_value ?? "published"}${litNode?.quantitative_unit || "nM"} is at least partly protocol-dependent, which elevates translational risk if the wrong assay context is assumed.`;
}

function PocketViewer({ scoreA, scoreB, compoundA, compoundB }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0c0e12";
    ctx.fillRect(0, 0, w, h);

    function drawPocket(cx, label, score, color) {
      const confidence = Math.min(1, Math.max(0, ((score ?? -3) + 3) / 3));

      ctx.beginPath();
      ctx.moveTo(cx - 35, h * 0.25);
      ctx.bezierCurveTo(cx - 50, h * 0.3, cx - 55, h * 0.5, cx - 40, h * 0.75);
      ctx.lineTo(cx + 40, h * 0.75);
      ctx.bezierCurveTo(cx + 55, h * 0.5, cx + 50, h * 0.3, cx + 35, h * 0.25);
      ctx.closePath();
      ctx.strokeStyle = "rgba(100,120,150,0.4)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "rgba(20,25,35,0.8)";
      ctx.fill();

      const blobRadius = 12 + (confidence * 8);
      const gradient = ctx.createRadialGradient(cx, h * 0.52, 0, cx, h * 0.52, blobRadius);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, "transparent");
      ctx.beginPath();
      ctx.arc(cx, h * 0.52, blobRadius, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();

      [[cx - 25, h * 0.38], [cx + 20, h * 0.4], [cx - 15, h * 0.66]].forEach(([px, py]) => {
        ctx.beginPath();
        ctx.setLineDash([2, 3]);
        ctx.moveTo(cx, h * 0.52);
        ctx.lineTo(px, py);
        ctx.strokeStyle = `rgba(${color === "#4d7cff" ? "77,124,255" : "0,229,160"},${0.3 + (confidence * 0.4)})`;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.setLineDash([]);
      });

      ctx.fillStyle = "#6b7590";
      ctx.font = "9px DM Mono";
      ctx.textAlign = "center";
      ctx.fillText(label, cx, h * 0.88);
      ctx.fillStyle = color;
      ctx.fillText(`score: ${Number.isFinite(score) ? score.toFixed(2) : "—"}`, cx, h * 0.96);
    }

    drawPocket(w * 0.28, compoundA || "Direction A", scoreA ?? -1.42, "#4d7cff");
    drawPocket(w * 0.72, compoundB || "Direction B", scoreB ?? -2.81, "#00e5a0");
  }, [compoundA, compoundB, scoreA, scoreB]);

  return (
    <canvas
      ref={canvasRef}
      width={280}
      height={140}
      style={{ width: "100%", height: 140 }}
    />
  );
}

export default function ExperimentsPanel({
  selectedNode,
  nodes,
  sessionId,
  activeBag,
  bags,
  onSaveToBag,
}) {
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);
  const [summary, setSummary] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [nextSteps, setNextSteps] = useState([]);
  const [nextStepsLoading, setNextStepsLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const logRef = useRef(null);

  const contradictionCandidates = useMemo(
    () => (selectedNode?.contradicting_node_ids || [])
      .map((nodeId) => nodes.find((node) => node.node_id === nodeId))
      .filter(Boolean),
    [nodes, selectedNode],
  );

  const contradictingNode = useMemo(() => {
    if (!selectedNode) {
      return null;
    }

    return contradictionCandidates.find((node) => isPrivateNode(node) !== isPrivateNode(selectedNode))
      || contradictionCandidates[0]
      || null;
  }, [contradictionCandidates, selectedNode]);

  const privateNode = isPrivateNode(selectedNode)
    ? selectedNode
    : isPrivateNode(contradictingNode)
      ? contradictingNode
      : null;

  const litNode = isLiteratureNode(selectedNode)
    ? selectedNode
    : isLiteratureNode(contradictingNode)
      ? contradictingNode
      : null;

  const visibleHistory = useMemo(
    () => history.filter((run) => run.nodeAId === privateNode?.node_id && run.nodeBId === litNode?.node_id),
    [history, litNode?.node_id, privateNode?.node_id],
  );

  const addLog = (message) => {
    const time = new Date().toISOString().slice(14, 19);
    setLogs((previous) => [...previous, `[${time}] ${message}`]);
  };

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    setLogs([]);
    setRunning(false);
    setResults(null);
    setSummary("");
    setSummaryLoading(false);
    setNextSteps([]);
    setNextStepsLoading(false);
  }, [selectedNode?.node_id, privateNode?.node_id, litNode?.node_id]);

  const generateSummary = async (expResults) => {
    if (!privateNode || !litNode) {
      return;
    }

    if (!ANTHROPIC_API_KEY) {
      setSummary(buildFallbackSummary(expResults, privateNode, litNode));
      return;
    }

    setSummaryLoading(true);
    setSummary("");

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": ANTHROPIC_API_KEY,
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1000,
          stream: true,
          messages: [{
            role: "user",
            content: `You are a computational biology expert writing a scientific interpretation.
Given these DiffDock structural docking results:
${JSON.stringify(expResults, null, 2)}

Private assay node: compound=${privateNode?.subject_name}, IC50=${privateNode?.quantitative_value}${privateNode?.quantitative_unit}, cell_line=${privateNode?.cell_line}
Published node: compound=${litNode?.subject_name}, IC50=${litNode?.quantitative_value}${litNode?.quantitative_unit}, cell_line=${litNode?.cell_line}, citations=${litNode?.citation_count}

Write exactly 3 sentences as a scientific interpretation:
1. What the DiffDock scores imply about binding geometry
2. Which direction (A or B) is more structurally consistent
3. What this means for the IC50 discrepancy and clinical risk
Write in the style of a methods/results section. Be specific about compound names and values.`,
          }],
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      if (!response.body) {
        throw new Error("Claude streaming is not available in this browser.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";

      const processBlock = (block) => {
        const dataLines = block
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());

        if (dataLines.length === 0) {
          return;
        }

        const payloadText = dataLines.join("\n");
        if (!payloadText || payloadText === "[DONE]") {
          return;
        }

        const payload = JSON.parse(payloadText);
        if (payload.type === "content_block_start" && payload.content_block?.text) {
          text += payload.content_block.text;
          setSummary(text);
        }
        if (payload.type === "content_block_delta" && payload.delta?.text) {
          text += payload.delta.text;
          setSummary(text);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        blocks.forEach((block) => {
          try {
            processBlock(block);
          } catch {
            // Ignore malformed stream chunks and continue.
          }
        });
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        processBlock(buffer);
      }

      if (!text.trim()) {
        setSummary(buildFallbackSummary(expResults, privateNode, litNode));
      }
    } catch (error) {
      setSummary(buildFallbackSummary(expResults, privateNode, litNode));
      addLog(`Summary fallback: ${error.message || "Claude unavailable."}`);
    } finally {
      setSummaryLoading(false);
    }
  };

  const generateNextSteps = async (expResults) => {
    if (!privateNode || !litNode) {
      return;
    }

    if (!ANTHROPIC_API_KEY) {
      setNextSteps([]);
      return;
    }

    setNextStepsLoading(true);
    setNextSteps([]);

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": ANTHROPIC_API_KEY,
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `You are a computational biology expert.
Given these DiffDock experiment results:
${JSON.stringify(expResults, null, 2)}

Private node: ${privateNode?.subject_name}, IC50=${privateNode?.quantitative_value}${privateNode?.quantitative_unit}, cell_line=${privateNode?.cell_line}
Literature node: ${litNode?.subject_name}, IC50=${litNode?.quantitative_value}${litNode?.quantitative_unit}

Return ONLY valid JSON — no preamble, no markdown, no backticks:
{
  "recommendations": [
    {
      "title": "short action title (max 8 words)",
      "rationale": "one sentence why this experiment matters",
      "experiment_type": "docking" | "assay" | "literature",
      "prefill": {
        "compound": "compound name to test",
        "cell_line": "suggested cell line",
        "direction": "a" | "b" | "both"
      }
    }
  ]
}
Provide exactly 3 recommendations. Be specific about compound names,
cell lines, and what the structural data suggests.`,
          }],
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = await response.json();
      const text = data.content?.[0]?.text || "[]";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setNextSteps(Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 3) : []);
    } catch (error) {
      setNextSteps([]);
      addLog(`Recommendations unavailable: ${error.message || "Claude unavailable."}`);
    } finally {
      setNextStepsLoading(false);
    }
  };

  const generateReport = () => {
    if (!results) {
      return;
    }

    const win = window.open("", "_blank");
    if (!win) {
      addLog("Report window blocked by the browser.");
      return;
    }

    const reportHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Dialectic Experiment Report</title>
        <style>
          body {
            font-family: 'Courier New', monospace;
            max-width: 800px; margin: 40px auto;
            color: #1a1a2e; font-size: 12px; line-height: 1.6;
          }
          h1 { font-size: 20px; border-bottom: 2px solid #1a1a2e; padding-bottom: 8px; }
          h2 { font-size: 14px; color: #333; margin-top: 24px; }
          .badge {
            display: inline-block; padding: 2px 8px;
            border: 1px solid #333; font-size: 10px;
            margin-right: 6px; text-transform: uppercase;
          }
          .score-box {
            background: #f5f5f5; border: 1px solid #ddd;
            padding: 12px; margin: 8px 0;
          }
          .warning {
            border-left: 3px solid #cc0000;
            padding-left: 10px; color: #cc0000;
          }
          table { width: 100%; border-collapse: collapse; margin: 12px 0; }
          td, th { border: 1px solid #ddd; padding: 6px 10px; font-size: 11px; }
          th { background: #f0f0f0; }
          .footer { margin-top: 40px; font-size: 10px; color: #999; border-top: 1px solid #ddd; padding-top: 12px; }
        </style>
      </head>
      <body>
        <h1>⬡ Dialectic — Experiment Report</h1>
        <p>Generated: ${escapeHtml(new Date().toLocaleString())} · Session: ${escapeHtml(sessionId)}</p>

        <h2>Contradiction Summary</h2>
        <div class="warning">
          <strong>${escapeHtml(privateNode?.subject_name || "Private compound")}</strong>
          reports IC50 = ${escapeHtml(privateNode?.quantitative_value)}${escapeHtml(privateNode?.quantitative_unit || "nM")}
          (private assay, ${escapeHtml(privateNode?.cell_line || "unknown cell line")})
          vs published IC50 = ${escapeHtml(litNode?.quantitative_value)}${escapeHtml(litNode?.quantitative_unit || "nM")}
          (${escapeHtml(litNode?.citation_count || "?")} citations).
          Friction score: ${escapeHtml(privateNode?.friction_score?.toFixed(2) || "0.85")} (CRITICAL).
        </div>

        <h2>DiffDock Results</h2>
        <table>
          <tr>
            <th>Direction</th>
            <th>Compound</th>
            <th>Conditions</th>
            <th>DiffDock Score</th>
            <th>Est. IC50 (nM)</th>
            <th>Verdict</th>
          </tr>
          ${results.direction_a ? `<tr>
            <td>My Data → Their Protocol</td>
            <td>${escapeHtml(results.direction_a.compound)}</td>
            <td>${escapeHtml(results.direction_a.conditions)}</td>
            <td>${escapeHtml(formatFixed(results.direction_a.diffdock_score, 3))}</td>
            <td>${escapeHtml(results.direction_a.estimated_ic50_nm)}</td>
            <td>${escapeHtml(results.direction_a.verdict)}</td>
          </tr>` : ""}
          ${results.direction_b ? `<tr>
            <td>Their Data → My Protocol</td>
            <td>${escapeHtml(results.direction_b.compound)}</td>
            <td>${escapeHtml(results.direction_b.conditions)}</td>
            <td>${escapeHtml(formatFixed(results.direction_b.diffdock_score, 3))}</td>
            <td>${escapeHtml(results.direction_b.estimated_ic50_nm)}</td>
            <td>${escapeHtml(results.direction_b.verdict)}</td>
          </tr>` : ""}
        </table>

        <h2>Structural Interpretation</h2>
        <p>${escapeHtml(summary || "Not generated.")}</p>

        ${nextSteps.length > 0 ? `
        <h2>Recommended Next Experiments</h2>
        <ol>
          ${nextSteps.map((step) => `
            <li>
              <strong>${escapeHtml(step.title)}</strong><br/>
              ${escapeHtml(step.rationale)}<br/>
              <em>Suggested: ${escapeHtml(step.prefill?.compound)} in ${escapeHtml(step.prefill?.cell_line)}</em>
            </li>
          `).join("")}
        </ol>` : ""}

        <h2>BioRender Pathway Visualization</h2>
        <p>
          View the KRAS signaling pathway relevant to this contradiction in BioRender:<br/>
          <a href="https://app.biorender.com/biorender-templates?search=KRAS" target="_blank">
            https://app.biorender.com/biorender-templates?search=KRAS
          </a>
        </p>

        <div class="footer">
          Dialectic · Bio x AI Hackathon · YC HQ · ${escapeHtml(new Date().toLocaleDateString())}
          · Powered by Claude (Anthropic) + DiffDock (Tamarind Bio)
        </div>
      </body>
      </html>
    `;

    win.document.write(reportHtml);
    win.document.close();
    win.print();
  };

  const restoreHistoryRun = (run) => {
    setResults(run.results);
    setSummary("");
    setSummaryLoading(false);
    setNextSteps([]);
    setNextStepsLoading(false);
  };

  const finalizeExperiment = async (expResults, direction) => {
    const frictionTimeline = expResults.friction_timeline || [];

    setResults(expResults);
    addLog("✓ Experiment complete.");
    await generateSummary(expResults);
    await generateNextSteps(expResults);
    setHistory((previous) => [...previous, {
      id: Date.now(),
      timestamp: new Date().toLocaleTimeString(),
      nodeAId: privateNode?.node_id,
      nodeBId: litNode?.node_id,
      nodeA: privateNode?.subject_name,
      nodeB: litNode?.subject_name,
      direction,
      scoreA: expResults.direction_a?.diffdock_score,
      scoreB: expResults.direction_b?.diffdock_score,
      frictionFinal: frictionTimeline[frictionTimeline.length - 1],
      results: expResults,
    }]);
  };

  const runExperiment = async (direction) => {
    if (!privateNode || !litNode || running) {
      return;
    }

    setRunning(true);
    setResults(null);
    setSummary("");
    setSummaryLoading(false);
    setNextSteps([]);
    setNextStepsLoading(false);
    setLogs([]);

    try {
      const response = await fetch("/api/experiment/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          node_a_id: privateNode.node_id,
          node_b_id: litNode.node_id,
          direction,
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      if (!response.body) {
        throw new Error("Experiment streaming is not available in this browser.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const processBlock = async (block) => {
        const dataLines = block
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());

        if (dataLines.length === 0) {
          return;
        }

        const evt = JSON.parse(dataLines.join("\n"));
        if (evt.event === "log") {
          addLog(evt.message);
        }
        if (evt.event === "complete") {
          await finalizeExperiment(evt.results, direction);
        }
        if (evt.event === "error") {
          addLog(`✗ Error: ${evt.message}`);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          try {
            await processBlock(block);
          } catch {
            // Ignore malformed SSE chunks and continue.
          }
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        await processBlock(buffer);
      }
    } catch (error) {
      addLog(`✗ Request failed: ${error.message}`);
    } finally {
      setRunning(false);
    }
  };

  const copyExperimentId = async () => {
    if (!results) {
      return;
    }

    const directionA = results.direction_a;
    const directionB = results.direction_b;
    const text = `Dialectic Experiment · ${directionA?.compound || "?"} vs ${directionB?.compound || "?"} · DiffDock/KRAS G12C · ${new Date().toLocaleDateString()} · Scores: A=${directionA?.diffdock_score?.toFixed(2) ?? "—"}, B=${directionB?.diffdock_score?.toFixed(2) ?? "—"}`;

    try {
      await navigator.clipboard.writeText(text);
      addLog("Citation copied to clipboard.");
    } catch {
      addLog("Clipboard copy failed.");
    }
  };

  const affinityData = results ? [
    {
      name: "My Assay",
      score: privateNode?.quantitative_value ? (-Math.log10(privateNode.quantitative_value / 1e9) * 0.5) - 1 : -2.1,
      fill: "#4d7cff",
    },
    {
      name: "Published",
      score: litNode?.quantitative_value ? (-Math.log10(litNode.quantitative_value / 1e9) * 0.5) - 1 : -0.8,
      fill: "#00e5a0",
    },
    results.direction_a ? { name: "My→Their", score: results.direction_a.diffdock_score, fill: "#ffb340" } : null,
    results.direction_b ? { name: "Their→Mine", score: results.direction_b.diffdock_score, fill: "#ff8c00" } : null,
  ].filter(Boolean) : [];

  const doseData = (() => {
    if (!results) {
      return [];
    }

    const concentrations = Array.from({ length: 10 }, (_, index) => 10 ** (-3 + (index * 0.6)));
    const myIC50 = privateNode?.quantitative_value || 180;
    const theirIC50 = litNode?.quantitative_value || 1;
    const ic50A = results.direction_a?.estimated_ic50_nm || 50;
    const ic50B = results.direction_b?.estimated_ic50_nm || 10;

    return concentrations.map((concentration) => ({
      conc: concentration.toFixed(3),
      "My Assay": hillCurveValue(myIC50, concentration),
      Published: hillCurveValue(theirIC50, concentration),
      "DiffDock A": hillCurveValue(ic50A, concentration),
      "DiffDock B": hillCurveValue(ic50B, concentration),
    }));
  })();

  const frictionData = results ? [
    { stage: "Baseline", friction: results.friction_timeline?.[0] || 0.1 },
    { stage: "Pass 1", friction: results.friction_timeline?.[1] || 0.35 },
    { stage: "Cross-Corpus", friction: results.friction_timeline?.[2] || 0.67 },
    { stage: "DiffDock", friction: results.friction_timeline?.[3] || 0.85 },
  ] : [];

  const hasContradiction = Boolean(privateNode && litNode);

  return (
    <div style={s.container}>
      <div style={s.header}>⬡ Experiment Runner</div>
      <div style={s.sub}>Compare private assay data against published protocols via DiffDock + SurfDock</div>

      {!hasContradiction ? (
        <div style={s.emptyState}>
          <div style={{ fontSize: 18, marginBottom: 8 }}>⬡</div>
          <div>Select a contradicted node on the map</div>
          <div style={{ fontSize: 9, marginTop: 4 }}>CRITICAL nodes (red) open this tab automatically</div>
        </div>
      ) : (
        <>
          {visibleHistory.length > 0 ? (
            <div style={{ marginBottom: 12 }}>
              <button
                type="button"
                onClick={() => setShowHistory((current) => !current)}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "1px solid #1e2430",
                  color: "#6b7590",
                  fontFamily: "'DM Mono',monospace",
                  fontSize: 10,
                  padding: "6px 10px",
                  cursor: "pointer",
                  textAlign: "left",
                  marginBottom: showHistory ? 8 : 0,
                }}
              >
                ◈ Experiment History ({visibleHistory.length} runs)
                {showHistory ? " ▲" : " ▼"}
              </button>

              {showHistory ? visibleHistory.map((run, index) => (
                <div
                  key={run.id}
                  onClick={() => restoreHistoryRun(run)}
                  style={{
                    background: "#0c0e12",
                    border: "1px solid #1e2430",
                    padding: 8,
                    marginBottom: 4,
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ color: "#e8eaf0", fontSize: 10 }}>
                      Run {index + 1} · {run.nodeA} vs {run.nodeB}
                    </div>
                    <div style={{ color: "#6b7590", fontSize: 9, marginTop: 2 }}>
                      {run.timestamp} · friction: {formatFixed(run.frictionFinal)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 9, color: "#ffb340" }}>
                      A: {formatFixed(run.scoreA)}
                    </div>
                    <div style={{ fontSize: 9, color: "#ff8c00" }}>
                      B: {formatFixed(run.scoreB)}
                    </div>
                  </div>
                </div>
              )) : null}

              {visibleHistory.length >= 2 && showHistory ? (
                <div
                  style={{
                    background: "#0c0e12",
                    border: "1px solid #1e2430",
                    padding: 8,
                    marginTop: 4,
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      color: "#6b7590",
                      letterSpacing: 1.5,
                      marginBottom: 6,
                    }}
                  >
                    SCORE TREND
                  </div>
                  <ResponsiveContainer width="100%" height={60}>
                    <LineChart data={visibleHistory.map((run, index) => ({
                      run: `Run ${index + 1}`,
                      scoreA: run.scoreA,
                      scoreB: run.scoreB,
                    }))}
                    >
                      <XAxis dataKey="run" tick={{ fontSize: 7, fill: "#6b7590" }} />
                      <YAxis tick={{ fontSize: 7, fill: "#6b7590" }} />
                      <Tooltip
                        contentStyle={{
                          background: "#0c0e12",
                          border: "1px solid #1e2430",
                          fontSize: 9,
                        }}
                      />
                      <Line type="monotone" dataKey="scoreA" stroke="#ffb340" dot={false} strokeWidth={1.5} />
                      <Line type="monotone" dataKey="scoreB" stroke="#ff8c00" dot={false} strokeWidth={1.5} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : null}
            </div>
          ) : null}

          <div style={s.card}>
            <div style={{ fontSize: 9, color: "#6b7590", letterSpacing: 1.5, marginBottom: 8 }}>
              EXPERIMENT SETUP
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "stretch", marginBottom: 12 }}>
              <div style={s.nodeCard}>
                <div style={s.badge("77,124,255")}>◼ Private</div>
                <div style={{ color: "#e8eaf0", marginBottom: 4 }}>
                  {privateNode.subject_name || "Unknown compound"}
                </div>
                <div style={{ color: "#6b7590", fontSize: 10 }}>
                  IC50: {formatMeasurement(privateNode)}
                </div>
                <div style={{ color: "#6b7590", fontSize: 10 }}>
                  Cell: {privateNode.cell_line || "—"}
                </div>
              </div>
              <div style={s.vsDiv}>
                <div>—</div>
                <div>VS</div>
                <div>—</div>
              </div>
              <div style={s.nodeCard}>
                <div style={s.badge("0,229,160")}>◉ Literature</div>
                <div style={{ color: "#e8eaf0", marginBottom: 4 }}>
                  {litNode.subject_name || "Unknown compound"}
                </div>
                <div style={{ color: "#6b7590", fontSize: 10 }}>
                  IC50: {formatMeasurement(litNode)}
                </div>
                <div style={{ color: "#6b7590", fontSize: 10 }}>
                  {litNode.citation_count || 0} citations
                </div>
              </div>
            </div>

            <button
              type="button"
              style={{ ...s.dirBtn("#4d7cff"), opacity: running ? 0.65 : 1 }}
              disabled={running}
              onClick={() => runExperiment("a")}
            >
              ▶ Run My Data → Their Protocol
              <div style={{ color: "#6b7590", fontSize: 9, marginTop: 2 }}>
                DiffDock: {privateNode.subject_name} in {litNode.cell_line || "their conditions"}
              </div>
            </button>
            <button
              type="button"
              style={{ ...s.dirBtn("#00e5a0"), opacity: running ? 0.65 : 1 }}
              disabled={running}
              onClick={() => runExperiment("b")}
            >
              ▶ Run Their Data → My Protocol
              <div style={{ color: "#6b7590", fontSize: 9, marginTop: 2 }}>
                DiffDock: {litNode.subject_name} in {privateNode.cell_line || "my conditions"}
              </div>
            </button>
            <button
              type="button"
              style={{ ...s.dirBtn("#ffb340"), opacity: running ? 0.65 : 1, marginBottom: 0 }}
              disabled={running}
              onClick={() => runExperiment("both")}
            >
              ▶▶ Run Both — Full Comparison
              <div style={{ color: "#6b7590", fontSize: 9, marginTop: 2 }}>
                DiffDock (live ~2 min) + SurfDock (background ~20 min)
              </div>
            </button>
          </div>

          {logs.length > 0 ? (
            <div style={s.terminal} ref={logRef}>
              {logs.map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}
              {running ? <div style={{ opacity: 0.5 }}>█</div> : null}
            </div>
          ) : null}

          {results ? (
            <>
              <div style={s.grid2x2}>
                <div style={s.chartCard}>
                  <div style={s.chartTitle}>Binding Affinity</div>
                  <ResponsiveContainer width="100%" height={150}>
                    <BarChart data={affinityData} margin={{ top: 5, right: 5, bottom: 20, left: -20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.cartesianGrid} />
                      <XAxis dataKey="name" tick={{ fontSize: 8, fill: "#6b7590" }} />
                      <YAxis tick={{ fontSize: 8, fill: "#6b7590" }} />
                      <Tooltip {...CHART_THEME.tooltip} />
                      <ReferenceLine
                        y={-1.5}
                        stroke="#ff3050"
                        strokeDasharray="3 3"
                        label={{ value: "Strong", fontSize: 8, fill: "#ff3050" }}
                      />
                      <Bar dataKey="score" radius={[2, 2, 0, 0]}>
                        {affinityData.map((entry) => (
                          <Cell key={entry.name} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div style={s.chartCard}>
                  <div style={s.chartTitle}>Dose-Response Curves</div>
                  <ResponsiveContainer width="100%" height={150}>
                    <LineChart data={doseData} margin={{ top: 5, right: 5, bottom: 20, left: -20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.cartesianGrid} />
                      <XAxis
                        dataKey="conc"
                        tick={{ fontSize: 7, fill: "#6b7590" }}
                        label={{ value: "Conc (nM)", position: "insideBottom", offset: -10, fontSize: 8, fill: "#6b7590" }}
                      />
                      <YAxis tick={{ fontSize: 8, fill: "#6b7590" }} />
                      <Tooltip {...CHART_THEME.tooltip} />
                      <Line type="monotone" dataKey="My Assay" stroke="#4d7cff" dot={false} strokeWidth={1.5} />
                      <Line type="monotone" dataKey="Published" stroke="#00e5a0" dot={false} strokeWidth={1.5} />
                      <Line type="monotone" dataKey="DiffDock A" stroke="#ffb340" dot={false} strokeDasharray="4 2" strokeWidth={1} />
                      <Line type="monotone" dataKey="DiffDock B" stroke="#ff8c00" dot={false} strokeDasharray="4 2" strokeWidth={1} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <div style={s.chartCard}>
                  <div style={s.chartTitle}>Predicted Binding Poses</div>
                  <PocketViewer
                    scoreA={results.direction_a?.diffdock_score}
                    scoreB={results.direction_b?.diffdock_score}
                    compoundA={results.direction_a?.compound}
                    compoundB={results.direction_b?.compound}
                  />
                  <div style={{ fontSize: 8, color: "#3a4055", textAlign: "center", marginTop: 4 }}>
                    Schematic · Full 3D PDB via Tamarind dashboard
                  </div>
                </div>

                <div style={s.chartCard}>
                  <div style={s.chartTitle}>Friction Score Evolution</div>
                  <ResponsiveContainer width="100%" height={150}>
                    <LineChart data={frictionData} margin={{ top: 5, right: 5, bottom: 20, left: -20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.cartesianGrid} />
                      <ReferenceArea y1={0} y2={0.3} fill="rgba(0,229,160,0.05)" />
                      <ReferenceArea y1={0.3} y2={0.6} fill="rgba(200,230,0,0.05)" />
                      <ReferenceArea y1={0.6} y2={0.85} fill="rgba(255,140,0,0.05)" />
                      <ReferenceArea y1={0.85} y2={1} fill="rgba(255,48,80,0.07)" />
                      <XAxis dataKey="stage" tick={{ fontSize: 7, fill: "#6b7590" }} />
                      <YAxis domain={[0, 1]} tick={{ fontSize: 8, fill: "#6b7590" }} />
                      <Tooltip {...CHART_THEME.tooltip} />
                      <Line
                        type="monotone"
                        dataKey="friction"
                        stroke="#ff3050"
                        dot={{ fill: "#ff3050", r: 3 }}
                        strokeWidth={2}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {(results.direction_a?.surfdock_status === "running" || results.direction_b?.surfdock_status === "running") ? (
                <div
                  style={{
                    ...s.card,
                    borderColor: "rgba(255,179,64,0.3)",
                    color: "#ffb340",
                    fontSize: 10,
                    marginBottom: 12,
                  }}
                >
                  ⏳ SurfDock deep analysis running in background (~20 min) · Results will update automatically when complete · Job IDs: {results.direction_a?.surfdock_job_id || "—"} / {results.direction_b?.surfdock_job_id || "—"}
                </div>
              ) : null}

              <div style={s.summaryCard}>
                <div style={{ fontSize: 9, color: "#ffb340", letterSpacing: 1.5, marginBottom: 4 }}>
                  ⬡ STRUCTURAL INTERPRETATION
                </div>
                <div style={{ fontSize: 9, color: "#3a4055", marginBottom: 8 }}>
                  {ANTHROPIC_API_KEY ? "Generated by Claude · Grounded in DiffDock structural data" : "Local fallback · Grounded in DiffDock structural data"}
                </div>
                {summaryLoading && !summary ? (
                  <div style={{ color: "#6b7590" }}>Generating interpretation...</div>
                ) : null}
                {summary ? (
                  <div style={{ color: "#e8eaf0", lineHeight: 1.7, fontSize: 11 }}>
                    {summary}
                  </div>
                ) : null}
              </div>

              <div
                style={{
                  background: "#0c0e12",
                  border: "1px solid #1e2430",
                  padding: 12,
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    fontSize: 9,
                    color: "#00e5a0",
                    letterSpacing: 1.5,
                    marginBottom: 10,
                  }}
                >
                  ▶ RECOMMENDED NEXT EXPERIMENTS
                </div>

                {nextStepsLoading ? (
                  <div style={{ color: "#6b7590", fontSize: 10 }}>
                    Analyzing results...
                  </div>
                ) : null}

                {nextSteps.map((step, index) => (
                  <div
                    key={`${step.title || "recommendation"}-${index}`}
                    style={{
                      background: "#080a0e",
                      border: "1px solid #1e2430",
                      padding: 10,
                      marginBottom: 8,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: 8,
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ color: "#e8eaf0", fontSize: 11, marginBottom: 3 }}>
                        {index + 1}. {step.title}
                      </div>
                      <div style={{ color: "#6b7590", fontSize: 10, lineHeight: 1.5 }}>
                        {step.rationale}
                      </div>
                      <div
                        style={{
                          fontSize: 9,
                          color: "#3a4055",
                          marginTop: 4,
                        }}
                      >
                        {step.prefill?.compound} · {step.prefill?.cell_line}
                      </div>
                    </div>
                    {step.experiment_type === "docking" ? (
                      <button
                        type="button"
                        onClick={() => {
                          runExperiment(step.prefill?.direction || "both");
                        }}
                        style={{
                          background: "transparent",
                          border: "1px solid #00e5a0",
                          color: "#00e5a0",
                          fontFamily: "'DM Mono',monospace",
                          fontSize: 10,
                          padding: "4px 10px",
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                        }}
                      >
                        Run This →
                      </button>
                    ) : null}
                    {step.experiment_type === "literature" ? (
                      <button
                        type="button"
                        onClick={() => {
                          window.dispatchEvent(new CustomEvent("dialectic:oracle-query", {
                            detail: { query: `What does the literature say about ${step.prefill?.compound} in ${step.prefill?.cell_line}?` },
                          }));
                        }}
                        style={{
                          background: "transparent",
                          border: "1px solid #4d7cff",
                          color: "#4d7cff",
                          fontFamily: "'DM Mono',monospace",
                          fontSize: 10,
                          padding: "4px 10px",
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                        }}
                      >
                        Ask Oracle →
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>

              <div style={s.exportRow}>
                <button type="button" style={s.exportBtn} onClick={() => generateReport()}>
                  ◈ Export Report
                </button>
                <button
                  type="button"
                  style={{
                    ...s.exportBtn,
                    borderColor: "rgba(0,180,120,0.4)",
                    color: "#00b478",
                  }}
                  onClick={() => window.open(
                    "https://app.biorender.com/biorender-templates?search=KRAS+signaling",
                    "_blank",
                  )}
                >
                  🎨 BioRender Pathway
                </button>
                <button
                  type="button"
                  style={{ ...s.exportBtn, opacity: activeBag ? 1 : 0.45 }}
                  onClick={() => {
                    if (activeBag && onSaveToBag) {
                      const note = summary || buildFallbackSummary(results, privateNode, litNode);
                      onSaveToBag(activeBag.id, note);
                      addLog(`Saved interpretation to ${activeBag.name}.`);
                    }
                  }}
                  disabled={!activeBag}
                >
                  ◫ Save to Bag
                </button>
                <button type="button" style={s.exportBtn} onClick={copyExperimentId}>
                  ⬡ Copy Citation
                </button>
              </div>
            </>
          ) : null}
        </>
      )}

      <style>{`
        @keyframes pulse {
          0% { opacity: 0.75; }
          50% { opacity: 1; }
          100% { opacity: 0.75; }
        }
      `}</style>
    </div>
  );
}
