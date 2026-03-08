from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from datetime import datetime
from typing import Any

import httpx
from anthropic import AsyncAnthropic
from dotenv import load_dotenv

from models import ClaimNode

load_dotenv()

SEMANTIC_SCHOLAR_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
EUROPE_PMC_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
ABSTRACT_CLAIM_SYSTEM_PROMPT = (
    "Extract biological claims from this abstract. Return ONLY a JSON array. "
    "Each item: {sentence_index: int, sentence_text: str, claim_text: str, "
    "subject: {name, entity_type}, predicate: {relation, polarity, quantitative_value, quantitative_unit}, "
    "object: {name, entity_type}, context: {cell_line, organism, disease_context}}. "
    "Polarity must be: promotes|inhibits|neutral|ambiguous. Return empty array [] if no clear biological claims."
)

VALID_POLARITIES = {"promotes", "inhibits", "neutral", "ambiguous"}
VERB_POLARITY_RULES = [
    (r"\b(inhibit(?:s|ed|ion)?|suppress(?:es|ed|ion)?|reduce(?:s|d|tion)?|block(?:s|ed|ade)?)\b", "inhibits"),
    (r"\b(promote(?:s|d)?|activate(?:s|d|ion)?|increase(?:s|d)?|enhance(?:s|d|ment)?)\b", "promotes"),
    (r"\b(remain(?:s|ed)?|maintain(?:s|ed)?|show(?:s|ed)?)\b", "neutral"),
]


def _anthropic_client() -> AsyncAnthropic | None:
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    return AsyncAnthropic(api_key=api_key) if api_key else None


def _extract_json_payload(text: str) -> Any:
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate)
        candidate = re.sub(r"\s*```$", "", candidate)
    decoder = json.JSONDecoder()
    for index, char in enumerate(candidate):
        if char not in "[{":
            continue
        try:
            payload, _ = decoder.raw_decode(candidate[index:])
            return payload
        except json.JSONDecodeError:
            continue
    raise ValueError("No JSON payload found in Claude response.")


