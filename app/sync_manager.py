"""EdgeMind sync engine: reconciles the device's Edge shard with the fleet's
Qdrant Server whenever the link allows.

Offline-first contract:
  - Perception, memory writes and search never wait on the network. Every
    change lands in the Edge shard first and in the sync ledger second.
  - When the link is down (simulated switch, or the server really is
    unreachable) changes queue up; nothing is lost and nothing blocks.
  - When it returns, the queue drains in priority order. Each memory is
    reconciled with a three-way merge against the cloud copy:
        cloud absent                -> create (v1)
        cloud unchanged since base  -> fast-forward upload
        cloud changed, disjoint     -> adopt cloud fields locally, upload merge
        cloud changed, same field   -> CONFLICT (manual or latest-wins)
    Telemetry (sightings, last seen) merges with max() and never conflicts.
  - Cloud-side edits to memories this device holds are pulled down and
    applied to the Edge shard (payload + BM25 re-index).
"""

import base64
import itertools
import logging
import random
import threading
import time
from collections import deque
from datetime import datetime

from .cloud_store import CloudStore, CloudUnavailable
from .constants import (
    DEVICE_ID,
    MAX_SYNC_RETRIES,
    PRIVATE_CLASSES,
    PULL_INTERVAL_S,
    SEMANTIC_FIELDS,
    SYNC_BATCH,
    SYNC_BATCH_PACING_S,
    SYNC_DB,
    SYNC_INTERVAL_S,
    THUMBS_DIR,
    VECTOR_NAME,
)
from .sync_policy import SyncPolicy
from .sync_queue import SyncLedger, now_iso

logger = logging.getLogger(__name__)

HQ_NOTES = [
    "HQ: scheduled for replacement next quarter",
    "HQ: verified against asset register",
    "HQ: flagged for safety inspection",
    "HQ: owner requested this stays in place",
]
def _mem(n: int) -> str:
    return f"{n} memor{'y' if n == 1 else 'ies'}"


STAGED_CLOUD_NOTE = "HQ inspection #{n}: condition OK, no action"
STAGED_EDGE_NOTE = "Field report #{n}: damage spotted on-site, needs repair"


