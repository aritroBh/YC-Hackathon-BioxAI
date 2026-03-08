from __future__ import annotations

import asyncio
import json
import os
import random
import time
from typing import Any, AsyncGenerator

from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agents import tamarind_arbiter
from agents.tamarind_arbiter import run_experiment as tamarind_run_experiment, run_tamarind_arbiter
from agents.schema_agent import analyze_csv
from models import ClaimNode, ExperimentRequest, OracleRequest, Session
from pipeline.contradiction_index import build_clean_entity_index, summarize_entity_pair_counts
from pipeline.debate_runner import run_full_debate
from pipeline.embedder import embed_nodes
from pipeline.ingest_csv import ingest_csv
from pipeline.ingest_pdf import ingest_pdf
from pipeline.ingest_s2 import ingest_s2
from pipeline.ingest_url import ingest_url
from pipeline.ingest_xlsx import ingest_xlsx
from pipeline.ingest_youtube import ingest_youtube
from pipeline.umap_reducer import reduce_umap
from session_store import create_session, get_session, load_session_from_disk, update_session

load_dotenv()
tamarind_arbiter.TAMARIND_API_KEY = os.getenv("TAMARIND_API_KEY", "").strip()

DEMO_SESSION_ID = "55500fc5f1654234b44f5d61182cf924"

ORACLE_SYSTEM_PROMPT = """
You are the Dialectic Oracle. You ONLY answer using information in the <MAP_CONTEXT> block.
Every factual claim MUST be cited as [NODE: {description} | {provenance}].
Contradiction citations: [CONTRA: {type} between {node_a} and {node_b}].
If asked about something not in context: "That requires information not in your current selection. The loaded nodes cover: [list subjects]. Select nodes about [gap] to answer this."
Friction scale: <0.3 LOW, 0.3-0.6 MEDIUM, 0.6-0.85 HIGH, >0.85 CRITICAL.
Never introduce biology from your training that isn't grounded in a loaded node.
""".strip()

MAX_SOURCE_ITEMS = 25
MIN_S2_PAPERS = 20
MAX_S2_PAPERS = 500
_SESSION_LOCKS: dict[str, asyncio.Lock] = {}

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


class UrlListRequest(BaseModel):
    urls: list[str]
    session_id: str | None = None
    semantic_focus: str = ""


class SemanticScholarRequest(BaseModel):
    query: str
    paper_count: int = 100
    session_id: str | None = None
    semantic_focus: str = ""


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


def _get_session_lock(session_id: str) -> asyncio.Lock:
    lock = _SESSION_LOCKS.get(session_id)
    if lock is None:
        lock = asyncio.Lock()
        _SESSION_LOCKS[session_id] = lock
    return lock


def _get_or_create_session(session_id: str | None) -> Session:
    if session_id:
        existing_session = get_session(session_id)
        if existing_session is not None:
            return existing_session
        return create_session(session_id=session_id)
    return create_session()


def _normalize_urls(urls: list[str]) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw_url in urls:
        url = str(raw_url or "").strip()
        if not url or url in seen:
            continue
        cleaned.append(url)
        seen.add(url)
    return cleaned


async def _gather_limited(items: list[Any], worker, limit: int = 5) -> list[Any]:
    semaphore = asyncio.Semaphore(limit)

    async def run(item: Any) -> Any:
        async with semaphore:
            return await worker(item)

    return await asyncio.gather(*(run(item) for item in items))


def _public_provenance(node: ClaimNode) -> str:
    if node.source_type == "pdf_document":
        return node.file_name or node.source_id or "PDF document"
    if node.source_type == "web_url":
        return node.abstract_url or node.source_id or "Web URL"
    if node.source_type == "youtube_video":
        return node.abstract_url or node.source_id or "YouTube transcript"
    authors = node.paper_authors or "Unknown authors"
    year = node.paper_year if node.paper_year is not None else "n.d."
    sentence_number = node.sentence_id.split("::")[-1] if node.sentence_id else "?"
    return f"{authors} {year}, sent:{sentence_number}"


def _private_provenance(node: ClaimNode) -> str:
    row_value = node.row_index if node.row_index is not None else "?"
    file_name = node.file_name or "uploaded.csv"
    return f"Row {row_value} of {file_name}"


def _node_provenance(node: ClaimNode) -> str:
    return _private_provenance(node) if node.source_type == "private_csv" else _public_provenance(node)


