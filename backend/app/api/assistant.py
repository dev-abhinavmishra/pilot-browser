"""
Assistant endpoint for the Pilot Browser API.

Public (no-auth) endpoint powering the Pilot AI side panel. Uses the
configured OpenAI-compatible LLM when reachable; otherwise falls back to
DuckDuckGo instant answers so the panel is always useful.
"""
import logging
import re
import time
from collections import deque
from typing import List, Optional, Dict, Any

import aiohttp
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.core.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

# lightweight abuse guard for the unauthenticated endpoint
_RATE_MAX = 20            # requests per window per client
_RATE_WINDOW = 60.0       # seconds
_MAX_QUERY = 2000         # chars
_MAX_EXCERPT = 8000       # chars
_rate: Dict[str, deque] = {}


def _rate_limited(key: str) -> bool:
    now = time.monotonic()
    q = _rate.setdefault(key, deque())
    while q and now - q[0] > _RATE_WINDOW:
        q.popleft()
    if len(q) >= _RATE_MAX:
        return True
    q.append(now)
    return False


class PageContext(BaseModel):
    url: Optional[str] = None
    title: Optional[str] = None
    excerpt: Optional[str] = None


class AskRequest(BaseModel):
    query: str
    page: Optional[PageContext] = None


class AskResponse(BaseModel):
    answer: str
    sources: List[Dict[str, str]] = []


async def _llm_answer(req: AskRequest) -> Optional[str]:
    """Try the configured OpenAI-compatible backend; return None on failure."""
    if not settings.OPENAI_API_KEY:
        return None
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(
            api_key=settings.OPENAI_API_KEY,
            base_url=settings.OPENAI_API_BASE,
            timeout=12.0,
            max_retries=1,  # fall back fast when no local LLM is running
        )
        messages = [
            {"role": "system", "content": "You are Pilot, a concise assistant embedded in a browser. Answer briefly, use markdown bullets when helpful."},
        ]
        if req.page and req.page.excerpt:
            messages.append({
                "role": "system",
                "content": f"The user is viewing {req.page.title or ''} ({req.page.url or ''}).\nPage excerpt:\n{req.page.excerpt[:4000]}",
            })
        messages.append({"role": "user", "content": req.query})
        resp = await client.chat.completions.create(model=settings.LLM_MODEL, messages=messages, max_tokens=600)
        return resp.choices[0].message.content
    except Exception as e:
        logger.info(f"LLM unavailable, using fallback: {e}")
        return None


async def _ddg_fallback(query: str) -> AskResponse:
    """DuckDuckGo instant-answer fallback — always tries to say something useful."""
    sources: List[Dict[str, str]] = []
    answer = ""
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as sess:
            async with sess.get(
                "https://api.duckduckgo.com/",
                params={"q": query, "format": "json", "no_html": 1, "skip_disambig": 1},
            ) as r:
                data = await r.json(content_type=None)
                answer = data.get("AbstractText") or data.get("Answer") or ""
                if data.get("AbstractURL"):
                    sources.append({"title": data.get("Heading") or "DuckDuckGo", "url": data["AbstractURL"]})
                for topic in (data.get("RelatedTopics") or [])[:4]:
                    if isinstance(topic, dict) and topic.get("FirstURL"):
                        sources.append({"title": (topic.get("Text") or "")[:80], "url": topic["FirstURL"]})
    except Exception as e:
        logger.info(f"DDG fallback failed: {e}")

    if not answer:
        answer = (
            "I couldn't find an instant answer. Try opening the search results for "
            f"\"{query}\" — or start a local LLM (OPENAI_API_BASE) for full AI answers."
        )
    return AskResponse(answer=answer, sources=sources)


def _extractive_summary(text: str, bullets: int = 5) -> str:
    """Fallback summary: surface the page's first content sentences as bullets."""
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if len(s.strip()) > 30]
    if not sentences:
        return ""
    return "\n".join(f"- {s}" for s in sentences[:bullets])


@router.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest, request: Request):
    """Answer a question, optionally with the current page as context."""
    key = request.client.host if request.client else "local"
    if _rate_limited(key):
        raise HTTPException(status_code=429, detail="Too many requests — slow down.")
    req.query = req.query[:_MAX_QUERY]
    if req.page and req.page.excerpt:
        req.page.excerpt = req.page.excerpt[:_MAX_EXCERPT]

    llm = await _llm_answer(req)
    if llm:
        return AskResponse(answer=llm, sources=[])

    # summarize-with-page requests should still summarize when the LLM is down
    if req.page and req.page.excerpt and "summar" in req.query.lower():
        summary = _extractive_summary(req.page.excerpt)
        if summary:
            return AskResponse(answer=summary, sources=[])
    return await _ddg_fallback(req.query)