class SyncManager:
    def __init__(self, emit):
        self.emit = emit
        self.cloud = CloudStore()
        self.policy = SyncPolicy()
        self.online = True            # the operator's network switch
        self.reachable = False        # did the cloud actually answer last time
        self.ledger: SyncLedger | None = None
        self.store = None
        self.registry = None
        self.mission_id = None
        self.lock = threading.RLock()
        self.activity = deque(maxlen=250)
        self._seq = itertools.count(1)
        self.last_sync_at = None
        self.drain = {"active": False, "done": 0, "total": 0}
        self.cloud_counts = {"total": None, "device": None, "devices": []}
        self._last_pull = 0.0
        self._last_counts = 0.0
        self._dirty = True
        self._running = False
        self._staged = 0
        self._backlog_pending = False   # next drain follows a reconnect

    # ------------------------------------------------------------ lifecycle
    def start(self):
        try:
            self.cloud.connect()
            self.reachable = True
            self._refresh_cloud_counts(force=True)
            self.log("ok", "net", f"Cloud memory online · {self._cloud_label()}")
        except Exception as e:
            logger.exception("Cloud connect failed")
            self.log("warn", "net", f"Cloud memory unavailable ({e}); running edge-only")
        self._running = True
        threading.Thread(target=self._worker, daemon=True, name="sync-worker").start()
        threading.Thread(target=self._state_loop, daemon=True, name="sync-state").start()

    def attach(self, store, registry):
        """A new mission: fresh shard, fresh ledger, same cloud."""
        with self.lock:
            if self.ledger is not None:
                self.ledger.close()
            self.ledger = SyncLedger(SYNC_DB)
            self.store = store
            self.registry = registry
            self.mission_id = datetime.now().strftime("m-%Y%m%d-%H%M%S")
            registry.on_change = self.on_memory_change
            self.drain = {"active": False, "done": 0, "total": 0}
            self.last_sync_at = None
            self.activity.clear()
            self.log("info", "edge", f"Mission {self.mission_id} · Edge shard initialized on device")
            self.log("info", "net", f"Link {'ONLINE' if self.online else 'OFFLINE'} · cloud: {self._cloud_label()}")
            self._dirty = True

    def _cloud_label(self) -> str:
        if self.cloud.kind == "qdrant-server":
            return f"Qdrant Server @ {self.cloud.target.replace('http://', '')}"
        if self.cloud.kind == "embedded":
            return "embedded Qdrant (local mode)"
        return "not connected"

    # ------------------------------------------------------------- activity
    def log(self, level: str, cat: str, text: str):
        entry = {"id": next(self._seq), "ts": time.time(), "level": level, "cat": cat, "text": text}
        self.activity.append(entry)
        self.emit({"type": "activity", **entry})

    def _status(self, label: str, status: str):
        self.emit({"type": "memory_status", "obj": label, "status": status})
        self._dirty = True

    # ------------------------------------------------- hooks from the device
    def on_memory_change(self, rec, event: str, patch: dict):
        ledger = self.ledger
        if ledger is None:
            return
        if event == "created":
            scope, reason = self.policy.classify("object", rec.cls)
            status = ledger.register(rec.point_id, rec.label, rec.cls, "object", scope, reason, {})
            if scope == "local":
                self.log("dim", "edge", f"{rec.label} {rec.cls} → Edge · kept on device ({reason})")
            elif self.link_up():
                self.log("dim", "edge", f"{rec.label} {rec.cls} → Edge · queued for sync")
            else:
                self.log("info", "queue", f"{rec.label} {rec.cls} → Edge ✓ · offline, added to sync queue")
            self._status(rec.label, status)
        elif event in ("caption", "edit"):
            mem = ledger.record_change(rec.point_id, patch)
            if mem is not None:
                if event == "edit":
                    where = "queued" if mem["scope"] == "sync" else "local only"
                    self.log("info", "edge", f"✎ {rec.label} {', '.join(patch)} edited on device · {where}")
                self._status(rec.label, mem["status"])
        elif event == "forgotten":
            mem = ledger.mark_deleted(rec.point_id)
            if mem is not None:
                tail = "deletion queued for cloud" if mem["base_version"] > 0 else "never left the device"
                self.log("warn", "edge", f"🗑 {rec.label} forgotten on device · {tail}")
                self._status(rec.label, "deleted")
        self._dirty = True

    # ----------------------------------------------------------- connection
    def link_up(self) -> bool:
        return self.online and self.reachable

    def set_online(self, online: bool):
        if online == self.online:
            return
        self.online = online
        if online:
            self.log("ok", "net", "🌐 Network restored · reconnecting to cloud memory")
            pending = self.ledger.counts()["queued_ops"] if self.ledger else 0
            if pending:
                self._backlog_pending = True
                self.log("info", "sync", f"{pending} change{'s' if pending != 1 else ''} waiting in the sync queue")
        else:
            self.log("warn", "net", "⚠ Network unavailable · local memory and search stay active, cloud sync paused")
            if self.ledger:
                self.ledger.release_in_flight()
            self.drain["active"] = False
        self._dirty = True

    def _lost_cloud(self, err: str):
        if self.reachable:
            self.log("warn", "net", f"⚠ Cloud unreachable · changes stay queued ({err[:80]})")
        self.reachable = False
        if self.ledger:
            self.ledger.release_in_flight()
        self.drain["active"] = False
        self._dirty = True

    # --------------------------------------------------------------- worker
    def _worker(self):
        while self._running:
            try:
                worked = self._tick()
            except Exception:
                logger.exception("Sync tick failed")
                worked = False
            time.sleep(SYNC_BATCH_PACING_S if worked else SYNC_INTERVAL_S)

    def _tick(self) -> bool:
        if self.ledger is None or not self.online or self.cloud.client is None:
            return False
        if not self.reachable:
            if not self.cloud.ping():
                return False
            self.reachable = True
            self._backlog_pending = True
            self.log("ok", "net", f"Cloud memory reachable · {self._cloud_label()}")
            self._dirty = True

        with self.lock:
            batch = self.ledger.take_batch(SYNC_BATCH)
            if not batch:
                self._finish_drain()
                self._maybe_pull()
                self._refresh_cloud_counts()
                return False

            if not self.drain["active"]:
                total = self.ledger.counts()["queued_ops"]
                # A backlog (reconnect, outage) is a headline event; trickle
                # sync of fresh memories while online stays quiet.
                backlog = total >= 5 or self._backlog_pending
                self.drain = {"active": True, "done": 0, "total": total,
                              "started": time.time(), "backlog": backlog}
                self._backlog_pending = False
                if backlog:
                    self.log("info", "sync", f"↻ Synchronizing {_mem(total)} → cloud")

            uploaded, removed = [], []
            for item in batch:
                try:
                    outcome = self._sync_one(item)
                except CloudUnavailable as e:
                    self._lost_cloud(str(e))
                    return False
                except Exception as e:
                    logger.exception("Sync failed for %s", item["memory_id"])
                    self.ledger.fail(item["memory_id"], str(e))
                    if item["retry_count"] + 1 >= MAX_SYNC_RETRIES:
                        self.log("err", "sync", f"✗ {item['memory_id'][:8]} failed {MAX_SYNC_RETRIES}× : {e}")
                    continue
                label = outcome[1]
                if outcome[0] == "uploaded":
                    uploaded.append(f"{label} v{outcome[2]}")
                elif outcome[0] == "removed":
                    removed.append(label)
                self.drain["done"] += 1

            remaining = self.ledger.counts()["queued_ops"]
            self.drain["total"] = max(self.drain["total"], self.drain["done"] + remaining)
            if uploaded:
                backlog = self.drain.get("backlog")
                self.log("ok" if backlog else "dim", "sync",
                         f"↑ {len(uploaded)} synced → cloud · {', '.join(uploaded)}"
                         + (f"  [{self.drain['done']}/{self.drain['total']}]" if backlog else ""))
            if removed:
                self.log("ok", "sync", f"↑ removed from cloud · {', '.join(removed)}")
            self._dirty = True
            return True

    def _finish_drain(self):
        if self.drain["active"]:
            n = self.drain["done"]
            self.drain["active"] = False
            self.last_sync_at = time.time()
            if self.drain.get("backlog"):
                self.log("ok", "sync", f"✓ Synchronization complete · {_mem(n)} up to date")
            self._refresh_cloud_counts(force=True)
            self._dirty = True
        elif self.last_sync_at is None and self.ledger.counts()["synced"]:
            self.last_sync_at = time.time()

    # -------------------------------------------------------- reconcile one
    def _sync_one(self, item) -> tuple:
        mid, op = item["memory_id"], item["operation"]
        mem = self.ledger.get(mid)
        label = mem["label"] if mem else mid[:8]

        if op in ("delete", "retract"):
            self.cloud.delete(mid)
            self.ledger.complete_removal(mid)
            if op == "retract":
                self._status(label, "local")
            return ("removed", label)

        edge = self.store.get_object(mid)
        if edge is None or mem is None:
            self.ledger.complete_removal(mid)
            return ("skipped", label)

        ep = dict(edge.payload or {})
        dense = list(edge.vector[VECTOR_NAME]) if isinstance(edge.vector, dict) else list(edge.vector)
        local = {f: ep.get(f) for f in SEMANTIC_FIELDS}
        dirty = set(mem["dirty"])
        cloud_rec = self.cloud.get_many([mid]).get(mid)
        cp = dict(cloud_rec.payload or {}) if cloud_rec else {}
        cver = int(cp.get("version", 0)) if cloud_rec else 0
        base = mem["base_version"]

        if cloud_rec is not None and cver > base and base > 0:
            snap = mem["base_snapshot"]
            cloud_changed = {f for f in SEMANTIC_FIELDS if cp.get(f) != snap.get(f)}
            clash = {f for f in dirty & cloud_changed if cp.get(f) != local.get(f)}
            if clash:
                return self._raise_conflicts(mem, clash, local, cp, cver)
            adopt = {f: cp.get(f) for f in cloud_changed - dirty if cp.get(f) != local.get(f)}
            if adopt:
                self.registry.apply_text(label, adopt, origin="cloud")
                local.update(adopt)
                self.log("info", "sync", f"⇄ {label} merged cloud edit ({', '.join(adopt)}) with local changes")

        written = set(SEMANTIC_FIELDS) if cloud_rec is None else (dirty | set())
        version = max(cver, base) + 1
        payload = self._cloud_payload(mem, ep, local, version, cp, written)
        doc = ". ".join(s for s in (ep.get("cls"), local.get("caption"), local.get("note")) if s)
        self.cloud.put(mid, dense, self.store.bm25.embed_document(doc), payload)
        self.ledger.complete(mid, version, local, set(SEMANTIC_FIELDS))
        mem_after = self.ledger.get(mid)
        self._status(label, mem_after["status"] if mem_after else "synced")
        return ("uploaded", label, version)

    def _cloud_payload(self, mem, ep, fields, version, prev, written) -> dict:
        ts = now_iso()
        field_ts = dict(prev.get("field_ts") or {})
        for f in written:
            field_ts[f] = {"ts": mem["field_ts"].get(f, ts), "by": DEVICE_ID}
        thumb_b64 = prev.get("thumb_b64")
        if ep.get("thumb"):
            path = THUMBS_DIR / ep["thumb"]
            if path.exists():
                thumb_b64 = base64.b64encode(path.read_bytes()).decode()
        return {
            "memory_id": mem["memory_id"],
            "device_id": prev.get("device_id", DEVICE_ID),
            "mission_id": prev.get("mission_id", self.mission_id),
            "kind": "object",
            "obj": mem["label"],
            "cls": ep.get("cls"),
            "caption": fields.get("caption"),
            "note": fields.get("note"),
            "t_first": ep.get("t_first"),
            "t_last": max(ep.get("t_last") or 0, prev.get("t_last") or 0),
            "sightings": max(ep.get("sightings") or 0, prev.get("sightings") or 0),
            "thumb_b64": thumb_b64,
            "version": version,
            "created_at": prev.get("created_at", ts),
            "updated_at": ts,
            "updated_by": DEVICE_ID,
            "field_ts": field_ts,
        }

    def _raise_conflicts(self, mem, clash, local, cp, cver) -> tuple:
        label = mem["label"]
        ids = []
        for f in sorted(clash):
            cts = (cp.get("field_ts") or {}).get(f) or {}
            cid = self.ledger.open_conflict(
                mem["memory_id"], label, f,
                local.get(f), mem["field_ts"].get(f), DEVICE_ID,
                cp.get(f), cts.get("ts") or cp.get("updated_at"), cts.get("by") or cp.get("updated_by"),
                cver, mem["local_version"],
            )
            ids.append(cid)
            self.log("conflict", "conflict",
                     f"⚠ CONFLICT · {label} / {f} · edge: “{local.get(f)}” vs cloud: “{cp.get(f)}”")
        self._status(label, "conflict")
        if self.policy.conflict_mode == "latest":
            for cid in ids:
                self._resolve_locked(cid, "latest", auto=True)
        return ("conflict", label)

    # ------------------------------------------------------------ conflicts
    def resolve(self, conflict_id: int, choice: str):
        with self.lock:
            self._resolve_locked(conflict_id, choice)

    def _resolve_locked(self, conflict_id: int, choice: str, auto: bool = False):
        c = self.ledger.conflict(conflict_id) if self.ledger else None
        if c is None or c["resolution"]:
            return
        winner = c["suggested"] if choice == "latest" else choice
        mem = self.ledger.get(c["memory_id"])
        if mem is None:
            return
        field = c["field"]
        if winner == "cloud":
            self.registry.apply_text(mem["label"], {field: c["cloud_value"]}, origin="cloud")
        self.ledger.resolve_field(c["memory_id"], field, c["cloud_value"], winner)
        self.ledger.close_conflict(conflict_id, f"{'auto-' if auto else ''}{choice}:{winner}")
        kept = c["edge_value"] if winner == "edge" else c["cloud_value"]
        how = "latest wins (auto)" if auto else f"keep {choice}"
        self.log("ok", "conflict", f"✓ Conflict resolved · {mem['label']} / {field} → “{kept}” ({how})")
        after = self.ledger.get(c["memory_id"])
        self._status(mem["label"], after["status"])
        self._dirty = True

    # ----------------------------------------------------------------- pull
    def _maybe_pull(self):
        if time.time() - self._last_pull < PULL_INTERVAL_S:
            return
        self._last_pull = time.time()
        synced = self.ledger.all("synced")
        for i in range(0, len(synced), 64):
            chunk = synced[i:i + 64]
            recs = self.cloud.get_many([m["memory_id"] for m in chunk])
            for m in chunk:
                rec = recs.get(m["memory_id"])
                if rec is None:
                    continue
                cp = rec.payload or {}
                cver = int(cp.get("version", 0))
                if cver <= m["base_version"]:
                    continue
                fresh = self.ledger.get(m["memory_id"])
                if fresh is None or fresh["dirty"] or fresh["status"] != "synced":
                    continue
                changed = {f: cp.get(f) for f in SEMANTIC_FIELDS if cp.get(f) != fresh["fields"].get(f)}
                if changed:
                    self.registry.apply_text(m["label"], changed, origin="cloud")
                    who = cp.get("updated_by", "cloud")
                    self.log("info", "pull", f"↓ {m['label']} updated from cloud by {who} · "
                             + ", ".join(f"{k}: “{v}”" for k, v in changed.items()))
                cts = {f: (cp.get("field_ts") or {}).get(f, {}).get("ts") for f in changed}
                self.ledger.apply_cloud(m["memory_id"], changed, cver, cts)
                self._status(m["label"], "synced")

    def _refresh_cloud_counts(self, force=False):
        if not force and time.time() - self._last_counts < 2.0:
            return
        self._last_counts = time.time()
        try:
            self.cloud_counts = {
                "total": self.cloud.count(),
                "device": self.cloud.count(DEVICE_ID),
                "devices": self.cloud.device_counts(),
            }
            self._dirty = True
        except CloudUnavailable as e:
            self._lost_cloud(str(e))

    # ---------------------------------------------------- operator commands
    def annotate(self, obj: str, note: str):
        with self.lock:
            if self.registry and self.registry.apply_text(obj, {"note": note or None}, origin="edge"):
                return True
        return False

    def forget(self, obj: str):
        with self.lock:
            if self.registry:
                self.registry.forget(obj)

    def set_scope(self, obj: str, scope: str):
        with self.lock:
            mem = self.ledger.by_label(obj) if self.ledger else None
            if mem is None or scope not in ("sync", "local"):
                return
            reason = "operator: shared with fleet" if scope == "sync" else "operator: keep on device"
            after = self.ledger.set_scope(mem["memory_id"], scope, reason)
            verb = "shared with cloud" if scope == "sync" else "pulled back to device-only"
            self.log("info", "policy", f"{obj} {verb} by operator")
            self._status(obj, after["status"])

    def set_policy(self, privacy_rule=None, conflict_mode=None):
        with self.lock:
            if conflict_mode in ("manual", "latest") and conflict_mode != self.policy.conflict_mode:
                self.policy.conflict_mode = conflict_mode
                self.log("info", "policy", f"Conflict policy → {'latest timestamp wins' if conflict_mode == 'latest' else 'manual review'}")
                if conflict_mode == "latest" and self.ledger:
                    for c in self.ledger.open_conflicts():
                        self._resolve_locked(c["id"], "latest", auto=True)
            if privacy_rule is not None and bool(privacy_rule) != self.policy.privacy_rule:
                self.policy.privacy_rule = bool(privacy_rule)
                self._reapply_privacy()
            self._dirty = True

    def _reapply_privacy(self):
        rule = self.policy.privacy_rule
        moved = 0
        for m in (self.ledger.all() if self.ledger else []):
            if m["status"] == "deleted" or m["cls"] not in PRIVATE_CLASSES:
                continue
            if (m["scope_reason"] or "").startswith("operator"):
                continue
            scope, reason = self.policy.classify("object", m["cls"])
            if scope != m["scope"]:
                after = self.ledger.set_scope(m["memory_id"], scope, reason)
                self._status(m["label"], after["status"])
                moved += 1
        state = "ON · sensitive areas stay on device" if rule else "OFF · sensitive areas shared"
        self.log("info", "policy", f"Privacy rule {state} · {moved} memories re-scoped")

    def sync_now(self):
        self._last_pull = 0.0
        if not self.online:
            self.log("warn", "net", "Sync requested but the device is offline · changes remain queued")
        elif not self.reachable:
            self.log("warn", "net", "Sync requested · cloud unreachable, retrying")
        else:
            self.log("info", "sync", "Manual sync requested")

    def _pick_synced(self, obj: str | None):
        if obj:
            m = self.ledger.by_label(obj)
            return m if m and m["base_version"] > 0 and m["status"] != "deleted" else None
        synced = [m for m in self.ledger.all("synced") if m["base_version"] > 0]
        if not synced:
            return None
        recs = self.registry.objects if self.registry else {}
        synced.sort(key=lambda m: (bool(m["fields"].get("caption")),
                                   getattr(recs.get(m["label"]), "sightings", 0)), reverse=True)
        return synced[0]

    def hq_edit(self, obj: str | None = None, note: str | None = None):
        """Someone at HQ edits a memory in the cloud (not on this device)."""
        with self.lock:
            if not self.ledger:
                return "no mission running"
            m = self._pick_synced(obj)
            if m is None:
                return "no synced memory to edit yet"
            note = note or random.choice(HQ_NOTES)
            doc = ". ".join(s for s in (m["cls"], m["fields"].get("caption"), note) if s)
            try:
                v = self.cloud.remote_edit(m["memory_id"], "note", note, "hq-console",
                                           self.store.bm25.embed_document(doc))
            except CloudUnavailable as e:
                return f"cloud unreachable: {e}"
            self.log("info", "cloud", f"☁ HQ console edited {m['label']} in the cloud (v{v}) · note: “{note}”")
            self._last_pull = 0.0
            self._refresh_cloud_counts(force=True)
            return None

    def stage_conflict(self, obj: str | None = None):
        """Deterministic demo: HQ and the field device edit the same field."""
        with self.lock:
            if not self.ledger:
                return "no mission running"
            m = self._pick_synced(obj)
            if m is None:
                return "no synced memory yet · let a few objects sync first"
            self._staged += 1
            cloud_note = STAGED_CLOUD_NOTE.format(n=self._staged)
            edge_note = STAGED_EDGE_NOTE.format(n=self._staged)
            doc = ". ".join(s for s in (m["cls"], m["fields"].get("caption"), cloud_note) if s)
            try:
                v = self.cloud.remote_edit(m["memory_id"], "note", cloud_note, "hq-console",
                                           self.store.bm25.embed_document(doc))
            except CloudUnavailable as e:
                return f"cloud unreachable: {e}"
            self.log("info", "cloud", f"☁ HQ console set {m['label']} note in the cloud (v{v}): “{cloud_note}”")
            time.sleep(0.05)  # the field edit is strictly later: "latest" picks edge
            self.registry.apply_text(m["label"], {"note": edge_note}, origin="edge")
            return None

    def inspect(self, obj: str) -> dict | None:
        mem = self.ledger.by_label(obj) if self.ledger else None
        if mem is None:
            return None
        rec = self.registry.objects.get(obj) if self.registry else None
        cloud = None
        if self.link_up():
            try:
                r = self.cloud.get_many([mem["memory_id"]]).get(mem["memory_id"])
                if r is not None:
                    p = r.payload or {}
                    cloud = {k: p.get(k) for k in ("version", "caption", "note", "updated_by",
                                                   "updated_at", "device_id", "sightings")}
            except CloudUnavailable:
                pass
        return {
            "type": "inspect_result",
            "obj": obj,
            "memory_id": mem["memory_id"],
            "cls": mem["cls"],
            "scope": mem["scope"],
            "scope_reason": mem["scope_reason"],
            "status": mem["status"],
            "local_version": mem["local_version"],
            "base_version": mem["base_version"],
            "dirty": mem["dirty"],
            "caption": rec.caption if rec else mem["fields"].get("caption"),
            "note": rec.note if rec else mem["fields"].get("note"),
            "sightings": rec.sightings if rec else None,
            "t_first": rec.t_first if rec else None,
            "synced_at": mem["synced_at"],
            "cloud": cloud,
            "link_up": self.link_up(),
        }

    # ---------------------------------------------------------- cloud search
    def cloud_search(self, qvec, text: str, limit: int):
        if not self.online:
            return None, 0.0, "device offline · cloud memory unreachable"
        if self.cloud.client is None:
            return None, 0.0, "no cloud configured"
        try:
            sparse = self.store.bm25.embed_query(text) if self.store else None
            points, micros = self.cloud.search(qvec.tolist(), sparse, limit)
            if not self.reachable:
                self.reachable = True
                self._dirty = True
            return points, micros, None
        except CloudUnavailable as e:
            self._lost_cloud(str(e))
            return None, 0.0, "cloud unreachable"

    # ---------------------------------------------------------------- state
    def state(self) -> dict:
        counts = self.ledger.counts() if self.ledger else {}
        link = "online" if self.link_up() else ("offline" if not self.online else "unreachable")
        store = self.store
        return {
            "type": "sync_state",
            "device_id": DEVICE_ID,
            "mission_id": self.mission_id,
            "online": self.online,
            "link": link,
            "cloud_kind": self.cloud.kind,
            "cloud_label": self._cloud_label(),
            "cloud_rtt_ms": round(self.cloud.last_rtt_ms, 1) if self.cloud.last_rtt_ms else None,
            "edge": {
                "objects": len(self.registry.objects) if self.registry else 0,
                "frames": store.count if store else 0,
                "bytes": store.bytes_on_disk() if store and store.shard else 0,
            },
            "cloud": self.cloud_counts,
            "counts": counts,
            "drain": {k: self.drain.get(k) for k in ("active", "done", "total")},
            "last_sync_at": self.last_sync_at,
            "policy": self.policy.to_dict(),
            "conflicts": self.ledger.open_conflicts() if self.ledger else [],
        }

    def _state_loop(self):
        last = 0.0
        while self._running:
            time.sleep(0.4)
            if self._dirty or time.time() - last > 3.0:
                self._dirty = False
                last = time.time()
                try:
                    self.emit(self.state())
                except Exception:
                    logger.exception("state emit failed")
