"""FTMO AI Trading Bot dashboard — receives pushes from the bot PC and serves a live UI.

Channels:
  POST /api/ingest  full payload (60s from pusher)   [token]
  POST /api/tick    live prices + equity (2s)        [token]
  WS   /ws          streams ticks + full updates to browsers
  GET  /api/data    latest full payload (polling fallback)
  POST /api/command          queue a manual-exit command (browser; PIN checked by the bot)
  POST /api/commands/poll    bot picks up pending commands       [token]
  POST /api/command_result   bot reports command outcome          [token]
"""
import asyncio
import json
import os
import re
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, PlainTextResponse

TOKEN = os.environ.get("INGEST_TOKEN", "change-me")
DATA_FILE = Path(os.environ.get("DATA_FILE", "data/latest.json"))
TICK_FILE = Path(os.environ.get("TICK_FILE", "data/latest_tick.json"))
CMD_FILE = Path(os.environ.get("CMD_FILE", "data/commands.json"))
SUBS_FILE = Path(os.environ.get("SUBS_FILE", "data/subs.json"))
VAPID_PUB = os.environ.get("VAPID_PUB", "")

app = FastAPI(title="FTMO AI Bot Dashboard")
STATE: dict = {"payload": None}
TICK: dict = {}
CMDS: list = []
_RATE: dict = {}  # ip -> [unix ts] of recent /api/command posts

# push notifications to ingest handlers arrive on the event loop; keep a loop ref
LOOP: asyncio.AbstractEventLoop = None


class Hub:
    def __init__(self):
        self.clients = set()

    async def connect(self, ws):
        await ws.accept()
        self.clients.add(ws)

    def disconnect(self, ws):
        self.clients.discard(ws)

    def broadcast(self, msg: dict):
        """Thread-safe: schedule sends on the event loop."""
        if LOOP is None or not self.clients:
            return
        async def _send_all():
            for ws in list(self.clients):
                try:
                    await ws.send_json(msg)
                except Exception:
                    self.clients.discard(ws)
        asyncio.run_coroutine_threadsafe(_send_all(), LOOP)


HUB = Hub()


def _load_disk():
    if STATE["payload"] is None and DATA_FILE.exists():
        try:
            STATE["payload"] = json.loads(DATA_FILE.read_text())
        except Exception:
            pass
    if not TICK and TICK_FILE.exists():
        try:
            TICK.update(json.loads(TICK_FILE.read_text()))
        except Exception:
            pass
    if not CMDS and CMD_FILE.exists():
        try:
            CMDS.extend(json.loads(CMD_FILE.read_text()))
        except Exception:
            pass


def _save_cmds():
    try:
        CMD_FILE.parent.mkdir(parents=True, exist_ok=True)
        CMD_FILE.write_text(json.dumps(CMDS[-50:]))
    except Exception:
        pass


@app.on_event("startup")
async def _startup():
    global LOOP
    LOOP = asyncio.get_running_loop()


@app.get("/health")
def health():
    return {"ok": True, "ws_clients": len(HUB.clients)}


def _auth(authorization: str):
    if TOKEN != "change-me" and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="bad token")


@app.post("/api/ingest")
async def ingest(request: Request, authorization: str = Header(default="")):
    _auth(authorization)
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="bad json")
    payload["received_at"] = int(time.time())
    STATE["payload"] = payload
    try:
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        DATA_FILE.write_text(json.dumps(payload))
    except Exception:
        pass
    HUB.broadcast({"type": "full", "payload": payload})
    return {"ok": True}


@app.post("/api/tick")
async def tick(request: Request, authorization: str = Header(default="")):
    _auth(authorization)
    try:
        t = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="bad json")
    t["received_at"] = int(time.time())
    TICK.clear()
    TICK.update(t)
    try:
        TICK_FILE.parent.mkdir(parents=True, exist_ok=True)
        TICK_FILE.write_text(json.dumps(t))
    except Exception:
        pass
    HUB.broadcast({"type": "tick", "tick": t})
    return {"ok": True}


@app.post("/api/command")
async def command(request: Request):
    """Queue a manual-exit request from the browser. No token here (the page is
    public) — the PIN is verified on the bot PC before anything executes."""
    ip = request.client.host if request.client else "?"
    now = time.time()
    recent = [t for t in _RATE.get(ip, []) if now - t < 60]
    if len(recent) >= 6:
        raise HTTPException(status_code=429, detail="too many commands — slow down")
    recent.append(now)
    _RATE[ip] = recent
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="bad json")
    if body.get("type") != "close":
        raise HTTPException(status_code=400, detail="only close commands are supported")
    sym = str(body.get("symbol", ""))
    pin = str(body.get("pin", ""))
    if not re.fullmatch(r"[A-Z0-9.\-]{3,20}", sym, re.IGNORECASE) or not pin:
        raise HTTPException(status_code=400, detail="bad symbol or missing PIN")
    cmd = {"id": uuid.uuid4().hex[:12], "type": "close", "symbol": sym.upper(),
           "pin": pin, "ts": int(now), "status": "pending"}
    CMDS.append(cmd)
    _save_cmds()
    return {"ok": True, "id": cmd["id"]}


