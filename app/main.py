import asyncio
import json
import logging

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import videos
from .captioner import Captioner
from .constants import MAX_UPLOAD_MB, PROJECT_ROOT
from .detector import ObjectDetector
from .director import Director
from .encoder import get_encoder
from .session import DemoSession
from .sync_manager import SyncManager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()


class Hub:
    """Broadcasts demo events to connected browsers, callable from any thread."""

    def __init__(self):
        self.sockets: set[WebSocket] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    async def send_all(self, event: dict):
        message = json.dumps(event)
        dead = []
        for ws in self.sockets:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.sockets.discard(ws)

    def emit(self, event: dict):
        if self.loop is None:
            return
        asyncio.run_coroutine_threadsafe(self.send_all(event), self.loop)


hub = Hub()
encoder = get_encoder()
detector = ObjectDetector()
captioner = Captioner()
sync = SyncManager(hub.emit)
session: DemoSession | None = None
demo_lock = asyncio.Lock()
demo_running = False


@app.on_event("startup")
async def startup():
    hub.loop = asyncio.get_running_loop()
    await asyncio.to_thread(sync.start)
    logger.info("Warming models (encoder, detector, captioner)...")
    await asyncio.to_thread(encoder.warm)
    await asyncio.to_thread(detector.warm)
    await asyncio.to_thread(captioner.warm)
    logger.info("Models warm. Ready to run.")


async def run_demo(mode: str, video_id: str = videos.MISSION_ID):
    global demo_running, session
    async with demo_lock:
        if demo_running:
            return
        demo_running = True

    try:
        if session is not None:
            session.shutdown()
        if mode == "auto":
            video_id = videos.MISSION_ID
        video = (video_id, videos.video_path(video_id), videos.video_name(video_id))
        session = DemoSession(encoder, detector, captioner, hub.emit, sync, video=video)

        if mode == "auto":
            await asyncio.to_thread(sync.set_online, True)
            await session.start(boot_delay=1.1)
            director = Director(session, hub.emit)
            await director.run_timeline()
            # Let the tail of the video play out.
            await asyncio.sleep(8)
            session.shutdown()
        else:
            await session.start(boot_delay=0.55)
            # Silent warm-up so the user's first search shows steady-state latency.
            await asyncio.sleep(2.5)
            await session.warm_query()
            # Stay live until the mission video ends; the pipeline announces
            # mission_complete itself. Memory remains searchable afterwards.
            await asyncio.to_thread(session.pipeline.thread.join)
    finally:
        demo_running = False


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    hub.sockets.add(ws)
    logger.info("Browser connected (%d active)", len(hub.sockets))
    await ws.send_text(json.dumps({"type": "ready", "running": demo_running}))
    await ws.send_text(json.dumps(sync.state()))
    for entry in list(sync.activity)[-60:]:
        await ws.send_text(json.dumps({"type": "activity", **entry}))
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            cmd = msg.get("cmd")
            if cmd == "start":
                video_id = str(msg.get("video") or videos.MISSION_ID)
                if videos.video_path(video_id) is None:
                    await ws.send_text(json.dumps({"type": "toast", "level": "warn",
                                                   "text": "That video is not available any more"}))
                    continue
                if demo_running and msg.get("force"):
                    await stop_current_run()
                if demo_running:
                    logger.info("Start ignored: demo already running")
                else:
                    logger.info("Start command received (mode=%s, video=%s)",
                                msg.get("mode", "interactive"), video_id)
                    asyncio.create_task(run_demo(msg.get("mode", "interactive"), video_id))
            elif cmd == "query":
                text = (msg.get("text") or "").strip()[:120]
                cls = (msg.get("cls") or "").strip()[:60] or None
                scope = msg.get("scope") if msg.get("scope") in ("edge", "cloud", "both") else "edge"
                if text and session is not None:
                    logger.info("User query: %r (cls=%r, scope=%s)", text, cls, scope)
                    asyncio.create_task(session.run_query(text, cls=cls, scope=scope))
            elif cmd == "label":
                text = (msg.get("text") or "").strip()[:60]
                if text and session is not None:
                    logger.info("Teach concept: %r", text)
                    asyncio.create_task(session.teach(text))
            else:
                await handle_sync_command(ws, cmd, msg)
    except WebSocketDisconnect:
        hub.sockets.discard(ws)
        logger.info("Browser disconnected (%d active)", len(hub.sockets))


