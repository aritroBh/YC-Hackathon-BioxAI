from __future__ import annotations

import asyncio
import json
import os
import re
from collections import defaultdict
from typing import Any

from anthropic import AsyncAnthropic
from dotenv import load_dotenv

from pipeline.contradiction_index import normalize_entity

load_dotenv()

SYSTEM_PROMPT = """
You are the Dialectic Skeptic. The Synthesizer has built a consensus. Destroy it with data.

You receive: the synthesis output AND a list of all available nodes (not just the cluster).
Find real contradictions. Every contradiction MUST cite two node_ids that exist in the input.

Return ONLY valid JSON, no markdown:
{
  "verdict": "no_contradiction|mild_tension|significant_contradiction|fundamental_conflict",
  "contradictions": [
    {
      "contradiction_id": "CONTRA-<cluster_id>-<index>",
      "contradiction_type": "direct_polarity_reversal|magnitude_discrepancy|context_dependent_reversal|private_vs_published|mechanism_conflict",
      "description": "<precise mechanistic description>",
      "claim_a": {
        "node_id": "<must exist in input>",
        "claim_text": "<exact text from input>",
        "source_type": "<from input>",
        "citation_count": <from input or null>
      },
      "claim_b": {
        "node_id": "<must exist in input>",
        "claim_text": "<exact text from input>",
        "source_type": "<from input>",
        "citation_count": <from input or null>
      },
      "conflict_axis": "polarity|magnitude|context|mechanism",
      "severity": "low|medium|high|critical",
      "friction_score_contribution": <float 0-1>,
      "user_facing_explanation": "<plain English, 1-2 sentences, suitable for non-expert>",
      "recommended_experiment": "<specific wet-lab or computational experiment to resolve this>"
    }
  ],
  "composite_friction_score": <float 0-1>,
  "friction_components": {
    "polarity_conflict": <float 0-1>,
    "quantitative_conflict": <float 0-1>,
    "context_conflict": <float 0-1>,
    "source_credibility_gap": <float 0-1>
  },
  "skeptic_summary": "<2-3 sentences, most important risk>",
  "validation_risk_level": "LOW|MEDIUM|HIGH|CRITICAL"
}

Friction scoring guide:
- direct_polarity_reversal: friction_score_contribution = 0.85
- magnitude_discrepancy >100x: friction_score_contribution = 0.80
- magnitude_discrepancy 10-100x: friction_score_contribution = 0.60
- context_dependent_reversal: friction_score_contribution = 0.55
- private_vs_published (high citation): friction_score_contribution = 0.70
- mild_tension only: composite_friction_score < 0.30

GUIDELINES:
- Prefer finding real contradictions over being overly cautious.
- Two claims about the SAME target with OPPOSITE effects (one inhibits, one activates)
  are ALWAYS a genuine contradiction worth flagging, even if the experimental context differs.
- Two claims with the same target where IC50 values differ by >10x are worth flagging
  as magnitude_discrepancy — the difference itself is scientifically interesting.
- Private lab data contradicting published literature IS significant even if both could
  theoretically be true in different contexts. Flag it and let the scientist decide.
- DO NOT use node_ids that are not in the provided input.
- If you find zero contradictions in a cluster of 10+ nodes about the same biological
  target, you are probably being too conservative. Look harder.
- Return verdict "no_contradiction" only when nodes genuinely cover completely different
  targets with no overlap.
""".strip()

ALLOWED_VERDICTS = {
    "no_contradiction",
    "mild_tension",
    "significant_contradiction",
    "fundamental_conflict",
}
ALLOWED_TYPES = {
    "direct_polarity_reversal",
    "magnitude_discrepancy",
    "context_dependent_reversal",
    "private_vs_published",
    "mechanism_conflict",
}
ALLOWED_AXES = {"polarity", "magnitude", "context", "mechanism"}
ALLOWED_SEVERITIES = {"low", "medium", "high", "critical"}
COMPONENT_FIELDS = (
    "polarity_conflict",
    "quantitative_conflict",
    "context_conflict",
    "source_credibility_gap",
)


