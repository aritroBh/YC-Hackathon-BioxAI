from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

from anthropic import AsyncAnthropic
from dotenv import load_dotenv

from agents.skeptic import run_skeptic
from agents.synthesizer import run_synthesizer
from agents.tamarind_arbiter import run_tamarind_arbiter
from models import ClaimNode, Session
from pipeline.contradiction_index import (
    build_clean_entity_index,
    find_candidate_contradiction_pairs,
    summarize_entity_pair_counts,
)
from session_store import update_session

load_dotenv()

CROSS_CORPUS_SYSTEM_PROMPT = """
You are evaluating whether pairs of biological claims genuinely contradict each other.
For each pair, assess if there is a real scientific conflict.

Return ONLY valid JSON array, one object per pair:
[
  {
    "pair_index": int,
    "is_genuine_contradiction": bool,
    "contradiction_type": "direct_polarity_reversal|magnitude_discrepancy|context_dependent_reversal|private_vs_published|no_contradiction",
    "friction_score": float,
    "user_facing_explanation": "<1-2 plain English sentences explaining the conflict>",
    "recommended_experiment": "<specific experiment to resolve, or empty string>"
  }
]

Scoring rules:
- direct_polarity_reversal (A inhibits X, B activates X): friction = 0.75-0.90
- magnitude_discrepancy >100x same assay: friction = 0.80
- magnitude_discrepancy 10-100x: friction = 0.60
- context_dependent_reversal (different cell lines): friction = 0.50
- private_vs_high_citation contradiction: friction = 0.70
- Contradictions that could be explained by different experimental contexts
  (different organisms, different assay types) should score 0.1-0.3 lower.
- If the "contradiction" is just two papers studying different aspects,
  is_genuine_contradiction = false.
""".strip()

ALLOWED_CROSS_TYPES = {
    "direct_polarity_reversal",
    "magnitude_discrepancy",
    "context_dependent_reversal",
    "private_vs_published",
    "no_contradiction",
}


def _anthropic_client() -> AsyncAnthropic | None:
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    return AsyncAnthropic(api_key=api_key) if api_key else None


def cluster_nodes_by_umap(nodes: list[ClaimNode], n_cells: int = 4) -> dict[int, list[str]]:
    """
    Simple grid clustering on umap_x/umap_y.
    Divide the UMAP space into n_cells x n_cells grid.
    Return dict: {cluster_id: [node_ids]}.
    Nodes with missing/zeroed UMAP coordinates go into cluster 0.
    """
    if not nodes:
        return {}

    active_nodes = [
        node
        for node in nodes
        if node.umap_x is not None
        and node.umap_y is not None
        and not (node.umap_x == 0 and node.umap_y == 0)
    ]
    if not active_nodes:
        return {0: [node.node_id for node in nodes]}

    x_values = [float(node.umap_x) for node in active_nodes]
    y_values = [float(node.umap_y) for node in active_nodes]
    x_min, x_max = min(x_values), max(x_values)
    y_min, y_max = min(y_values), max(y_values)

    clusters: dict[int, list[str]] = {}
    for node in nodes:
        if node.umap_x is None or node.umap_y is None or (node.umap_x == 0 and node.umap_y == 0):
            cluster_id = 0
        elif x_max == x_min or y_max == y_min:
            cluster_id = 1
        else:
            col = min(int((float(node.umap_x) - x_min) / (x_max - x_min) * n_cells), n_cells - 1)
            row = min(int((float(node.umap_y) - y_min) / (y_max - y_min) * n_cells), n_cells - 1)
            cluster_id = 1 + row * n_cells + col
        clusters.setdefault(cluster_id, []).append(node.node_id)

    return clusters


def _cluster_node_payload(node: ClaimNode) -> dict[str, Any]:
    return {
        "node_id": node.node_id,
        "claim_text": node.claim_text,
        "polarity": node.polarity,
        "source_type": node.source_type,
        "citation_count": node.citation_count,
        "cell_line": node.cell_line,
        "organism": node.organism,
        "quantitative_value": node.quantitative_value,
        "quantitative_unit": node.quantitative_unit,
        "subject_name": node.subject_name,
        "object_name": node.object_name,
    }


