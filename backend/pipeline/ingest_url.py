from __future__ import annotations

import httpx
from bs4 import BeautifulSoup

from models import ClaimNode
from pipeline.ingest_text_common import parse_claims_from_text


async def fetch_url_text(url: str) -> str:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header"]):
            tag.decompose()
        return soup.get_text(separator=" ", strip=True)


async def ingest_url(url: str, semantic_focus: str = "") -> list[ClaimNode]:
    text = await fetch_url_text(url)
    return await parse_claims_from_text(
        text,
        source_type="web_url",
        source_id=f"url::{url}",
        source_url=url,
        semantic_focus=semantic_focus,
        title=url,
    )
