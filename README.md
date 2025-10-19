# Groq OSS-120B Agent (Playwright Docker Option B)

This repo runs a restricted web agent that:
- Uses **Groq** Chat Completions (OpenAI-compatible) (default model: `openai/gpt-oss-120b`)
- Browses the web **headlessly** via Playwright (Chromium) with a real user agent
- Enforces a **domain allow-list** and **click-to-approve** UX
- Provides a **kill switch** (shutdown/start) behind an admin token

## 1) Configure
```bash
cp backend/.env.example backend/.env
# Put your GROQ_API_KEY=... in backend/.env
```

## 2) Build & Run (Docker)
```bash
docker compose up -d --build
docker compose logs -f
```

Open `frontend/index.html` in your browser. If serving via another host, point it at `http://localhost:8000`.

## 3) Render.com
- Headless Playwright only (works fine with this image).
- The base image already includes browsers.

## 4) Useful commands
```bash
docker compose up -d --build   # rebuild after changes
docker compose logs -f         # follow logs
docker compose down            # stop & remove
```

## 5) Security
- Keep `.env` out of git.
- Change `ADMIN_TOKEN` in `.env`.
- Consider outbound network ACLs as an extra hard fence.
