from fastapi import FastAPI,WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from backend.player_tracker import publish,store,get_snaps
from backend.models import PlayerSnapshot
from backend.database import init_db, insert_session, insert_snapshot
from backend.predictor import predict,train
from backend.generator import generate_room
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
import redis
import os
import json
import asyncio

@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield

app=FastAPI(title="LiminalVoid", version="1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class CSPMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://cdn.jsdelivr.net; "
            "style-src 'self' 'unsafe-inline'; "
            "font-src 'self' data:; "
            "img-src 'self' data: blob:; "
            "connect-src 'self' ws://localhost:8000 ws://127.0.0.1:8000;"
        )
        return response
app.add_middleware(CSPMiddleware) 

redis_host=os.environ.get("REDIS_HOST","127.0.0.1")
cache= redis.Redis(host=redis_host, port=6379)

connected_clients: list[WebSocket]=[]


@app.get("/health")
def health():
    return {"status": "alive", "service": "liminalvoid-api"}

@app.get("/redis-check")
def redis_check():
    cache.set("test","liminalvoid_works")
    val = cache.get("test")
    return {"redis": val.decode()}

@app.post("/train")
def train_model():
    train(epochs=30)
    return {"status": "trained", "epochs": 30}

@app.websocket("/ws/player")
async def player(websocket: WebSocket):
    await websocket.accept()
    connected_clients.append(websocket)
    try:
        while True:
            data= await websocket.receive_text()
            snapshot= json.loads(data)
            snapshot_obj=PlayerSnapshot(**snapshot) 
            store(snapshot_obj)
            publish(snapshot_obj)
            insert_snapshot(snapshot_obj.model_dump())
            prediction = predict(snapshot_obj.session_id)
            room = generate_room(prediction)
            await websocket.send_json(room)


          

    except WebSocketDisconnect:
        connected_clients.remove(websocket)

@app.post("/snap")
def recieve(snap:PlayerSnapshot):
    insert_session(snap.session_id)
    insert_snapshot(snap.model_dump())
    publish(snap)
    store(snap)
    return {
        "status": "received",
        "session_id": snap.session_id,
        "snapshots_stored": len(get_snaps(snap.session_id))
    }

@app.get("/session/{session_id}")
def session(session_id: str):
    snap=get_snaps(session_id)
    return {
        "session_id":session_id,
        "count":len(snap),
        "snapshot":snap
    }


app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")


