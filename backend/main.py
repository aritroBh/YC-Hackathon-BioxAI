from __future__ import annotations

import asyncio
import json
import os
from typing import Any, AsyncGenerator

from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agents.schema_agent import analyze_csv
from models import ClaimNode, OracleRequest
from pipeline.contradiction_index import build_clean_entity_index, summarize_entity_pair_counts
from pipeline.debate_runner import run_full_debate
from pipeline.embedder import embed_nodes
from pipeline.ingest_csv import ingest_csv
from pipeline.ingest_s2 import ingest_s2
from pipeline.umap_reducer import reduce_umap
from session_store import create_session, get_session, load_session_from_disk, update_session

load_dotenv()

DEMO_SESSION_ID = "55500fc5f1654234b44f5d61182cf924"

ORACLE_SYSTEM_PROMPT = """
You are the Dialectic Oracle. You ONLY answer using information in the <MAP_CONTEXT> block.
Every factual claim MUST be cited as [NODE: {description} | {provenance}].
Contradiction citations: [CONTRA: {type} between {node_a} and {node_b}].
If asked about something not in context: "That requires information not in your current selection. The loaded nodes cover: [list subjects]. Select nodes about [gap] to answer this."
Friction scale: <0.3 LOW, 0.3-0.6 MEDIUM, 0.6-0.85 HIGH, >0.85 CRITICAL.
Never introduce biology from your training that isn't grounded in a loaded node.
""".strip()

