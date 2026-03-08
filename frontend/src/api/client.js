const BASE = "/api";

async function parseJsonResponse(response, fallbackMessage) {
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof payload === "string"
      ? payload
      : payload?.detail || payload?.error || fallbackMessage;
    throw new Error(message);
  }

  return payload;
}

export async function analyzeSchema(headers, sampleRows, fileName) {
  const response = await fetch(`${BASE}/schema-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      headers,
      sample_rows: sampleRows,
      file_name: fileName,
    }),
  });

  return parseJsonResponse(response, `Schema agent failed: ${response.status}`);
}

export async function startIngest(formData) {
  const response = await fetch(`${BASE}/ingest`, {
    method: "POST",
    body: formData,
  });

  return parseJsonResponse(response, `Ingest failed: ${response.status}`);
}

export function pollStatus(sessionId, onUpdate, intervalMs = 2000) {
  return new Promise((resolve, reject) => {
    let timeoutId = null;

    const tick = async () => {
      try {
        const response = await fetch(`${BASE}/session/${sessionId}/status`);
        const data = await parseJsonResponse(response, `Status check failed: ${response.status}`);

        onUpdate?.(data);

        if (data.status === "ready") {
          resolve(data);
          return;
        }

        if (data.status === "error") {
          reject(new Error(data.error_message ?? "Pipeline error"));
          return;
        }

        timeoutId = globalThis.setTimeout(tick, intervalMs);
      } catch (error) {
        if (timeoutId) {
          globalThis.clearTimeout(timeoutId);
        }
        reject(error);
      }
    };

    void tick();
  });
}

export async function getSessionNodes(sessionId) {
  const response = await fetch(`${BASE}/session/${sessionId}/nodes`);
  return parseJsonResponse(response, `Failed to load nodes: ${response.status}`);
}

export async function streamOracle(sessionId, selectedNodeIds, messages, bagName = null) {
  const response = await fetch(`${BASE}/oracle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      selected_node_ids: selectedNodeIds,
      messages,
      is_bag_query: bagName !== null,
      bag_name: bagName,
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  if (!response.body) {
    throw new Error("Oracle streaming is not available in this browser.");
  }

  return response.body;
}
