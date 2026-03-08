export default function SchemaPreview({ data }) {
  if (!data?.column_mapping) {
    return null;
  }

  const entries = Object.entries(data.column_mapping);

  return (
    <div
      style={{
        marginTop: 16,
        border: "1px solid #1e2430",
        background: "#050608",
        padding: "12px",
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: 2,
          textTransform: "uppercase",
          color: "#3a4055",
          marginBottom: 10,
        }}
      >
        Schema Agent Mapping
      </div>
      {entries.map(([columnName, info]) => (
        <div
          key={columnName}
          style={{
            display: "flex",
            gap: 8,
            padding: "3px 0",
            borderBottom: "1px solid rgba(30,36,48,0.5)",
            fontSize: 11,
            alignItems: "center",
          }}
        >
          <span
            style={{
              color: "#6b7590",
              minWidth: 120,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {columnName}
          </span>
          <span style={{ color: "#3a4055" }}>-&gt;</span>
          <span style={{ color: info.semantic_role === "unmapped" ? "#3a4055" : "#00e5a0" }}>
            {info.semantic_role}
          </span>
          <span style={{ marginLeft: "auto", color: "#3a4055", fontSize: 10 }}>
            {info.confidence ? `${(info.confidence * 100).toFixed(0)}%` : ""}
          </span>
        </div>
      ))}
      {data.warnings?.length > 0 ? (
        <div style={{ marginTop: 8, fontSize: 10, color: "#ffb340" }}>
          WARNING: {data.warnings[0]}
        </div>
      ) : null}
    </div>
  );
}
