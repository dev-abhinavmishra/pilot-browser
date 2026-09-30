"""
Database module for the Pilot Browser backend.

This module handles database connections, session management, and ORM setup.
"""
import os
from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.pool import NullPool
from contextlib import asynccontextmanager
import logging

# Configure logging
logger = logging.getLogger(__name__)

# Get database URL from environment or use SQLite by default
DATABASE_URL = os.getenv(
    "DATABASE_URL", 
    "sqlite+aiosqlite:///./pilot_browser.db"
)

# Create async engine
engine = create_async_engine(
    DATABASE_URL,
    echo=os.getenv("SQL_ECHO", "false").lower() == "true",
    future=True,
    pool_pre_ping=True,
    pool_recycle=300,  # Recycle connections after 5 minutes
    poolclass=NullPool if "sqlite" in DATABASE_URL else None
)

# Create async session factory
async_session_factory = sessionmaker(
    engine, 
    class_=AsyncSession, 
    expire_on_commit=False,
    autoflush=False
)

# Base class for all models
Base = declarative_base()

# Dependency to get DB session
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency that provides a database session.
    
    Yields:
        AsyncSession: An async database session
    """
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception as e:
            await session.rollback()
            logger.error(f"Database error: {e}", exc_info=True)
            raise

# Context manager for getting DB session in non-request contexts
@asynccontextmanager
async def get_db_cm() -> AsyncGenerator[AsyncSession, None]:
    """Async context manager that provides a database session.

    Yields:
        AsyncSession: An async database session
    """
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception as e:
            await session.rollback()
            logger.error(f"Database error: {e}", exc_info=True)
            raise

async def init_db():
    """Initialize the database.
    
    Creates all tables if they don't exist.
    """
    from sqlalchemy import inspect
    
    async with engine.begin() as conn:
        # Create all tables
        await conn.run_sync(Base.metadata.create_all)
        
        def get_table_names(sync_conn):
            inspector = inspect(sync_conn)
            return inspector.get_table_names()

        table_names = await conn.run_sync(get_table_names)
        logger.info(f"Database initialized. Tables: {table_names}")

# Import models to ensure they are registered with SQLAlchemy
from app.models import user, credential, task  # noqa