def _anthropic_client() -> AsyncAnthropic | None:
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    return AsyncAnthropic(api_key=api_key) if api_key else None


def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _safe_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
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
    raise ValueError("No JSON object found in skeptic response.")


def _compact_node(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "node_id": _safe_text(node.get("node_id")),
        "claim_text": _safe_text(node.get("claim_text")),
        "polarity": _safe_text(node.get("polarity")).lower() or "ambiguous",
        "subject_name": _safe_text(node.get("subject_name")),
        "object_name": _safe_text(node.get("object_name")),
        "source_type": _safe_text(node.get("source_type")) or "unknown",
        "citation_count": _safe_int(node.get("citation_count")),
        "cell_line": _safe_text(node.get("cell_line")) or None,
        "quantitative_value": _safe_float(node.get("quantitative_value")),
        "quantitative_unit": _safe_text(node.get("quantitative_unit")) or None,
    }


def _pair_key(node: dict[str, Any]) -> tuple[str, str]:
    return (normalize_entity(node.get("subject_name")), normalize_entity(node.get("object_name")))


def _same_entity_pair(node_a: dict[str, Any], node_b: dict[str, Any]) -> bool:
    key_a = _pair_key(node_a)
    key_b = _pair_key(node_b)
    return key_a == key_b and key_a != ("", "")


def _citation_count(node: dict[str, Any]) -> int:
    return max(0, _safe_int(node.get("citation_count")) or 0)


def _quantitative_ratio(node_a: dict[str, Any], node_b: dict[str, Any]) -> float:
    value_a = _safe_float(node_a.get("quantitative_value"))
    value_b = _safe_float(node_b.get("quantitative_value"))
    if value_a is None or value_b is None:
        return 1.0
    low = min(abs(value_a), abs(value_b))
    high = max(abs(value_a), abs(value_b))
    if low == 0:
        return high if high > 0 else 1.0
    return high / low


def _has_opposite_polarity(node_a: dict[str, Any], node_b: dict[str, Any]) -> bool:
    return {node_a.get("polarity"), node_b.get("polarity")} == {"promotes", "inhibits"}


def _has_source_conflict(node_a: dict[str, Any], node_b: dict[str, Any]) -> bool:
    if not _same_entity_pair(node_a, node_b):
        return False
    if node_a.get("polarity") != node_b.get("polarity"):
        return False
    ratio = _quantitative_ratio(node_a, node_b)
    if ratio <= 5:
        return False
    private_public = (
        node_a.get("source_type") == "private_csv" and node_b.get("source_type") == "public_abstract"
    ) or (
        node_b.get("source_type") == "private_csv" and node_a.get("source_type") == "public_abstract"
    )
    if not private_public:
        return False
    return max(_citation_count(node_a), _citation_count(node_b)) > 50


def _context_penalty(node_a: dict[str, Any], node_b: dict[str, Any]) -> float:
    penalty = 0.0
    if _safe_text(node_a.get("cell_line")).lower() and _safe_text(node_b.get("cell_line")).lower():
        if _safe_text(node_a.get("cell_line")).lower() != _safe_text(node_b.get("cell_line")).lower():
            penalty += 0.15
    if _safe_text(node_a.get("quantitative_unit")).lower() and _safe_text(node_b.get("quantitative_unit")).lower():
        if _safe_text(node_a.get("quantitative_unit")).lower() != _safe_text(node_b.get("quantitative_unit")).lower():
            penalty += 0.1
    return min(penalty, 0.3)


def _severity_label(score: float) -> str:
    if score >= 0.85:
        return "critical"
    if score >= 0.6:
        return "high"
    if score >= 0.3:
        return "medium"
    return "low"


def _risk_label(score: float) -> str:
    if score >= 0.85:
        return "CRITICAL"
    if score >= 0.6:
        return "HIGH"
    if score >= 0.3:
        return "MEDIUM"
    return "LOW"


