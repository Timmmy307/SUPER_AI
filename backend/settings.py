from pydantic import BaseSettings, Field
from typing import List
import os

class Settings(BaseSettings):
    groq_api_key: str = Field(..., env="GROQ_API_KEY")
    model: str = Field(default=os.getenv("MODEL", "openai/gpt-oss-120b"))
    allowed_domains: List[str] = Field(default_factory=lambda: os.getenv("ALLOWED_DOMAINS", "example.com,wikipedia.org").split(","))
    blocked_domains: List[str] = Field(default_factory=lambda: [d for d in os.getenv("BLOCKED_DOMAINS", "").split(",") if d])
    admin_token: str = Field(default=os.getenv("ADMIN_TOKEN", "change-me"))
    user_agent: str = Field(default=os.getenv("USER_AGENT", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"))

settings = Settings()