def _is_private_node(node: ClaimNode) -> bool:
    return node.source_type == "private_csv"


def _node_compound_name(node: ClaimNode) -> str:
    candidates = [
        (node.subject_type, node.subject_name),
        (node.object_type, node.object_name),
        (None, node.subject_name),
        (None, node.object_name),
    ]
    for value_type, value in candidates:
        if not value:
            continue
        if value_type is None or "compound" in value_type.lower():
            return value
    return "Unknown compound"


def _format_quantitative_value(node: ClaimNode) -> str:
    if node.quantitative_value is None:
        return "n/a"
    return f"{node.quantitative_value:g} {node.quantitative_unit or ''}".strip()


def _node_conditions(node: ClaimNode) -> str:
    parts = []
    if node.cell_line:
        parts.append(f"cell line {node.cell_line}")
    if node.predicate_relation:
        parts.append(f"assay {node.predicate_relation}")
    if node.quantitative_value is not None:
        parts.append(f"reported {_format_quantitative_value(node)}")
    return " | ".join(parts) if parts else "reference protocol"


def _has_tamarind_api_key() -> bool:
    return bool(os.getenv("TAMARIND_API_KEY", "").strip())


def _confidence_to_ic50_nm(score: float | None) -> float | None:
    if score is None:
        return None
    return round((10 ** (-score * 0.8)) * 100, 3)


def _binding_label(score: float | None) -> str:
    if score is None:
        return "No docking score available"
    if score > -1.5:
        return "Strong predicted binding"
    if score > -2.5:
        return "Moderate predicted binding"
    return "Weak predicted binding"


def _experiment_timeline(node_a: ClaimNode, node_b: ClaimNode, ran_direction_a: bool, ran_direction_b: bool) -> list[float]:
    final_score = min(1.0, max(float(node_a.friction_score or 0.0), float(node_b.friction_score or 0.0)))
    baseline = 0.1
    pass_one = min(1.0, round(final_score * 0.4, 3))
    cross_corpus = min(1.0, round(final_score * 0.7, 3))
    after_a = min(1.0, round(final_score * 0.88, 3)) if ran_direction_a else cross_corpus
    after_b = round(final_score, 3) if ran_direction_b else after_a
    return [baseline, pass_one, cross_corpus, after_a, after_b]


def _experiment_recommendation(
    direction_a: dict[str, Any] | None,
    direction_b: dict[str, Any] | None,
    node_a: ClaimNode,
    node_b: ClaimNode,
) -> str:
    compound_a = _node_compound_name(node_a)
    compound_b = _node_compound_name(node_b)

    score_a = direction_a.get("confidence_score") if direction_a else None
    score_b = direction_b.get("confidence_score") if direction_b else None

    if score_a is not None and score_b is not None:
        if score_a > score_b:
            return (
                f"My compound under the published protocol remains more favorable structurally "
                f"({score_a:.2f} vs {score_b:.2f}), suggesting protocol transfer explains more of the IC50 gap."
            )
        if score_b > score_a:
            return (
                f"The literature compound holds the stronger docking readout under your assay "
                f"({score_b:.2f} vs {score_a:.2f}), suggesting the discrepancy may reflect compound-specific behavior."
            )
        return (
            f"Both swap directions converge on nearly identical docking confidence for {compound_a} and {compound_b}, "
            "so the disagreement is more consistent with assay context than chemistry alone."
        )

    if score_a is not None:
        return (
            f"Direction A isolates {compound_a} under the published protocol and yields {score_a:.2f}; "
            "run Direction B to complete the cross-protocol comparison."
        )

    if score_b is not None:
        return (
            f"Direction B isolates {compound_b} under your private assay and yields {score_b:.2f}; "
            "run Direction A to complete the cross-protocol comparison."
        )

    return "DiffDock did not return a usable score for either direction."


