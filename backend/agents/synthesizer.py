from __future__ import annotations

import asyncio
import json
import os
import re
import statistics
from collections import defaultdict
from typing import Any

from anthropic import AsyncAnthropic
from dotenv import load_dotenv

load_dotenv()

SYSTEM_PROMPT = """
You are the Dialectic Synthesizer. Given a cluster of biological claim nodes, identify the dominant consensus assertion.

Return ONLY valid JSON, no markdown:
{
  "core_assertion": "<one atomic falsifiable sentence>",
  "consensus_polarity": "promotes|inhibits|neutral|mixed",
  "evidence_weight": <float 0-1>,
  "private_public_alignment": "aligned|partially_aligned|divergent|private_only|public_only",
  "supporting_node_ids": ["<node_id>"],
  "supporting_narrative": "<2-3 sentences citing source types>",
  "anomalies": [
    {
      "anomaly_type": "polarity_reversal|magnitude_outlier|context_dependent_reversal|source_conflict",
      "description": "<specific description>",
      "involved_node_ids": ["<node_id>"],
      "severity": "low|medium|high|critical"
    }
  ],
  "handoff_note": "<instruction to skeptic about what specifically to challenge>"
}

Rules:
- core_assertion must reference specific entities from the nodes (gene names, compounds, cell lines)
- supporting_node_ids must only contain node_ids from the input
- Flag as magnitude_outlier if any quantitative_value is >10x the median of others in cluster
- Flag as polarity_reversal if any node has opposite polarity to the majority
- evidence_weight: >0.7 if 3+ concordant nodes, <0.4 if mixed signals
""".strip()

ALLOWED_POLARITIES = {"promotes", "inhibits", "neutral", "mixed"}
ALLOWED_ALIGNMENTS = {
    "aligned",
    "partially_aligned",
    "divergent",
    "private_only",
    "public_only",
}
ALLOWED_ANOMALIES = {
    "polarity_reversal",
    "magnitude_outlier",
    "context_dependent_reversal",
    "source_conflict",
}
ALLOWED_SEVERITIES = {"low", "medium", "high", "critical"}


def _anthropic_client() -> AsyncAnthropic | None:
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    return AsyncAnthropic(api_key=api_key) if api_key else None


def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _safe_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _safe_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _clip_score(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = default
    return round(max(0.0, min(1.0, numeric)), 3)


def _extract_json_payload(text: str) -> Any:
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate)
        candidate = re.sub(r"\s*```$", "", candidate)

    decoder = json.JSONDecoder()
    for index, char in enumerate(candidate):
        if char not in "{[":
            continue
        try:
            payload, _ = decoder.raw_decode(candidate[index:])
            return payload
        except json.JSONDecodeError:
            continue
    raise ValueError("No JSON object found in synthesizer response.")


def _normalize_entity(value: Any) -> str:
    lowered = _safe_text(value).lower()
    lowered = re.sub(r"[^a-z0-9]+", " ", lowered)
    return " ".join(lowered.split())


def _compact_node(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "node_id": _safe_text(node.get("node_id")),
        "claim_text": _safe_text(node.get("claim_text")),
        "polarity": _safe_text(node.get("polarity")).lower() or "mixed",
        "source_type": _safe_text(node.get("source_type")) or "unknown",
        "citation_count": _safe_int(node.get("citation_count")),
        "cell_line": _safe_text(node.get("cell_line")) or None,
        "quantitative_value": _safe_float(node.get("quantitative_value")),
        "quantitative_unit": _safe_text(node.get("quantitative_unit")) or None,
        "subject_name": _safe_text(node.get("subject_name")),
        "object_name": _safe_text(node.get("object_name")),
    }


def _pair_key(node: dict[str, Any]) -> tuple[str, str]:
    return (_normalize_entity(node.get("subject_name")), _normalize_entity(node.get("object_name")))


def _node_weight(node: dict[str, Any]) -> float:
    citations = max(0, _safe_int(node.get("citation_count")) or 0)
    public_bonus = 0.4 if node.get("source_type") == "public_abstract" else 0.0
    return 1.0 + public_bonus + min(citations / 25.0, 2.0)


def _majority_polarity(nodes: list[dict[str, Any]]) -> str:
    scores: defaultdict[str, float] = defaultdict(float)
    for node in nodes:
        polarity = _safe_text(node.get("polarity")).lower()
        if polarity not in {"promotes", "inhibits", "neutral"}:
            continue
        scores[polarity] += _node_weight(node)

    if not scores:
        return "mixed"

    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    if len(ordered) == 1:
        return ordered[0][0]

    top_label, top_score = ordered[0]
    second_score = ordered[1][1]
    if second_score > 0 and top_score <= second_score * 1.2:
        return "mixed"
    return top_label


