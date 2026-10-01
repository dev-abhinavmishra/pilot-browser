"""Tests for the /assistant/agent-step endpoint — the in-browser agent planner."""
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api import assistant  # noqa: E402


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(assistant.router, prefix="/assistant")
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _no_llm(monkeypatch):
    """Default: LLM unreachable so tests exercise the deterministic planner."""
    async def none(req):
        return None
    monkeypatch.setattr(assistant, "_llm_plan", none)


def post(client, **kw):
    return client.post("/assistant/agent-step", json=kw)


# --- deterministic planner -------------------------------------------------

def test_navigate_full_url(client):
    r = post(client, goal="go to https://example.com/docs")
    assert r.status_code == 200
    body = r.json()
    assert body["action"] == "navigate"
    assert body["arg"]["url"] == "https://example.com/docs"


def test_navigate_bare_domain_gets_https(client):
    body = post(client, goal="open github.com").json()
    assert body["action"] == "navigate"
    assert body["arg"]["url"] == "https://github.com"


def test_javascript_url_never_navigates(client):
    body = post(client, goal="go to javascript:alert(1)").json()
    assert body["action"] != "navigate" or "javascript:" not in json.dumps(body["arg"])


def test_search_goal(client):
    body = post(client, goal="search for best mechanical keyboards").json()
    assert body["action"] == "search"
    assert body["arg"]["query"] == "best mechanical keyboards"


def test_click_first_result(client):
    snap = {"url": "https://duckduckgo.com/?q=x", "title": "results", "elements": [
        {"id": 0, "tag": "a", "text": "Result one", "href": "https://a.example"},
        {"id": 1, "tag": "a", "text": "Result two", "href": "https://b.example"},
    ]}
    body = post(client, goal="open the first result", snapshot=snap).json()
    assert body["action"] == "click"
    assert body["arg"]["id"] == 0


def test_click_by_label(client):
    snap = {"url": "https://site.example", "elements": [
        {"id": 0, "tag": "a", "text": "Pricing", "href": "/pricing"},
        {"id": 1, "tag": "a", "text": "Blog", "href": "/blog"},
    ]}
    body = post(client, goal="click the pricing link", snapshot=snap).json()
    assert body["action"] == "click"
    assert body["arg"]["id"] == 0


def test_click_no_match_fails(client):
    snap = {"url": "https://site.example", "elements": [{"id": 0, "tag": "a", "text": "Home"}]}
    body = post(client, goal="click the nonexistent-button-xyzzy", snapshot=snap).json()
    assert body["action"] == "fail"
    assert body["final_answer"]


def test_type_into_field(client):
    snap = {"url": "https://site.example", "elements": [
        {"id": 0, "tag": "input", "type": "search", "placeholder": "Search…"},
    ]}
    body = post(client, goal='type "hello world" into the search box', snapshot=snap).json()
    assert body["action"] == "type"
    assert body["arg"]["id"] == 0
    assert body["arg"]["text"] == "hello world"


def test_scroll(client):
    body = post(client, goal="scroll down", snapshot={"url": "https://x.example"}).json()
    assert body["action"] == "scroll"
    assert body["arg"]["direction"] == "down"


def test_extract_failed_result_fails_not_serves_garbage(client):
    # a timed-out extract must not be served as the "summary"
    hist = [{"action": "extract", "result": "page unresponsive (script timeout)", "ok": False}]
    body = post(client, goal="summarize this page", snapshot={"url": "https://x.example"}, history=hist).json()
    assert body["action"] == "fail"
    assert "couldn't read" in body["final_answer"].lower()


def test_extract_then_done(client):
    snap = {"url": "https://x.example", "title": "T", "text": "the page text"}
    r1 = post(client, goal="summarize this page", snapshot=snap).json()
    assert r1["action"] == "extract"
    hist = [{"action": "extract", "result": "the page text"}]
    r2 = post(client, goal="summarize this page", snapshot=snap, history=hist).json()
    assert r2["action"] == "done"
    assert "page text" in r2["final_answer"]


def test_unknown_goal_fails_with_guidance(client):
    body = post(client, goal="frobulate the widget", snapshot={"url": "https://x.example"}).json()
    assert body["action"] == "fail"
    assert "LLM" in body["final_answer"] or "go to" in body["final_answer"]


def test_navigate_already_on_target_done(client):
    snap = {"url": "https://example.com/", "title": "Example", "elements": []}
    body = post(client, goal="go to example.com", snapshot=snap).json()
    assert body["action"] == "done"


def test_navigate_completes_after_landing(client):
    snap = {"url": "https://example.com/", "title": "Example", "elements": []}
    hist = [{"action": "navigate", "arg": {"url": "https://example.com"}, "result": "navigated", "ok": True}]
    body = post(client, goal="go to example.com", snapshot=snap, history=hist).json()
    assert body["action"] == "done"
    assert "example.com" in body["final_answer"]