def _all_nodes_payload(node: ClaimNode) -> dict[str, Any]:
    return {
        "node_id": node.node_id,
        "claim_text": node.claim_text,
        "polarity": node.polarity,
        "subject_name": node.subject_name,
        "object_name": node.object_name,
        "source_type": node.source_type,
        "citation_count": node.citation_count,
        "cell_line": node.cell_line,
        "quantitative_value": node.quantitative_value,
        "quantitative_unit": node.quantitative_unit,
    }


def _cross_pair_payload(node: ClaimNode) -> dict[str, Any]:
    return {
        "node_id": node.node_id,
        "claim_text": node.claim_text,
        "polarity": node.polarity,
        "source_type": node.source_type,
        "citation_count": node.citation_count,
        "cell_line": node.cell_line,
        "quantitative_value": node.quantitative_value,
        "quantitative_unit": node.quantitative_unit,
    }


def _clip_score(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = default
    return round(max(0.0, min(1.0, numeric)), 3)


def _format_rationale(explanation: str, experiment: str) -> str:
    explanation = str(explanation or "").strip()
    experiment = str(experiment or "").strip()
    if explanation and experiment:
        return f"{explanation} Recommended experiment: {experiment}"
    return explanation or experiment


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
    raise ValueError("No JSON payload found.")


def _context_penalty(node_a: ClaimNode, node_b: ClaimNode) -> float:
    penalty = 0.0
    if (node_a.cell_line or "").strip().lower() and (node_b.cell_line or "").strip().lower():
        if node_a.cell_line.strip().lower() != node_b.cell_line.strip().lower():
            penalty += 0.15
    if (node_a.quantitative_unit or "").strip().lower() and (node_b.quantitative_unit or "").strip().lower():
        if node_a.quantitative_unit.strip().lower() != node_b.quantitative_unit.strip().lower():
            penalty += 0.1
    return min(penalty, 0.3)


def _quantitative_ratio(node_a: ClaimNode, node_b: ClaimNode) -> float:
    if node_a.quantitative_value is None or node_b.quantitative_value is None:
        return 1.0
    low = min(abs(node_a.quantitative_value), abs(node_b.quantitative_value))
    high = max(abs(node_a.quantitative_value), abs(node_b.quantitative_value))
    if low == 0:
        return high if high > 0 else 1.0
    return high / low


def _heuristic_cross_confirmation(
    node_a: ClaimNode,
    node_b: ClaimNode,
    priority: int,
    rule_triggered: str,
) -> dict[str, Any] | None:
    ratio = _quantitative_ratio(node_a, node_b)
    penalty = _context_penalty(node_a, node_b)
    subject = node_a.subject_name or "The intervention"
    object_name = node_a.object_name or "the target"

    if rule_triggered == "polarity_reversal":
        contradiction_type = "direct_polarity_reversal"
        score = 0.85
        if penalty >= 0.15:
            contradiction_type = "context_dependent_reversal"
            score = max(0.5, 0.75 - penalty)
            explanation = f"These nodes report opposite effects of {subject} on {object_name}, and the disagreement tracks different biological contexts."
        else:
            explanation = f"These nodes say {subject} drives {object_name} in opposite directions, which is a direct contradiction."
        return {
            "priority": priority,
            "rule_triggered": rule_triggered,
            "is_genuine_contradiction": True,
            "contradiction_type": contradiction_type,
            "friction_score": round(score, 3),
            "user_facing_explanation": explanation,
            "recommended_experiment": (
                f"Repeat {subject} against {object_name} in a matched side-by-side assay with the same dose range, endpoint, and timepoint."
            ),
        }

    if rule_triggered == "magnitude_discrepancy" and ratio > 10:
        score = 0.8 if ratio > 100 else 0.6
        score = max(0.4, score - penalty)
        return {
            "priority": priority,
            "rule_triggered": rule_triggered,
            "is_genuine_contradiction": True,
            "contradiction_type": "magnitude_discrepancy",
            "friction_score": round(score, 3),
            "user_facing_explanation": f"The reported strength of {subject} on {object_name} differs by about {ratio:.1f}x across claims, which is too large to ignore.",
            "recommended_experiment": (
                f"Measure a harmonized dose-response curve for {subject} versus {object_name} using the same units, calibration controls, and assay timing."
            ),
        }

    if rule_triggered == "source_conflict" and ratio > 5:
        score = max(0.45, 0.7 - penalty)
        return {
            "priority": priority,
            "rule_triggered": rule_triggered,
            "is_genuine_contradiction": True,
            "contradiction_type": "private_vs_published",
            "friction_score": round(score, 3),
            "user_facing_explanation": f"Private lab data and high-citation published evidence disagree materially on how strongly {subject} affects {object_name}.",
            "recommended_experiment": (
                f"Replicate the private assay for {subject} and benchmark it directly against the published protocol with shared controls and raw trace review."
            ),
        }

    return None


def _apply_contradiction(
    node_map: dict[str, ClaimNode],
    contradiction_links: dict[str, set[str]],
    best_rationales: dict[str, tuple[float, str]],
    node_id_a: str,
    node_id_b: str,
    friction_score: float,
    rationale: str,
) -> None:
    if node_id_a not in node_map or node_id_b not in node_map:
        return
    contradiction_links[node_id_a].add(node_id_b)
    contradiction_links[node_id_b].add(node_id_a)
    for source_id, other_id in ((node_id_a, node_id_b), (node_id_b, node_id_a)):
        node = node_map[source_id]
        node.friction_score = max(node.friction_score, friction_score)
        node.debate_state = "challenged"
        contradiction_links[source_id].add(other_id)
        current = best_rationales.get(source_id)
        if current is None or friction_score >= current[0]:
            best_rationales[source_id] = (friction_score, rationale)


async def run_cross_corpus_skeptic(pairs: list[tuple], all_nodes_slim: list[dict]) -> list[dict]:
    """
    Evaluate candidate contradiction pairs across the full corpus.
    Pairs are batched in groups of 5 and run with asyncio.gather, semaphore=3.
    """
    if not pairs:
        return []

    client = _anthropic_client()
    batch_size = 5
    semaphore = asyncio.Semaphore(3)
    all_nodes_index = {node["node_id"]: node for node in all_nodes_slim if node.get("node_id")}

    async def evaluate_batch(batch_index: int, batch_pairs: list[tuple]) -> list[dict]:
        batch_payload = []
        for offset, (node_a, node_b, priority, rule_triggered) in enumerate(batch_pairs):
            batch_payload.append(
                {
                    "pair_index": batch_index * batch_size + offset,
                    "node_a": _cross_pair_payload(node_a),
                    "node_b": _cross_pair_payload(node_b),
                    "priority": priority,
                    "rule_triggered": rule_triggered,
                }
            )

        async with semaphore:
            if client is None:
                parsed = []
                for item, (node_a, node_b, priority, rule_triggered) in zip(batch_payload, batch_pairs):
                    heuristic = _heuristic_cross_confirmation(node_a, node_b, priority, rule_triggered)
                    parsed.append(
                        {
                            "pair_index": item["pair_index"],
                            "is_genuine_contradiction": bool(heuristic),
                            "contradiction_type": heuristic["contradiction_type"] if heuristic else "no_contradiction",
                            "friction_score": heuristic["friction_score"] if heuristic else 0.0,
                            "user_facing_explanation": heuristic["user_facing_explanation"] if heuristic else "",
                            "recommended_experiment": heuristic["recommended_experiment"] if heuristic else "",
                        }
                    )
            else:
                response = await client.messages.create(
                    model="claude-sonnet-4-20250514",
                    max_tokens=1800,
                    temperature=0,
                    system=CROSS_CORPUS_SYSTEM_PROMPT,
                    messages=[
                        {
                            "role": "user",
                            "content": json.dumps(batch_payload, ensure_ascii=True),
                        }
                    ],
                )
                response_text = "".join(
                    block.text for block in response.content if getattr(block, "type", "") == "text"
                )
                payload = _extract_json_payload(response_text)
                parsed = payload if isinstance(payload, list) else []

        confirmed: list[dict] = []
        local_lookup = {item["pair_index"]: pair for item, pair in zip(batch_payload, batch_pairs)}
        for item in parsed:
            if not isinstance(item, dict):
                continue
            pair_index = item.get("pair_index")
            if pair_index not in local_lookup:
                continue
            node_a, node_b, priority, rule_triggered = local_lookup[pair_index]
            heuristic = _heuristic_cross_confirmation(node_a, node_b, priority, rule_triggered)
            if heuristic is None:
                continue

            is_genuine = bool(item.get("is_genuine_contradiction"))
            if rule_triggered == "polarity_reversal":
                is_genuine = True
            if not is_genuine:
                continue

            contradiction_type = str(item.get("contradiction_type") or heuristic["contradiction_type"]).strip()
            if contradiction_type not in ALLOWED_CROSS_TYPES:
                contradiction_type = heuristic["contradiction_type"]
            if contradiction_type == "no_contradiction":
                continue

            friction_score = _clip_score(item.get("friction_score"), heuristic["friction_score"])
            friction_score = max(friction_score, heuristic["friction_score"])
            confirmed.append(
                {
                    "pair_index": pair_index,
                    "node_id_a": node_a.node_id,
                    "node_id_b": node_b.node_id,
                    "contradiction_type": contradiction_type,
                    "friction_score": friction_score,
                    "user_facing_explanation": (
                        str(item.get("user_facing_explanation") or "").strip()
                        or heuristic["user_facing_explanation"]
                    ),
                    "recommended_experiment": (
                        str(item.get("recommended_experiment") or "").strip()
                        or heuristic["recommended_experiment"]
                    ),
                    "rule_triggered": rule_triggered,
                    "priority": priority,
                    "claim_a": all_nodes_index.get(node_a.node_id, _cross_pair_payload(node_a)),
                    "claim_b": all_nodes_index.get(node_b.node_id, _cross_pair_payload(node_b)),
                }
            )
        return confirmed

    batches = [pairs[index : index + batch_size] for index in range(0, len(pairs), batch_size)]
    results = await asyncio.gather(*(evaluate_batch(index, batch) for index, batch in enumerate(batches)))
    flattened = [item for batch in results for item in batch]
    flattened.sort(key=lambda item: item["friction_score"], reverse=True)
    return flattened


async def run_full_debate(nodes: list[ClaimNode], session: Session) -> list[ClaimNode]:
    """
    1. Pass 1: Coarse cluster debate (n_cells=4).
    2. Pass 2: Cross-corpus contradiction scan.
    3. Finalize node states and contradiction links.
    """
    node_map = {node.node_id: node for node in nodes}
    contradiction_links: dict[str, set[str]] = {node.node_id: set() for node in nodes}
    best_rationales: dict[str, tuple[float, str]] = {}
    confirmed_contradictions: dict[tuple[str, str], float] = {}
    cluster_results: dict[str, Any] = {}

    for node in nodes:
        node.friction_score = 0.0
        node.debate_state = "pending"
        node.skeptic_rationale = None
        node.tamarind_verdict = None
        node.contradicting_node_ids = []

    all_nodes_slim = [_all_nodes_payload(node) for node in nodes]
    clean_entity_index, _, entity_extraction_stats = await build_clean_entity_index(nodes)
    entity_pair_counts = summarize_entity_pair_counts(clean_entity_index)

    clusters = cluster_nodes_by_umap(nodes, n_cells=4)
    pass1_clusters = {cluster_id: node_ids for cluster_id, node_ids in clusters.items() if len(node_ids) >= 2}
    pass1_cluster_count = len(pass1_clusters)

    if pass1_cluster_count:
        semaphore = asyncio.Semaphore(3)
        progress_lock = asyncio.Lock()
        completed_clusters = 0

        async def debate_one_cluster(cluster_id: int, node_ids: list[str]) -> None:
            nonlocal completed_clusters
            async with semaphore:
                cluster_nodes = [node_map[node_id] for node_id in node_ids if node_id in node_map]
                cluster_nodes_slim = [_cluster_node_payload(node) for node in cluster_nodes]
                try:
                    synthesis = await run_synthesizer(cluster_nodes_slim)
                    skeptic_output = await run_skeptic(synthesis, cluster_nodes_slim, all_nodes_slim, cluster_id)
                except Exception as exc:
                    synthesis = {
                        "core_assertion": "The cluster could not be synthesized.",
                        "consensus_polarity": "mixed",
                        "evidence_weight": 0.0,
                        "private_public_alignment": "public_only",
                        "supporting_node_ids": [],
                        "supporting_narrative": "",
                        "anomalies": [],
                        "handoff_note": "",
                    }
                    skeptic_output = {
                        "verdict": "no_contradiction",
                        "contradictions": [],
                        "composite_friction_score": 0.0,
                        "friction_components": {
                            "polarity_conflict": 0.0,
                            "quantitative_conflict": 0.0,
                            "context_conflict": 0.0,
                            "source_credibility_gap": 0.0,
                        },
                        "skeptic_summary": f"Debate failed for cluster {cluster_id}: {exc}",
                        "validation_risk_level": "LOW",
                    }

                async with progress_lock:
                    cluster_results[str(cluster_id)] = {
                        "node_ids": node_ids,
                        "synthesis": synthesis,
                        "skeptic_output": skeptic_output,
                    }

                    baseline_score = min(_clip_score(skeptic_output.get("composite_friction_score")), 0.25)
                    baseline_rationale = (
                        str(skeptic_output.get("skeptic_summary") or "").strip()
                        or str(synthesis.get("supporting_narrative") or "").strip()
                        or "Consensus held within the coarse semantic cluster."
                    )

                    for node_id in node_ids:
                        node = node_map[node_id]
                        node.friction_score = max(node.friction_score, baseline_score)
                        if node.debate_state == "pending":
                            node.debate_state = "synthesized"
                        if not node.skeptic_rationale:
                            node.skeptic_rationale = baseline_rationale

                    for contradiction in skeptic_output.get("contradictions", []):
                        claim_a_id = contradiction.get("claim_a", {}).get("node_id")
                        claim_b_id = contradiction.get("claim_b", {}).get("node_id")
                        if not claim_a_id or not claim_b_id:
                            continue
                        friction_score = _clip_score(contradiction.get("friction_score_contribution"))
                        rationale = _format_rationale(
                            contradiction.get("user_facing_explanation", ""),
                            contradiction.get("recommended_experiment", ""),
                        )
                        _apply_contradiction(
                            node_map,
                            contradiction_links,
                            best_rationales,
                            claim_a_id,
                            claim_b_id,
                            friction_score,
                            rationale,
                        )
                        pair_key = tuple(sorted((claim_a_id, claim_b_id)))
                        confirmed_contradictions[pair_key] = max(
                            confirmed_contradictions.get(pair_key, 0.0),
                            friction_score,
                        )

                    completed_clusters += 1
                    progress = 60 + int((completed_clusters / pass1_cluster_count) * 15)
                    update_session(
                        session.session_id,
                        nodes=list(node_map.values()),
                        debate_results={
                            "clusters": cluster_results,
                            "pass1_cluster_count": pass1_cluster_count,
                            "cross_corpus_pairs_evaluated": 0,
                            "entity_pair_counts": entity_pair_counts,
                            "entity_extraction_stats": entity_extraction_stats,
                        },
                        status="debating",
                        progress=progress,
                    )

        await asyncio.gather(
            *(debate_one_cluster(cluster_id, node_ids) for cluster_id, node_ids in pass1_clusters.items())
        )

    update_session(
        session.session_id,
        nodes=list(node_map.values()),
        debate_results={
            "clusters": cluster_results,
            "pass1_cluster_count": pass1_cluster_count,
            "cross_corpus_pairs_evaluated": 0,
            "entity_pair_counts": entity_pair_counts,
            "entity_extraction_stats": entity_extraction_stats,
        },
        status="debating",
        progress=75,
    )

    candidate_pairs = await find_candidate_contradiction_pairs(nodes)
    cross_corpus_results = await run_cross_corpus_skeptic(candidate_pairs, all_nodes_slim)
    for contradiction in cross_corpus_results:
        rationale = _format_rationale(
            contradiction.get("user_facing_explanation", ""),
            contradiction.get("recommended_experiment", ""),
        )
        _apply_contradiction(
            node_map,
            contradiction_links,
            best_rationales,
            contradiction["node_id_a"],
            contradiction["node_id_b"],
            _clip_score(contradiction["friction_score"]),
            rationale,
        )
        pair_key = tuple(sorted((contradiction["node_id_a"], contradiction["node_id_b"])))
        confirmed_contradictions[pair_key] = max(
            confirmed_contradictions.get(pair_key, 0.0),
            _clip_score(contradiction["friction_score"]),
        )

    update_session(
        session.session_id,
        nodes=list(node_map.values()),
        debate_results={
            "clusters": cluster_results,
            "pass1_cluster_count": pass1_cluster_count,
            "cross_corpus_pairs_evaluated": len(candidate_pairs),
            "cross_corpus_contradictions": cross_corpus_results,
            "entity_pair_counts": entity_pair_counts,
            "entity_extraction_stats": entity_extraction_stats,
        },
        status="debating",
        progress=90,
    )

    for node in nodes:
        node.contradicting_node_ids = sorted(contradiction_links[node.node_id])
        if node.node_id in best_rationales:
            node.skeptic_rationale = best_rationales[node.node_id][1]
        elif node.debate_state == "pending" and node.friction_score == 0.0:
            node.debate_state = "synthesized"
            node.skeptic_rationale = "No contradiction was found for this node in either the cluster debate or the cross-corpus scan."
        elif node.debate_state == "pending":
            node.debate_state = "synthesized"
            node.skeptic_rationale = node.skeptic_rationale or "This node participated in debate and no direct contradiction was confirmed."
        elif node.debate_state == "synthesized" and not node.skeptic_rationale:
            node.skeptic_rationale = "No direct contradiction was confirmed for this node."
        node.friction_score = _clip_score(node.friction_score)

    tamarind_nodes_with_verdict: set[str] = set()
    contradiction_pairs = sorted(
        (
            (friction_score, node_id_a, node_id_b)
            for (node_id_a, node_id_b), friction_score in confirmed_contradictions.items()
            if friction_score >= 0.85
        ),
        reverse=True,
    )
    for _, node_id_a, node_id_b in contradiction_pairs:
        node_a = node_map.get(node_id_a)
        node_b = node_map.get(node_id_b)
        if node_a is None or node_b is None:
            continue
        verdict = await run_tamarind_arbiter(node_a, node_b)
        if verdict.get("verdict") != "skipped":
            node_a.tamarind_verdict = verdict
            node_b.tamarind_verdict = verdict
            tamarind_nodes_with_verdict.update((node_id_a, node_id_b))

    tamarind_nodes_evaluated = len(tamarind_nodes_with_verdict)

    update_session(
        session.session_id,
        nodes=list(node_map.values()),
        debate_results={
            "clusters": cluster_results,
            "pass1_cluster_count": pass1_cluster_count,
            "cross_corpus_pairs_evaluated": len(candidate_pairs),
            "cross_corpus_contradictions": cross_corpus_results,
            "tamarind_nodes_evaluated": tamarind_nodes_evaluated,
            "entity_pair_counts": entity_pair_counts,
            "entity_extraction_stats": entity_extraction_stats,
        },
        status="debating",
        progress=95,
    )
    return list(node_map.values())
