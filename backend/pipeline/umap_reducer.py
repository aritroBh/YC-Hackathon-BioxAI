from __future__ import annotations

import numpy as np
import umap

from models import ClaimNode


def reduce_umap(nodes: list[ClaimNode], vectors_dict: dict[str, np.ndarray]) -> list[ClaimNode]:
    if not nodes:
        return nodes

    if len(nodes) < 4:
        for node in nodes:
            node.umap_x = 0.0
            node.umap_y = 0.0
        return nodes

    fallback_dimension = 0
    if vectors_dict:
        fallback_dimension = len(next(iter(vectors_dict.values())))

    matrix_rows: list[np.ndarray] = []
    for node in nodes:
        vector = vectors_dict.get(node.node_id)
        if vector is None:
            vector = np.zeros(fallback_dimension or 1, dtype=np.float32)
        matrix_rows.append(vector)

    x_matrix = np.vstack(matrix_rows)

    try:
        reducer = umap.UMAP(
            n_neighbors=min(15, len(nodes) - 1),
            min_dist=0.25,
            n_components=2,
            metric="cosine",
            random_state=42,
        )
        coords = reducer.fit_transform(x_matrix)
        for node, coord in zip(nodes, coords):
            node.umap_x = float(coord[0])
            node.umap_y = float(coord[1])
    except Exception:
        for node in nodes:
            node.umap_x = 0.0
            node.umap_y = 0.0

    return nodes
