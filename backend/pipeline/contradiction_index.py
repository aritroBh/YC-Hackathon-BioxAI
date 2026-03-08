from __future__ import annotations

import asyncio
import json
import os
import re
from collections import defaultdict
from typing import Any

from anthropic import AsyncAnthropic

KNOWN_GENES = {
    "kras",
    "nras",
    "hras",
    "braf",
    "egfr",
    "her2",
    "erbb2",
    "tp53",
    "p53",
    "pten",
    "rb1",
    "apc",
    "brca1",
    "brca2",
    "myc",
    "cmyc",
    "alk",
    "met",
    "ret",
    "ros1",
    "ntrk",
    "fgfr",
    "pdgfr",
    "kit",
    "flt3",
    "jak2",
    "stat3",
    "pi3k",
    "pik3ca",
    "akt",
    "mtor",
    "erk",
    "mek",
    "raf",
    "ras",
    "src",
    "abl",
    "bcrabl",
    "cdk4",
    "cdk6",
    "rb",
    "mdm2",
    "vegf",
    "vegfr",
    "pd1",
    "pdl1",
    "ctla4",
    "idh1",
    "idh2",
    "nf1",
    "nf2",
    "vhl",
    "stk11",
}

KNOWN_MUTATIONS = {
    "g12c",
    "g12d",
    "g12v",
    "g13d",
    "v600e",
    "v600k",
    "t790m",
    "l858r",
    "exon19del",
    "exon20ins",
    "h1047r",
    "h1047l",
    "e545k",
    "r175h",
    "r248w",
    "r273h",
    "c797s",
    "t315i",
    "f317l",
    "d816v",
}

KNOWN_COMPOUNDS = {
    "amg510",
    "sotorasib",
    "mrtx849",
    "adagrasib",
    "ars1620",
    "ami1",
    "erlotinib",
    "gefitinib",
    "osimertinib",
    "afatinib",
    "lapatinib",
    "vemurafenib",
    "dabrafenib",
    "trametinib",
    "cobimetinib",
    "binimetinib",
    "imatinib",
    "dasatinib",
    "nilotinib",
    "ponatinib",
    "bosutinib",
    "alpelisib",
    "copanlisib",
    "idelalisib",
    "duvelisib",
    "palbociclib",
    "ribociclib",
    "abemaciclib",
    "olaparib",
    "niraparib",
    "rucaparib",
    "talazoparib",
    "pembrolizumab",
    "nivolumab",
    "atezolizumab",
    "durvalumab",
    "ipilimumab",
}

KNOWN_PATHWAYS = {
    "mapk",
    "pi3k",
    "akt",
    "mtor",
    "jakstat",
    "nfkb",
    "wnt",
    "hedgehog",
    "notch",
    "tgfb",
    "vegf",
    "apoptosis",
    "autophagy",
    "cellcycle",
    "dnarepair",
    "oxidativephosphorylation",
    "glycolysis",
}

_ENTITY_RANK = {
    "compound": 0,
    "gene_mutation": 1,
    "gene": 2,
    "pathway": 3,
    "unknown": 4,
}
_FILLER_WORDS = {
    "the",
    "this",
    "that",
    "compound",
    "treatment",
    "drug",
    "inhibitor",
    "agent",
    "molecule",
    "activity",
    "effect",
    "level",
    "levels",
    "expression",
    "cell",
    "cells",
    "showed",
    "increase",
    "increased",
    "decrease",
    "decreased",
    "reduce",
    "reduced",
    "enhance",
    "enhanced",
    "mediate",
    "mediated",
    "mutant",
    "mutation",
    "protein",
    "receptor",
    "signaling",
    "signalling",
    "phosphorylation",
    "viability",
    "response",
    "sensitivity",
    "resistance",
    "pathway",
}
_GENERIC_NON_ENTITY_WORDS = {
    "cancer",
    "tumor",
    "tumors",
    "carcinoma",
    "disease",
    "diseases",
    "therapy",
    "therapies",
    "treatment",
    "treatments",
    "response",
    "responses",
    "benefit",
    "efficacy",
    "effectiveness",
    "mechanism",
    "mechanisms",
    "challenge",
    "challenges",
    "activity",
    "activities",
    "binding",
    "survival",
    "dependency",
    "dependencies",
    "xenograft",
    "xenografts",
    "model",
    "models",
    "phenotype",
    "phenotypes",
    "combination",
    "combinations",
    "score",
    "scores",
    "line",
    "lines",
    "patient",
    "patients",
    "overall",
    "clinical",
    "meaningful",
    "singleagent",
}
_FLEX_SEP = r"[\s\-_()/,]*"
_SORTED_GENES = sorted(KNOWN_GENES, key=len, reverse=True)
_SORTED_MUTATIONS = sorted(KNOWN_MUTATIONS, key=len, reverse=True)
_SORTED_COMPOUNDS = sorted(KNOWN_COMPOUNDS, key=len, reverse=True)
_SORTED_PATHWAYS = sorted(KNOWN_PATHWAYS, key=len, reverse=True)

