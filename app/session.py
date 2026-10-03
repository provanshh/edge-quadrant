"""A live demo session: the Edge shard, detector, captioner, ingest pipeline,
and the shared query path used by both interactive commands and the auto
director. Everything runs in this one process; nothing leaves the device."""

import asyncio
import base64
import logging

import numpy as np

from .constants import (
    DEVICE_ID,
    OBJECT_SEARCH_LIMIT,
    RRF_K,
    SHARD_DIR,
    THUMBS_DIR,
    WEAK_OBJECT_SCORE,
)
from .edge_store import EdgeStore
from .pipeline import IngestPipeline
from .projection import MemoryMapProjector
from .registry import ObjectRegistry

logger = logging.getLogger(__name__)

BOOT_LINES = [
    "edgemind // offline-first ai memory · powered by qdrant edge",
    "shard path: ./edge-data/shard  (a folder, not a server)",
    "dense: siglip2-base · 768d · cosine   sparse: bm25 over captions",
    "detector: yoloe-11l · open vocabulary · on-device",
    "captioner: florence-2-base · enriching every object it meets",
    "sync engine: edge ledger ⇄ qdrant server · versioned, conflict-aware",
    "0 objects remembered · patrol start",
]


class DemoSession:
    def __init__(self, encoder, detector, captioner, emit, sync=None, video=None):
        self.encoder = encoder
        self.detector = detector
        self.captioner = captioner
        self.emit = emit
        self.sync = sync
        # (video_id, path, display name); None means the bundled mission footage
        self.video = video
        self.store = None
        self.pipeline = None
        self.registry = None
        self.projector = None
        self.ready = False

    async def start(self, boot_delay: float):
        """Reset all state, play the boot sequence, start ingesting."""
        self.ready = False

        self.store = EdgeStore(SHARD_DIR)
        self.projector = MemoryMapProjector()

        self.emit({"type": "phase", "name": "boot"})

        await asyncio.to_thread(self.store.initialize)
        await asyncio.to_thread(self.detector.reset)
        self.projector.load()

        self.registry = ObjectRegistry(
            self.encoder, self.store, self.projector, self.captioner, self.emit,
        )
        self.captioner.on_caption = self.registry.attach_caption
        if self.captioner.thread is None:
            self.captioner.start()
        if self.sync is not None:
            self.sync.attach(self.store, self.registry)

        for line in BOOT_LINES:
            self.emit({"type": "boot_line", "text": line})
            await asyncio.sleep(boot_delay)
        await asyncio.sleep(0.4)

        video_id, video_path, video_name = self.video or ("mission", None, "Demo · house walkthrough")
        self.pipeline = IngestPipeline(
            self.encoder, self.detector, self.registry,
            self.store, self.projector, self.emit, video_path=video_path,
        )
        self.emit({"type": "video_start", "vocab": len(self.detector.vocab),
                   "video_id": video_id, "video_name": video_name,
                   "video_url": f"/footage/{video_id}.mp4"})
        self.pipeline.start()
        self.ready = True

    async def run_query(self, text: str, cls: str | None = None, scope: str = "edge"):
        """Embed the query, hybrid-search the shard and/or the cloud, emit results.

        scope: "edge" (on-device only), "cloud" (fleet memory on Qdrant
        Server), or "both" (merged, deduplicated by memory id). Edge search
        never touches the network; cloud search degrades gracefully offline.
        """
        use_edge = scope in ("edge", "both")
        use_cloud = scope in ("cloud", "both") and self.sync is not None
        if not self.ready or (self.store.count == 0 and not use_cloud):
            self.emit({"type": "query_result", "text": text, "latency_us": 0, "scope": scope,
                       "objects": [], "moments": []})
            return

        def search():
            qvec = self.encoder.encode_text(text)
            qnorm = qvec / (np.linalg.norm(qvec) + 1e-9)
            objects, moments, micros = [], [], 0.0
            if use_edge and self.store.count:
                objects, obj_us = self.store.search_objects(qvec, text, cls=cls)
                moments, mom_us = self.store.search_frames(qvec)
                micros = obj_us + mom_us
            cloud_pts, cloud_us, cloud_err = None, 0.0, None
            if use_cloud:
                cloud_pts, cloud_us, cloud_err = self.sync.cloud_search(
                    qvec, text, OBJECT_SEARCH_LIMIT + 2)
            return qnorm, objects, moments, micros, cloud_pts, cloud_us, cloud_err

        (qnorm, objects, moments, micros,
         cloud_pts, cloud_us, cloud_err) = await asyncio.to_thread(search)

        def cosine(vec):
            if vec is None:
                return None
            v = np.asarray(vec, dtype=np.float32)
            return float(qnorm @ (v / (np.linalg.norm(v) + 1e-9)))

        words = [w for w in text.lower().split() if len(w) > 2]

        def lexical_hit(p) -> bool:
            hay = f"{p.get('caption') or ''} {p.get('note') or ''}".lower()
            return bool(words) and all(w in hay for w in words)

        object_cards = []
        by_id = {}
        fused = {}
        for rank, r in enumerate(objects):
            fused[str(r.id)] = 1.0 / (RRF_K + rank + 1)
        for rank, r in enumerate(cloud_pts or []):
            fused[str(r.id)] = fused.get(str(r.id), 0.0) + 1.0 / (RRF_K + rank + 1)

        for r in objects:
            vec = r.vector.get("vision") if isinstance(r.vector, dict) else None
            score = cosine(vec)
            p = r.payload
            card = {
                "id": str(r.id),
                "obj": p.get("obj"),
                "cls": p.get("cls"),
                "caption": p.get("caption"),
                "note": p.get("note"),
                "score": round(score, 3) if score is not None else None,
                "thumb": self._thumb_b64(p.get("thumb")),
                "t_first": p.get("t_first"),
                "t_last": p.get("t_last"),
                "box": p.get("box"),
                "xy": [p.get("x"), p.get("y")],
                "sightings": p.get("sightings"),
                "weak": score is not None and score < WEAK_OBJECT_SCORE and not lexical_hit(p),
                "source": "edge",
                "device": DEVICE_ID,
            }
            object_cards.append(card)
            by_id[card["id"]] = card

        for r in cloud_pts or []:
            p = r.payload or {}
            pid = str(r.id)
            if pid in by_id:
                by_id[pid]["source"] = "both"
                by_id[pid]["cloud_version"] = p.get("version")
                continue
            vec = r.vector.get("vision") if isinstance(r.vector, dict) else None
            score = cosine(vec)
            object_cards.append({
                "id": pid,
                "obj": p.get("obj"),
                "cls": p.get("cls"),
                "caption": p.get("caption"),
                "note": p.get("note"),
                "score": round(score, 3) if score is not None else None,
                "thumb": p.get("thumb_b64") or "",
                "t_first": p.get("t_first"),
                "t_last": p.get("t_last"),
                "sightings": p.get("sightings"),
                "weak": score is not None and score < WEAK_OBJECT_SCORE and not lexical_hit(p),
                "source": "cloud",
                "device": p.get("device_id"),
                "mission": p.get("mission_id"),
                "cloud_version": p.get("version"),
            })

        if use_cloud and use_edge:
            # Both lists are already hybrid-ranked; fuse the rankings (RRF)
            # rather than re-sorting on the dense score alone.
            object_cards.sort(key=lambda c: fused.get(c["id"], 0.0), reverse=True)
            object_cards = object_cards[:OBJECT_SEARCH_LIMIT + 2]

        moment_cards = [
            {
                "score": round(r.score, 3),
                "thumb": self._thumb_b64(r.payload.get("thumb")),
                "video_ts": r.payload.get("t"),
                "xy": [r.payload.get("x"), r.payload.get("y")],
            }
            for r in moments
        ]

        self.emit({
            "type": "query_result",
            "text": text,
            "cls": cls,
            "scope": scope,
            "latency_us": round(micros, 1),
            "cloud_latency_us": round(cloud_us, 1) if use_cloud and not cloud_err else None,
            "cloud_error": cloud_err,
            "objects": object_cards,
            "moments": moment_cards,
        })

    @staticmethod
    def _thumb_b64(name) -> str:
        if not name:
            return ""
        path = THUMBS_DIR / name
        if not path.exists():
            return ""
        return base64.b64encode(path.read_bytes()).decode()

    async def warm_query(self):
        if self.ready:
            def warm():
                qvec = self.encoder.encode_text("warm up")
                self.store.search_objects(qvec, "warm up")
                self.store.search_frames(qvec)
            await asyncio.to_thread(warm)

    async def teach(self, text: str):
        """Teach the detector a new concept: one text embedding, applied live."""
        if not self.ready:
            return
        added = self.detector.teach(text)
        if not added:
            return
        self.emit({"type": "label_added", "text": text})

    def shutdown(self):
        self.ready = False
        if self.pipeline:
            self.pipeline.stop()
        if self.captioner:
            self.captioner.on_caption = None
        if self.store:
            try:
                self.store.close()
            except Exception:
                pass