def _build_core_assertion(subject: str, object_name: str, polarity: str) -> str:
    if subject and object_name and polarity == "promotes":
        return f"{subject} promotes {object_name}."
    if subject and object_name and polarity == "inhibits":
        return f"{subject} inhibits {object_name}."
    if subject and object_name and polarity == "neutral":
        return f"{subject} has a neutral effect on {object_name}."
    if subject and object_name:
        return f"Evidence about {subject} and {object_name} is mixed."
    return "The cluster does not support a single atomic assertion."


def _severity_for_ratio(ratio: float) -> str:
    if ratio >= 100:
        return "critical"
    if ratio >= 30:
        return "high"
    if ratio >= 15:
        return "medium"
    return "low"


def _fallback_synthesis(cluster_nodes: list[dict[str, Any]]) -> dict[str, Any]:
    compact_nodes = [_compact_node(node) for node in cluster_nodes]
    valid_node_ids = {node["node_id"] for node in compact_nodes if node["node_id"]}
    if not compact_nodes:
        return {
            "core_assertion": "The cluster does not support a single atomic assertion.",
            "consensus_polarity": "mixed",
            "evidence_weight": 0.0,
            "private_public_alignment": "public_only",
            "supporting_node_ids": [],
            "supporting_narrative": "No claim nodes were provided to synthesize.",
            "anomalies": [],
            "handoff_note": "No skeptic challenge is possible because the cluster was empty.",
        }

    pair_groups: defaultdict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    pair_weights: defaultdict[tuple[str, str], float] = defaultdict(float)
    for node in compact_nodes:
        key = _pair_key(node)
        pair_groups[key].append(node)
        pair_weights[key] += _node_weight(node)

    dominant_pair = max(pair_weights.items(), key=lambda item: item[1])[0]
    dominant_nodes = pair_groups[dominant_pair]
    consensus_polarity = _majority_polarity(dominant_nodes)
    supporting_nodes = [
        node
        for node in dominant_nodes
        if consensus_polarity == "mixed" or node.get("polarity") == consensus_polarity
    ]
    if not supporting_nodes:
        supporting_nodes = sorted(dominant_nodes, key=_node_weight, reverse=True)

    lead_node = supporting_nodes[0]
    core_assertion = _build_core_assertion(
        lead_node.get("subject_name", ""),
        lead_node.get("object_name", ""),
        consensus_polarity,
    )

    concordant_count = sum(1 for node in dominant_nodes if node.get("polarity") == consensus_polarity)
    discordant_count = sum(
        1 for node in dominant_nodes if node.get("polarity") not in {"", consensus_polarity, "ambiguous"}
    )
    evidence_weight = 0.35 + min(concordant_count, 4) * 0.12
    if concordant_count >= 3 and consensus_polarity != "mixed":
        evidence_weight = max(evidence_weight, 0.72)
    if consensus_polarity == "mixed" or discordant_count > 0:
        evidence_weight = min(evidence_weight - min(discordant_count * 0.12, 0.3), 0.39)
    evidence_weight = _clip_score(evidence_weight)

    public_polarity = _majority_polarity([node for node in dominant_nodes if node.get("source_type") == "public_abstract"])
    private_polarity = _majority_polarity([node for node in dominant_nodes if node.get("source_type") == "private_csv"])
    if public_polarity != "mixed" and private_polarity != "mixed":
        if public_polarity == private_polarity:
            private_public_alignment = "aligned"
        else:
            private_public_alignment = "divergent"
    elif public_polarity != "mixed" and private_polarity == "mixed":
        private_public_alignment = "partially_aligned"
    elif private_polarity != "mixed" and public_polarity == "mixed":
        private_public_alignment = "partially_aligned"
    elif any(node.get("source_type") == "private_csv" for node in dominant_nodes) and not any(
        node.get("source_type") == "public_abstract" for node in dominant_nodes
    ):
        private_public_alignment = "private_only"
    else:
        private_public_alignment = "public_only"

    source_counts: defaultdict[str, int] = defaultdict(int)
    total_citations = 0
    for node in supporting_nodes:
        source_counts[node.get("source_type") or "unknown"] += 1
        total_citations += max(0, _safe_int(node.get("citation_count")) or 0)
    source_summary = ", ".join(
        f"{count} {source_type.replace('_', ' ')}"
        for source_type, count in sorted(source_counts.items(), key=lambda item: item[0])
    )
    supporting_narrative = (
        f"{len(supporting_nodes)} node(s) converge on {core_assertion.rstrip('.')}. "
        f"Support comes from {source_summary or 'the available sources'}. "
        f"Public evidence in this set contributes {total_citations} total citations."
    )

    anomalies: list[dict[str, Any]] = []
    cluster_majority = _majority_polarity(compact_nodes)
    opposite_pairs = {("promotes", "inhibits"), ("inhibits", "promotes")}
    if cluster_majority in {"promotes", "inhibits"}:
        opposite_nodes = [
            node["node_id"]
            for node in compact_nodes
            if (cluster_majority, node.get("polarity")) in opposite_pairs and node["node_id"] in valid_node_ids
        ]
        if opposite_nodes:
            anomalies.append(
                {
                    "anomaly_type": "polarity_reversal",
                    "description": f"Some nodes reverse the majority polarity of {cluster_majority} within this cluster.",
                    "involved_node_ids": opposite_nodes,
                    "severity": "high" if len(opposite_nodes) > 1 else "medium",
                }
            )

    values_by_unit: defaultdict[str, list[tuple[str, float]]] = defaultdict(list)
    for node in compact_nodes:
        value = _safe_float(node.get("quantitative_value"))
        if value is None or value == 0:
            continue
        unit = _safe_text(node.get("quantitative_unit")) or "__missing__"
        values_by_unit[unit].append((node["node_id"], abs(value)))

    for unit, values in values_by_unit.items():
        if len(values) < 2:
            continue
        for node_id, value in values:
            others = [other_value for other_id, other_value in values if other_id != node_id and other_value > 0]
            if not others:
                continue
            median_others = statistics.median(others)
            if median_others > 0 and value > 10 * median_others:
                anomalies.append(
                    {
                        "anomaly_type": "magnitude_outlier",
                        "description": (
                            f"Node {node_id} reports a quantitative value more than 10x above the median of peer nodes"
                            f" for unit {unit if unit != '__missing__' else 'unspecified'}."
                        ),
                        "involved_node_ids": [node_id],
                        "severity": _severity_for_ratio(value / median_others),
                    }
                )

    for nodes_with_same_pair in pair_groups.values():
        pair_majority = _majority_polarity(nodes_with_same_pair)
        if pair_majority not in {"promotes", "inhibits"}:
            continue
        opposite_node_ids = [
            node["node_id"]
            for node in nodes_with_same_pair
            if (pair_majority, node.get("polarity")) in opposite_pairs
        ]
        cell_lines = {
            _safe_text(node.get("cell_line")).lower()
            for node in nodes_with_same_pair
            if _safe_text(node.get("cell_line"))
        }
        if opposite_node_ids and len(cell_lines) > 1:
            subject = nodes_with_same_pair[0].get("subject_name", "The subject")
            object_name = nodes_with_same_pair[0].get("object_name", "the target")
            anomalies.append(
                {
                    "anomaly_type": "context_dependent_reversal",
                    "description": f"{subject} shows opposite polarity toward {object_name} across different cell-line contexts.",
                    "involved_node_ids": opposite_node_ids,
                    "severity": "high",
                }
            )

    public_nodes = [node for node in compact_nodes if node.get("source_type") == "public_abstract"]
    private_nodes = [node for node in compact_nodes if node.get("source_type") == "private_csv"]
    if public_nodes and private_nodes:
        public_majority = _majority_polarity(public_nodes)
        private_majority = _majority_polarity(private_nodes)
        if public_majority in {"promotes", "inhibits", "neutral"} and private_majority in {"promotes", "inhibits", "neutral"}:
            if public_majority != private_majority:
                anomalies.append(
                    {
                        "anomaly_type": "source_conflict",
                        "description": "Private and published evidence point in different directions for this cluster.",
                        "involved_node_ids": [node["node_id"] for node in compact_nodes if node["node_id"] in valid_node_ids],
                        "severity": "high",
                    }
                )

    deduped_anomalies: list[dict[str, Any]] = []
    seen_anomalies: set[tuple[str, tuple[str, ...]]] = set()
    for anomaly in anomalies:
        node_ids = sorted({node_id for node_id in anomaly.get("involved_node_ids", []) if node_id in valid_node_ids})
        key = (anomaly["anomaly_type"], tuple(node_ids))
        if key in seen_anomalies:
            continue
        seen_anomalies.add(key)
        deduped_anomalies.append(
            {
                "anomaly_type": anomaly["anomaly_type"],
                "description": _safe_text(anomaly.get("description")),
                "involved_node_ids": node_ids,
                "severity": anomaly["severity"] if anomaly["severity"] in ALLOWED_SEVERITIES else "medium",
            }
        )

    if deduped_anomalies:
        target_ids = ", ".join(deduped_anomalies[0]["involved_node_ids"][:4])
        handoff_note = f"Stress-test the consensus by checking nodes {target_ids} and whether the disagreement is mechanistic, contextual, or quantitative."
    else:
        handoff_note = "Challenge whether the consensus still holds after checking source quality, cell-line context, and any quantitative caveats."

    return {
        "core_assertion": core_assertion,
        "consensus_polarity": consensus_polarity,
        "evidence_weight": evidence_weight,
        "private_public_alignment": private_public_alignment,
        "supporting_node_ids": [node["node_id"] for node in supporting_nodes[:6] if node["node_id"] in valid_node_ids],
        "supporting_narrative": supporting_narrative,
        "anomalies": deduped_anomalies,
        "handoff_note": handoff_note,
    }