_GENE_MUT_PATTERN = re.compile(
    r"\b("
    + "|".join(re.escape(gene) for gene in _SORTED_GENES)
    + r")"
    + _FLEX_SEP
    + r"("
    + "|".join(re.escape(mutation) for mutation in _SORTED_MUTATIONS)
    + r")\b",
    re.IGNORECASE,
)

_GENE_PATTERNS = {}
_COMPOUND_PATTERNS = {}
_PATHWAY_PATTERNS = {}
_ENTITY_INDEX_CACHE: dict[
    tuple[tuple[str, str, str, str], ...],
    tuple[dict[str, list[str]], dict[str, tuple[str, str]], dict[str, int]],
] = {}
_ANTHROPIC_CLIENT: AsyncAnthropic | None = None
_ANTHROPIC_CLIENT_READY = False


def normalize_entity(name: str) -> str:
    if not name:
        return ""
    normalized = name.lower().strip()
    normalized = re.sub(r"[\s\-_()/,]", "", normalized)
    normalized = re.sub(r"[^a-z0-9]", "", normalized)
    return normalized


def _compile_entity_patterns() -> None:
    global _GENE_PATTERNS
    global _COMPOUND_PATTERNS
    global _PATHWAY_PATTERNS
    if _GENE_PATTERNS:
        return

    def compile_pattern(entity: str) -> re.Pattern[str]:
        body = _FLEX_SEP.join(re.escape(char) for char in entity)
        return re.compile(rf"\b{body}\b", re.IGNORECASE)

    _GENE_PATTERNS = {gene: compile_pattern(gene) for gene in _SORTED_GENES}
    _COMPOUND_PATTERNS = {compound: compile_pattern(compound) for compound in _SORTED_COMPOUNDS}
    _PATHWAY_PATTERNS = {pathway: compile_pattern(pathway) for pathway in _SORTED_PATHWAYS}


def _anthropic_client() -> AsyncAnthropic | None:
    global _ANTHROPIC_CLIENT
    global _ANTHROPIC_CLIENT_READY
    if not _ANTHROPIC_CLIENT_READY:
        api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
        _ANTHROPIC_CLIENT = AsyncAnthropic(api_key=api_key) if api_key else None
        _ANTHROPIC_CLIENT_READY = True
    return _ANTHROPIC_CLIENT


