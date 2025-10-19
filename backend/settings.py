from pydantic import BaseSettings, Field
from typing import List

class Settings(BaseSettings):
    groq_api_key: str = Field(..., env="GROQ_API_KEY")
    model: str = "openai/gpt-oss-120b"  # GPT-OSS 120B on Groq
    # Start with a strict allow-list:
    allowed_domains: List[str] = ["example.com", "wikipedia.org"]
    # Optional: blocklist if you want an extra fence
    blocked_domains: List[str] = []
    # UI auth token for kill/approve endpoints (simple shared secret)
    admin_token: str = Field("change-me")
    user_agent: str = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/120.0.0.0 Safari/537.36")

settings = Settings()
