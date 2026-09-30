"""
Assistant endpoint for the Pilot Browser API.

Public (no-auth) endpoint powering the Pilot AI side panel. Uses the
configured OpenAI-compatible LLM when reachable; otherwise falls back to
DuckDuckGo instant answers so the panel is always useful.
"""
import json
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


def _rate_limited(key: str, max_req: int = _RATE_MAX) -> bool:
    now = time.monotonic()
    q = _rate.setdefault(key, deque())
    while q and now - q[0] > _RATE_WINDOW:
        q.popleft()
    if len(q) >= max_req:
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


# ---------------------------------------------------------------------------
# Agent stepper: observe → decide ONE action → the browser executes it.
# The renderer drives the live tab (snapshot → POST here → act → repeat).
# ---------------------------------------------------------------------------

AGENT_ACTIONS = {"navigate", "search", "click", "type", "press_enter", "scroll", "extract", "done", "fail"}
_MAX_HISTORY = 12
_MAX_ELEMENTS = 50


class AgentElement(BaseModel):
    id: int                      # index into the snapshot's element list
    tag: str = ""
    text: str = ""
    href: Optional[str] = None
    type: Optional[str] = None   # input type
    placeholder: Optional[str] = None


class AgentSnapshot(BaseModel):
    url: Optional[str] = None
    title: Optional[str] = None
    text: Optional[str] = None   # visible-text sample
    elements: List[AgentElement] = []


class AgentStepRequest(BaseModel):
    goal: str
    snapshot: Optional[AgentSnapshot] = None
    history: List[Dict[str, Any]] = []   # [{action, arg, result}]


class AgentStepResponse(BaseModel):
    thought: str = ""
    action: str
    arg: Dict[str, Any] = {}
    final_answer: Optional[str] = None


def _clean_url(url: str) -> Optional[str]:
    """Allow only http(s) navigation targets; map bare domains to https."""
    url = url.strip().strip('"\'')
    if not url or len(url) > 2000:
        return None
    if re.match(r"^https?://", url, re.I):
        return url
    if re.match(r"^[\w.-]+\.[a-z]{2,}(/[^\s]*)?$", url, re.I):
        return "https://" + url
    return None


def _validate_plan(plan: Dict[str, Any]) -> Optional[AgentStepResponse]:
    """Sanitize an LLM-produced plan; return None if unusable."""
    action = str(plan.get("action") or "").lower()
    if action not in AGENT_ACTIONS:
        return None
    arg = plan.get("arg") if isinstance(plan.get("arg"), dict) else {}
    thought = str(plan.get("thought") or "")[:300]
    final = plan.get("final_answer")
    out = {"thought": thought, "action": action, "arg": {}, "final_answer": (str(final)[:4000] if final else None)}
    if action == "navigate":
        url = _clean_url(str(arg.get("url") or ""))
        if not url:
            return None
        out["arg"]["url"] = url
    elif action == "search":
        q = str(arg.get("query") or "").strip()[:500]
        if not q:
            return None
        out["arg"]["query"] = q
    elif action in ("click", "type"):
        try:
            out["arg"]["id"] = int(arg.get("id"))
        except (TypeError, ValueError):
            return None
        if action == "type":
            out["arg"]["text"] = str(arg.get("text") or "")[:500]
            out["arg"]["submit"] = bool(arg.get("submit"))
    elif action == "scroll":
        out["arg"]["direction"] = "up" if str(arg.get("direction")).lower() == "up" else "down"
    return AgentStepResponse(**out)


def _norm_url(u: str) -> str:
    u = u.lower().strip()
    u = re.sub(r"^https?://", "", u)
    u = re.sub(r"^www\.", "", u)
    return u.rstrip("/")