def _ordered_unique(items: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        unique.append(item)
    return unique


def _find_named_entities(
    text: str,
    patterns: dict[str, re.Pattern[str]],
    exclude: set[str] | None = None,
) -> list[str]:
    matches: list[tuple[int, str]] = []
    for entity, pattern in patterns.items():
        if exclude and entity in exclude:
            continue
        match = pattern.search(text)
        if match:
            matches.append((match.start(), entity))
    matches.sort(key=lambda item: (item[0], item[1]))
    return [entity for _, entity in matches]


def _find_gene_mutation_entities(text: str) -> tuple[list[str], set[str]]:
    combos: list[str] = []
    genes_in_combos: set[str] = set()
    for match in _GENE_MUT_PATTERN.finditer(text):
        gene = normalize_entity(match.group(1))
        mutation = normalize_entity(match.group(2))
        combos.append(f"{gene}{mutation}")
        genes_in_combos.add(gene)
    return _ordered_unique(combos), genes_in_combos


def _extract_primary_known_entity(text: str) -> str:
    if not text:
        return ""

    _compile_entity_patterns()
    compounds = _find_named_entities(text, _COMPOUND_PATTERNS)
    if compounds:
        return compounds[0]

    gene_mutations, genes_in_combos = _find_gene_mutation_entities(text)
    if gene_mutations:
        return gene_mutations[0]

    genes = _find_named_entities(text, _GENE_PATTERNS, exclude=genes_in_combos)
    if genes:
        return genes[0]

    pathways = _find_named_entities(text, _PATHWAY_PATTERNS)
    if pathways:
        return pathways[0]

    return ""


def classify_entity(name: str) -> str:
    normalized = normalize_entity(name)
    if not normalized:
        return "unknown"
    if normalized in KNOWN_COMPOUNDS:
        return "compound"
    for gene in _SORTED_GENES:
        if normalized.startswith(gene):
            suffix = normalized[len(gene) :]
            if suffix in KNOWN_MUTATIONS:
                return "gene_mutation"
    if normalized in KNOWN_GENES:
        return "gene"
    if normalized in KNOWN_PATHWAYS:
        return "pathway"
    return "unknown"


def canonicalize_entity_pair(subject: str, object_name: str) -> tuple[str | None, str | None]:
    normalized_subject = normalize_entity(subject)
    normalized_object = normalize_entity(object_name)
    if not normalized_subject or not normalized_object or normalized_subject == normalized_object:
        return None, None

    subject_rank = _ENTITY_RANK[classify_entity(normalized_subject)]
    object_rank = _ENTITY_RANK[classify_entity(normalized_object)]
    if subject_rank > object_rank:
        normalized_subject, normalized_object = normalized_object, normalized_subject
    return normalized_subject, normalized_object


def extract_entities_regex(text: str) -> tuple[str | None, str | None]:
    if not text:
        return None, None

    _compile_entity_patterns()

    compounds = _find_named_entities(text, _COMPOUND_PATTERNS)
    gene_mutations, genes_in_combos = _find_gene_mutation_entities(text)
    genes = _find_named_entities(text, _GENE_PATTERNS, exclude=genes_in_combos)
    pathways = _find_named_entities(text, _PATHWAY_PATTERNS)

    if compounds:
        target = next((entity for entity in gene_mutations + genes + pathways if entity != compounds[0]), None)
        if target:
            return canonicalize_entity_pair(compounds[0], target)
        second_compound = next((entity for entity in compounds[1:] if entity != compounds[0]), None)
        if second_compound:
            return canonicalize_entity_pair(compounds[0], second_compound)

    targets = gene_mutations + genes
    if targets:
        secondary = next((entity for entity in pathways + targets[1:] if entity != targets[0]), None)
        if secondary:
            return canonicalize_entity_pair(targets[0], secondary)

    ordered_entities = gene_mutations + genes + pathways
    if len(ordered_entities) >= 2:
        second = next((entity for entity in ordered_entities[1:] if entity != ordered_entities[0]), None)
        if second:
            return canonicalize_entity_pair(ordered_entities[0], second)

    return None, None


def is_noisy_entity(name: str) -> bool:
    return not bool(_salvage_entity(name))


def _salvage_entity(name: str) -> str:
    if not name:
        return ""

    normalized = normalize_entity(name)
    if not normalized or len(normalized) > 40:
        return ""

    if classify_entity(normalized) != "unknown":
        return normalized

    primary_known = _extract_primary_known_entity(name)
    if primary_known:
        return primary_known

    words = re.findall(r"[a-z0-9]+", name.lower())
    if not words or len(words) > 3:
        return ""
    if set(words).issubset(_FILLER_WORDS):
        return ""
    if any(word in _GENERIC_NON_ENTITY_WORDS for word in words):
        return ""

    if re.fullmatch(r"[a-z]{2,10}\d[a-z0-9]*", normalized):
        return normalized
    if re.fullmatch(r"[a-z]{4,18}", normalized):
        return normalized
    return ""


def _clean_candidate_pair(subject: str, object_name: str) -> tuple[str, str] | None:
    if not subject or not object_name:
        return None
    clean_subject = _salvage_entity(subject)
    clean_object = _salvage_entity(object_name)
    if not clean_subject or not clean_object:
        return None
    clean_subject, clean_object = canonicalize_entity_pair(clean_subject, clean_object)
    if not clean_subject or not clean_object:
        return None
    return clean_subject, clean_object


ENTITY_EXTRACT_PROMPT = """Extract the two most important biological entities from each claim.
Return ONLY a JSON array, one object per claim, in the same order:
[{"subject": "<primary entity: gene, protein, or compound name>", "object": "<secondary entity or pathway>"}]
Rules:
- Use standard names: "KRAS G12C" not "the mutant protein"
- Use drug names: "AMG-510" or "sotorasib" not "the covalent inhibitor"
- Max 3 words per entity
- If no clear entities, use {"subject": "", "object": ""}
Return ONLY the JSON array."""


def _extract_json_array(text: str) -> list[dict[str, Any]]:
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate)
        candidate = re.sub(r"\s*```$", "", candidate)

    decoder = json.JSONDecoder()
    for index, char in enumerate(candidate):
        if char != "[":
            continue
        try:
            payload, _ = decoder.raw_decode(candidate[index:])
        except json.JSONDecodeError:
            continue
        return payload if isinstance(payload, list) else []
    raise ValueError("No JSON array found in LLM output.")


