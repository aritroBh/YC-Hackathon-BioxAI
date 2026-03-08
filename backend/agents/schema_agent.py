from __future__ import annotations

import json
import os
import re
from typing import Any

from anthropic import AsyncAnthropic
from dotenv import load_dotenv

load_dotenv()

SCHEMA_SYSTEM_PROMPT = """
You are the Dialectic Schema Agent. Analyze CSV headers and sample rows.
Map each column to one of these semantic roles (or "unmapped"):
target_gene, compound_id, cell_line, mutation, assay_type, affinity_value,
affinity_unit, effect_direction, confidence, replicate_n, organism,
disease_context, timepoint, additional_notes

For each row in sample_rows, extract ONE atomic biological claim.

Return ONLY valid JSON (no markdown):
{
  "schema_analysis": {
    "confidence_score": float,
    "inferred_experiment_type": str,
    "column_mapping": {
      "<col_name>": { "semantic_role": str, "confidence": float, "normalization_notes": str }
    },
    "warnings": [str]
  },
  "extracted_claims": [
    {
      "source_row_index": int,
      "claim_text": str,
      "subject": { "name": str, "entity_type": str },
      "predicate": { "relation": str, "polarity": str, "quantitative_value": float|null, "quantitative_unit": str|null },
      "object": { "name": str, "entity_type": str },
      "context": { "cell_line": str|null, "organism": str|null, "disease_context": str|null },
      "extraction_confidence": float
    }
  ]
}

Rules:
- NEVER infer values not present in the row
- Polarity "inhibits" if IC50/Ki/Kd + reduction; "promotes" if activation/upregulation
- claim_text must be one atomic falsifiable sentence with numeric values and units
""".strip()

