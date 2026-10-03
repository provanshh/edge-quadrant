"""Centralized memory: a Qdrant Server collection shared by the fleet.

Same vector layout as the Edge shard (dense SigLIP2 "vision" + sparse BM25
"caption", with server-side IDF), so a memory moves edge -> cloud verbatim and
the cloud answers the same hybrid queries over every device's knowledge.

Every cloud point carries sync metadata: a monotonically increasing version,
who wrote it last, and per-field timestamps used for conflict detection.

If no server answers at CLOUD_URL, qdrant-client's embedded local mode stands
in so the workflow still runs; the UI labels which one is live.
"""

import logging
import time

from qdrant_client import QdrantClient, models

from .constants import (
    CLOUD_API_KEY,
    CLOUD_COLLECTION,
    CLOUD_FALLBACK_DIR,
    CLOUD_TIMEOUT_S,
    CLOUD_URL,
    SPARSE_VECTOR_NAME,
    VECTOR_DIMENSION,
    VECTOR_NAME,
)
from .sync_queue import now_iso

logger = logging.getLogger(__name__)


class CloudUnavailable(Exception):
    pass


def _sparse(sv) -> models.SparseVector | None:
    if sv is None or not list(sv.indices):
        return None
    return models.SparseVector(indices=list(sv.indices), values=list(sv.values))


class CloudStore:
    def __init__(self):
        self.client: QdrantClient | None = None
        self.kind = "disconnected"
        self.target = CLOUD_URL
        self.last_rtt_ms: float | None = None

    # ------------------------------------------------------------ lifecycle
    def connect(self):
        try:
            client = QdrantClient(url=CLOUD_URL, api_key=CLOUD_API_KEY, timeout=CLOUD_TIMEOUT_S)
            client.get_collections()
            self.client, self.kind, self.target = client, "qdrant-server", CLOUD_URL
        except Exception as e:
            logger.warning("No Qdrant Server at %s (%s); using embedded local mode", CLOUD_URL, e)
            CLOUD_FALLBACK_DIR.mkdir(parents=True, exist_ok=True)
            self.client = QdrantClient(path=str(CLOUD_FALLBACK_DIR))
            self.kind, self.target = "embedded", str(CLOUD_FALLBACK_DIR.name)
        self._ensure_collection()
        logger.info("Cloud memory: %s (%s)", self.kind, self.target)

    def _ensure_collection(self):
        if self.client.collection_exists(CLOUD_COLLECTION):
            return
        self.client.create_collection(
            CLOUD_COLLECTION,
            vectors_config={VECTOR_NAME: models.VectorParams(
                size=VECTOR_DIMENSION, distance=models.Distance.COSINE)},
            sparse_vectors_config={SPARSE_VECTOR_NAME: models.SparseVectorParams(
                modifier=models.Modifier.IDF)},
        )
        for key in ("device_id", "cls", "kind", "mission_id"):
            self.client.create_payload_index(CLOUD_COLLECTION, key, models.PayloadSchemaType.KEYWORD)

    def ping(self) -> bool:
        try:
            t0 = time.perf_counter()
            self.client.get_collection(CLOUD_COLLECTION)
            self.last_rtt_ms = (time.perf_counter() - t0) * 1000
            return True
        except Exception:
            return False

    def _call(self, fn, *args, **kwargs):
        try:
            t0 = time.perf_counter()
            out = fn(*args, **kwargs)
            self.last_rtt_ms = (time.perf_counter() - t0) * 1000
            return out
        except Exception as e:
            raise CloudUnavailable(str(e)) from e

    # --------------------------------------------------------------- reads
    def get_many(self, ids: list[str], with_vectors=False) -> dict:
        if not ids:
            return {}
        recs = self._call(self.client.retrieve, CLOUD_COLLECTION, ids=ids,
                          with_payload=True, with_vectors=with_vectors)
        return {str(r.id): r for r in recs}

    def count(self, device_id: str | None = None) -> int:
        flt = None
        if device_id:
            flt = models.Filter(must=[models.FieldCondition(
                key="device_id", match=models.MatchValue(value=device_id))])
        return self._call(self.client.count, CLOUD_COLLECTION, count_filter=flt, exact=True).count

    def device_counts(self) -> list:
        try:
            res = self._call(self.client.facet, CLOUD_COLLECTION, key="device_id", limit=12)
            return [[h.value, h.count] for h in res.hits]
        except CloudUnavailable:
            raise
        except Exception:
            return []

    def search(self, dense: list[float], sparse_query, limit: int):
        """Hybrid dense + BM25 over the fleet's memory, RRF-fused on the server."""
        prefetch = [models.Prefetch(query=dense, using=VECTOR_NAME, limit=limit * 6)]
        sq = _sparse(sparse_query)
        if sq is not None:
            prefetch.append(models.Prefetch(query=sq, using=SPARSE_VECTOR_NAME, limit=limit * 6))
        t0 = time.perf_counter_ns()
        res = self._call(
            self.client.query_points, CLOUD_COLLECTION,
            prefetch=prefetch, query=models.FusionQuery(fusion=models.Fusion.RRF),
            limit=limit, with_payload=True, with_vectors=[VECTOR_NAME],
        )
        micros = (time.perf_counter_ns() - t0) / 1_000
        return res.points, micros

    # -------------------------------------------------------------- writes
    def put(self, memory_id: str, dense: list[float], sparse_doc, payload: dict):
        vector = {VECTOR_NAME: dense}
        sp = _sparse(sparse_doc)
        if sp is not None:
            vector[SPARSE_VECTOR_NAME] = sp
        self._call(self.client.upsert, CLOUD_COLLECTION, wait=True,
                   points=[models.PointStruct(id=memory_id, vector=vector, payload=payload)])

    def patch(self, memory_id: str, payload: dict, sparse_doc=None):
        self._call(self.client.set_payload, CLOUD_COLLECTION, payload=payload,
                   points=[memory_id], wait=True)
        sp = _sparse(sparse_doc)
        if sp is not None:
            self._call(self.client.update_vectors, CLOUD_COLLECTION, wait=True,
                       points=[models.PointVectors(id=memory_id, vector={SPARSE_VECTOR_NAME: sp})])

    def delete(self, memory_id: str):
        self._call(self.client.delete, CLOUD_COLLECTION, wait=True,
                   points_selector=models.PointIdsList(points=[memory_id]))

    def remote_edit(self, memory_id: str, field: str, value, by: str, sparse_doc=None,
                    ts: str | None = None) -> int:
        """An edit made in the cloud (HQ console / another device), not by us."""
        recs = self.get_many([memory_id])
        rec = recs.get(memory_id)
        if rec is None:
            raise KeyError(memory_id)
        p = rec.payload or {}
        ts = ts or now_iso()
        version = int(p.get("version", 0)) + 1
        field_ts = dict(p.get("field_ts") or {})
        field_ts[field] = {"ts": ts, "by": by}
        self.patch(memory_id, {field: value, "version": version, "updated_at": ts,
                               "updated_by": by, "field_ts": field_ts}, sparse_doc)
        return version
