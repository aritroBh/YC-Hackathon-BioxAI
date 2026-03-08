from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import os
import re
import uuid
from datetime import datetime
from typing import Any

from anthropic import AsyncAnthropic
from dotenv import load_dotenv

from agents.schema_agent import analyze_csv
from models import ClaimNode

load_dotenv()

BATCH_EXTRACTION_SYSTEM_PROMPT = (
    "Given this column mapping and these rows, extract one claim per row. "
    "Return JSON array only — same format as before: "
    "[{source_row_index, claim_text, subject, predicate, object, context}]"
)

VALID_POLARITIES = {"promotes", "inhibits", "neutral", "ambiguous"}


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
    raise ValueError("No JSON payload found in extraction response.")


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


def _normalize_entity(value: Any, default_name: str, default_type: str) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if value is None:
        return {"name": default_name, "entity_type": default_type}
    return {"name": _clean_text(value, default_name), "entity_type": default_type}


def _normalize_predicate(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if value is None:
        return {
            "relation": "modulates",
            "polarity": "ambiguous",
            "quantitative_value": None,
            "quantitative_unit": None,
        }
    return {
        "relation": _clean_text(value, "modulates"),
        "polarity": "ambiguous",
        "quantitative_value": None,
        "quantitative_unit": None,
    }


def _normalize_context(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {
        "cell_line": None,
        "organism": None,
        "disease_context": _clean_text(value),
    }


def _rows_with_indices(rows: list[dict[str, Any]], start_index: int = 0) -> list[dict[str, Any]]:
    enriched_rows: list[dict[str, Any]] = []
    for offset, row in enumerate(rows, start=start_index):
        enriched_row = dict(row)
        enriched_row["__source_row_index"] = offset
        enriched_rows.append(enriched_row)
    return enriched_rows


def _claim_to_node(claim: dict[str, Any], file_hash: str, file_name: str) -> ClaimNode | None:
    if not isinstance(claim, dict):
        return None
    claim_text = _clean_text(claim.get("claim_text"))
    if not claim_text:
        return None

    subject = _normalize_entity(claim.get("subject"), "Unknown subject", "entity")
    predicate = _normalize_predicate(claim.get("predicate"))
    obj = _normalize_entity(claim.get("object"), "Unknown object", "entity")
    context = _normalize_context(claim.get("context"))

    row_index = claim.get("source_row_index")
    try:
        row_index = int(row_index) if row_index is not None else None
    except (TypeError, ValueError):
        row_index = None

    node_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"private::{file_hash}::{claim_text}"))
    quantitative_value = _clean_float(predicate.get("quantitative_value"))

    return ClaimNode(
        node_id=node_id,
        source_type="private_csv",
        claim_text=claim_text,
        subject_name=_clean_text(subject.get("name"), "Unknown subject") or "Unknown subject",
        subject_type=_clean_text(subject.get("entity_type"), "entity") or "entity",
        predicate_relation=_clean_text(predicate.get("relation"), "modulates") or "modulates",
        polarity=_normalize_polarity(predicate.get("polarity")),
        quantitative_value=quantitative_value,
        quantitative_unit=_clean_text(predicate.get("quantitative_unit")),
        object_name=_clean_text(obj.get("name"), "Unknown object") or "Unknown object",
        object_type=_clean_text(obj.get("entity_type"), "entity") or "entity",
        cell_line=_clean_text(context.get("cell_line")),
        organism=_clean_text(context.get("organism")),
        disease_context=_clean_text(context.get("disease_context")),
        file_name=file_name,
        row_index=row_index,
        paper_id=None,
        sentence_id=None,
        sentence_text=None,
        citation_count=None,
        abstract_url=None,
        ingested_at=datetime.utcnow().isoformat(),
    )


async def _extract_batch_with_claude(
    headers: list[str],
    column_mapping: dict[str, Any],
    rows: list[dict[str, Any]],
    file_name: str,
    semantic_focus: str,
) -> list[dict[str, Any]]:
    client = _anthropic_client()
    if client is None:
        fallback = await analyze_csv(
            headers=headers,
            sample_rows=rows,
            file_name=file_name,
            mode="extract_only",
            semantic_focus=semantic_focus,
        )
        return list(fallback.get("extracted_claims", []))

    payload = {
        "file_name": file_name,
        "semantic_focus": semantic_focus,
        "headers": headers,
        "column_mapping": column_mapping,
        "rows": rows,
    }

    try:
        response = await asyncio.wait_for(
            client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=4000,
                temperature=0,
                system=BATCH_EXTRACTION_SYSTEM_PROMPT,
                messages=[
                    {
                        "role": "user",
                        "content": json.dumps(payload, ensure_ascii=True),
                    }
                ],
            ),
            timeout=15,
        )
        response_text = "".join(
            block.text for block in response.content if getattr(block, "type", "") == "text"
        )
        parsed = _extract_json_payload(response_text)
        if isinstance(parsed, dict):
            return list(parsed.get("extracted_claims", []))
        if not isinstance(parsed, list):
            raise ValueError("Batch extraction response was not a JSON array.")
        return parsed
    except Exception:
        fallback = await analyze_csv(
            headers=headers,
            sample_rows=rows,
            file_name=file_name,
            mode="extract_only",
            semantic_focus=semantic_focus,
        )
        return list(fallback.get("extracted_claims", []))


async def ingest_csv(file_bytes: bytes, file_name: str, semantic_focus: str) -> list[ClaimNode]:
    decoded = file_bytes.decode("utf-8", errors="ignore")
    reader = csv.DictReader(io.StringIO(decoded))
    headers = reader.fieldnames or []
    all_rows = list(reader)
    if not headers or not all_rows:
        return []

    file_hash = hashlib.sha256(file_bytes).hexdigest()
    first_rows = _rows_with_indices(all_rows[:10], start_index=0)
    schema_result = await analyze_csv(
        headers=headers,
        sample_rows=first_rows,
        file_name=file_name,
        semantic_focus=semantic_focus,
    )
    column_mapping = (schema_result.get("schema_analysis") or {}).get("column_mapping", {})

    nodes_by_id: dict[str, ClaimNode] = {}
    for claim in schema_result.get("extracted_claims", []):
        node = _claim_to_node(claim, file_hash=file_hash, file_name=file_name)
        if node is not None:
            nodes_by_id[node.node_id] = node

    for batch_start in range(10, len(all_rows), 50):
        batch_rows = _rows_with_indices(all_rows[batch_start : batch_start + 50], start_index=batch_start)
        extracted_claims = await _extract_batch_with_claude(
            headers=headers,
            column_mapping=column_mapping,
            rows=batch_rows,
            file_name=file_name,
            semantic_focus=semantic_focus,
        )
        for claim in extracted_claims:
            node = _claim_to_node(claim, file_hash=file_hash, file_name=file_name)
            if node is not None:
                nodes_by_id[node.node_id] = node

    return list(nodes_by_id.values())