def _sse_event(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _run_direction_experiment(primary_node: ClaimNode, protocol_node: ClaimNode, direction: str) -> dict[str, Any]:
    compound = _node_compound_name(primary_node)
    conditions = _node_conditions(protocol_node)
    timestamp = int(time.time())

    if not _has_tamarind_api_key():
        base_score = -1.42 if direction == "a" else -2.81
        score = round(base_score + random.uniform(-0.3, 0.3), 3)
        return {
            "job_id": f"dialectic-mock-{timestamp}-{direction}",
            "compound": compound,
            "conditions": conditions,
            "confidence_score": score,
            "estimated_ic50_nm": _confidence_to_ic50_nm(score),
            "verdict": _binding_label(score),
            "mock": True,
        }

    docking_node = primary_node.model_copy(
        update={
            "node_id": f"{primary_node.node_id}-experiment-{direction}",
            "claim_text": f"{compound} under {conditions}",
            "cell_line": protocol_node.cell_line or primary_node.cell_line,
            "predicate_relation": protocol_node.predicate_relation or primary_node.predicate_relation,
            "quantitative_value": primary_node.quantitative_value,
            "quantitative_unit": primary_node.quantitative_unit,
        }
    )
    protocol_context = protocol_node.model_copy(
        update={
            "node_id": f"{protocol_node.node_id}-protocol-{direction}",
            "subject_name": protocol_node.cell_line or protocol_node.predicate_relation or "Protocol context",
            "subject_type": "assay_context",
            "object_name": protocol_node.organism or protocol_node.object_name or "Reference context",
            "object_type": "assay_context",
        }
    )

    verdict = await run_tamarind_arbiter(docking_node, protocol_context)
    score = verdict.get("binding_affinity_a")

    return {
        "job_id": verdict.get("tamarind_job_id") or f"dialectic-live-{timestamp}-{direction}",
        "compound": verdict.get("compound_a") or compound,
        "conditions": conditions,
        "confidence_score": score,
        "estimated_ic50_nm": _confidence_to_ic50_nm(score),
        "verdict": verdict.get("verdict") or _binding_label(score),
        "mock": bool(verdict.get("mock")),
    }


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
                "provenance_summary": _node_provenance(node),
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
            f"{_node_provenance(node)}]"
            f" has friction {node.friction_score:.2f}."
            for node in ranked_nodes[:3]
        )

    return " ".join(
        f"{node.claim_text} [NODE: {node.node_id} | "
        f"{_node_provenance(node)}]"
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
) -> int:
    _update_session_state(
        session_id,
        status="ingesting",
        progress=5,
        error_message=None,
        debate_results={},
    )

    collected_nodes: list[ClaimNode] = []
    if csv_bytes is not None and csv_name:
        collected_nodes.extend(await ingest_csv(csv_bytes, csv_name, semantic_focus))
        _update_session_state(session_id, status="ingesting", progress=20, error_message=None)

    if search_query:
        collected_nodes.extend(await ingest_s2(search_query, paper_count, semantic_focus))
        _update_session_state(session_id, status="ingesting", progress=35, error_message=None)

    if not collected_nodes:
        raise ValueError("No claim nodes were extracted from the provided inputs.")

    return await _add_nodes_and_finalize(session_id, collected_nodes)


async def _finalize_session_pipeline(session_id: str) -> None:
    session = get_session(session_id)
    if session is None:
        raise ValueError("Session was not found during finalization.")

    nodes = _dedupe_nodes(session.nodes)
    if not nodes:
        raise ValueError("No claim nodes are available in the session.")

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

    _update_session_state(session_id, nodes=nodes, status="embedding", progress=55, error_message=None)
    nodes, vectors = await embed_nodes(nodes)
    _update_session_state(session_id, nodes=nodes, status="embedding", progress=68)

    nodes = reduce_umap(nodes, vectors)
    _update_session_state(session_id, nodes=nodes, status="embedding", progress=80)

    session = get_session(session_id)
    if session is None:
        raise ValueError("Session was not found during the debate stage.")

    _update_session_state(session_id, nodes=nodes, status="debating", progress=90)
    nodes = await run_full_debate(nodes, session)

    _update_session_state(session_id, nodes=nodes, status="finalizing", progress=97)
    _update_session_state(session_id, nodes=nodes, status="ready", progress=100, error_message=None)


