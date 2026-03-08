from __future__ import annotations

import asyncio

from models import ClaimNode
from pipeline.ingest_text_common import parse_claims_from_text


def extract_text_from_pdf(file_bytes: bytes) -> str:
    import fitz

    document = fitz.open(stream=file_bytes, filetype="pdf")
    try:
        return "\n".join(page.get_text() for page in document)
    finally:
        document.close()


async def ingest_pdf(file_bytes: bytes, filename: str, semantic_focus: str = "") -> list[ClaimNode]:
    text = await asyncio.to_thread(extract_text_from_pdf, file_bytes)
    return await parse_claims_from_text(
        text,
        source_type="pdf_document",
        source_id=f"pdf::{filename}",
        source_url=None,
        semantic_focus=semantic_focus,
        title=filename,
        chunk_source_ids=True,
    )
