from __future__ import annotations

import hashlib
import os
import re

import numpy as np
from dotenv import load_dotenv
from openai import AsyncOpenAI

from models import ClaimNode

load_dotenv()

DELTAS = {
    "promotes": 0.15,
    "inhibits": -0.15,
    "neutral": 0.0,
    "ambiguous": 0.0,
}

FALLBACK_DIMENSION = 256


def _openai_client() -> AsyncOpenAI | None:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    return AsyncOpenAI(api_key=api_key) if api_key else None


def _embedding_text(node: ClaimNode) -> str:
    return (
        f"[POLARITY:{node.polarity}] {node.claim_text} | Subject: {node.subject_name} | "
        f"Object: {node.object_name} | Context: {node.cell_line or 'unknown'}, {node.organism or 'unknown'}"
    )


def _fallback_vector(text: str) -> np.ndarray:
    vector = np.zeros(FALLBACK_DIMENSION, dtype=np.float32)
    for token in re.findall(r"[a-z0-9_]+", text.lower()):
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % FALLBACK_DIMENSION
        sign = -1.0 if digest[4] % 2 else 1.0
        vector[index] += sign * (1.0 + digest[5] / 255.0)
    return vector


def _normalize_vector(vector: np.ndarray, polarity: str) -> np.ndarray:
    shifted = np.array(vector, dtype=np.float32) + DELTAS.get(polarity, 0.0)
    norm = np.linalg.norm(shifted)
    if norm == 0:
        return shifted
    return shifted / norm


async def embed_nodes(nodes: list[ClaimNode]) -> tuple[list[ClaimNode], dict[str, np.ndarray]]:
    if not nodes:
        return nodes, {}

    client = _openai_client()
    texts = [_embedding_text(node) for node in nodes]
    vectors_dict: dict[str, np.ndarray] = {}

    for batch_start in range(0, len(nodes), 500):
        batch_nodes = nodes[batch_start : batch_start + 500]
        batch_texts = texts[batch_start : batch_start + 500]

        raw_vectors: list[np.ndarray]
        if client is not None:
            try:
                response = await client.embeddings.create(
                    model="text-embedding-3-small",
                    input=batch_texts,
                )
                raw_vectors = [
                    np.array(item.embedding, dtype=np.float32)
                    for item in response.data
                ]
            except Exception:
                raw_vectors = [_fallback_vector(text) for text in batch_texts]
        else:
            raw_vectors = [_fallback_vector(text) for text in batch_texts]

        for node, vector in zip(batch_nodes, raw_vectors):
            vectors_dict[node.node_id] = _normalize_vector(vector, node.polarity)

    return nodes, vectors_dict
