from __future__ import annotations

import asyncio
import re

import httpx
from youtube_transcript_api import YouTubeTranscriptApi

from models import ClaimNode
from pipeline.ingest_text_common import parse_claims_from_text


def extract_video_id(url: str) -> str | None:
    patterns = [
        r"youtu\.be/([^?&]+)",
        r"youtube\.com/watch\?v=([^&]+)",
        r"youtube\.com/embed/([^?]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def _fetch_transcript(video_id: str) -> list[dict]:
    return YouTubeTranscriptApi.get_transcript(video_id)


async def _fetch_video_title(url: str) -> str | None:
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(
            "https://www.youtube.com/oembed",
            params={"url": url, "format": "json"},
        )
        if not response.is_success:
            return None
        payload = response.json()
        title = payload.get("title")
        return str(title).strip() if title else None


async def ingest_youtube(url: str, semantic_focus: str = "") -> list[ClaimNode]:
    video_id = extract_video_id(url)
    if not video_id:
        return []

    try:
        transcript = await asyncio.to_thread(_fetch_transcript, video_id)
    except Exception:
        return []

    full_text = " ".join(item.get("text", "") for item in transcript if item.get("text"))
    if not full_text.strip():
        return []

    video_title = await _fetch_video_title(url)
    return await parse_claims_from_text(
        full_text,
        source_type="youtube_video",
        source_id=f"youtube::{video_id}",
        source_url=url,
        semantic_focus=semantic_focus,
        title=video_title or video_id,
    )