async def _add_nodes_and_finalize(session_id: str, new_nodes: list[ClaimNode]) -> int:
    if not new_nodes:
        return 0

    async with _get_session_lock(session_id):
        session = get_session(session_id)
        if session is None:
            session = create_session(session_id=session_id)

        existing_ids = {node.node_id for node in session.nodes}
        merged_nodes = _dedupe_nodes(session.nodes + new_nodes)
        nodes_added = len([node for node in merged_nodes if node.node_id not in existing_ids])

        if nodes_added == 0 and session.nodes:
            return 0

        _update_session_state(
            session_id,
            nodes=merged_nodes,
            status="ingesting",
            progress=45,
            error_message=None,
            debate_results={},
        )
        await _finalize_session_pipeline(session_id)
        return nodes_added


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
    session_id: str | None = Form(default=None),
    search_query: str | None = Form(default=None),
    paper_count: int = Form(default=500),
    semantic_focus: str = Form(default=""),
) -> dict[str, Any]:
    if csv is None and not (search_query and search_query.strip()):
        raise HTTPException(status_code=400, detail="Provide a CSV file, a Semantic Scholar query, or both.")
    if not (MIN_S2_PAPERS <= paper_count <= MAX_S2_PAPERS):
        raise HTTPException(
            status_code=400,
            detail=f"Semantic Scholar paper count must be between {MIN_S2_PAPERS} and {MAX_S2_PAPERS}.",
        )

    session = _get_or_create_session(session_id)
    csv_bytes = await csv.read() if csv is not None else None
    csv_name = csv.filename if csv is not None else None
    normalized_query = search_query.strip() if search_query else None

    try:
        nodes_added = await _run_ingestion_pipeline(
            session_id=session.session_id,
            csv_bytes=csv_bytes,
            csv_name=csv_name,
            search_query=normalized_query,
            paper_count=paper_count,
            semantic_focus=semantic_focus,
        )
        return {"session_id": session.session_id, "nodes_added": nodes_added}
    except Exception as exc:
        _update_session_state(
            session.session_id,
            status="error",
            progress=100,
            error_message=str(exc),
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/s2-search")
async def semantic_scholar_route(request: SemanticScholarRequest) -> dict[str, Any]:
    normalized_query = request.query.strip()
    if len(normalized_query) < 3:
        raise HTTPException(status_code=400, detail="Semantic Scholar query must be at least 3 characters.")
    if not (MIN_S2_PAPERS <= request.paper_count <= MAX_S2_PAPERS):
        raise HTTPException(
            status_code=400,
            detail=f"Semantic Scholar paper count must be between {MIN_S2_PAPERS} and {MAX_S2_PAPERS}.",
        )

    session = _get_or_create_session(request.session_id)
    try:
        _update_session_state(session.session_id, status="ingesting", progress=5, error_message=None)
        new_nodes = await ingest_s2(normalized_query, request.paper_count, request.semantic_focus)
        if not new_nodes:
            raise ValueError("No Semantic Scholar claim nodes were extracted from the provided query.")
        nodes_added = await _add_nodes_and_finalize(session.session_id, new_nodes)
        return {"session_id": session.session_id, "nodes_added": nodes_added}
    except Exception as exc:
        _update_session_state(session.session_id, status="error", progress=100, error_message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/ingest/pdf")
async def ingest_pdf_route(
    files: list[UploadFile] = File(...),
    session_id: str | None = Form(default=None),
    semantic_focus: str = Form(default=""),
) -> dict[str, Any]:
    if not files:
        raise HTTPException(status_code=400, detail="Provide at least one PDF file.")
    if len(files) > MAX_SOURCE_ITEMS:
        raise HTTPException(status_code=400, detail=f"PDF uploads are limited to {MAX_SOURCE_ITEMS} files.")

    session = _get_or_create_session(session_id)
    _update_session_state(session.session_id, status="ingesting", progress=5, error_message=None)

    async def worker(upload: UploadFile) -> list[ClaimNode]:
        file_bytes = await upload.read()
        return await ingest_pdf(file_bytes, upload.filename or "document.pdf", semantic_focus)

    try:
        batches = await _gather_limited(files, worker, limit=5)
        nodes_added = await _add_nodes_and_finalize(
            session.session_id,
            [node for batch in batches for node in batch],
        )
        return {"session_id": session.session_id, "nodes_added": nodes_added}
    except Exception as exc:
        _update_session_state(session.session_id, status="error", progress=100, error_message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/ingest/urls")
async def ingest_urls_route(request: UrlListRequest) -> dict[str, Any]:
    urls = _normalize_urls(request.urls)
    if not urls:
        raise HTTPException(status_code=400, detail="Provide at least one URL.")
    if len(urls) > MAX_SOURCE_ITEMS:
        raise HTTPException(status_code=400, detail=f"URL ingestion is limited to {MAX_SOURCE_ITEMS} links.")

    session = _get_or_create_session(request.session_id)
    _update_session_state(session.session_id, status="ingesting", progress=5, error_message=None)

    try:
        batches = await _gather_limited(
            urls,
            lambda url: ingest_url(url, request.semantic_focus),
            limit=5,
        )
        nodes_added = await _add_nodes_and_finalize(
            session.session_id,
            [node for batch in batches for node in batch],
        )
        return {"session_id": session.session_id, "nodes_added": nodes_added}
    except Exception as exc:
        _update_session_state(session.session_id, status="error", progress=100, error_message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/ingest/youtube")
async def ingest_youtube_route(request: UrlListRequest) -> dict[str, Any]:
    urls = _normalize_urls(request.urls)
    if not urls:
        raise HTTPException(status_code=400, detail="Provide at least one YouTube URL.")
    if len(urls) > MAX_SOURCE_ITEMS:
        raise HTTPException(status_code=400, detail=f"YouTube ingestion is limited to {MAX_SOURCE_ITEMS} videos.")

    session = _get_or_create_session(request.session_id)
    _update_session_state(session.session_id, status="ingesting", progress=5, error_message=None)

    try:
        batches = await _gather_limited(
            urls,
            lambda url: ingest_youtube(url, request.semantic_focus),
            limit=5,
        )
        nodes_added = await _add_nodes_and_finalize(
            session.session_id,
            [node for batch in batches for node in batch],
        )
        return {"session_id": session.session_id, "nodes_added": nodes_added}
    except Exception as exc:
        _update_session_state(session.session_id, status="error", progress=100, error_message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/ingest/xlsx")
async def ingest_xlsx_route(
    files: list[UploadFile] = File(...),
    session_id: str | None = Form(default=None),
    semantic_focus: str = Form(default=""),
) -> dict[str, Any]:
    if not files:
        raise HTTPException(status_code=400, detail="Provide at least one Excel file.")
    if len(files) > MAX_SOURCE_ITEMS:
        raise HTTPException(status_code=400, detail=f"Excel uploads are limited to {MAX_SOURCE_ITEMS} files.")

    session = _get_or_create_session(session_id)
    _update_session_state(session.session_id, status="ingesting", progress=5, error_message=None)

    async def worker(upload: UploadFile) -> list[ClaimNode]:
        file_bytes = await upload.read()
        return await ingest_xlsx(file_bytes, upload.filename or "spreadsheet.xlsx", semantic_focus)

    try:
        batches = await _gather_limited(files, worker, limit=5)
        nodes_added = await _add_nodes_and_finalize(
            session.session_id,
            [node for batch in batches for node in batch],
        )
        return {"session_id": session.session_id, "nodes_added": nodes_added}
    except Exception as exc:
        _update_session_state(session.session_id, status="error", progress=100, error_message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/experiment/run")
async def run_experiment_endpoint(request: ExperimentRequest) -> StreamingResponse:
    session = get_session(request.session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    node_map = {node.node_id: node for node in session.nodes}
    node_a = node_map.get(request.node_a_id)
    node_b = node_map.get(request.node_b_id)
    if not node_a or not node_b:
        raise HTTPException(404, "Node not found")

    async def event_stream() -> AsyncGenerator[str, None]:
        def log(message: str) -> str:
            return f"data: {json.dumps({'event': 'log', 'message': message})}\n\n"

        yield log("Initializing experiment runner...")
        yield log(f"Node A: {node_a.subject_name} ({node_a.source_type})")
        yield log(f"Node B: {node_b.subject_name} ({node_b.source_type})")
        yield log("Submitting DiffDock jobs to Tamarind...")

        try:
            results = await tamarind_run_experiment(node_a, node_b, request.direction)
            yield log("DiffDock complete. Parsing confidence scores...")
            yield log("SurfDock running in background (~20 min)...")
            yield log("Generating visualizations...")
            yield f"data: {json.dumps({'event': 'complete', 'results': results})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'event': 'error', 'message': str(exc)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


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
        return _node_provenance(node)

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


@app.post("/api/claude")
async def claude_proxy(request: Request) -> dict[str, Any]:
    body = await request.json()
    import anthropic

    client = anthropic.Anthropic()
    response = client.messages.create(
        model=body.get("model", "claude-sonnet-4-20250514"),
        max_tokens=body.get("max_tokens", 1000),
        system=body.get("system", ""),
        messages=body.get("messages", []),
    )
    return {
        "content": [{"type": "text", "text": response.content[0].text}]
    }
