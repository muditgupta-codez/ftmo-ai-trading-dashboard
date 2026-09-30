"""FTMO AI Trading Bot dashboard — receives pushes from the bot PC and serves a live UI."""
import json
import os
import time
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

TOKEN = os.environ.get("INGEST_TOKEN", "change-me")
DATA_FILE = Path(os.environ.get("DATA_FILE", "data/latest.json"))

app = FastAPI(title="FTMO AI Bot Dashboard")
STATE: dict = {"payload": None}


def _load_disk():
    if STATE["payload"] is None and DATA_FILE.exists():
        try:
            STATE["payload"] = json.loads(DATA_FILE.read_text())
        except Exception:
            pass


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/api/ingest")
async def ingest(request: Request, authorization: str = Header(default="")):
    if TOKEN != "change-me" and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="bad token")
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
    return {"ok": True}


@app.get("/api/data")
def data():
    _load_disk()
    return JSONResponse(STATE["payload"] or {"empty": True})


@app.get("/", response_class=HTMLResponse)
def index():
    return Path("index.html").read_text()
