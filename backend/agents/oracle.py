from __future__ import annotations

import asyncio
import json
import os
import re
from typing import AsyncGenerator, Any

from anthropic import AsyncAnthropic
from dotenv import load_dotenv

from models import ClaimNode

load_dotenv()

ORACLE_SYSTEM_PROMPT = """
You are the Dialectic Oracle. You ONLY answer using information in the <MAP_CONTEXT> block.
Every factual claim MUST be cited as [NODE: {description} | {provenance}].
Contradiction citations: [CONTRA: {type} between {node_a} and {node_b}].
If asked about something not in context: "That requires information not in your current selection. The loaded nodes cover: [list subjects]. Select nodes about [gap] to answer this."
Friction scale: <0.3 LOW, 0.3-0.6 MEDIUM, 0.6-0.85 HIGH, >0.85 CRITICAL.
Never introduce biology from your training that isn't grounded in a loaded node.
""".strip()


def _anthropic_client() -> AsyncAnthropic | None:
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    return AsyncAnthropic(api_key=api_key) if api_key else None


def _build_context(selected_nodes: list[ClaimNode]) -> dict[str, Any]:
    return {
        "subjects": sorted({node.subject_name for node in selected_nodes if node.subject_name}),
        "nodes": [
            {
                "node_id": node.node_id,
                "claim_text": node.claim_text,
                "subject_name": node.subject_name,
                "subject_type": node.subject_type,
                "predicate_relation": node.predicate_relation,
                "polarity": node.polarity,
                "quantitative_value": node.quantitative_value,
                "quantitative_unit": node.quantitative_unit,
                "object_name": node.object_name,
                "object_type": node.object_type,
                "cell_line": node.cell_line,
                "organism": node.organism,
                "disease_context": node.disease_context,
                "source_type": node.source_type,
                "file_name": node.file_name,
                "row_index": node.row_index,
                "paper_id": node.paper_id,
                "sentence_id": node.sentence_id,
                "sentence_text": node.sentence_text,
                "citation_count": node.citation_count,
                "abstract_url": node.abstract_url,
                "friction_score": node.friction_score,
                "debate_state": node.debate_state,
                "skeptic_rationale": node.skeptic_rationale,
                "contradicting_node_ids": node.contradicting_node_ids,
            }
            for node in selected_nodes
        ],
    }


def _node_provenance(node: ClaimNode) -> str:
    if node.source_type == "private_csv":
        row_text = f"row {node.row_index}" if node.row_index is not None else "unknown row"
        return f"{node.file_name or 'CSV'} {row_text}"
    citation = f"{node.citation_count} cites" if node.citation_count is not None else "citation count unavailable"
    sentence = f"sentence {node.sentence_id}" if node.sentence_id else "abstract extraction"
    return f"{node.paper_id or 'paper'} {sentence}, {citation}"


def _node_citation(node: ClaimNode) -> str:
    description = f"{node.node_id} {node.subject_name} {node.predicate_relation.replace('_', ' ')} {node.object_name}"
    return f"[NODE: {description} | {_node_provenance(node)}]"


def _split_stream_chunks(text: str, words_per_chunk: int = 12) -> list[str]:
    words = text.split()
    if not words:
        return [""]
    return [
        " ".join(words[index : index + words_per_chunk]) + (" " if index + words_per_chunk < len(words) else "")
        for index in range(0, len(words), words_per_chunk)
    ]


def _relevant_nodes(selected_nodes: list[ClaimNode], question: str) -> list[ClaimNode]:
    tokens = {token for token in re.findall(r"[a-z0-9]+", question.lower()) if len(token) > 2}
    scored = []
    for node in selected_nodes:
        haystack = " ".join(
            part
            for part in (
                node.claim_text,
                node.subject_name,
                node.object_name,
                node.cell_line or "",
                node.organism or "",
                node.disease_context or "",
            )
            if part
        ).lower()
        score = sum(1 for token in tokens if token in haystack)
        scored.append((score, node.friction_score, node))
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    relevant = [node for score, _, node in scored if score > 0][:4]
    return relevant or sorted(selected_nodes, key=lambda node: node.friction_score, reverse=True)[:4]


def _local_oracle_answer(selected_nodes: list[ClaimNode], messages: list[dict[str, Any]]) -> str:
    if not selected_nodes:
        return "That requires information not in your current selection. The loaded nodes cover: []. Select nodes about your target pathway to answer this."

    latest_user_message = ""
    for message in reversed(messages):
        if message.get("role") == "user":
            latest_user_message = str(message.get("content", ""))
            break

    question = latest_user_message.lower()
    subjects = sorted({node.subject_name for node in selected_nodes if node.subject_name})
    relevant = _relevant_nodes(selected_nodes, latest_user_message)

    if not relevant:
        subject_list = ", ".join(subjects[:8])
        return (
            f"That requires information not in your current selection. The loaded nodes cover: [{subject_list}]. "
            "Select nodes closer to your question to answer this."
        )

    if "why" in question and "red" in question:
        hot_nodes = [node for node in relevant if node.friction_score >= 0.6] or relevant[:3]
        lines = []
        for node in hot_nodes[:3]:
            risk = "CRITICAL" if node.friction_score > 0.85 else "HIGH" if node.friction_score >= 0.6 else "MEDIUM"
            contradiction_text = ""
            if node.contradicting_node_ids:
                contradiction_text = (
                    f" [CONTRA: friction between {node.node_id} and {node.contradicting_node_ids[0]}]"
                )
            lines.append(
                f"{node.subject_name} is marked {risk} because its friction score is {node.friction_score:.2f} "
                f"and the claim competes with nearby evidence on {node.object_name}. {_node_citation(node)}{contradiction_text}"
            )
        return " ".join(lines)

    if "summarize" in question or "summary" in question:
        lines = []
        for node in relevant[:3]:
            lines.append(
                f"{node.subject_name} {node.predicate_relation.replace('_', ' ')} {node.object_name} "
                f"with polarity {node.polarity}. {_node_citation(node)}"
            )
        return " ".join(lines)

    evidence_lines = [
        f"{node.claim_text} {_node_citation(node)}"
        for node in relevant[:3]
    ]
    return " ".join(evidence_lines)


async def stream_oracle(
    selected_nodes: list[ClaimNode], messages: list[dict[str, Any]]
) -> AsyncGenerator[str, None]:
    context = _build_context(selected_nodes)
    system_prompt = f"{ORACLE_SYSTEM_PROMPT}\n<MAP_CONTEXT>\n{json.dumps(context, ensure_ascii=True)}\n</MAP_CONTEXT>"
    sanitized_messages = [
        {
            "role": "assistant" if message.get("role") == "assistant" else "user",
            "content": str(message.get("content", "")),
        }
        for message in messages
        if str(message.get("content", "")).strip()
    ]

    client = _anthropic_client()
    if client is None:
        local_answer = _local_oracle_answer(selected_nodes, sanitized_messages)
        for chunk in _split_stream_chunks(local_answer):
            yield chunk
            await asyncio.sleep(0)
        return

    try:
        async with client.messages.stream(
            model="claude-sonnet-4-20250514",
            max_tokens=2000,
            temperature=0,
            system=system_prompt,
            messages=sanitized_messages,
        ) as stream:
            async for text in stream.text_stream:
                if text:
                    yield text
        return
    except Exception:
        local_answer = _local_oracle_answer(selected_nodes, sanitized_messages)
        for chunk in _split_stream_chunks(local_answer):
            yield chunk
            await asyncio.sleep(0)
