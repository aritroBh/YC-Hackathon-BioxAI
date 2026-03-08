from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from datetime import datetime
from typing import Any

from anthropic import AsyncAnthropic
from dotenv import load_dotenv

from models import ClaimNode

load_dotenv()

MAX_CHUNK_CHARS = 600
OVERLAP_CHARS = 100
VALID_POLARITIES = {"promotes", "inhibits", "neutral", "ambiguous"}
TEXT_CLAIM_SYSTEM_PROMPT = """
Extract biological claims from the provided text chunk.
Return ONLY a valid JSON array.
Each item must have this shape:
[
  {
    "sentence_index": int,
    "sentence_text": str,
    "claim_text": str,
    "subject": {"name": str, "entity_type": str},
    "predicate": {
      "relation": str,
      "polarity": "promotes|inhibits|neutral|ambiguous",
      "quantitative_value": float | null,
      "quantitative_unit": str | null
    },
    "object": {"name": str, "entity_type": str},
    "context": {"cell_line": str | null, "organism": str | null, "disease_context": str | null}
  }
]

Rules:
- Extract only concrete biological or experimental claims.
- Keep claims atomic and falsifiable.
- Return [] when the chunk contains no usable claims.
""".strip()
VERB_POLARITY_RULES = [
    (r"\b(inhibit(?:s|ed|ion)?|suppress(?:es|ed|ion)?|reduce(?:s|d|tion)?|block(?:s|ed|ade)?)\b", "inhibits"),
    (r"\b(promote(?:s|d)?|activate(?:s|d|ion)?|increase(?:s|d)?|enhance(?:s|d|ment)?)\b", "promotes"),
    (r"\b(remain(?:s|ed)?|maintain(?:s|ed)?|show(?:s|ed)?)\b", "neutral"),
]
COMMON_ENTITY_WORDS = {
    "The",
    "These",
    "Those",
    "This",
    "That",
    "Figure",
    "Figures",
    "Table",
    "Tables",
    "Results",
    "Result",
    "Study",
    "Studies",
}


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
    raise ValueError("No JSON payload found in chunk extraction response.")


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


def _sentence_split(text: str) -> list[str]:
    return [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+", text)
        if len(sentence.strip()) >= 45
    ]


def _extract_quantity(sentence: str) -> tuple[float | None, str | None]:
    match = re.search(r"([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([A-Za-z%/.-]+)?", sentence)
    if not match:
        return None, None
    return float(match.group(1)), match.group(2) if match.group(2) else None


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


