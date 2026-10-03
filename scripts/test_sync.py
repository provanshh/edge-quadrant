"""End-to-end check of the EdgeMind sync engine, no models or footage needed.

Drives a real Edge shard, the real sync ledger and a real Qdrant Server
(EDGEMIND_CLOUD_URL, default localhost:6333) through the full offline-first
story: sync, go offline, queue, cloud-side edits, reconnect, pull, disjoint
merge, conflict, resolution, deletion, and cloud hybrid search.

Uses its own collection and device id, and drops the collection afterwards.

    uv run python scripts/test_sync.py
"""

import os
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

os.environ.setdefault("EDGEMIND_CLOUD_COLLECTION", "edgemind_selftest")
os.environ.setdefault("EDGEMIND_DEVICE_ID", "test-rig")
sys.path.insert(0, str(Path(__file__).parent.parent))

import numpy as np  # noqa: E402

import app.sync_manager as sm  # noqa: E402
from app.constants import CLOUD_COLLECTION, VECTOR_DIMENSION  # noqa: E402
from app.edge_store import EdgeStore  # noqa: E402

TMP = Path(tempfile.mkdtemp(prefix="edgemind-test-"))
sm.SYNC_DB = TMP / "sync.db"
sm.SYNC_BATCH_PACING_S = 0.0
sm.SYNC_INTERVAL_S = 0.1
sm.PULL_INTERVAL_S = 0.3

rng = np.random.default_rng(7)


class Rec:
    def __init__(self, label, cls):
        self.label, self.obj_id, self.cls = label, label, cls
        self.point_id = str(uuid.uuid4())
        self.caption, self.note = None, None
        self.sightings, self.t_first, self.t_last = 3, 1.0, 1.0

    def bm25_doc(self):
        return ". ".join(s for s in (self.cls, self.caption, self.note) if s)


class FakeRegistry:
    """The slice of ObjectRegistry the sync layer talks to."""

    def __init__(self, store):
        self.store = store
        self.objects = {}
        self.on_change = None
        self.n = 0

    def create(self, cls, caption=None):
        self.n += 1
        rec = Rec(f"OBJ-{self.n:03d}", cls)
        v = rng.normal(size=VECTOR_DIMENSION).astype(np.float32)
        self.objects[rec.label] = rec
        self.store.upsert_object(rec.point_id, v / np.linalg.norm(v), {
            "kind": "object", "obj": rec.label, "cls": cls, "t_first": 1.0,
            "t_last": 1.0, "sightings": 3})
        self.on_change(rec, "created", {})
        if caption:
            rec.caption = caption
            self.store.set_caption(rec.point_id, caption, rec.bm25_doc())
            self.on_change(rec, "caption", {"caption": caption})
        return rec

    def apply_text(self, obj_id, patch, origin="edge"):
        rec = self.objects.get(obj_id)
        if rec is None:
            return None
        for k, v in patch.items():
            setattr(rec, k, v or None)
        self.store.set_text(rec.point_id, patch, rec.bm25_doc())
        if origin == "edge":
            self.on_change(rec, "edit", patch)
        return rec

    def forget(self, obj_id):
        rec = self.objects.pop(obj_id, None)
        if rec:
            self.store.delete_object(rec.point_id)
            self.on_change(rec, "forgotten", {})


events = []
lock = threading.Lock()


def emit(ev):
    with lock:
        events.append(ev)