app = FastAPI(title="Dialectic API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup() -> None:
    load_session_from_disk(DEMO_SESSION_ID)


class SchemaAgentRequest(BaseModel):
    headers: list[str]
    sample_rows: list[dict[str, Any]]
    file_name: str


def _anthropic_client() -> AsyncAnthropic | None:
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    return AsyncAnthropic(api_key=api_key) if api_key else None


def _dedupe_nodes(nodes: list[ClaimNode]) -> list[ClaimNode]:
    deduped: dict[str, ClaimNode] = {}
    for node in nodes:
        deduped[node.node_id] = node
    return list(deduped.values())


def _update_session_state(session_id: str, **changes: Any) -> None:
    update_session(session_id, **changes)


def _public_provenance(node: ClaimNode) -> str:
    authors = node.paper_authors or "Unknown authors"
    year = node.paper_year if node.paper_year is not None else "n.d."
    sentence_number = node.sentence_id.split("::")[-1] if node.sentence_id else "?"
    return f"{authors} {year}, sent:{sentence_number}"


def _private_provenance(node: ClaimNode) -> str:
    row_value = node.row_index if node.row_index is not None else "?"
    file_name = node.file_name or "uploaded.csv"
    return f"Row {row_value} of {file_name}"


def _build_map_context(selected_nodes: list[ClaimNode], session_nodes: list[ClaimNode]) -> dict[str, Any]:
    node_lookup = {node.node_id: node for node in session_nodes}
    context_nodes: list[dict[str, Any]] = []
    for node in selected_nodes:
        contradicting_nodes = []
        for contradiction_id in node.contradicting_node_ids:
            other = node_lookup.get(contradiction_id)
            if other is None:
                continue
            contradicting_nodes.append(
                {
                    "node_id": other.node_id,
                    "claim_text": other.claim_text,
                    "source_type": other.source_type,
                }
            )

        context_nodes.append(
            {
                "node_id": node.node_id,
                "source_type": node.source_type,
                "claim_text": node.claim_text,
                "polarity": node.polarity,
                "subject_name": node.subject_name,
                "object_name": node.object_name,
                "quantitative_value": node.quantitative_value,
                "quantitative_unit": node.quantitative_unit,
                "cell_line": node.cell_line,
                "organism": node.organism,
                "friction_score": node.friction_score,
                "debate_state": node.debate_state,
                "skeptic_rationale": node.skeptic_rationale,
                "provenance_summary": _private_provenance(node)
                if node.source_type == "private_csv"
                else _public_provenance(node),
                "contradicting_nodes": contradicting_nodes,
            }
        )

    return {
        "selected_node_count": len(selected_nodes),
        "nodes": context_nodes,
    }


def _fallback_oracle_text(selected_nodes: list[ClaimNode], messages: list[dict[str, str]]) -> str:
    if not selected_nodes:
        return "That requires information not in your current selection. The loaded nodes cover: []. Select nodes about the missing topic to answer this."

    latest_user_prompt = ""
    for message in reversed(messages):
        if message["role"] == "user":
            latest_user_prompt = message["content"].lower()
            break

    if "red" in latest_user_prompt or "friction" in latest_user_prompt:
        ranked_nodes = sorted(selected_nodes, key=lambda node: node.friction_score, reverse=True)
        return " ".join(
            f"{node.claim_text} [NODE: {node.node_id} | "
            f"{_private_provenance(node) if node.source_type == 'private_csv' else _public_provenance(node)}]"
            f" has friction {node.friction_score:.2f}."
            for node in ranked_nodes[:3]
        )

    return " ".join(
        f"{node.claim_text} [NODE: {node.node_id} | "
        f"{_private_provenance(node) if node.source_type == 'private_csv' else _public_provenance(node)}]"
        for node in selected_nodes[:3]
    )


async def _stream_oracle_response(
    selected_nodes: list[ClaimNode],
    session_nodes: list[ClaimNode],
    messages: list[dict[str, str]],
) -> AsyncGenerator[str, None]:
    context = _build_map_context(selected_nodes, session_nodes)
    system_prompt = (
        ORACLE_SYSTEM_PROMPT
        + "\n\n<MAP_CONTEXT>\n"
        + json.dumps(context, ensure_ascii=True)
        + "\n</MAP_CONTEXT>"
    )
    client = _anthropic_client()

    if client is None:
        yield _fallback_oracle_text(selected_nodes, messages)
        return

    try:
        async with client.messages.stream(
            model="claude-sonnet-4-20250514",
            max_tokens=1500,
            system=system_prompt,
            messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                if text:
                    yield text
    except Exception:
        yield _fallback_oracle_text(selected_nodes, messages)


async def _run_ingestion_pipeline(
    session_id: str,
    csv_bytes: bytes | None,
    csv_name: str | None,
    search_query: str | None,
    paper_count: int,
    semantic_focus: str,
) -> None:
    try:
        _update_session_state(
            session_id,
            status="ingesting",
            progress=5,
            error_message=None,
            debate_results={},
        )

        private_nodes: list[ClaimNode] = []
        public_nodes: list[ClaimNode] = []

        if csv_bytes is not None and csv_name:
            private_nodes = await ingest_csv(csv_bytes, csv_name, semantic_focus)
            _update_session_state(
                session_id,
                nodes=_dedupe_nodes(private_nodes),
                status="ingesting",
                progress=25,
            )

        if search_query:
            public_nodes = await ingest_s2(search_query, paper_count, semantic_focus)
            _update_session_state(
                session_id,
                nodes=_dedupe_nodes(private_nodes + public_nodes),
                status="ingesting",
                progress=45,
            )

        nodes = _dedupe_nodes(private_nodes + public_nodes)
        if not nodes:
            raise ValueError("No claim nodes were extracted from the provided inputs.")

        if len(nodes) < 4:
            for node in nodes:
                node.umap_x = 0.0
                node.umap_y = 0.0
                node.friction_score = 0.0
                node.debate_state = "skipped"
                node.skeptic_rationale = "Not enough nodes were available to run embedding, UMAP, and debate."
                node.contradicting_node_ids = []

            _update_session_state(
                session_id,
                nodes=nodes,
                debate_results={"clusters": {}, "note": "Skipped debate because fewer than four nodes were ingested."},
                status="ready",
                progress=100,
                error_message=None,
            )
            return

        _update_session_state(session_id, nodes=nodes, status="embedding", progress=50)
        nodes, vectors = await embed_nodes(nodes)
        _update_session_state(session_id, nodes=nodes, status="embedding", progress=55)

        nodes = reduce_umap(nodes, vectors)
        _update_session_state(session_id, nodes=nodes, status="embedding", progress=60)

        session = get_session(session_id)
        if session is None:
            raise ValueError("Session was not found during the debate stage.")

        _update_session_state(session_id, nodes=nodes, status="debating", progress=60)
        nodes = await run_full_debate(nodes, session)

        _update_session_state(session_id, nodes=nodes, status="finalizing", progress=95)
        _update_session_state(session_id, nodes=nodes, status="ready", progress=100, error_message=None)
    except Exception as exc:
        _update_session_state(
            session_id,
            status="error",
            progress=100,
            error_message=str(exc),
        )


def _friction_distribution(nodes: list[ClaimNode]) -> dict[str, int]:
    distribution = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    for node in nodes:
        score = float(node.friction_score or 0.0)
        if score >= 0.85:
            distribution["critical"] += 1
        elif score >= 0.60:
            distribution["high"] += 1
        elif score >= 0.30:
            distribution["medium"] += 1
        else:
            distribution["low"] += 1
    return distribution


@app.post("/api/schema-agent")
async def schema_agent_route(request: SchemaAgentRequest) -> dict[str, Any]:
    analysis = await analyze_csv(
        headers=request.headers,
        sample_rows=request.sample_rows,
        file_name=request.file_name,
    )
    schema_analysis = analysis.get("schema_analysis", {})
    return {
        "column_mapping": schema_analysis.get("column_mapping", {}),
        "inferred_experiment_type": schema_analysis.get("inferred_experiment_type", "unknown"),
        "warnings": schema_analysis.get("warnings", []),
    }


@app.post("/api/ingest")
async def ingest_route(
    csv: UploadFile | None = File(default=None),
    search_query: str | None = Form(default=None),
    paper_count: int = Form(default=500),
    semantic_focus: str = Form(default=""),
) -> dict[str, str]:
    if csv is None and not (search_query and search_query.strip()):
        raise HTTPException(status_code=400, detail="Provide a CSV file, a Semantic Scholar query, or both.")

    csv_bytes = await csv.read() if csv is not None else None
    csv_name = csv.filename if csv is not None else None
    normalized_query = search_query.strip() if search_query else None

    session = create_session()
    asyncio.create_task(
        _run_ingestion_pipeline(
            session_id=session.session_id,
            csv_bytes=csv_bytes,
            csv_name=csv_name,
            search_query=normalized_query,
            paper_count=paper_count,
            semantic_focus=semantic_focus,
        )
    )
    return {"session_id": session.session_id}


@app.get("/api/demo")
async def demo_route() -> dict[str, str]:
    return {"session_id": DEMO_SESSION_ID}


@app.get("/api/session/{session_id}/status")
async def session_status_route(session_id: str) -> dict[str, Any]:
    session = get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return {
        "status": session.status,
        "progress": session.progress,
        "node_count": len(session.nodes),
        "error_message": session.error_message,
    }


@app.get("/api/session/{session_id}/nodes")
async def session_nodes_route(session_id: str) -> dict[str, Any]:
    session = get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return {"nodes": [node.model_dump() for node in session.nodes]}


@app.get("/api/session/{session_id}/debug")
async def session_debug_route(session_id: str) -> dict[str, Any]:
    session = get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    entity_pair_counts = session.debate_results.get("entity_pair_counts")
    entity_extraction_stats = session.debate_results.get("entity_extraction_stats")
    if entity_pair_counts is None or entity_extraction_stats is None:
        clean_index, _, entity_extraction_stats = await build_clean_entity_index(session.nodes)
        entity_pair_counts = summarize_entity_pair_counts(clean_index)

    sample_nodes = sorted(
        [node for node in session.nodes if float(node.friction_score or 0.0) > 0.5],
        key=lambda node: node.friction_score,
        reverse=True,
    )[:3]

    return {
        "total_nodes": len(session.nodes),
        "friction_distribution": _friction_distribution(session.nodes),
        "nodes_with_contradictions": sum(1 for node in session.nodes if node.contradicting_node_ids),
        "entity_pair_counts": entity_pair_counts,
        "entity_extraction_stats": entity_extraction_stats,
        "cross_corpus_pairs_evaluated": int(session.debate_results.get("cross_corpus_pairs_evaluated", 0) or 0),
        "pass1_cluster_count": int(session.debate_results.get("pass1_cluster_count", 0) or 0),
        "sample_contradictions": [
            {
                "node_id": node.node_id,
                "claim_text": node.claim_text,
                "friction_score": round(float(node.friction_score or 0.0), 3),
                "skeptic_rationale": node.skeptic_rationale or "",
                "contradicting_count": len(node.contradicting_node_ids),
            }
            for node in sample_nodes
        ],
    }


@app.post("/api/oracle")
async def oracle_route(request: OracleRequest) -> StreamingResponse:
    session = get_session(request.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    node_lookup = {node.node_id: node for node in session.nodes}
    selected_nodes = [node_lookup[node_id] for node_id in request.selected_node_ids if node_id in node_lookup]

    def provenance_summary(node: ClaimNode) -> str:
        if node.source_type == "private_csv":
            return f"Row {node.row_index} of {node.file_name or 'private file'}"

        authors_raw = (node.paper_authors or "").replace(" and ", ";").replace(",", ";")
        authors = [author.strip() for author in authors_raw.split(";") if author.strip()]
        author_str = ", ".join(authors[:2]) if authors else "Unknown"
        if len(authors) > 2:
            author_str = f"{author_str} et al."
        year = f" {node.paper_year}" if node.paper_year is not None else ""
        return f"{author_str}{year}, ({node.citation_count or 0} citations)"

    context = {
        "selected_node_count": len(selected_nodes),
        "is_bag_query": request.is_bag_query,
        "bag_name": request.bag_name,
        "nodes": [
            {
                "node_id": node.node_id,
                "source_type": node.source_type,
                "claim_text": node.claim_text,
                "polarity": node.polarity,
                "subject_name": node.subject_name,
                "object_name": node.object_name,
                "quantitative_value": node.quantitative_value,
                "quantitative_unit": node.quantitative_unit,
                "cell_line": node.cell_line,
                "organism": node.organism,
                "friction_score": node.friction_score,
                "debate_state": node.debate_state,
                "provenance_summary": provenance_summary(node),
                "source_url": getattr(node, "abstract_url", None),
                "skeptic_rationale": node.skeptic_rationale,
                "contradicting_nodes": [
                    {
                        "node_id": contra_id,
                        "claim_text": node_lookup[contra_id].claim_text if contra_id in node_lookup else "",
                        "source_type": node_lookup[contra_id].source_type if contra_id in node_lookup else "",
                        "friction_score": node_lookup[contra_id].friction_score if contra_id in node_lookup else 0,
                    }
                    for contra_id in (node.contradicting_node_ids or [])
                    if contra_id in node_lookup
                ],
            }
            for node in selected_nodes
        ],
    }

    if request.is_bag_query and selected_nodes:
        frictions = [float(node.friction_score or 0.0) for node in selected_nodes]
        context["bag_summary"] = {
            "bag_name": request.bag_name,
            "total_nodes": len(selected_nodes),
            "avg_friction": round(sum(frictions) / len(frictions), 3) if frictions else 0,
            "critical_count": sum(1 for value in frictions if value >= 0.85),
            "high_count": sum(1 for value in frictions if value >= 0.60),
            "contradicted_count": sum(1 for node in selected_nodes if node.contradicting_node_ids),
            "private_count": sum(1 for node in selected_nodes if node.source_type == "private_csv"),
            "public_count": sum(1 for node in selected_nodes if node.source_type == "public_abstract"),
        }

    messages = [
        {
            "role": "assistant" if message.get("role") == "assistant" else "user",
            "content": str(message.get("content", "")).strip(),
        }
        for message in request.messages
        if str(message.get("content", "")).strip()
    ]
    if not messages:
        messages = [{
            "role": "user",
            "content": "Summarize the selected nodes." if selected_nodes else "No nodes are selected.",
        }]

    oracle_system_prompt = """
You are the Dialectic Oracle.
You ONLY answer using information in the MAP_CONTEXT block.
Cite every factual claim as [NODE: description | provenance].
Friction: <0.3=LOW, 0.3-0.6=MEDIUM, 0.6-0.85=HIGH, >0.85=CRITICAL.
When answering about a @bag, lead with bag_summary stats before specifics.
Never use biology from training not grounded in a loaded node.
""".strip()

    async def generator() -> AsyncGenerator[str, None]:
        system_prompt = f"{oracle_system_prompt}\n\n<MAP_CONTEXT>\n{json.dumps(context, indent=2)}\n</MAP_CONTEXT>"
        client = _anthropic_client()

        if client is None:
            yield _fallback_oracle_text(selected_nodes, messages)
            return

        try:
            async with client.messages.stream(
                model="claude-sonnet-4-20250514",
                max_tokens=1500,
                system=system_prompt,
                messages=messages,
            ) as stream:
                async for text in stream.text_stream:
                    if text:
                        yield text
        except Exception:
            yield _fallback_oracle_text(selected_nodes, messages)

    return StreamingResponse(
        generator(),
        media_type="text/plain",
        headers={"Cache-Control": "no-cache"},
    )