def _clean_text(value: Any, default: str | None = None) -> str | None:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _clean_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        match = re.search(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", str(value))
        return float(match.group(0)) if match else None


def _normalize_polarity(value: Any) -> str:
    polarity = str(value or "ambiguous").strip().lower()
    return polarity if polarity in VALID_POLARITIES else "ambiguous"


def _sentence_split(abstract: str) -> list[str]:
    return [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+", abstract)
        if len(sentence.strip()) > 40
    ]


def _infer_context(sentence: str) -> dict[str, Any]:
    lowered = sentence.lower()
    organism = None
    if "human" in lowered:
        organism = "human"
    elif "mouse" in lowered or "murine" in lowered:
        organism = "mouse"
    elif "rat" in lowered:
        organism = "rat"

    cell_line_match = re.search(r"\b[A-Z]{1,4}[A-Za-z0-9-]{2,8}\b", sentence)
    disease_match = re.search(
        r"\b([A-Za-z0-9\- ]+(?:cancer|tumor|carcinoma|disease|syndrome|infection|fibrosis))\b",
        sentence,
        flags=re.IGNORECASE,
    )

    return {
        "cell_line": cell_line_match.group(0) if cell_line_match else None,
        "organism": organism,
        "disease_context": disease_match.group(1).strip() if disease_match else None,
    }


def _extract_quantity(sentence: str) -> tuple[float | None, str | None]:
    match = re.search(r"([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([A-Za-z%/.-]+)?", sentence)
    if not match:
        return None, None
    return float(match.group(1)), match.group(2) if match.group(2) else None


def _heuristic_claims_from_abstract(paper: dict[str, Any]) -> list[dict[str, Any]]:
    title = _clean_text(paper.get("title"), "Untitled paper") or "Untitled paper"
    abstract = _clean_text(paper.get("abstract"), "") or ""
    claims: list[dict[str, Any]] = []
    for sentence_index, sentence in enumerate(_sentence_split(abstract)):
        polarity = "ambiguous"
        relation = "modulates"
        for pattern, matched_polarity in VERB_POLARITY_RULES:
            match = re.search(pattern, sentence, flags=re.IGNORECASE)
            if match:
                polarity = matched_polarity
                relation = match.group(1).lower()
                break

        quantitative_value, quantitative_unit = _extract_quantity(sentence)
        claims.append(
            {
                "sentence_index": sentence_index,
                "sentence_text": sentence,
                "claim_text": sentence.rstrip(".") + ".",
                "subject": {"name": title, "entity_type": "study"},
                "predicate": {
                    "relation": relation,
                    "polarity": polarity,
                    "quantitative_value": quantitative_value,
                    "quantitative_unit": quantitative_unit,
                },
                "object": {"name": sentence[:80], "entity_type": "biological_claim"},
                "context": _infer_context(sentence),
            }
        )
    return claims


def _author_summary(paper: dict[str, Any]) -> str | None:
    authors = paper.get("authors") or []
    names = [
        _clean_text(author.get("name"))
        for author in authors
        if isinstance(author, dict) and _clean_text(author.get("name"))
    ]
    if not names:
        return None
    if len(names) <= 3:
        return ", ".join(names)
    return f"{', '.join(names[:3])}, et al."


def _normalize_epmc_paper(result: dict[str, Any]) -> dict[str, Any]:
    author_string = _clean_text(result.get("authorString")) or ""
    authors = [
        {"name": name.strip()}
        for name in author_string.split(",")
        if name.strip()
    ]

    paper_id = (
        _clean_text(result.get("pmid"))
        or _clean_text(result.get("doi"))
        or _clean_text(result.get("id"))
        or "unknown-paper"
    )
    if not paper_id.startswith("epmc:"):
        paper_id = f"epmc:{paper_id}"

    cited_by_count = result.get("citedByCount")
    try:
        cited_by_count = int(cited_by_count) if cited_by_count is not None else None
    except (TypeError, ValueError):
        cited_by_count = None

    year = result.get("pubYear")
    try:
        year = int(year) if year is not None else None
    except (TypeError, ValueError):
        year = None

    full_text_urls = (((result.get("fullTextUrlList") or {}).get("fullTextUrl")) or [])
    abstract_url = None
    if full_text_urls and isinstance(full_text_urls, list):
        abstract_url = _clean_text(full_text_urls[0].get("url")) if isinstance(full_text_urls[0], dict) else None
    if not abstract_url:
        source = _clean_text(result.get("source"), "MED") or "MED"
        record_id = _clean_text(result.get("pmid")) or _clean_text(result.get("id")) or paper_id
        abstract_url = f"https://europepmc.org/article/{source}/{record_id}"

    return {
        "paperId": paper_id,
        "title": _clean_text(result.get("title"), "Untitled paper"),
        "authors": authors,
        "year": year,
        "venue": _clean_text(result.get("journalTitle")),
        "citationCount": cited_by_count,
        "abstract": _clean_text(result.get("abstractText"), "") or "",
        "abstract_url": abstract_url,
    }


async def _extract_claims_from_paper(
    paper: dict[str, Any],
    semaphore: asyncio.Semaphore,
    semantic_focus: str,
) -> list[dict[str, Any]]:
    client = _anthropic_client()
    if client is None:
        return _heuristic_claims_from_abstract(paper)

    title = _clean_text(paper.get("title"), "Untitled paper") or "Untitled paper"
    abstract = _clean_text(paper.get("abstract"), "") or ""
    user_message = f"Paper: {title}\nAbstract: {abstract}"
    if semantic_focus:
        user_message += f"\nSemantic focus: {semantic_focus}"

    async with semaphore:
        try:
            response = await asyncio.wait_for(
                client.messages.create(
                    model="claude-sonnet-4-20250514",
                    max_tokens=2500,
                    temperature=0,
                    system=ABSTRACT_CLAIM_SYSTEM_PROMPT,
                    messages=[{"role": "user", "content": user_message}],
                ),
                timeout=15,
            )
            response_text = "".join(
                block.text for block in response.content if getattr(block, "type", "") == "text"
            )
            parsed = _extract_json_payload(response_text)
            if not isinstance(parsed, list):
                raise ValueError("Abstract extraction response was not a JSON array.")
            return parsed
        except Exception:
            return _heuristic_claims_from_abstract(paper)


async def _fetch_papers_from_semantic_scholar(
    client: httpx.AsyncClient,
    query: str,
    paper_count: int,
) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    offset = 0

    while len(collected) < paper_count:
        response = None
        for attempt in range(4):
            response = await client.get(
                SEMANTIC_SCHOLAR_URL,
                params={
                    "query": query,
                    "offset": offset,
                    "limit": min(100, paper_count - len(collected)),
                    "fields": "paperId,title,authors,year,venue,citationCount,abstract",
                },
            )
            if response.status_code != 429:
                break
            await asyncio.sleep(2 * (attempt + 1))

        if response is None:
            break
        if response.status_code == 429:
            response.raise_for_status()

        response.raise_for_status()
        batch = response.json().get("data", [])
        if not batch:
            break
        collected.extend(batch)
        offset += len(batch)
        if len(batch) < 100:
            break

    return collected[:paper_count]


async def _fetch_papers_from_europe_pmc(
    client: httpx.AsyncClient,
    query: str,
    paper_count: int,
) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    cursor_mark = "*"

    while len(collected) < paper_count:
        page_size = min(100, paper_count - len(collected))
        response = await client.get(
            EUROPE_PMC_URL,
            params={
                "query": query,
                "resultType": "core",
                "format": "json",
                "pageSize": page_size,
                "cursorMark": cursor_mark,
            },
        )
        response.raise_for_status()
        payload = response.json()
        batch = (((payload.get("resultList") or {}).get("result")) or [])
        if not batch:
            break
        collected.extend(_normalize_epmc_paper(result) for result in batch)
        next_cursor_mark = payload.get("nextCursorMark")
        if not next_cursor_mark or next_cursor_mark == cursor_mark:
            break
        cursor_mark = next_cursor_mark

    return collected[:paper_count]


async def _fetch_papers(query: str, paper_count: int) -> list[dict[str, Any]]:
    if paper_count <= 0:
        return []

    async with httpx.AsyncClient(
        timeout=45,
        headers={"User-Agent": "Dialectic/1.0 (+local-dev)"},
    ) as client:
        try:
            papers = await _fetch_papers_from_semantic_scholar(client, query, paper_count)
            if papers:
                return papers
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 429:
                raise
        return await _fetch_papers_from_europe_pmc(client, query, paper_count)


def _claim_to_node(paper: dict[str, Any], claim: dict[str, Any]) -> ClaimNode | None:
    claim_text = _clean_text(claim.get("claim_text"))
    if not claim_text:
        return None

    subject = claim.get("subject") or {}
    predicate = claim.get("predicate") or {}
    obj = claim.get("object") or {}
    context = claim.get("context") or {}

    sentence_index = claim.get("sentence_index", 0)
    try:
        sentence_index = int(sentence_index)
    except (TypeError, ValueError):
        sentence_index = 0

    citation_count = paper.get("citationCount")
    try:
        citation_count = int(citation_count) if citation_count is not None else None
    except (TypeError, ValueError):
        citation_count = None

    paper_id = _clean_text(paper.get("paperId"), "unknown-paper") or "unknown-paper"
    node_id = str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"public::{paper_id}::{sentence_index}::{claim_text}",
        )
    )

    paper_year = paper.get("year")
    try:
        paper_year = int(paper_year) if paper_year is not None else None
    except (TypeError, ValueError):
        paper_year = None

    return ClaimNode(
        node_id=node_id,
        source_type="public_abstract",
        claim_text=claim_text,
        subject_name=_clean_text(subject.get("name"), _clean_text(paper.get("title"), "Unknown subject")) or "Unknown subject",
        subject_type=_clean_text(subject.get("entity_type"), "entity") or "entity",
        predicate_relation=_clean_text(predicate.get("relation"), "modulates") or "modulates",
        polarity=_normalize_polarity(predicate.get("polarity")),
        quantitative_value=_clean_float(predicate.get("quantitative_value")),
        quantitative_unit=_clean_text(predicate.get("quantitative_unit")),
        object_name=_clean_text(obj.get("name"), "Unknown object") or "Unknown object",
        object_type=_clean_text(obj.get("entity_type"), "entity") or "entity",
        cell_line=_clean_text(context.get("cell_line")),
        organism=_clean_text(context.get("organism")),
        disease_context=_clean_text(context.get("disease_context")),
        file_name=None,
        row_index=None,
        paper_id=paper_id,
        sentence_id=f"{paper_id}::sent::{sentence_index}",
        sentence_text=_clean_text(claim.get("sentence_text")),
        citation_count=citation_count,
        abstract_url=_clean_text(paper.get("abstract_url"), f"https://www.semanticscholar.org/paper/{paper_id}"),
        paper_authors=_author_summary(paper),
        paper_year=paper_year,
        ingested_at=datetime.utcnow().isoformat(),
    )


async def ingest_s2(query: str, paper_count: int, semantic_focus: str) -> list[ClaimNode]:
    papers = await _fetch_papers(query=query, paper_count=paper_count)
    eligible_papers = [
        paper
        for paper in papers
        if len((_clean_text(paper.get("abstract"), "") or "")) >= 150
    ]

    semaphore = asyncio.Semaphore(10)
    claim_batches = await asyncio.gather(
        *[
            _extract_claims_from_paper(
                paper=paper,
                semaphore=semaphore,
                semantic_focus=semantic_focus,
            )
            for paper in eligible_papers
        ],
        return_exceptions=True,
    )

    nodes_by_id: dict[str, ClaimNode] = {}
    for paper, claim_batch in zip(eligible_papers, claim_batches):
        if isinstance(claim_batch, Exception):
            claim_batch = _heuristic_claims_from_abstract(paper)
        for claim in claim_batch:
            node = _claim_to_node(paper, claim)
            if node is not None:
                nodes_by_id[node.node_id] = node

    return list(nodes_by_id.values())