def test_search_completes_after_results(client):
    snap = {"url": "https://duckduckgo.com/?q=cats", "title": "cats at DuckDuckGo", "elements": []}
    hist = [{"action": "search", "arg": {"query": "cats"}, "result": "searched", "ok": True}]
    body = post(client, goal="search for cats", snapshot=snap, history=hist).json()
    assert body["action"] == "done"


def test_scroll_completes_after_first(client):
    hist = [{"action": "scroll", "arg": {"direction": "down"}, "result": "scrolled down", "ok": True}]
    body = post(client, goal="scroll down", snapshot={"url": "https://x.example"}, history=hist).json()
    assert body["action"] == "done"


def test_failed_navigate_retries_not_done(client):
    # a failed navigation must NOT count as completion
    hist = [{"action": "navigate", "arg": {"url": "https://example.com"}, "result": "failed", "ok": False}]
    body = post(client, goal="go to example.com", snapshot={"url": "about:blank"}, history=hist).json()
    assert body["action"] == "navigate"


def test_click_completes_after_one_click(client):
    # Devin Review: a successful click must terminate the goal, not re-fire
    snap = {"url": "https://site.example", "elements": [{"id": 0, "tag": "a", "text": "Pricing"}]}
    hist = [{"action": "click", "arg": {"id": 0}, "result": "clicked Pricing", "ok": True}]
    body = post(client, goal="click the pricing link", snapshot=snap, history=hist).json()
    assert body["action"] == "done"


def test_type_completes_after_one_fill(client):
    snap = {"url": "https://site.example", "elements": [{"id": 0, "tag": "input", "placeholder": "Search…"}]}
    hist = [{"action": "type", "arg": {"id": 0, "text": "hello"}, "result": "typed", "ok": True}]
    body = post(client, goal='type "hello" into the search box', snapshot=snap, history=hist).json()
    assert body["action"] == "done"


def test_extract_does_not_complete_unrelated_goal(client):
    # a prior extract must not satisfy a goal that isn't about reading the page
    hist = [{"action": "extract", "result": "page text", "ok": True}]
    body = post(client, goal="frobulate the widget", snapshot={"url": "https://x.example"}, history=hist).json()
    assert body["action"] == "fail"


def test_search_done_when_results_already_on_screen(client):
    snap = {"url": "https://duckduckgo.com/?q=cats", "title": "cats at DDG", "elements": []}
    body = post(client, goal="search for cats", snapshot=snap).json()
    assert body["action"] == "done"


def test_validate_plan_rejects_id_beyond_snapshot():
    out = assistant._validate_plan({"action": "click", "arg": {"id": 99}}, max_id=2)
    assert out is None


def test_validate_plan_accepts_id_within_snapshot():
    out = assistant._validate_plan({"action": "click", "arg": {"id": 1}}, max_id=2)
    assert out is not None and out.arg["id"] == 1


def test_empty_snapshot_navigate_short_circuits_rules(client, monkeypatch):
    # real-LLM finding: on a start tab the model refused; rules must plan nav/search first
    async def refuse(req):
        return assistant.AgentStepResponse(thought="no context", action="fail", final_answer="cannot navigate")
    monkeypatch.setattr(assistant, "_llm_plan", refuse)
    body = post(client, goal="go to example.com", snapshot={"url": None, "elements": []}).json()
    assert body["action"] == "navigate"


def test_loop_breaker_pairwise(client):
    hist = [
        {"action": "click", "arg": {"id": 0}, "result": "clicked", "ok": True},
        {"action": "click", "arg": {"id": 0}, "result": "clicked", "ok": True},
    ]
    body = post(client, goal="do the thing", snapshot={"url": "https://x.example"}, history=hist).json()
    assert body["action"] == "done"


def test_loop_breaker_two_cycle(client):
    hist = [
        {"action": "navigate", "arg": {"url": "https://x.example"}, "ok": True},
        {"action": "click", "arg": {"id": 0}, "ok": True},
        {"action": "navigate", "arg": {"url": "https://x.example"}, "ok": True},
        {"action": "click", "arg": {"id": 0}, "ok": True},
    ]
    body = post(client, goal="do the thing", snapshot={"url": "https://x.example"}, history=hist).json()
    assert body["action"] == "done"


def test_loop_breaker_ignores_failed_actions(client):
    # identical FAILED steps must not count as completion
    hist = [
        {"action": "navigate", "arg": {"url": "https://x.example"}, "ok": False},
        {"action": "navigate", "arg": {"url": "https://x.example"}, "ok": False},
    ]
    body = post(client, goal="frobulate", snapshot={"url": "https://other.example"}, history=hist).json()
    assert body["action"] != "done"


def test_step_limit_returns_done(client):
    hist = [{"action": "scroll", "result": "scrolled down"}] * 12
    body = post(client, goal="keep scrolling", snapshot={"url": "https://x.example"}, history=hist).json()
    assert body["action"] == "done"


def test_goal_and_history_are_clamped(client):
    body = post(client, goal="scroll down " * 500,
                snapshot={"url": "https://x.example"},
                history=[{"action": "scroll"}] * 100).json()
    assert body["action"] in ("scroll", "done", "fail")


