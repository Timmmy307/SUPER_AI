from groq import Groq
from settings import settings

client = Groq(api_key=settings.groq_api_key)

SYSTEM_PROMPT = (
    "You are a cautious web-enabled assistant. "
    "Never browse domains not approved by the host unless explicitly allowed via approval. "
    "When unsure, ask for permission first."
)

def llm_chat(messages: list[dict]) -> str:
    resp = client.chat.completions.create(
        model=settings.model,  # e.g. "openai/gpt-oss-120b"
        messages=messages,
        temperature=0.2,
    )
    return resp.choices[0].message.content  # type: ignore
