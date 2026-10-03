"""Video library: the bundled mission footage plus user uploads.

Uploads are transcoded once with ffmpeg to H.264 MP4 (<= 1280 px wide,
30 fps, no audio) so the same file plays in the browser and decodes in
OpenCV for the pipeline. Everything stays on the device.
"""

import json
import logging
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import cv2

from .constants import MAX_UPLOAD_SECONDS, MISSION_VIDEO, UPLOADS_DIR

logger = logging.getLogger(__name__)

MISSION_ID = "mission"
BROWSER_SAFE = {".mp4", ".webm", ".m4v"}


def _probe(path: Path) -> dict:
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    w, h = cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    ok = cap.isOpened()
    cap.release()
    return {"ok": ok, "duration": round(frames / fps, 1) if fps else 0,
            "width": int(w), "height": int(h)}


def list_videos() -> list[dict]:
    out = []
    if MISSION_VIDEO.exists():
        out.append({"id": MISSION_ID, "name": "Demo · house walkthrough",
                    "duration": _probe(MISSION_VIDEO)["duration"], "builtin": True,
                    "url": f"/footage/{MISSION_ID}.mp4"})
    if UPLOADS_DIR.exists():
        metas = []
        for meta_file in UPLOADS_DIR.glob("*.json"):
            try:
                meta = json.loads(meta_file.read_text())
            except Exception:
                continue
            if (UPLOADS_DIR / f"{meta['id']}.mp4").exists():
                metas.append(meta)
        metas.sort(key=lambda m: m.get("created", 0), reverse=True)
        for m in metas:
            out.append({**m, "builtin": False, "url": f"/footage/{m['id']}.mp4"})
    return out


def video_path(video_id: str | None) -> Path | None:
    if not video_id or video_id == MISSION_ID:
        return MISSION_VIDEO if MISSION_VIDEO.exists() else None
    if not video_id.isalnum():
        return None
    path = UPLOADS_DIR / f"{video_id}.mp4"
    return path if path.exists() else None


def video_name(video_id: str | None) -> str:
    for v in list_videos():
        if v["id"] == (video_id or MISSION_ID):
            return v["name"]
    return video_id or MISSION_ID


def new_upload_paths(filename: str) -> tuple[str, Path, Path]:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    vid = uuid.uuid4().hex[:10]
    suffix = Path(filename or "").suffix.lower()[:8] or ".bin"
    return vid, UPLOADS_DIR / f"raw-{vid}{suffix}", UPLOADS_DIR / f"{vid}.mp4"


def finalize_upload(vid: str, raw: Path, out: Path, original_name: str) -> dict:
    """Transcode (or adopt) the raw upload, write metadata. Runs in a thread."""
    try:
        if shutil.which("ffmpeg"):
            cmd = [
                "ffmpeg", "-y", "-loglevel", "error", "-i", str(raw),
                "-t", str(MAX_UPLOAD_SECONDS),
                "-vf", "scale='min(1280,iw)':-2,fps=30",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
                "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", str(out),
            ]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode != 0:
                raise RuntimeError(res.stderr.strip()[-300:] or "ffmpeg failed")
        elif raw.suffix in BROWSER_SAFE:
            shutil.copyfile(raw, out)
        else:
            raise RuntimeError("ffmpeg is not installed; upload an .mp4 or .webm file")
        info = _probe(out)
        if not info["ok"] or info["duration"] <= 0:
            out.unlink(missing_ok=True)
            raise RuntimeError("could not read any frames from this video")
        stem = Path(original_name or "video").stem.replace("_", " ").replace("-", " ").strip()
        meta = {"id": vid, "name": (stem or "Uploaded video")[:60], "created": time.time(),
                "duration": info["duration"], "width": info["width"], "height": info["height"]}
        (UPLOADS_DIR / f"{vid}.json").write_text(json.dumps(meta))
        return meta
    finally:
        raw.unlink(missing_ok=True)


def delete_upload(video_id: str) -> bool:
    if video_id == MISSION_ID or not video_id.isalnum():
        return False
    removed = False
    for p in (UPLOADS_DIR / f"{video_id}.mp4", UPLOADS_DIR / f"{video_id}.json"):
        if p.exists():
            p.unlink()
            removed = True
    return removed
