from __future__ import annotations

import asyncio
import io

import pandas as pd

from models import ClaimNode
from pipeline.ingest_csv import ingest_csv


def _xlsx_to_csv_bytes(file_bytes: bytes) -> bytes:
    dataframe = pd.read_excel(io.BytesIO(file_bytes))
    csv_text = dataframe.to_csv(index=False)
    return csv_text.encode("utf-8")


async def ingest_xlsx(file_bytes: bytes, filename: str, semantic_focus: str = "") -> list[ClaimNode]:
    csv_bytes = await asyncio.to_thread(_xlsx_to_csv_bytes, file_bytes)
    return await ingest_csv(csv_bytes, filename, semantic_focus)