def _component_field(contradiction_type: str) -> str:
    if contradiction_type == "magnitude_discrepancy":
        return "quantitative_conflict"
    if contradiction_type == "context_dependent_reversal":
        return "context_conflict"
    if contradiction_type == "private_vs_published":
        return "source_credibility_gap"
    return "polarity_conflict"


def _recommended_experiment(contradiction_type: str, node_a: dict[str, Any], node_b: dict[str, Any]) -> str:
    subject = node_a.get("subject_name") or "the intervention"
    object_name = node_a.get("object_name") or "the target"
    if contradiction_type == "direct_polarity_reversal":
        return f"Repeat {subject} against {object_name} in a matched side-by-side assay with the same dose range, endpoint, and timepoint."
    if contradiction_type == "context_dependent_reversal":
        cell_a = node_a.get("cell_line") or "context A"
        cell_b = node_b.get("cell_line") or "context B"
        return f"Run the same {subject} perturbation in both {cell_a} and {cell_b} with identical controls to test whether the reversal is context-specific."
    if contradiction_type == "magnitude_discrepancy":
        return f"Measure a harmonized dose-response curve for {subject} versus {object_name} with the same assay units and calibration controls."
    if contradiction_type == "private_vs_published":
        return f"Replicate the private assay for {subject} and benchmark it directly against the published protocol with shared controls and raw trace review."
    return f"Compare the competing mechanistic readouts for {subject} and {object_name} in one blinded orthogonal assay panel."


def _heuristic_contradiction(node_a: dict[str, Any], node_b: dict[str, Any]) -> dict[str, Any] | None:
    if not _same_entity_pair(node_a, node_b):
        return None

    subject = node_a.get("subject_name") or "The intervention"
    object_name = node_a.get("object_name") or "the target"
    ratio = _quantitative_ratio(node_a, node_b)
    penalty = _context_penalty(node_a, node_b)

    if _has_opposite_polarity(node_a, node_b):
        if penalty >= 0.15:
            contradiction_type = "context_dependent_reversal"
            score = max(0.5, 0.75 - penalty)
            explanation = (
                f"These nodes describe opposite effects of {subject} on {object_name}, and the disagreement persists even after accounting for different cell-line context."
            )
            description = f"{subject} reverses direction on {object_name} across different experimental contexts."
            axis = "context"
        else:
            contradiction_type = "direct_polarity_reversal"
            score = 0.85
            explanation = f"These nodes say {subject} pushes {object_name} in opposite directions, which is a direct contradiction."
            description = f"{subject} is reported as both promoting and inhibiting {object_name}."
            axis = "polarity"
        return {
            "contradiction_type": contradiction_type,
            "conflict_axis": axis,
            "friction_score_contribution": round(score, 3),
            "description": description,
            "user_facing_explanation": explanation,
            "recommended_experiment": _recommended_experiment(contradiction_type, node_a, node_b),
        }

    if ratio > 10:
        base = 0.8 if ratio > 100 else 0.6
        score = max(0.4, base - penalty)
        return {
            "contradiction_type": "magnitude_discrepancy",
            "conflict_axis": "magnitude",
            "friction_score_contribution": round(score, 3),
            "description": f"{subject} shows a {ratio:.1f}x quantitative spread on {object_name} across claims that point in the same direction.",
            "user_facing_explanation": f"The measured strength of {subject} on {object_name} differs by about {ratio:.1f}x, which is scientifically meaningful rather than trivial noise.",
            "recommended_experiment": _recommended_experiment("magnitude_discrepancy", node_a, node_b),
        }

    if _has_source_conflict(node_a, node_b):
        score = max(0.45, 0.7 - penalty)
        return {
            "contradiction_type": "private_vs_published",
            "conflict_axis": "polarity",
            "friction_score_contribution": round(score, 3),
            "description": f"Private and high-citation published evidence disagree materially on the effect size for {subject} versus {object_name}.",
            "user_facing_explanation": f"Private lab data and heavily cited published literature do not agree on how strongly {subject} affects {object_name}.",
            "recommended_experiment": _recommended_experiment("private_vs_published", node_a, node_b),
        }

    return None