def wait_for(cond, what, timeout=10.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for: {what}")


def check(cond, what):
    if not cond:
        raise AssertionError(what)
    print(f"  ✓ {what}")


def cloud_payload(sync, rec):
    r = sync.cloud.get_many([rec.point_id]).get(rec.point_id)
    return (r.payload or {}) if r else None


def edge_payload(store, rec):
    r = store.get_object(rec.point_id)
    return dict(r.payload or {}) if r else None


def main():
    store = EdgeStore(TMP / "shard")
    store.initialize()
    reg = FakeRegistry(store)
    sync = sm.SyncManager(emit)
    sync.start()
    check(sync.cloud.kind in ("qdrant-server", "embedded"), f"cloud connected ({sync.cloud.kind})")
    sync.attach(store, reg)
    led = sync.ledger

    print("1. online: new memories sync, private ones stay on device")
    chair = reg.create("armchair", "a leather lounge chair")
    stool = reg.create("bar stool", "a chrome bar stool")
    table = reg.create("pool table", "a green pool table")
    lamp = reg.create("floor lamp", "a brass floor lamp")
    bed = reg.create("bed", "a bed with white pillows")
    wait_for(lambda: led.counts()["synced"] == 4 and led.counts()["queued_ops"] == 0, "4 synced")
    check(cloud_payload(sync, chair)["caption"] == "a leather lounge chair", "caption in cloud")
    check(cloud_payload(sync, bed) is None, "private-class memory never left the device")
    check(led.by_label(bed.label)["status"] == "local", "bed is local-only")

    print("2. offline: memory and edits keep working, changes queue")
    sync.set_online(False)
    vase = reg.create("vase", "a blue ceramic vase")
    sync.annotate(chair.label, "left armrest worn")
    time.sleep(0.6)
    c = led.counts()
    check(c["queued_ops"] == 2, f"2 ops queued offline (got {c['queued_ops']})")
    check(cloud_payload(sync, vase) is None, "new memory not in cloud while offline")
    check(edge_payload(store, chair)["note"] == "left armrest worn", "local edit applied to Edge shard")
    hits, _ = store.search_objects(rng.normal(size=VECTOR_DIMENSION).astype(np.float32), "worn armrest")
    check(any(h.payload.get("obj") == chair.label for h in hits), "local hybrid search sees the offline edit")
    pts, _, err = sync.cloud_search(np.ones(VECTOR_DIMENSION, dtype=np.float32), "chair", 3)
    check(pts is None and err, "cloud search refuses gracefully while offline")

    print("3. cloud-side edits happen meanwhile (HQ)")
    check(sync.hq_edit(stool.label, "HQ: verified against asset register") is None, "HQ edits stool in cloud")
    # disjoint: HQ edits the note, device edits the caption of the same memory
    check(sync.hq_edit(table.label, "HQ: felt replaced in May") is None, "HQ edits pool-table note")
    reg.apply_text(table.label, {"caption": "a green pool table with cues"})
    # clash: both edit the lamp note
    check(sync.stage_conflict(lamp.label) is None, "staged a same-field conflict on the lamp")

    print("4. reconnect: drain, merge, pull, detect conflict")
    sync.set_online(True)
    wait_for(lambda: led.counts()["open_conflicts"] == 1 and led.counts()["queued_ops"] == 0,
             "drain finished with one conflict")
    check(cloud_payload(sync, vase) is not None, "offline memory reached the cloud")
    check(cloud_payload(sync, chair)["note"] == "left armrest worn", "offline edit reached the cloud")
    tp_cloud, tp_edge = cloud_payload(sync, table), edge_payload(store, table)
    check(tp_cloud["note"] == "HQ: felt replaced in May"
          and tp_cloud["caption"] == "a green pool table with cues", "disjoint edits merged in cloud")
    check(tp_edge.get("note") == "HQ: felt replaced in May", "cloud note adopted on the edge")
    wait_for(lambda: (edge_payload(store, stool) or {}).get("note") == "HQ: verified against asset register",
             "HQ edit pulled into the Edge shard")
    print("  ✓ HQ edit pulled into the Edge shard")
    conflict = led.open_conflicts()[0]
    check(conflict["field"] == "note" and conflict["suggested"] == "edge", "conflict on lamp/note, latest = edge")
    check(cloud_payload(sync, lamp)["note"] == conflict["cloud_value"], "cloud untouched while conflicted")

    print("5. resolve: keep edge")
    sync.resolve(conflict["id"], "edge")
    wait_for(lambda: (cloud_payload(sync, lamp) or {}).get("note") == conflict["edge_value"]
             and led.by_label(lamp.label)["status"] == "synced", "edge value in cloud")
    print("  ✓ edge value written to cloud, lamp synced")
    v = cloud_payload(sync, lamp)["version"]

    print("6. resolve: keep cloud")
    check(sync.stage_conflict(lamp.label) is None, "second conflict staged")
    wait_for(lambda: led.counts()["open_conflicts"] == 1, "second conflict detected")
    second = led.open_conflicts()[0]
    sync.resolve(second["id"], "cloud")
    wait_for(lambda: led.by_label(lamp.label)["status"] == "synced", "lamp synced")
    check(edge_payload(store, lamp)["note"] == second["cloud_value"], "cloud value written into Edge shard")
    check(cloud_payload(sync, lamp)["note"] == second["cloud_value"], "cloud keeps its value")
    check(cloud_payload(sync, lamp)["version"] > v, "cloud version advanced")

    print("7. latest-wins policy auto-resolves")
    sync.set_policy(conflict_mode="latest")
    check(sync.stage_conflict(lamp.label) is None, "third conflict staged")
    wait_for(lambda: (cloud_payload(sync, lamp) or {}).get("note", "").startswith("Field report #3")
             and led.counts()["open_conflicts"] == 0 and led.counts()["resolved_conflicts"] == 3,
             "auto-resolved to the later (edge) edit")
    print("  ✓ auto-resolved to the later (edge) edit")
    sync.set_policy(conflict_mode="manual")

    print("8. operator controls: share / retract / forget")
    sync.set_scope(bed.label, "sync")
    wait_for(lambda: cloud_payload(sync, bed) is not None, "bed shared to cloud")
    print("  ✓ bed shared to cloud")
    sync.set_scope(bed.label, "local")
    wait_for(lambda: cloud_payload(sync, bed) is None, "bed retracted")
    print("  ✓ bed retracted from cloud")
    sync.forget(vase.label)
    wait_for(lambda: cloud_payload(sync, vase) is None, "vase deleted in cloud")
    print("  ✓ forgotten memory deleted in cloud")
    check(edge_payload(store, vase) is None, "forgotten memory gone from Edge shard")

    print("9. cloud hybrid search")
    q = store.get_object(chair.point_id).vector["vision"]
    pts, us, err = sync.cloud_search(np.asarray(q, dtype=np.float32), "leather lounge chair", 3)
    check(err is None and pts and str(pts[0].id) == chair.point_id, f"cloud finds the chair ({us/1000:.1f} ms)")

    print("10. real outage: cloud unreachable -> queue holds")
    sync.reachable = False
    real_url = sync.cloud.client
    from qdrant_client import QdrantClient
    sync.cloud.client = QdrantClient(url="http://127.0.0.1:9", timeout=1)
    sync.annotate(stool.label, "local note during outage")
    time.sleep(1.0)
    check(led.counts()["queued_ops"] == 1 and sync.link_up() is False, "change held while cloud unreachable")
    sync.cloud.client = real_url
    wait_for(lambda: led.counts()["queued_ops"] == 0, "drained after cloud came back")
    check(cloud_payload(sync, stool)["note"] == "local note during outage", "outage edit delivered")

    print("\nactivity tail:")
    for e in list(sync.activity)[-8:]:
        print("   ", e["text"])
    sync.cloud.client.delete_collection(CLOUD_COLLECTION)
    print("\nALL SYNC CHECKS PASSED")


if __name__ == "__main__":
    main()
