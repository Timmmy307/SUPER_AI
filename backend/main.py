import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Body, HTTPException, Query
from fastapi.responses import StreamingResponse, JSONResponse
from typing import Dict, Any
from urllib.parse import urlparse
from settings import settings
from security import require_admin
from browser import fetch_page
from agent import llm_chat

app = FastAPI(title="Groq OSS120B Restricted Agent")

# --- State ---
shutdown_flag = False
allowed_domains = set(settings.allowed_domains)
blocked_domains = set(settings.blocked_domains)

# --- Helpers ---
def domain_of(url: str) -> str:
    return urlparse(url).hostname or ""

def ensure_not_shutdown():
    if shutdown_flag:
        raise HTTPException(status_code=503, detail="Agent is shut down")

# --- Admin / Kill switch ---
@app.post("/admin/shutdown")
def shutdown(_: Any = require_admin):
    global shutdown_flag
    shutdown_flag = True
    return {"ok": True, "status": "shutdown"}

@app.post("/admin/start")
def start(_: Any = require_admin):
    global shutdown_flag
    shutdown_flag = False
    return {"ok": True, "status": "running"}

@app.post("/admin/allow")
def admin_allow(domain: str = Body(...), _: Any = require_admin):
    allowed_domains.add(domain)
    return {"ok": True, "allowed": sorted(allowed_domains)}

@app.get("/admin/status")
def status(_: Any = require_admin):
    return {"shutdown": shutdown_flag, "allowed": sorted(allowed_domains), "blocked": sorted(blocked_domains)}

# --- Browsing with allow-list + approval flow ---
@app.get("/browse/text")
async def browse_text(url: str = Query(...), approve: bool = Query(False)):
    ensure_not_shutdown()
    dom = domain_of(url)
    if dom in blocked_domains:
        raise HTTPException(403, "Domain is blocked")
    if dom not in allowed_domains and not approve:
        return JSONResponse(
            status_code=401,
            content={"needsApproval": True, "domain": dom, "url": url}
        )
    text, _ = await fetch_page(url, want_screenshot=False)
    # optional: trim very long text
    return {"domain": dom, "text": text[:200000]}

@app.get("/browse/screenshot")
async def browse_screenshot(url: str = Query(...), approve: bool = Query(False)):
    ensure_not_shutdown()
    dom = domain_of(url)
    if dom in blocked_domains:
        raise HTTPException(403, "Domain is blocked")
    if dom not in allowed_domains and not approve:
        return JSONResponse(
            status_code=401,
            content={"needsApproval": True, "domain": dom, "url": url}
        )
    _, img = await fetch_page(url, want_screenshot=True)
    if not img:
        raise HTTPException(500, "Screenshot failed")
    return StreamingResponse(iter([img]), media_type="image/png")

# --- Task endpoint that lets the LLM decide to browse, but enforces approvals ---
@app.post("/task")
async def run_task(payload: Dict[str, Any]):
    ensure_not_shutdown()
    user_goal = payload.get("goal", "")
    # Extremely simple example: ask LLM to produce a plan; client can call /browse endpoints as needed.
    content = llm_chat([
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Goal: {user_goal}\nCreate a short, concrete plan and list any URLs you need."}
    ])
    return {"plan": content}

# --- WebSocket to drive "popup" approvals from the UI ---
@app.websocket("/ws/approvals")
async def approvals_ws(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            # Client sends {"url": "..."} when LLM/tool asks for a new domain
            msg = await ws.receive_json()
            url = msg.get("url", "")
            dom = domain_of(url)
            if dom in blocked_domains:
                await ws.send_json({"approved": False, "domain": dom})
                continue
            if dom in allowed_domains:
                await ws.send_json({"approved": True, "domain": dom})
                continue
            # Ask the operator via UI (client shows a modal); here we just echo back and client decides.
            await ws.send_json({"needsDecision": True, "domain": dom, "url": url})
    except WebSocketDisconnect:
        pass