def _build_components(contradictions: list[dict[str, Any]]) -> dict[str, float]:
    components = {field: 0.0 for field in COMPONENT_FIELDS}
    for contradiction in contradictions:
        field = _component_field(contradiction["contradiction_type"])
        components[field] = max(components[field], _clip_score(contradiction["friction_score_contribution"]))
        if contradiction["contradiction_type"] in {"direct_polarity_reversal", "private_vs_published"}:
            components["polarity_conflict"] = max(
                components["polarity_conflict"],
                _clip_score(contradiction["friction_score_contribution"]),
            )
    return {key: round(value, 3) for key, value in components.items()}


def _weighted_composite(contradictions: list[dict[str, Any]], components: dict[str, float]) -> float:
    if contradictions:
        weights = {
            "direct_polarity_reversal": 1.0,
            "magnitude_discrepancy": 0.9,
            "private_vs_published": 0.9,
            "context_dependent_reversal": 0.8,
            "mechanism_conflict": 0.7,
        }
        weighted = 0.0
        total_weight = 0.0
        for contradiction in contradictions:
            weight = weights.get(contradiction["contradiction_type"], 0.7)
            weighted += _clip_score(contradiction["friction_score_contribution"]) * weight
            total_weight += weight
        if total_weight:
            return round(max(0.0, min(1.0, weighted / total_weight)), 3)

    non_zero = [value for value in components.values() if value > 0]
    if not non_zero:
        return 0.0
    return round(min(sum(non_zero) / len(non_zero), 0.29), 3)


def _verdict(composite: float, contradictions: list[dict[str, Any]]) -> str:
    if not contradictions:
        return "no_contradiction"
    if composite >= 0.75 or any(_clip_score(item["friction_score_contribution"]) >= 0.85 for item in contradictions):
        return "fundamental_conflict"
    if composite >= 0.3:
        return "significant_contradiction"
    return "mild_tension"