def _extract_candidate_entities(sentence: str) -> list[str]:
    candidates: list[str] = []
    patterns = [
        r"\b[A-Z0-9]{2,}(?:[-/][A-Z0-9]+)*\b",
        r"\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, sentence):
            token = match.group(0).strip()
            if token in COMMON_ENTITY_WORDS or token.lower() in {"http", "https"}:
                continue
            if token not in candidates:
                candidates.append(token)
    return candidates


def _heuristic_claims_from_chunk(chunk_text: str, chunk_index: int, title: str) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    for sentence_index, sentence in enumerate(_sentence_split(chunk_text)):
        polarity = "ambiguous"
        relation = "modulates"
        for pattern, matched_polarity in VERB_POLARITY_RULES:
            match = re.search(pattern, sentence, flags=re.IGNORECASE)
            if match:
                polarity = matched_polarity
                relation = match.group(1).lower()
                break

        quantitative_value, quantitative_unit = _extract_quantity(sentence)
        entities = _extract_candidate_entities(sentence)
        subject_name = entities[0] if entities else title
        object_name = entities[1] if len(entities) > 1 else sentence[:80]

        claims.append(
            {
                "sentence_index": (chunk_index * 1000) + sentence_index,
                "sentence_text": sentence,
                "claim_text": sentence.rstrip(".") + ".",
                "subject": {"name": subject_name, "entity_type": "entity"},
                "predicate": {
                    "relation": relation,
                    "polarity": polarity,
                    "quantitative_value": quantitative_value,
                    "quantitative_unit": quantitative_unit,
                },
                "object": {"name": object_name, "entity_type": "biological_claim"},
                "context": _infer_context(sentence),
            }
        )
    return claims


async def _extract_claims_from_chunk(
    chunk_text: str,
    chunk_index: int,
    title: str,
    semantic_focus: str,
    semaphore: asyncio.Semaphore,
) -> list[dict[str, Any]]:
    client = _anthropic_client()
    if client is None:
        return _heuristic_claims_from_chunk(chunk_text, chunk_index, title)

    prompt_payload = {
        "title": title,
        "semantic_focus": semantic_focus,
        "chunk_index": chunk_index,
        "text_chunk": chunk_text,
    }

    async with semaphore:
        try:
            response = await asyncio.wait_for(
                client.messages.create(
                    model="claude-sonnet-4-20250514",
                    max_tokens=2500,
                    temperature=0,
                    system=TEXT_CLAIM_SYSTEM_PROMPT,
                    messages=[
                        {
                            "role": "user",
                            "content": json.dumps(prompt_payload, ensure_ascii=True),
                        }
                    ],
                ),
                timeout=20,
            )
            response_text = "".join(
                block.text for block in response.content if getattr(block, "type", "") == "text"
            )
            parsed = _extract_json_payload(response_text)
            if not isinstance(parsed, list):
                raise ValueError("Chunk extraction response was not a JSON array.")
            return parsed
        except Exception:
            return _heuristic_claims_from_chunk(chunk_text, chunk_index, title)


def chunk_text(text: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        return []

    chunks: list[str] = []
    start = 0
    step = MAX_CHUNK_CHARS - OVERLAP_CHARS
    while start < len(normalized):
        end = min(start + MAX_CHUNK_CHARS, len(normalized))
        chunks.append(normalized[start:end])
        start += step
    return chunks


def _claim_to_node(
    claim: dict[str, Any],
    *,
    source_type: str,
    base_source_id: str,
    node_source_id: str,
    source_url: str | None,
    sentence_index: int,
    title: str,
) -> ClaimNode | None:
    claim_text = _clean_text(claim.get("claim_text"))
    if not claim_text:
        return None

    subject = claim.get("subject") or {}
    predicate = claim.get("predicate") or {}
    obj = claim.get("object") or {}
    context = claim.get("context") or {}

    node_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{source_type}::{base_source_id}::{claim_text}"))

    return ClaimNode(
        node_id=node_id,
        source_type=source_type,
        source_id=node_source_id,
        claim_text=claim_text,
        subject_name=_clean_text(subject.get("name"), title) or title,
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
        file_name=title if source_type == "pdf_document" else None,
        row_index=None,
        paper_id=title or base_source_id,
        sentence_id=f"{base_source_id}::sent::{sentence_index}",
        sentence_text=_clean_text(claim.get("sentence_text")),
        citation_count=None,
        abstract_url=source_url,
        paper_authors=None,
        paper_year=None,
        ingested_at=datetime.utcnow().isoformat(),
    )


async def parse_claims_from_text(
    text: str,
    source_type: str,
    source_id: str,
    source_url: str | None,
    *,
    semantic_focus: str = "",
    title: str | None = None,
    chunk_source_ids: bool = False,
) -> list[ClaimNode]:
    text_chunks = chunk_text(text)
    if not text_chunks:
        return []

    source_title = title or source_id
    semaphore = asyncio.Semaphore(5)
    claim_batches = await asyncio.gather(
        *[
            _extract_claims_from_chunk(
                chunk_text=chunk,
                chunk_index=chunk_index,
                title=source_title,
                semantic_focus=semantic_focus,
                semaphore=semaphore,
            )
            for chunk_index, chunk in enumerate(text_chunks)
        ]
    )

    nodes_by_id: dict[str, ClaimNode] = {}
    sentence_counter = 0
    for chunk_index, claims in enumerate(claim_batches):
        node_source_id = f"{source_id}::chunk::{chunk_index}" if chunk_source_ids else source_id
        for claim in claims:
            node = _claim_to_node(
                claim,
                source_type=source_type,
                base_source_id=source_id,
                node_source_id=node_source_id,
                source_url=source_url,
                sentence_index=sentence_counter,
                title=source_title,
            )
            sentence_counter += 1
            if node is not None:
                nodes_by_id[node.node_id] = node

    return list(nodes_by_id.values())
