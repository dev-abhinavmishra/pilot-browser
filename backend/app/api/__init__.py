"""
API Router for Pilot Browser Backend.

This module contains all the API routes for the Pilot Browser application.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from typing import Optional
import logging

# Configure logging
logger = logging.getLogger(__name__)

# Create main router
router = APIRouter()

# OAuth2 scheme for token authentication
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

# Import and include sub-routers
from . import auth, search, agent, tasks, credentials, assistant

# Include all routers
router.include_router(auth.router, prefix="/auth", tags=["Authentication"])
router.include_router(search.router, prefix="/search", tags=["Search"])
router.include_router(agent.router, prefix="/agent", tags=["Agent"])
router.include_router(tasks.router, prefix="/tasks", tags=["Tasks"])
router.include_router(credentials.router, prefix="/credentials", tags=["Credentials"])
router.include_router(assistant.router, prefix="/assistant", tags=["Assistant"])

# Root endpoint
@router.get("/")
async def root():
    """Root endpoint that provides API information."""
    return {
        "name": "Pilot Browser API",
        "version": "0.1.0",
        "description": "API for the Pilot Browser application",
        "documentation": "/api/docs",
        "endpoints": [
            {"path": "/auth", "description": "Authentication endpoints"},
            {"path": "/search", "description": "Search functionality"},
            {"path": "/agent", "description": "Agent task execution"},
            {"path": "/tasks", "description": "Task management"},
            {"path": "/credentials", "description": "Credential management"}
        ]
    }