def _rule_plan(req: AgentStepRequest) -> AgentStepResponse:
    """Deterministic planner — handles common goals when no LLM is running."""
    goal = req.goal.strip()
    g = goal.lower()
    els = (req.snapshot.elements if req.snapshot else [])[:_MAX_ELEMENTS]

    def already_did(action: str, key: str) -> bool:
        """True if the same single-purpose action already succeeded in history."""
        for h in req.history:
            if h.get("action") == action and h.get("ok", True) is not False:
                harg = h.get("arg") or {}
                hv = harg.get("url") or harg.get("query") or harg.get("direction") or ""
                if _norm_url(str(hv)) == _norm_url(str(key)):
                    return True
        return False

    def match(el: AgentElement, target: str) -> bool:
        label = (el.text or el.placeholder or "").lower()
        if not target:
            return False
        if target in label or (label and label in target):
            return True
        tw = set(re.findall(r"[a-z0-9]+", target))
        lw = set(re.findall(r"[a-z0-9]+", label))
        return bool(tw & lw)

    def extract_done() -> Optional[AgentStepResponse]:
        for h in reversed(req.history):
            if h.get("action") != "extract":
                continue
            if h.get("ok", True) is False:
                return AgentStepResponse(
                    thought="Couldn't read the page.",
                    action="fail",
                    final_answer="I couldn't read the page content — it may still be loading or unresponsive.",
                )
            if h.get("result"):
                text = str(h["result"])
                return AgentStepResponse(
                    thought="Have the page content — reporting back.",
                    action="done",
                    final_answer=text[:1500],
                )
        return None

    if "summar" in g or "read the page" in g or "what does this page" in g or "what's on this page" in g:
        done = extract_done()
        if done:
            return done
        return AgentStepResponse(thought="Extracting the page text first.", action="extract")

    m = re.search(r"(?:go to|open|navigate to|visit|load)\s+(https?://\S+|[\w.-]+\.[a-z]{2,}(?:/\S*)?)", g)
    if not m:
        m = re.search(r"\b(https?://[^\s]+)", g)
    if m:
        url = _clean_url(m.group(1))
        if url:
            cur = req.snapshot.url if req.snapshot and req.snapshot.url else ""
            if cur and _norm_url(cur) == _norm_url(url):
                return AgentStepResponse(thought=f"Already on {url}", action="done", final_answer=f"Already on {url}.")
            if already_did("navigate", url):
                return AgentStepResponse(thought=f"Arrived at {url}", action="done", final_answer=f"Navigated to {url}.")
            return AgentStepResponse(thought=f"Navigating to {url}", action="navigate", arg={"url": url})

    m = re.match(r"^(?:search(?: for)?|look up|find)\s+[\"']?(.+?)[\"']?\s*$", g)
    if m:
        q = m.group(1).strip(" .")
        if q and not _clean_url(q):
            if already_did("search", q):
                return AgentStepResponse(thought="Search already ran.", action="done",
                                       final_answer=f"Search results for '{q}' are on screen.")
            return AgentStepResponse(thought=f"Searching for: {q}", action="search", arg={"query": q})

    if re.search(r"(first result|first link|top result)", g):
        for el in els:
            if el.tag == "a" and el.href:
                return AgentStepResponse(thought=f"Clicking first link: {el.text or el.href}", action="click", arg={"id": el.id})
        return AgentStepResponse(thought="No links on the page.", action="fail", final_answer="No clickable links found.")

    m = re.search(r"click(?:ing)? (?:the |on )?[\"']?(.+?)[\"']?\s*$", g)
    if m:
        target = m.group(1).strip()
        best = None
        for el in els:
            if (el.tag in ("a", "button", "input", "select") or el.type == "submit") and match(el, target):
                best = el
                break
        if best is not None:
            return AgentStepResponse(thought=f"Clicking {best.text or best.placeholder or best.tag}", action="click", arg={"id": best.id})
        return AgentStepResponse(thought=f"No element matching '{target}'.", action="fail", final_answer=f"Couldn't find a clickable element matching '{target}'.")

    m = re.search(r"(?:type|enter|fill(?: in)?) [\"'](.+?)[\"']\s*(?:in(?:to)?|as)\s+(?:the\s+)?[\"']?(.+?)[\"']?\s*$", g)
    if m:
        text, target = m.group(1), m.group(2)
        for el in els:
            if el.tag in ("input", "textarea") or el.type in ("text", "search", "email", "url", "password"):
                label = (el.placeholder or el.text or "").lower()
                if match(el, target) or not label:
                    return AgentStepResponse(thought=f"Typing into {el.placeholder or el.tag}", action="type",
                                           arg={"id": el.id, "text": text, "submit": "search" in g or "enter" in g})
        return AgentStepResponse(thought="No input field found.", action="fail", final_answer="No matching input field on the page.")

    if re.search(r"scroll (down|up)", g):
        d = "up" if "up" in g else "down"
        if already_did("scroll", d):
            return AgentStepResponse(thought=f"Already scrolled {d}.", action="done", final_answer=f"Scrolled {d}.")
        return AgentStepResponse(thought=f"Scrolling {d}.", action="scroll", arg={"direction": d})

    done = extract_done()
    if done:
        return done
    return AgentStepResponse(
        thought="No rule matches and no LLM planner is available.",
        action="fail",
        final_answer="I can't plan that task without the AI backend's LLM. Start a local model (OPENAI_API_BASE) or try: 'go to <site>', 'search for <q>', 'click the <label> link', 'summarize this page'.",
    )


