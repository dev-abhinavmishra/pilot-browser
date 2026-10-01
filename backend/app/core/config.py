"""Configuration for the Pilot Browser backend — env vars with local defaults."""
import os
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict
from dotenv import load_dotenv

load_dotenv()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", case_sensitive=True)

    APP_NAME: str = "Pilot Browser"
    DEBUG: bool = os.getenv("DEBUG", "false").lower() == "true"
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")

    # OpenAI-compatible LLM — point at any compatible server (llama.cpp, LM Studio,
    # Ollama, OpenAI). Empty key disables LLM calls and keeps the rule/DDG fallbacks.
    OPENAI_API_KEY: Optional[str] = os.getenv("OPENAI_API_KEY", "lm-studio")
    OPENAI_API_BASE: Optional[str] = os.getenv("OPENAI_API_BASE", "http://localhost:1234/v1")
    LLM_MODEL: str = os.getenv("LLM_MODEL", "local-model")


settings = Settings()

__all__ = ["settings"]