async def stop_current_run(timeout: float = 8.0):
    """Stop the live pipeline so a new video can start (memory is reset)."""
    if session is not None and session.pipeline is not None:
        session.pipeline.stop()
    waited = 0.0
    while demo_running and waited < timeout:
        await asyncio.sleep(0.1)
        waited += 0.1


async def handle_sync_command(ws: WebSocket, cmd: str, msg: dict):
    """EdgeMind controls: network switch, sync, conflicts, memory management."""
    obj = (msg.get("obj") or "").strip()[:40] or None
    error = None
    if cmd == "net":
        await asyncio.to_thread(sync.set_online, bool(msg.get("online")))
    elif cmd == "sync_now":
        sync.sync_now()
    elif cmd == "resolve":
        choice = msg.get("choice")
        if choice in ("edge", "cloud", "latest"):
            await asyncio.to_thread(sync.resolve, int(msg.get("id", 0)), choice)
    elif cmd == "stage_conflict":
        error = await asyncio.to_thread(sync.stage_conflict, obj)
    elif cmd == "hq_edit":
        error = await asyncio.to_thread(sync.hq_edit, obj)
    elif cmd == "annotate" and obj:
        await asyncio.to_thread(sync.annotate, obj, (msg.get("note") or "").strip()[:160])
    elif cmd == "forget" and obj:
        await asyncio.to_thread(sync.forget, obj)
    elif cmd == "scope" and obj:
        await asyncio.to_thread(sync.set_scope, obj, msg.get("scope"))
    elif cmd == "policy":
        await asyncio.to_thread(sync.set_policy, msg.get("privacy_rule"), msg.get("conflict_mode"))
    elif cmd == "inspect" and obj:
        result = await asyncio.to_thread(sync.inspect, obj)
        if result:
            await ws.send_text(json.dumps(result))
    if error:
        await ws.send_text(json.dumps({"type": "toast", "level": "warn", "text": error}))


@app.get("/")
async def index():
    return FileResponse(PROJECT_ROOT / "static" / "index.html")


@app.get("/footage/{video_id}.mp4")
async def footage(video_id: str):
    path = videos.video_path(video_id)
    if path is None:
        raise HTTPException(404, "video not found")
    return FileResponse(path, media_type="video/mp4")


@app.get("/api/videos")
async def get_videos():
    return {"videos": videos.list_videos(), "running": demo_running,
            "current": session.video[0] if session and session.video else None}


@app.post("/api/videos")
async def upload_video(file: UploadFile = File(...)):
    if file.content_type and not (file.content_type.startswith("video/")
                                  or file.content_type == "application/octet-stream"):
        raise HTTPException(400, "please choose a video file")
    vid, raw, out = videos.new_upload_paths(file.filename)
    size = 0
    with raw.open("wb") as f:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD_MB * (1 << 20):
                f.close()
                raw.unlink(missing_ok=True)
                raise HTTPException(413, f"video is larger than {MAX_UPLOAD_MB} MB")
            f.write(chunk)
    logger.info("Upload received: %s (%.1f MB), transcoding...", file.filename, size / 1e6)
    try:
        meta = await asyncio.to_thread(videos.finalize_upload, vid, raw, out, file.filename)
    except Exception as e:
        logger.warning("Upload failed: %s", e)
        raise HTTPException(422, str(e))
    sync.log("info", "edge", f"🎞 New video added to the device: {meta['name']} ({meta['duration']:.0f}s)")
    return {"video": {**meta, "builtin": False, "url": f"/footage/{vid}.mp4"}}


@app.delete("/api/videos/{video_id}")
async def remove_video(video_id: str):
    if session and session.video and session.video[0] == video_id and demo_running:
        raise HTTPException(409, "this video is playing right now")
    if not videos.delete_upload(video_id):
        raise HTTPException(404, "video not found")
    return {"ok": True}


app.mount("/static", StaticFiles(directory=PROJECT_ROOT / "static"), name="static")