async def extract_entities_llm(nodes_needing_extraction: list[dict[str, str]]) -> dict[str, tuple[str, str]]:
    if not nodes_needing_extraction:
        return {}

    client = _anthropic_client()
    if client is None:
        return {}

    batch_size = 20
    semaphore = asyncio.Semaphore(3)

    async def process_batch(batch: list[dict[str, str]]) -> dict[str, tuple[str, str]]:
        batch_results: dict[str, tuple[str, str]] = {}
        user_content = "\n".join(
            f"{index + 1}. {item['claim_text']}"
            for index, item in enumerate(batch)
        )

        async with semaphore:
            try:
                response = await client.messages.create(
                    model="claude-haiku-4-5-20251001",
                    max_tokens=1000,
                    temperature=0,
                    system=ENTITY_EXTRACT_PROMPT,
                    messages=[{"role": "user", "content": user_content}],
                )
                response_text = "".join(
                    block.text for block in response.content if getattr(block, "type", "") == "text"
                )
                extracted = _extract_json_array(response_text)
            except Exception as exc:
                print(f"LLM entity extraction batch failed: {exc}")
                return batch_results

        for index, item in enumerate(batch):
            if index >= len(extracted) or not isinstance(extracted[index], dict):
                continue
            batch_results[item["node_id"]] = (
                str(extracted[index].get("subject", "") or ""),
                str(extracted[index].get("object", "") or ""),
            )
        return batch_results

    batches = [
        nodes_needing_extraction[index : index + batch_size]
        for index in range(0, len(nodes_needing_extraction), batch_size)
    ]
    results: dict[str, tuple[str, str]] = {}
    for batch_results in await asyncio.gather(*(process_batch(batch) for batch in batches)):
        results.update(batch_results)
    return results


def _nodes_fingerprint(nodes: list) -> tuple[tuple[str, str, str, str], ...]:
    return tuple(
        (
            str(getattr(node, "node_id", "") or ""),
            str(getattr(node, "claim_text", "") or ""),
            str(getattr(node, "subject_name", "") or ""),
            str(getattr(node, "object_name", "") or ""),
        )
        for node in nodes
    )


def _copy_clean_index(index: dict[str, list[str]]) -> dict[str, list[str]]:
    return {key: list(node_ids) for key, node_ids in index.items()}


def _copy_entity_map(entity_map: dict[str, tuple[str, str]]) -> dict[str, tuple[str, str]]:
    return dict(entity_map)


