import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { analyzeSchema, pollStatus, startIngest } from "../api/client";
import SchemaPreview from "../components/SchemaPreview";

const DEMO_SESSION_ID = "55500fc5f1654234b44f5d61182cf924";

function parseCsvPreview(text, rowLimit = 10) {
  const rows = [];
  let currentField = "";
  let currentRow = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(currentField);
      currentField = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      currentRow.push(currentField);
      currentField = "";
      if (currentRow.some((value) => value.trim() !== "")) {
        rows.push(currentRow);
      }
      currentRow = [];
      if (rows.length > rowLimit) {
        break;
      }
      continue;
    }

    currentField += char;
  }

  if (currentField || currentRow.length) {
    currentRow.push(currentField);
    if (currentRow.some((value) => value.trim() !== "")) {
      rows.push(currentRow);
    }
  }

  if (!rows.length) {
    return { headers: [], sampleRows: [] };
  }

  const headers = rows[0].map((header) => header.trim().replace(/^"|"$/g, ""));
  const sampleRows = rows.slice(1, rowLimit + 1).map((row) => (
    Object.fromEntries(
      headers.map((header, columnIndex) => [
        header,
        (row[columnIndex] ?? "").trim().replace(/^"|"$/g, ""),
      ]),
    )
  ));

  return { headers, sampleRows };
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export default function UploadLanding() {
  const navigate = useNavigate();
  const csvInputRef = useRef(null);
  const [csvFile, setCsvFile] = useState(null);
  const [csvDragOver, setCsvDragOver] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [paperCount, setPaperCount] = useState(100);
  const [semanticFocus, setSemanticFocus] = useState("mechanism_of_action");
  const [schemaData, setSchemaData] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState(null);

  const handleCsvFile = useCallback(async (file) => {
    if (!file) {
      return;
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Only CSV files are supported.");
      return;
    }

    setError(null);
    setCsvFile(file);
    setIsAnalyzing(true);
    setSchemaData(null);

    try {
      const text = await file.text();
      const { headers, sampleRows } = parseCsvPreview(text);

      if (!headers.length) {
        throw new Error("The selected file does not contain readable CSV headers.");
      }

      const result = await analyzeSchema(headers, sampleRows, file.name);
      setSchemaData(result);
    } catch (analysisError) {
      setError(`Schema analysis failed: ${getErrorMessage(analysisError)}`);
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  const handleDrop = useCallback((event) => {
    event.preventDefault();
    setCsvDragOver(false);
    void handleCsvFile(event.dataTransfer.files?.[0]);
  }, [handleCsvFile]);

  const handleRun = useCallback(async () => {
    if (!csvFile && searchQuery.trim().length < 3) {
      setError("Provide a CSV file or a search query.");
      return;
    }

    setError(null);
    setIsRunning(true);
    setProgress(5);
    setStatusText("Starting ingestion pipeline...");

    try {
      const formData = new FormData();
      if (csvFile) {
        formData.append("csv", csvFile);
      }
      formData.append("search_query", searchQuery.trim());
      formData.append("paper_count", String(paperCount));
      formData.append("semantic_focus", semanticFocus);

      const { session_id: sessionId } = await startIngest(formData);
      setStatusText("Fetching papers and extracting claims...");

      const statusLabels = {
        queued: "Queued for ingestion...",
        ingesting: "Fetching papers and extracting claims...",
        embedding: "Embedding with polarity shift...",
        debating: "Running Actor/Critic debate pipeline...",
        finalizing: "Finalizing contradictions and layout...",
        ready: "Complete. Loading map...",
      };

      await pollStatus(sessionId, (data) => {
        setProgress(Math.max(5, data.progress ?? 0));
        setStatusText(statusLabels[data.status] ?? data.status ?? "Working...");
        if (data.status === "error") {
          throw new Error(data.error_message ?? "Pipeline failed.");
        }
      });

      setProgress(100);
      setStatusText("Ready.");
      window.setTimeout(() => navigate(`/map/${sessionId}`), 400);
    } catch (runError) {
      setError(getErrorMessage(runError));
      setIsRunning(false);
      setProgress(0);
      setStatusText("");
    }
  }, [csvFile, navigate, paperCount, searchQuery, semanticFocus]);

  const canRun = Boolean(csvFile || searchQuery.trim().length >= 3) && !isRunning;

  return (
    <div style={styles.page}>
      <div style={styles.gridBg} />

      <header style={styles.header}>
        <div style={styles.logo}>
          <div style={styles.logoMark} />
          <span style={styles.logoText}>
            Dia<span style={{ color: "#00e5a0" }}>lectic</span>
          </span>
        </div>
        <span style={styles.headerBadge}>EPISTEMIC RISK PLATFORM / BETA</span>
      </header>

      <div style={styles.hero}>
        <div style={styles.heroTag}>Bio x AI / Target Validation</div>
        <h1 style={styles.heroTitle}>
          Find contradictions
          <br />
          <span style={styles.heroSub}>before Phase I finds them for you</span>
        </h1>
        <p style={styles.heroDesc}>
          Upload private assay data. Pull public literature. Dialectic maps every claim,
          debates every contradiction, and tells you exactly why your target is risky.
        </p>
      </div>

      <div style={styles.uploadGrid}>
        <div
          style={{
            ...styles.panel,
            ...(csvDragOver ? styles.panelHover : null),
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setCsvDragOver(true);
          }}
          onDragLeave={() => setCsvDragOver(false)}
          onDrop={handleDrop}
        >
          <div style={styles.panelBadge("#4d7cff")}>PRIVATE / CSV</div>
          <div style={styles.panelTitle}>Lab Data</div>
          <div style={styles.panelDesc}>
            Upload your proprietary assay results. The Schema Agent auto-maps
            columns to biological roles.
          </div>

          <div
            style={{
              ...styles.dropzone,
              borderColor: csvDragOver ? "#4d7cff" : "#1e2430",
            }}
            onClick={() => csvInputRef.current?.click()}
          >
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              onChange={(event) => {
                if (event.target.files?.[0]) {
                  void handleCsvFile(event.target.files[0]);
                }
              }}
            />

            {isAnalyzing ? (
              <div style={styles.analyzing}>
                <div style={styles.spinner} />
                Analyzing columns...
              </div>
            ) : null}

            {!isAnalyzing && csvFile ? (
              <div style={styles.fileTag}>
                <span style={styles.fileTagName}>CSV {csvFile.name}</span>
                <button
                  type="button"
                  style={styles.removeBtn}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCsvFile(null);
                    setSchemaData(null);
                    setError(null);
                  }}
                >
                  x
                </button>
              </div>
            ) : null}

            {!isAnalyzing && !csvFile ? (
              <>
                <div style={styles.dropIcon}>UPLOAD</div>
                <div style={styles.dropText}>Drop CSV or click to upload</div>
                <div style={styles.dropSub}>Any column naming / UTF-8</div>
              </>
            ) : null}
          </div>

          {schemaData ? <SchemaPreview data={schemaData} /> : null}
        </div>

        <div style={styles.panel}>
          <div style={styles.panelBadge("#ffb340")}>PUBLIC / SEMANTIC SCHOLAR</div>
          <div style={styles.panelTitle}>Literature</div>
          <div style={styles.panelDesc}>
            Search published papers. Claims are extracted from every abstract
            and cross-debated against your private data.
          </div>

          <div style={styles.searchRow}>
            <input
              style={styles.searchInput}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canRun) {
                  void handleRun();
                }
              }}
              placeholder="e.g. KRAS G12C AMG-510 ERK MAPK resistance"
            />
          </div>

          <div style={styles.sliderRow}>
            <span style={styles.sliderLabel}>
              Papers: <b style={{ color: "#ffb340" }}>{paperCount}</b>
            </span>
            <input
              type="range"
              min="20"
              max="500"
              step="10"
              value={paperCount}
              onChange={(event) => setPaperCount(Number(event.target.value))}
              style={styles.slider}
            />
          </div>

          <div style={styles.examples}>
            {[
              "KRAS G12C AMG-510 MRTX849 ERK MAPK",
              "TP53 R175H gain-of-function oncogenesis",
              "EGFR T790M osimertinib resistance",
            ].map((query) => (
              <button
                key={query}
                type="button"
                style={styles.exampleBtn}
                onClick={() => setSearchQuery(query)}
              >
                - {query}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={styles.configRow}>
        <span style={styles.configLabel}>Semantic Focus</span>
        <select
          style={styles.select}
          value={semanticFocus}
          onChange={(event) => setSemanticFocus(event.target.value)}
        >
          <option value="mechanism_of_action">Mechanism of Action</option>
          <option value="phenotypic_results">Phenotypic Results</option>
          <option value="safety_toxicity">Safety / Toxicity</option>
          <option value="biomarker">Biomarker</option>
          <option value="structural">Structural Biology</option>
        </select>
        <span style={{ ...styles.configLabel, marginLeft: 32 }}>Arbiter</span>
        <span style={styles.configValueAccent}>Tamarind Bio</span>
        <span style={{ ...styles.configLabel, marginLeft: 32 }}>Embeddings</span>
        <span style={styles.configValueMuted}>text-embedding-3-small + Polarity Shift</span>
      </div>

      {isRunning ? (
        <div style={styles.progressWrap}>
          <div style={styles.progressBar}>
            <div
              style={{
                ...styles.progressFill,
                width: `${progress}%`,
              }}
            />
          </div>
          <div style={styles.progressText}>
            {statusText} ({progress}%)
          </div>
        </div>
      ) : null}

      {error ? <div style={styles.errorBox}>{error}</div> : null}

      <div style={styles.ctaRow}>
        <button
          type="button"
          style={{
            ...styles.btnPrimary,
            opacity: canRun ? 1 : 0.4,
            cursor: canRun ? "pointer" : "not-allowed",
          }}
          disabled={!canRun}
          onClick={() => void handleRun()}
        >
          {isRunning ? (
            <>
              <div style={styles.spinnerDark} />
              Running...
            </>
          ) : (
            "RUN EPISTEMIC ANALYSIS ->"
          )}
        </button>
        <button
          type="button"
          style={styles.btnSecondary}
          onClick={() => navigate(`/map/${DEMO_SESSION_ID}`)}
        >
          Load Demo Session
        </button>
      </div>

      <div style={{ height: 60 }} />
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#050608",
    color: "#e8eaf0",
    fontFamily: "'DM Mono', monospace",
    position: "relative",
    overflowX: "hidden",
  },
  gridBg: {
    position: "fixed",
    inset: 0,
    zIndex: 0,
    pointerEvents: "none",
    backgroundImage:
      "linear-gradient(rgba(77,124,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(77,124,255,0.03) 1px,transparent 1px)",
    backgroundSize: "40px 40px",
  },
  header: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "18px 40px",
    borderBottom: "1px solid #1e2430",
    background: "rgba(5,6,8,0.9)",
    flexWrap: "wrap",
  },
  logo: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  logoMark: {
    width: 24,
    height: 24,
    border: "1.5px solid #00e5a0",
    transform: "rotate(45deg)",
  },
  logoText: {
    fontFamily: "'Syne', sans-serif",
    fontWeight: 800,
    fontSize: 20,
  },
  headerBadge: {
    fontSize: 10,
    letterSpacing: 2,
    color: "#3a4055",
    border: "1px solid #1e2430",
    padding: "4px 10px",
  },
  hero: {
    position: "relative",
    zIndex: 1,
    maxWidth: 800,
    margin: "0 auto",
    padding: "64px 40px 48px",
    textAlign: "center",
  },
  heroTag: {
    display: "inline-block",
    fontSize: 10,
    letterSpacing: 3,
    textTransform: "uppercase",
    color: "#00e5a0",
    border: "1px solid rgba(0,229,160,0.2)",
    padding: "5px 14px",
    marginBottom: 24,
    background: "rgba(0,229,160,0.04)",
  },
  heroTitle: {
    fontFamily: "'Syne', sans-serif",
    fontSize: "clamp(32px, 5vw, 56px)",
    fontWeight: 800,
    lineHeight: 1.05,
    letterSpacing: -2,
    marginBottom: 16,
  },
  heroSub: {
    fontFamily: "'DM Mono', monospace",
    fontSize: "0.45em",
    color: "#6b7590",
    fontWeight: 400,
    letterSpacing: 0,
  },
  heroDesc: {
    fontSize: 13,
    color: "#6b7590",
    lineHeight: 1.7,
    maxWidth: 520,
    margin: "0 auto",
  },
  uploadGrid: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 1,
    maxWidth: 960,
    margin: "0 auto",
    background: "#1e2430",
  },
  panel: {
    background: "#0c0e12",
    padding: 32,
    transition: "background 0.2s",
    minWidth: 0,
  },
  panelHover: {
    background: "#13161c",
  },
  panelBadge: (color) => ({
    display: "inline-block",
    fontSize: 9,
    letterSpacing: 2,
    textTransform: "uppercase",
    color,
    border: `1px solid ${color}33`,
    padding: "3px 8px",
    marginBottom: 12,
  }),
  panelTitle: {
    fontFamily: "'Syne', sans-serif",
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 8,
  },
  panelDesc: {
    fontSize: 12,
    color: "#6b7590",
    lineHeight: 1.6,
    marginBottom: 20,
  },
  dropzone: {
    border: "1px dashed #1e2430",
    padding: "28px 20px",
    textAlign: "center",
    cursor: "pointer",
    transition: "border-color 0.2s",
    minHeight: 152,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
  },
  dropIcon: {
    fontSize: 12,
    marginBottom: 10,
    opacity: 0.6,
    letterSpacing: 2,
  },
  dropText: {
    fontSize: 12,
    color: "#6b7590",
    marginBottom: 4,
  },
  dropSub: {
    fontSize: 10,
    color: "#3a4055",
    letterSpacing: 1,
  },
  analyzing: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    justifyContent: "center",
    fontSize: 12,
    color: "#4d7cff",
  },
  fileTag: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    background: "rgba(77,124,255,0.08)",
    border: "1px solid rgba(77,124,255,0.2)",
    padding: "8px 12px",
    fontSize: 11,
    color: "#4d7cff",
  },
  fileTagName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  removeBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#ff3b5c",
    fontSize: 16,
    lineHeight: 1,
    padding: 0,
  },
  searchRow: {
    marginBottom: 12,
  },
  searchInput: {
    width: "100%",
    background: "#050608",
    border: "1px solid #1e2430",
    color: "#e8eaf0",
    fontFamily: "'DM Mono', monospace",
    fontSize: 13,
    padding: "11px 14px",
    outline: "none",
  },
  sliderRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  sliderLabel: {
    fontSize: 11,
    color: "#6b7590",
    whiteSpace: "nowrap",
  },
  slider: {
    flex: 1,
    accentColor: "#ffb340",
  },
  examples: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  exampleBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#3a4055",
    fontSize: 11,
    textAlign: "left",
    fontFamily: "'DM Mono', monospace",
    padding: "3px 0",
  },
  configRow: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: 12,
    maxWidth: 960,
    margin: "0 auto",
    background: "#0c0e12",
    borderTop: "1px solid #1e2430",
    borderLeft: "1px solid #1e2430",
    borderRight: "1px solid #1e2430",
    padding: "14px 24px",
    flexWrap: "wrap",
  },
  configLabel: {
    fontSize: 10,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: "#3a4055",
    whiteSpace: "nowrap",
  },
  configValueAccent: {
    color: "#00e5a0",
    fontSize: 12,
  },
  configValueMuted: {
    color: "#6b7590",
    fontSize: 12,
  },
  select: {
    background: "#050608",
    border: "1px solid #1e2430",
    color: "#e8eaf0",
    fontFamily: "'DM Mono', monospace",
    fontSize: 12,
    padding: "6px 10px",
    outline: "none",
  },
  progressWrap: {
    position: "relative",
    zIndex: 1,
    maxWidth: 960,
    margin: "0 auto",
    padding: "16px 0 0",
  },
  progressBar: {
    height: 2,
    background: "#1e2430",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "#00e5a0",
    transition: "width 0.4s ease",
    boxShadow: "0 0 8px #00e5a0",
  },
  progressText: {
    fontSize: 11,
    color: "#6b7590",
    textAlign: "center",
    marginTop: 8,
  },
  errorBox: {
    position: "relative",
    zIndex: 1,
    maxWidth: 960,
    margin: "12px auto 0",
    background: "rgba(255,59,92,0.08)",
    border: "1px solid rgba(255,59,92,0.3)",
    color: "#ff3b5c",
    padding: "10px 16px",
    fontSize: 12,
  },
  ctaRow: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: "28px 20px 0",
    flexWrap: "wrap",
  },
  btnPrimary: {
    background: "#00e5a0",
    color: "#000",
    border: "none",
    fontFamily: "'Syne', sans-serif",
    fontWeight: 700,
    fontSize: 13,
    letterSpacing: 1,
    textTransform: "uppercase",
    padding: "15px 44px",
    display: "flex",
    alignItems: "center",
    gap: 8,
    transition: "all 0.2s",
  },
  btnSecondary: {
    background: "transparent",
    color: "#6b7590",
    border: "1px solid #1e2430",
    cursor: "pointer",
    fontFamily: "'DM Mono', monospace",
    fontSize: 12,
    padding: "15px 20px",
  },
  spinner: {
    width: 12,
    height: 12,
    border: "1.5px solid #1e2430",
    borderTopColor: "#4d7cff",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  spinnerDark: {
    width: 12,
    height: 12,
    border: "1.5px solid rgba(0,0,0,0.2)",
    borderTopColor: "#000",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
};