# --- plan validation (LLM output sanitizer) ---------------------------------

def test_validate_plan_rejects_unknown_action():
    assert assistant._validate_plan({"action": "rm -rf /"}) is None


def test_validate_plan_rejects_non_http_url():
    assert assistant._validate_plan({"action": "navigate", "arg": {"url": "file:///etc/passwd"}}) is None
    assert assistant._validate_plan({"action": "navigate", "arg": {"url": "javascript:alert(1)"}}) is None


def test_validate_plan_accepts_valid_navigate():
    out = assistant._validate_plan({"thought": "t", "action": "navigate", "arg": {"url": "example.com/a"}})
    assert out is not None and out.action == "navigate" and out.arg["url"] == "https://example.com/a"


def test_validate_plan_coerces_scroll_direction():
    out = assistant._validate_plan({"action": "scroll", "arg": {"direction": "sideways"}})
    assert out is not None and out.arg["direction"] == "down"


def test_validate_plan_bad_element_id():
    assert assistant._validate_plan({"action": "click", "arg": {"id": "abc"}}) is None


# --- LLM planner path -------------------------------------------------------

def test_llm_plan_used_when_valid(client, monkeypatch):
    async def plan(req):
        return assistant.AgentStepResponse(thought="llm", action="done", final_answer="LLM says hi")
    monkeypatch.setattr(assistant, "_llm_plan", plan)
    body = post(client, goal="anything", snapshot={"url": "https://x.example"}).json()
    assert body["final_answer"] == "LLM says hi"


def test_llm_none_falls_back_to_rules(client, monkeypatch):
    # _no_llm fixture already forces None; a rule-matched goal must still plan
    body = post(client, goal="go to example.com").json()
    assert body["action"] == "navigate"


def test_llm_exception_falls_back(client, monkeypatch):
    async def boom(req):
        raise RuntimeError("llm down")
    monkeypatch.setattr(assistant, "_llm_plan", boom)
    body = post(client, goal="scroll down", snapshot={"url": "https://x.example"}).json()
    # an exploding LLM planner must degrade to rules, not 500
    assert body["action"] == "scroll"


# --- approval gate ---------------------------------------------------------
# Consequential actions (click/type/press_enter) must carry a `confirm` text so
# the UI can ask the user before executing; read-only actions must not.

def test_rule_click_plan_requires_confirm(client):
    snap = {"url": "https://site.example", "elements": [{"id": 0, "tag": "a", "text": "Pricing", "href": "/p"}]}
    body = post(client, goal="click the pricing link", snapshot=snap).json()
    assert body["action"] == "click"
    assert body["confirm"] and "Pricing" in body["confirm"]


def test_rule_type_plan_requires_confirm(client):
    snap = {"url": "https://site.example", "elements": [{"id": 0, "tag": "input", "placeholder": "Search…"}]}
    body = post(client, goal='type "hi" into the search box', snapshot=snap).json()
    assert body["action"] == "type"
    assert body["confirm"] and "hi" in body["confirm"]


def test_navigate_plan_needs_no_confirm(client):
    body = post(client, goal="go to example.com").json()
    assert body["action"] == "navigate"
    assert body["confirm"] is None


def test_validate_plan_sets_confirm_with_element_label():
    els = [assistant.AgentElement(id=0, tag="a", text="Buy now")]
    out = assistant._validate_plan({"action": "click", "arg": {"id": 0}}, max_id=1, elements=els)
    assert out is not None and out.confirm and "Buy now" in out.confirm


def test_validate_plan_press_enter_requires_confirm():
    out = assistant._validate_plan({"action": "press_enter", "arg": {}})
    assert out is not None and out.confirm


def test_validate_plan_safe_actions_have_no_confirm():
    out = assistant._validate_plan({"action": "scroll", "arg": {"direction": "down"}})
    assert out is not None and out.confirm is None
    out = assistant._validate_plan({"action": "navigate", "arg": {"url": "https://x.example"}})
    assert out is not None and out.confirm is None


# --- status endpoint ---------------------------------------------------------

def test_status_endpoint_shape(client):
    body = client.get("/assistant/status").json()
    assert body["backend"] == "ok"
    assert "model" in body
    assert "llm_configured" in body and "llm_available" in body


# --- LLM cooldown ------------------------------------------------------------
# After a failed probe the planner must skip the dead model for the cooldown
# window instead of paying its connect-timeout on every step.

def test_llm_down_cooldown():
    assistant._llm_mark(False, "x")
    assert assistant._llm_down() is True
    assistant._llm_mark(True)
    assert assistant._llm_down() is False
    assistant._llm_state.update(ok=None, error=None, since=0.0)


def test_llm_plan_returns_none_immediately_when_down():
    import asyncio
    assistant._llm_mark(False, "down")
    try:
        out = asyncio.run(assistant._llm_plan(assistant.AgentStepRequest(goal="go to example.com")))
        assert out is None
    finally:
        assistant._llm_state.update(ok=None, error=None, since=0.0)