async def _llm_plan(req: AgentStepRequest) -> Optional[AgentStepResponse]:
    """Ask the configured LLM for the next action as strict JSON. None on failure."""
    if not settings.OPENAI_API_KEY:
        return None
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(
            api_key=settings.OPENAI_API_KEY,
            base_url=settings.OPENAI_API_BASE,
            timeout=15.0,
            max_retries=1,
        )
        snap = req.snapshot or AgentSnapshot()
        els = [
            {"id": e.id, "tag": e.tag, "text": e.text[:80], "href": (e.href or "")[:200],
             "type": e.type, "placeholder": e.placeholder}
            for e in snap.elements[:_MAX_ELEMENTS]
        ]
        sys = (
            "You are Pilot, a browser agent. Given the user's GOAL, the current PAGE snapshot "
            "(url, title, visible text sample, interactive ELEMENTS with ids) and the HISTORY of "
            "actions already taken, decide the SINGLE next action.\n"
            "Respond with ONLY a JSON object: "
            '{"thought": "...", "action": "<act>", "arg": {...}, "final_answer": "..."}.\n'
            "Actions: navigate {url}, search {query}, click {id}, type {id, text, submit}, "
            "press_enter {}, scroll {direction}, extract {}, "
            "done {final_answer}, fail {final_answer}.\n"
            "Rules: only http(s) urls; reference elements by their numeric id; "
            "use extract to read page text before answering questions about it; "
            "use done as soon as the goal is satisfied; use fail if the goal is impossible."
        )
        user = json.dumps({
            "goal": req.goal[:_MAX_QUERY],
            "page": {"url": snap.url, "title": snap.title, "text": (snap.text or "")[:2500], "elements": els},
            "history": req.history[-_MAX_HISTORY:],
        })
        resp = await client.chat.completions.create(
            model=settings.LLM_MODEL,
            messages=[{"role": "system", "content": sys}, {"role": "user", "content": user}],
            max_tokens=400,
            temperature=0.1,
        )
        raw = resp.choices[0].message.content or ""
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            return None
        plan = json.loads(m.group(0))
        return _validate_plan(plan)
    except Exception as e:
        logger.info(f"LLM planner unavailable: {e}")
        return None


@router.post("/agent-step", response_model=AgentStepResponse)
async def agent_step(req: AgentStepRequest, request: Request):
    """Return the single next action for the in-browser agent loop."""
    key = "agent:" + (request.client.host if request.client else "local")
    if _rate_limited(key, max_req=_RATE_MAX * 3):
        raise HTTPException(status_code=429, detail="Too many requests — slow down.")
    req.goal = req.goal[:_MAX_QUERY]
    req.history = req.history[-_MAX_HISTORY:]
    if req.snapshot:
        req.snapshot.elements = req.snapshot.elements[:_MAX_ELEMENTS]
        if req.snapshot.text:
            req.snapshot.text = req.snapshot.text[:_MAX_EXCERPT]

    if len(req.history) >= _MAX_HISTORY:
        return AgentStepResponse(thought="Step limit reached.", action="done",
                                 final_answer="Stopped — reached the step limit without finishing the task.")

    try:
        plan = await _llm_plan(req)
    except Exception as e:  # planner itself guards, but never 500 the agent loop
        logger.info(f"LLM planner raised: {e}")
        plan = None
    if plan:
        return plan
    return _rule_plan(req)


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
