"""FTMO AI Trading Bot dashboard — receives pushes from the bot PC and serves a live UI.

Channels:
  POST /api/ingest  full payload (60s from pusher)   [token]
  POST /api/tick    live prices + equity (2s)        [token]
  WS   /ws          streams ticks + full updates to browsers
  GET  /api/data    latest full payload (polling fallback)
"""
import asyncio
import json
import os
import time
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse

TOKEN = os.environ.get("INGEST_TOKEN", "change-me")
DATA_FILE = Path(os.environ.get("DATA_FILE", "data/latest.json"))
TICK_FILE = Path(os.environ.get("TICK_FILE", "data/latest_tick.json"))

app = FastAPI(title="FTMO AI Bot Dashboard")
STATE: dict = {"payload": None}
TICK: dict = {}

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
    return JSONResponse(merged)


@app.get("/", response_class=HTMLResponse)
def index():
    return Path("index.html").read_text()