@app.post("/api/commands/poll")
async def commands_poll(request: Request, authorization: str = Header(default="")):
    """Bot fetches pending commands (marks them claimed so they run once)."""
    _auth(authorization)
    _load_disk()
    now = time.time()
    pending = [c for c in CMDS if c["status"] == "pending"]
    for c in pending:
        c["status"] = "claimed"
    if pending:
        _save_cmds()
    return {"commands": pending, "server_time": int(now)}


@app.post("/api/command_result")
async def command_result(request: Request, authorization: str = Header(default="")):
    _auth(authorization)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="bad json")
    for c in CMDS:
        if c["id"] == body.get("id"):
            c["status"] = "done" if body.get("ok") else "failed"
            c["message"] = str(body.get("message", ""))[:200]
            c["result_ts"] = int(time.time())
            _save_cmds()
            return {"ok": True}
    return {"ok": False, "detail": "unknown command id"}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await HUB.connect(ws)
    try:
        # send current state immediately on connect
        _load_disk()
        if STATE["payload"]:
            await ws.send_json({"type": "full", "payload": STATE["payload"]})
        if TICK:
            await ws.send_json({"type": "tick", "tick": TICK})
        while True:
            await ws.receive_text()  # keepalive from client; ignore content
    except WebSocketDisconnect:
        pass
    finally:
        HUB.disconnect(ws)


@app.get("/api/data")
def data():
    _load_disk()
    merged = dict(STATE["payload"] or {"empty": True})
    if not merged.get("empty"):
        merged["prices"] = TICK.get("prices") or merged.get("prices")
        if TICK.get("equity") is not None:
            merged.setdefault("account", {})["equity"] = TICK["equity"]
    # recent manual commands for UI feedback — PINs never leave the server
    merged["commands"] = [{k: c[k] for k in ("id", "type", "symbol", "status", "message", "ts") if k in c}
                          for c in CMDS[-20:]]
    return JSONResponse(merged)


# ---- web push (iOS home-screen / desktop PWA) ----

@app.get("/sw.js")
def sw_js():
    return FileResponse("sw.js", media_type="application/javascript")


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse("manifest.webmanifest", media_type="application/manifest+json")


@app.get("/icon-192.png")
def icon192():
    return FileResponse("icon-192.png", media_type="image/png")


@app.get("/icon-512.png")
def icon512():
    return FileResponse("icon-512.png", media_type="image/png")


@app.get("/api/push/key")
def push_key():
    return PlainTextResponse(VAPID_PUB)


def _load_subs():
    _load_disk()
    try:
        return json.loads(SUBS_FILE.read_text())
    except Exception:
        return []


def _save_subs(subs):
    try:
        SUBS_FILE.parent.mkdir(parents=True, exist_ok=True)
        SUBS_FILE.write_text(json.dumps(subs))
    except Exception:
        pass


@app.post("/api/push/subscribe")
async def push_subscribe(request: Request):
    """Browsers can't hold the ingest token — the PIN/data risk of a public
    subscribe endpoint is just junk entries; they never see real pushes."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="bad json")
    sub = body.get("subscription") or {}
    if not isinstance(sub, dict) or not sub.get("endpoint"):
        raise HTTPException(status_code=400, detail="missing subscription endpoint")
    subs = _load_subs()
    subs = [s for s in subs if s.get("endpoint") != sub.get("endpoint")]
    subs.append(sub)
    if len(subs) > 20:
        subs = subs[-20:]
    _save_subs(subs)
    return {"ok": True, "count": len(subs)}


@app.get("/api/push/subscriptions")
def push_subs_get(authorization: str = Header(default="")):
    _auth(authorization)
    return {"subscriptions": _load_subs()}


@app.post("/api/push/subscriptions")
async def push_subs_set(request: Request, authorization: str = Header(default="")):
    """The bot is the source of truth — it restores subs after a server rebuild."""
    _auth(authorization)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="bad json")
    subs = body.get("subscriptions") or []
    _save_subs(subs)
    return {"ok": True, "count": len(subs)}


@app.get("/", response_class=HTMLResponse)
def index():
    return Path("index.html").read_text()