def _sanitize_synthesis(result: dict[str, Any], fallback: dict[str, Any], valid_node_ids: set[str]) -> dict[str, Any]:
    synthesis = {
        "core_assertion": _safe_text(result.get("core_assertion")) or fallback["core_assertion"],
        "consensus_polarity": _safe_text(result.get("consensus_polarity")).lower() or fallback["consensus_polarity"],
        "evidence_weight": _clip_score(result.get("evidence_weight"), fallback["evidence_weight"]),
        "private_public_alignment": _safe_text(result.get("private_public_alignment")) or fallback["private_public_alignment"],
        "supporting_node_ids": [],
        "supporting_narrative": _safe_text(result.get("supporting_narrative")) or fallback["supporting_narrative"],
        "anomalies": [],
        "handoff_note": _safe_text(result.get("handoff_note")) or fallback["handoff_note"],
    }

    if synthesis["consensus_polarity"] not in ALLOWED_POLARITIES:
        synthesis["consensus_polarity"] = fallback["consensus_polarity"]
    if synthesis["private_public_alignment"] not in ALLOWED_ALIGNMENTS:
        synthesis["private_public_alignment"] = fallback["private_public_alignment"]

    supporting_node_ids = []
    for node_id in result.get("supporting_node_ids", []):
        normalized = _safe_text(node_id)
        if normalized and normalized in valid_node_ids and normalized not in supporting_node_ids:
            supporting_node_ids.append(normalized)
    synthesis["supporting_node_ids"] = supporting_node_ids or fallback["supporting_node_ids"]

    for anomaly in result.get("anomalies", []):
        if not isinstance(anomaly, dict):
            continue
        anomaly_type = _safe_text(anomaly.get("anomaly_type"))
        if anomaly_type not in ALLOWED_ANOMALIES:
            continue
        node_ids = []
        for node_id in anomaly.get("involved_node_ids", []):
            normalized = _safe_text(node_id)
            if normalized and normalized in valid_node_ids and normalized not in node_ids:
                node_ids.append(normalized)
        synthesis["anomalies"].append(
            {
                "anomaly_type": anomaly_type,
                "description": _safe_text(anomaly.get("description")),
                "involved_node_ids": node_ids,
                "severity": _safe_text(anomaly.get("severity")).lower()
                if _safe_text(anomaly.get("severity")).lower() in ALLOWED_SEVERITIES
                else "medium",
            }
        )

    if not synthesis["anomalies"]:
        synthesis["anomalies"] = fallback["anomalies"]

    return synthesis


async def run_synthesizer(cluster_nodes: list[dict]) -> dict:
    compact_nodes = [_compact_node(node) for node in cluster_nodes]
    fallback = _fallback_synthesis(compact_nodes)
    valid_node_ids = {node["node_id"] for node in compact_nodes if node["node_id"]}
    client = _anthropic_client()

    if client is None:
        return fallback

    try:
        response = await asyncio.wait_for(
            client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=1500,
                temperature=0,
                system=SYSTEM_PROMPT,
                messages=[
                    {
                        "role": "user",
                        "content": json.dumps({"cluster_nodes": compact_nodes}, ensure_ascii=True),
                    }
                ],
            ),
            timeout=60,
        )
        response_text = "".join(
            block.text for block in response.content if getattr(block, "type", "") == "text"
        )
        parsed = _extract_json_payload(response_text)
        if not isinstance(parsed, dict):
            return fallback
        return _sanitize_synthesis(parsed, fallback, valid_node_ids)
    except Exception:
        return fallback