def _sort_and_cap_all_nodes(cluster_nodes: list[dict[str, Any]], all_nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cluster_ids = {node["node_id"] for node in cluster_nodes if node.get("node_id")}
    deduped: dict[str, dict[str, Any]] = {}
    for node in cluster_nodes + [_compact_node(item) for item in all_nodes]:
        if node["node_id"]:
            deduped[node["node_id"]] = node
    ordered = sorted(
        deduped.values(),
        key=lambda node: (0 if node["node_id"] in cluster_ids else 1, -_citation_count(node), node["node_id"]),
    )
    return ordered[:200]


def _candidate_pairs(cluster_nodes: list[dict[str, Any]], all_nodes: list[dict[str, Any]]) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    cluster_pair_keys = {_pair_key(node) for node in cluster_nodes if _pair_key(node) != ("", "")}
    relevant_nodes = [node for node in all_nodes if _pair_key(node) in cluster_pair_keys]
    pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    seen_pairs: set[tuple[str, str]] = set()
    for left in cluster_nodes:
        for right in relevant_nodes:
            if left["node_id"] == right["node_id"]:
                continue
            pair_key = tuple(sorted((left["node_id"], right["node_id"])))
            if pair_key in seen_pairs:
                continue
            seen_pairs.add(pair_key)
            pairs.append((left, right))
    return pairs


def _fallback_skeptic(synthesis: dict, cluster_nodes: list[dict], all_nodes: list[dict], cluster_id: int) -> dict:
    cluster_nodes_slim = [_compact_node(node) for node in cluster_nodes]
    all_nodes_slim = _sort_and_cap_all_nodes(cluster_nodes_slim, all_nodes)

    contradictions: list[dict[str, Any]] = []
    for index, (node_a, node_b) in enumerate(_candidate_pairs(cluster_nodes_slim, all_nodes_slim), start=1):
        conflict = _heuristic_contradiction(node_a, node_b)
        if conflict is None:
            continue
        contradictions.append(
            {
                "contradiction_id": f"CONTRA-{cluster_id}-{index}",
                "contradiction_type": conflict["contradiction_type"],
                "description": conflict["description"],
                "claim_a": {
                    "node_id": node_a["node_id"],
                    "claim_text": node_a["claim_text"],
                    "source_type": node_a["source_type"],
                    "citation_count": node_a["citation_count"],
                },
                "claim_b": {
                    "node_id": node_b["node_id"],
                    "claim_text": node_b["claim_text"],
                    "source_type": node_b["source_type"],
                    "citation_count": node_b["citation_count"],
                },
                "conflict_axis": conflict["conflict_axis"],
                "severity": _severity_label(conflict["friction_score_contribution"]),
                "friction_score_contribution": conflict["friction_score_contribution"],
                "user_facing_explanation": conflict["user_facing_explanation"],
                "recommended_experiment": conflict["recommended_experiment"],
            }
        )

    contradictions.sort(key=lambda item: item["friction_score_contribution"], reverse=True)
    for index, contradiction in enumerate(contradictions, start=1):
        contradiction["contradiction_id"] = f"CONTRA-{cluster_id}-{index}"

    components = _build_components(contradictions)
    composite = _weighted_composite(contradictions, components)
    verdict = _verdict(composite, contradictions)
    if contradictions:
        top = contradictions[0]
        summary = (
            f"The strongest contradiction is between nodes {top['claim_a']['node_id']} and {top['claim_b']['node_id']}. "
            f"{top['user_facing_explanation']}"
        )
    elif any(components.values()):
        summary = "The cluster shows mild tension but no pair cleared the contradiction threshold."
    else:
        summary = "No direct contradiction was found for the entity pairs represented in this cluster."

    return {
        "verdict": verdict,
        "contradictions": contradictions,
        "composite_friction_score": composite,
        "friction_components": components,
        "skeptic_summary": summary,
        "validation_risk_level": _risk_label(composite),
        "all_nodes_considered": len(all_nodes_slim),
    }


def _sanitize_skeptic_output(
    result: dict[str, Any],
    cluster_nodes: list[dict],
    all_nodes: list[dict],
    cluster_id: int,
) -> dict[str, Any]:
    node_index = {node["node_id"]: node for node in all_nodes if node.get("node_id")}
    contradictions: list[dict[str, Any]] = []
    seen_pairs: set[tuple[str, str]] = set()

    for raw in result.get("contradictions", []):
        if not isinstance(raw, dict):
            continue
        claim_a_id = _safe_text(raw.get("claim_a", {}).get("node_id"))
        claim_b_id = _safe_text(raw.get("claim_b", {}).get("node_id"))
        if not claim_a_id or not claim_b_id or claim_a_id == claim_b_id:
            continue
        if claim_a_id not in node_index or claim_b_id not in node_index:
            continue
        pair_key = tuple(sorted((claim_a_id, claim_b_id)))
        if pair_key in seen_pairs:
            continue
        seen_pairs.add(pair_key)

        node_a = node_index[claim_a_id]
        node_b = node_index[claim_b_id]
        heuristic = _heuristic_contradiction(node_a, node_b)

        contradiction_type = _safe_text(raw.get("contradiction_type"))
        if heuristic is not None:
            contradiction_type = heuristic["contradiction_type"]
        if contradiction_type not in ALLOWED_TYPES:
            continue

        conflict_axis = _safe_text(raw.get("conflict_axis"))
        if heuristic is not None:
            conflict_axis = heuristic["conflict_axis"]
        if conflict_axis not in ALLOWED_AXES:
            conflict_axis = "mechanism" if contradiction_type == "mechanism_conflict" else "polarity"

        base_score = heuristic["friction_score_contribution"] if heuristic is not None else 0.45
        contribution = _clip_score(raw.get("friction_score_contribution"), base_score)
        if heuristic is not None:
            contribution = max(contribution, base_score)

        severity = _safe_text(raw.get("severity")).lower()
        if severity not in ALLOWED_SEVERITIES:
            severity = _severity_label(contribution)

        description = _safe_text(raw.get("description")) or (
            heuristic["description"] if heuristic is not None else "The claims are scientifically incompatible."
        )
        explanation = _safe_text(raw.get("user_facing_explanation")) or (
            heuristic["user_facing_explanation"] if heuristic is not None else "These two nodes cannot both be true as stated."
        )
        experiment = _safe_text(raw.get("recommended_experiment")) or _recommended_experiment(
            contradiction_type,
            node_a,
            node_b,
        )

        contradictions.append(
            {
                "contradiction_id": "",
                "contradiction_type": contradiction_type,
                "description": description,
                "claim_a": {
                    "node_id": node_a["node_id"],
                    "claim_text": node_a["claim_text"],
                    "source_type": node_a["source_type"],
                    "citation_count": node_a["citation_count"],
                },
                "claim_b": {
                    "node_id": node_b["node_id"],
                    "claim_text": node_b["claim_text"],
                    "source_type": node_b["source_type"],
                    "citation_count": node_b["citation_count"],
                },
                "conflict_axis": conflict_axis,
                "severity": severity,
                "friction_score_contribution": contribution,
                "user_facing_explanation": explanation,
                "recommended_experiment": experiment,
            }
        )

    contradictions.sort(key=lambda item: item["friction_score_contribution"], reverse=True)
    for index, contradiction in enumerate(contradictions, start=1):
        contradiction["contradiction_id"] = f"CONTRA-{cluster_id}-{index}"

    components = _build_components(contradictions)
    if not contradictions:
        raw_components = result.get("friction_components") or {}
        for field in COMPONENT_FIELDS:
            components[field] = max(components[field], _clip_score(raw_components.get(field), 0.0))
        components = {field: round(value, 3) for field, value in components.items()}

    composite = _weighted_composite(contradictions, components)
    verdict = _safe_text(result.get("verdict"))
    if verdict not in ALLOWED_VERDICTS:
        verdict = _verdict(composite, contradictions)
    if not contradictions:
        verdict = "no_contradiction"

    summary = _safe_text(result.get("skeptic_summary"))
    if not summary:
        if contradictions:
            top = contradictions[0]
            summary = (
                f"The strongest contradiction is between nodes {top['claim_a']['node_id']} and {top['claim_b']['node_id']}. "
                f"{top['user_facing_explanation']}"
            )
        elif any(components.values()):
            summary = "The cluster shows mild tension but no pair cleared the contradiction threshold."
        else:
            summary = "No direct contradiction was found for the entity pairs represented in this cluster."

    return {
        "verdict": verdict,
        "contradictions": contradictions,
        "composite_friction_score": composite,
        "friction_components": components,
        "skeptic_summary": summary,
        "validation_risk_level": _risk_label(composite),
        "all_nodes_considered": len(all_nodes),
    }


async def run_skeptic(
    synthesis: dict,
    cluster_nodes: list[dict],
    all_nodes: list[dict],
    cluster_id: int,
) -> dict:
    cluster_nodes_slim = [_compact_node(node) for node in cluster_nodes]
    all_nodes_slim = _sort_and_cap_all_nodes(cluster_nodes_slim, all_nodes)
    fallback = _fallback_skeptic(synthesis, cluster_nodes_slim, all_nodes_slim, cluster_id)
    client = _anthropic_client()

    if client is None:
        return fallback

    try:
        response = await asyncio.wait_for(
            client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=2500,
                temperature=0,
                system=SYSTEM_PROMPT,
                messages=[
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "cluster_id": cluster_id,
                                "synthesis": synthesis,
                                "cluster_nodes": cluster_nodes_slim,
                                "all_nodes": all_nodes_slim,
                            },
                            ensure_ascii=True,
                        ),
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
        return _sanitize_skeptic_output(parsed, cluster_nodes_slim, all_nodes_slim, cluster_id)
    except Exception:
        return fallback