async def build_clean_entity_index(
    nodes: list,
) -> tuple[dict[str, list[str]], dict[str, tuple[str, str]], dict[str, int]]:
    fingerprint = _nodes_fingerprint(nodes)
    cached = _ENTITY_INDEX_CACHE.get(fingerprint)
    if cached is not None:
        index, entity_map, stats = cached
        return _copy_clean_index(index), _copy_entity_map(entity_map), dict(stats)

    entity_map: dict[str, tuple[str, str]] = {}
    needs_llm: list[dict[str, str]] = []
    stats = {
        "regex_extracted": 0,
        "llm_extracted": 0,
        "unextracted": 0,
    }

    for node in nodes:
        node_id = str(getattr(node, "node_id", "") or "")
        claim_text = str(getattr(node, "claim_text", "") or "")
        subject, object_name = extract_entities_regex(claim_text)

        if subject and object_name:
            entity_map[node_id] = (subject, object_name)
            stats["regex_extracted"] += 1
            continue

        existing_subject = str(getattr(node, "subject_name", "") or "")
        existing_object = str(getattr(node, "object_name", "") or "")
        clean_pair = _clean_candidate_pair(existing_subject, existing_object)
        if clean_pair:
            entity_map[node_id] = clean_pair
            stats["regex_extracted"] += 1
            continue

        needs_llm.append({"node_id": node_id, "claim_text": claim_text})

    if needs_llm:
        print(f"Running LLM entity extraction on {len(needs_llm)} noisy nodes...")
        llm_results = await extract_entities_llm(needs_llm)
        for item in needs_llm:
            clean_pair = _clean_candidate_pair(*llm_results.get(item["node_id"], ("", "")))
            if clean_pair:
                entity_map[item["node_id"]] = clean_pair
                stats["llm_extracted"] += 1
            else:
                stats["unextracted"] += 1

    index = defaultdict(list)
    for node_id, (subject, object_name) in entity_map.items():
        if subject and object_name:
            key = f"{subject}::{object_name}"
            index[key].append(node_id)

    clean_index = dict(index)
    print(f"Entity index: {len(entity_map)} nodes mapped, {len(clean_index)} unique entity pairs")

    cached_result = (_copy_clean_index(clean_index), _copy_entity_map(entity_map), dict(stats))
    _ENTITY_INDEX_CACHE[fingerprint] = cached_result
    return _copy_clean_index(clean_index), _copy_entity_map(entity_map), dict(stats)


def summarize_entity_pair_counts(index: dict[str, list[str]], limit: int = 5) -> dict[str, int]:
    counts = {
        key: len(node_ids)
        for key, node_ids in index.items()
        if len(node_ids) >= 2
    }
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return dict(ranked[:limit])


async def top_entity_pair_counts(nodes: list, limit: int = 5) -> dict[str, int]:
    clean_index, _, _ = await build_clean_entity_index(nodes)
    return summarize_entity_pair_counts(clean_index, limit=limit)


async def find_candidate_contradiction_pairs(nodes: list) -> list[tuple]:
    node_map = {node.node_id: node for node in nodes}
    clean_index, _, _ = await build_clean_entity_index(nodes)

    candidates: list[tuple] = []
    seen_pairs: set[tuple[str, str]] = set()

    for node_ids in clean_index.values():
        if len(node_ids) < 2:
            continue

        for left_index in range(len(node_ids)):
            for right_index in range(left_index + 1, len(node_ids)):
                pair_key = tuple(sorted((node_ids[left_index], node_ids[right_index])))
                if pair_key in seen_pairs:
                    continue
                seen_pairs.add(pair_key)

                node_a = node_map.get(node_ids[left_index])
                node_b = node_map.get(node_ids[right_index])
                if node_a is None or node_b is None:
                    continue

                if (
                    node_a.polarity in ("promotes", "inhibits")
                    and node_b.polarity in ("promotes", "inhibits")
                    and node_a.polarity != node_b.polarity
                ):
                    candidates.append((node_a, node_b, 3, "polarity_reversal"))
                    continue

                value_a = getattr(node_a, "quantitative_value", None)
                value_b = getattr(node_b, "quantitative_value", None)
                if value_a is not None and value_b is not None and value_a > 0 and value_b > 0:
                    ratio = max(value_a, value_b) / min(value_a, value_b)
                    if ratio > 10:
                        candidates.append((node_a, node_b, 2, "magnitude_discrepancy"))
                        continue

                def is_high_citation(node: Any) -> bool:
                    return node.source_type == "public_abstract" and (node.citation_count or 0) > 50

                if (
                    (node_a.source_type == "private_csv" and is_high_citation(node_b))
                    or (node_b.source_type == "private_csv" and is_high_citation(node_a))
                ):
                    candidates.append((node_a, node_b, 1, "source_conflict"))

    candidates.sort(key=lambda item: (-item[2], item[3], item[0].node_id, item[1].node_id))
    return candidates[:30]
