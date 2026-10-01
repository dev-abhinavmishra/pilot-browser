"""API router for the Pilot Browser backend."""
from fastapi import APIRouter

router = APIRouter()

from . import assistant

router.include_router(assistant.router, prefix="/assistant", tags=["Assistant"])


@router.get("/")
async def root():
    return {
        "name": "Pilot Browser API",
        "version": "0.1.0",
        "endpoints": [
            {"path": "/assistant/ask", "description": "Q&A with page context"},
            {"path": "/assistant/agent-step", "description": "One-step planner for the in-browser agent"},
            {"path": "/assistant/status", "description": "Backend + LLM availability"},
        ],
    }