ROLE_KEYWORDS = {
    "target_gene": ["target", "gene", "protein", "receptor", "marker", "enzyme"],
    "compound_id": ["compound", "drug", "ligand", "molecule", "treatment", "inhibitor", "agonist"],
    "cell_line": ["cell line", "cell_line", "cell", "clone"],
    "mutation": ["mutation", "mutant", "variant", "allele"],
    "assay_type": ["assay", "readout", "screen", "method", "endpoint"],
    "affinity_value": ["ic50", "ec50", "kd", "ki", "potency", "affinity", "value", "percent", "viability", "expression"],
    "affinity_unit": ["unit", "units", "nm", "um", "mm", "μm", "uM", "%", "fold"],
    "effect_direction": ["effect", "direction", "response", "change", "regulation", "activity", "modulation"],
    "confidence": ["confidence", "score", "quality", "pvalue", "p-value", "significance"],
    "replicate_n": ["replicate", "replicates", "n"],
    "organism": ["organism", "species", "human", "mouse", "rat"],
    "disease_context": ["disease", "indication", "tumor", "cancer", "context", "phenotype"],
    "timepoint": ["time", "timepoint", "hour", "day", "duration"],
    "additional_notes": ["note", "comment", "description", "remark"],
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
    raise ValueError("No JSON object found in model response.")


def _stringify(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _extract_float(value: Any) -> float | None:
    if value is None:
        return None
    match = re.search(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", str(value))
    return float(match.group(0)) if match else None


def _normalize_header(header: str) -> str:
    return re.sub(r"[_\-\s]+", " ", header.strip().lower())


def _score_header_for_role(header: str, role: str) -> float:
    normalized = _normalize_header(header)
    best = 0.0
    for keyword in ROLE_KEYWORDS[role]:
        normalized_keyword = keyword.lower()
        if normalized == normalized_keyword:
            best = max(best, 0.98)
        elif normalized_keyword in normalized:
            overlap = min(len(normalized_keyword) / max(len(normalized), 1), 1.0)
            best = max(best, 0.6 + (0.35 * overlap))
    return round(best, 3)


def _infer_column_mapping(headers: list[str]) -> dict[str, dict[str, Any]]:
    mapping: dict[str, dict[str, Any]] = {}
    for header in headers:
        best_role = "unmapped"
        best_score = 0.0
        for role in ROLE_KEYWORDS:
            score = _score_header_for_role(header, role)
            if score > best_score:
                best_role = role
                best_score = score
        mapping[header] = {
            "semantic_role": best_role if best_score >= 0.55 else "unmapped",
            "confidence": round(best_score if best_score >= 0.55 else 0.25, 3),
            "normalization_notes": "Heuristic header keyword mapping.",
        }
    return mapping


def _pick_header(mapping: dict[str, dict[str, Any]], role: str) -> str | None:
    candidates = [
        (header, details["confidence"])
        for header, details in mapping.items()
        if details.get("semantic_role") == role
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[1], reverse=True)
    return candidates[0][0]


def _infer_experiment_type(headers: list[str], mapping: dict[str, dict[str, Any]]) -> str:
    normalized_headers = " ".join(_normalize_header(header) for header in headers)
    if any(token in normalized_headers for token in ("ic50", "ki", "kd", "affinity", "binding")):
        return "binding_affinity_assay"
    if _pick_header(mapping, "cell_line") and _pick_header(mapping, "effect_direction"):
        return "cell_response_assay"
    if _pick_header(mapping, "target_gene") and _pick_header(mapping, "mutation"):
        return "genotype_phenotype_assay"
    return "tabular_biology_dataset"


def _detect_polarity(effect_direction: str | None, quantitative_header: str | None, notes: str | None) -> str:
    haystack = " ".join(part for part in (effect_direction, quantitative_header, notes) if part).lower()
    if any(term in haystack for term in ("reduce", "decrease", "downreg", "suppress", "inhibit", "ic50", "ki", "kd")):
        return "inhibits"
    if any(term in haystack for term in ("increase", "upreg", "activate", "promote", "induce", "enhance")):
        return "promotes"
    if any(term in haystack for term in ("neutral", "no effect", "unchanged")):
        return "neutral"
    return "ambiguous"


def _relation_from_row(effect_direction: str | None, polarity: str, assay_type: str | None) -> str:
    if effect_direction:
        normalized = re.sub(r"[^a-z0-9\s_\-]", "", effect_direction.lower()).strip()
        if normalized:
            return normalized.replace(" ", "_")
    if assay_type:
        normalized_assay = re.sub(r"[^a-z0-9\s_\-]", "", assay_type.lower()).strip()
        if normalized_assay:
            return f"measured_in_{normalized_assay.replace(' ', '_')}"
    if polarity == "inhibits":
        return "inhibits"
    if polarity == "promotes":
        return "promotes"
    return "modulates"


def _trim_phrase(text: str | None, fallback: str) -> str:
    if not text:
        return fallback
    cleaned = re.sub(r"\s+", " ", str(text)).strip(" ,;:.")
    words = cleaned.split()
    if not words:
        return fallback
    return " ".join(words[:10])


def _build_claim_text(
    subject_name: str,
    relation: str,
    object_name: str,
    quantitative_value: float | None,
    quantitative_unit: str | None,
    cell_line: str | None,
    organism: str | None,
    disease_context: str | None,
) -> str:
    quant_fragment = ""
    if quantitative_value is not None:
        quant_fragment = f" at {quantitative_value:g}"
        if quantitative_unit:
            quant_fragment += f" {quantitative_unit}"
    context_parts = [
        f"in {cell_line}" if cell_line else None,
        f"in {organism}" if organism else None,
        f"under {disease_context}" if disease_context else None,
    ]
    context_fragment = ""
    filtered_context = [part for part in context_parts if part]
    if filtered_context:
        context_fragment = " " + ", ".join(filtered_context)
    return f"{subject_name} {relation.replace('_', ' ')} {object_name}{quant_fragment}{context_fragment}.".strip()


def _heuristic_extract_claims(
    sample_rows: list[dict[str, Any]], mapping: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    compound_header = _pick_header(mapping, "compound_id")
    target_header = _pick_header(mapping, "target_gene")
    cell_line_header = _pick_header(mapping, "cell_line")
    mutation_header = _pick_header(mapping, "mutation")
    assay_header = _pick_header(mapping, "assay_type")
    affinity_header = _pick_header(mapping, "affinity_value")
    unit_header = _pick_header(mapping, "affinity_unit")
    effect_header = _pick_header(mapping, "effect_direction")
    organism_header = _pick_header(mapping, "organism")
    disease_header = _pick_header(mapping, "disease_context")
    notes_header = _pick_header(mapping, "additional_notes")

    claims: list[dict[str, Any]] = []
    for row_number, row in enumerate(sample_rows):
        source_row_index = row.get("__source_row_index", row_number)
        compound_value = _stringify(row.get(compound_header)) if compound_header else None
        target_value = _stringify(row.get(target_header)) if target_header else None
        mutation_value = _stringify(row.get(mutation_header)) if mutation_header else None
        assay_value = _stringify(row.get(assay_header)) if assay_header else None
        effect_value = _stringify(row.get(effect_header)) if effect_header else None
        unit_value = _stringify(row.get(unit_header)) if unit_header else None
        note_value = _stringify(row.get(notes_header)) if notes_header else None
        organism_value = _stringify(row.get(organism_header)) if organism_header else None
        disease_value = _stringify(row.get(disease_header)) if disease_header else None
        cell_line_value = _stringify(row.get(cell_line_header)) if cell_line_header else None
        quantitative_value = _extract_float(row.get(affinity_header)) if affinity_header else None

        subject_name = compound_value or target_value or mutation_value or assay_value or "Observed condition"
        object_name = target_value or mutation_value or assay_value or disease_value or "measured phenotype"
        subject_type = "compound" if compound_value else "gene_or_biomarker"
        object_type = "gene" if target_value else "phenotype"
        polarity = _detect_polarity(effect_value, affinity_header, note_value)
        relation = _relation_from_row(effect_value, polarity, assay_value)

        if subject_name == object_name and assay_value:
            object_name = assay_value
            object_type = "assay"
        if subject_name == object_name and disease_value:
            object_name = disease_value
            object_type = "disease_context"

        subject_name = _trim_phrase(subject_name, "Observed condition")
        object_name = _trim_phrase(object_name, "measured phenotype")
        claim_text = _build_claim_text(
            subject_name=subject_name,
            relation=relation,
            object_name=object_name,
            quantitative_value=quantitative_value,
            quantitative_unit=unit_value,
            cell_line=cell_line_value,
            organism=organism_value,
            disease_context=disease_value,
        )
        claims.append(
            {
                "source_row_index": int(source_row_index),
                "claim_text": claim_text,
                "subject": {"name": subject_name, "entity_type": subject_type},
                "predicate": {
                    "relation": relation,
                    "polarity": polarity,
                    "quantitative_value": quantitative_value,
                    "quantitative_unit": unit_value,
                },
                "object": {"name": object_name, "entity_type": object_type},
                "context": {
                    "cell_line": cell_line_value,
                    "organism": organism_value,
                    "disease_context": disease_value,
                },
                "extraction_confidence": 0.67,
            }
        )
    return claims


def _heuristic_analysis(headers: list[str], sample_rows: list[dict[str, Any]]) -> dict[str, Any]:
    mapping = _infer_column_mapping(headers)
    warnings: list[str] = []
    if all(details["semantic_role"] == "unmapped" for details in mapping.values()):
        warnings.append("No strong biological column mapping was inferred from the provided headers.")
    if len(sample_rows) < 3:
        warnings.append("Fewer than three preview rows were supplied; extraction confidence may be lower.")
    experiment_type = _infer_experiment_type(headers, mapping)
    return {
        "schema_analysis": {
            "confidence_score": 0.72 if not warnings else 0.61,
            "inferred_experiment_type": experiment_type,
            "column_mapping": mapping,
            "warnings": warnings,
        },
        "extracted_claims": _heuristic_extract_claims(sample_rows, mapping),
    }


async def analyze_csv(
    headers: list[str],
    sample_rows: list[dict[str, Any]],
    file_name: str,
    mode: str = "analyze_and_extract",
    semantic_focus: str = "",
) -> dict[str, Any]:
    client = _anthropic_client()
    if client is None:
        return _heuristic_analysis(headers, sample_rows)

    prompt_payload = {
        "file_name": file_name,
        "mode": mode,
        "semantic_focus": semantic_focus,
        "headers": headers,
        "sample_rows": sample_rows,
        "instructions": (
            "Rows may include a metadata field named __source_row_index. "
            "If it exists, preserve that integer in source_row_index."
        ),
    }

    try:
        response = await client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=4000,
            temperature=0,
            system=SCHEMA_SYSTEM_PROMPT,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Analyze this CSV sample and return the required JSON object.\n"
                        f"{json.dumps(prompt_payload, ensure_ascii=True)}"
                    ),
                }
            ],
        )
        text = "".join(
            block.text for block in response.content if getattr(block, "type", "") == "text"
        )
        payload = _extract_json_payload(text)
        if not isinstance(payload, dict):
            raise ValueError("Schema agent response was not a JSON object.")
        return payload
    except Exception:
        return _heuristic_analysis(headers, sample_rows)
