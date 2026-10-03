"""The device-local sync ledger: one SQLite file next to the Edge shard.

Three tables:
  memories   sync metadata per memory (scope, versions, dirty fields, status)
  queue      pending operations, coalesced to one row per memory
  conflicts  field-level edge/cloud disagreements awaiting resolution

The Edge shard stays the source of truth for vectors and payloads; this file
only tracks what the cloud has and hasn't seen. Survives restarts of the
sync worker, never needs the network.
"""

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE memories (
    memory_id     TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    cls           TEXT,
    kind          TEXT NOT NULL,
    scope         TEXT NOT NULL,          -- sync | local
    scope_reason  TEXT,
    local_version INTEGER NOT NULL DEFAULT 1,
    base_version  INTEGER NOT NULL DEFAULT 0,   -- cloud version at last sync
    base_snapshot TEXT NOT NULL DEFAULT '{}',   -- semantic fields at last sync
    fields        TEXT NOT NULL DEFAULT '{}',   -- current semantic fields
    field_ts      TEXT NOT NULL DEFAULT '{}',   -- field -> last local edit ts
    dirty         TEXT NOT NULL DEFAULT '[]',   -- fields changed since sync
    status        TEXT NOT NULL,          -- local | pending | syncing | synced | conflict | deleted
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    synced_at     TEXT
);
CREATE TABLE queue (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id   TEXT NOT NULL UNIQUE,
    operation   TEXT NOT NULL,            -- upsert | delete
    priority    INTEGER NOT NULL DEFAULT 1,
    enqueued_at TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    in_flight   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE conflicts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id     TEXT NOT NULL,
    label         TEXT,
    field         TEXT NOT NULL,
    edge_value    TEXT,
    edge_ts       TEXT,
    edge_by       TEXT,
    cloud_value   TEXT,
    cloud_ts      TEXT,
    cloud_by      TEXT,
    cloud_version INTEGER,
    edge_version  INTEGER,
    suggested     TEXT,
    detected_at   TEXT NOT NULL,
    resolution    TEXT,
    resolved_at   TEXT
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class SyncLedger:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            path.unlink()
        self.db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.lock = threading.RLock()

    def close(self):
        with self.lock:
            self.db.close()

    # ------------------------------------------------------------- memories
    def register(self, memory_id, label, cls, kind, scope, reason, fields: dict):
        ts = now_iso()
        status = "pending" if scope == "sync" else "local"
        with self.lock:
            self.db.execute(
                "INSERT OR REPLACE INTO memories (memory_id, label, cls, kind, scope, scope_reason,"
                " fields, field_ts, dirty, status, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (memory_id, label, cls, kind, scope, reason, json.dumps(fields),
                 json.dumps({k: ts for k in fields}), json.dumps(sorted(fields)),
                 status, ts, ts),
            )
            if scope == "sync":
                self._enqueue(memory_id, "upsert", 1)
        return status

    def get(self, memory_id) -> dict | None:
        with self.lock:
            row = self.db.execute("SELECT * FROM memories WHERE memory_id=?", (memory_id,)).fetchone()
        return _decode(row) if row else None

    def by_label(self, label) -> dict | None:
        with self.lock:
            row = self.db.execute("SELECT * FROM memories WHERE label=?", (label,)).fetchone()
        return _decode(row) if row else None

    def all(self, status: str | None = None) -> list[dict]:
        with self.lock:
            if status:
                rows = self.db.execute("SELECT * FROM memories WHERE status=?", (status,)).fetchall()
            else:
                rows = self.db.execute("SELECT * FROM memories").fetchall()
        return [_decode(r) for r in rows]

    def record_change(self, memory_id, patch: dict, ts: str | None = None) -> dict | None:
        """A local semantic edit: bump the version, mark fields dirty, queue it."""
        ts = ts or now_iso()
        with self.lock:
            mem = self.get(memory_id)
            if mem is None or mem["status"] == "deleted":
                return None
            fields, field_ts, dirty = mem["fields"], mem["field_ts"], set(mem["dirty"])
            changed = False
            for k, v in patch.items():
                if fields.get(k) != v:
                    fields[k] = v
                    field_ts[k] = ts
                    dirty.add(k)
                    changed = True
            if not changed:
                return mem
            status = mem["status"]
            if mem["scope"] == "sync" and status != "conflict":
                status = "pending"
            self.db.execute(
                "UPDATE memories SET fields=?, field_ts=?, dirty=?, status=?,"
                " local_version=local_version+1, updated_at=? WHERE memory_id=?",
                (json.dumps(fields), json.dumps(field_ts), json.dumps(sorted(dirty)),
                 status, ts, memory_id),
            )
            if mem["scope"] == "sync" and status == "pending":
                self._enqueue(memory_id, "upsert", 0 if "note" in patch else 2)
            return self.get(memory_id)

    def apply_cloud(self, memory_id, patch: dict, cloud_version: int, cloud_ts: dict):
        """Cloud-side edit pulled down: adopt it without marking anything dirty."""
        with self.lock:
            mem = self.get(memory_id)
            if mem is None:
                return
            fields, field_ts, snap = mem["fields"], mem["field_ts"], mem["base_snapshot"]
            dirty = set(mem["dirty"])
            for k, v in patch.items():
                fields[k] = v
                snap[k] = v
                field_ts[k] = cloud_ts.get(k, field_ts.get(k))
                dirty.discard(k)
            self.db.execute(
                "UPDATE memories SET fields=?, field_ts=?, base_snapshot=?, dirty=?,"
                " base_version=?, updated_at=? WHERE memory_id=?",
                (json.dumps(fields), json.dumps(field_ts), json.dumps(snap),
                 json.dumps(sorted(dirty)), cloud_version, now_iso(), memory_id),
            )

    def set_scope(self, memory_id, scope, reason):
        with self.lock:
            mem = self.get(memory_id)
            if mem is None or mem["scope"] == scope:
                return mem
            if scope == "sync":
                dirty = sorted(set(mem["dirty"]) | set(mem["fields"]))
                self.db.execute(
                    "UPDATE memories SET scope=?, scope_reason=?, status='pending', dirty=?,"
                    " updated_at=? WHERE memory_id=?",
                    (scope, reason, json.dumps(dirty), now_iso(), memory_id))
                self._enqueue(memory_id, "upsert", 0)
            else:
                # Pulling a memory back to the device: retract it from the cloud.
                was_synced = mem["base_version"] > 0
                self.db.execute(
                    "UPDATE memories SET scope=?, scope_reason=?, status=?, base_version=0,"
                    " updated_at=? WHERE memory_id=?",
                    (scope, reason, "pending" if was_synced else "local", now_iso(), memory_id))
                if was_synced:
                    self._enqueue(memory_id, "retract", 0)
                else:
                    self.db.execute("DELETE FROM queue WHERE memory_id=?", (memory_id,))
            return self.get(memory_id)

    def mark_deleted(self, memory_id):
        with self.lock:
            mem = self.get(memory_id)
            if mem is None:
                return None
            self.db.execute("UPDATE memories SET status='deleted', updated_at=? WHERE memory_id=?",
                            (now_iso(), memory_id))
            self.db.execute("UPDATE conflicts SET resolution='deleted', resolved_at=?"
                            " WHERE memory_id=? AND resolution IS NULL", (now_iso(), memory_id))
            if mem["base_version"] > 0:
                self._enqueue(memory_id, "delete", 0)
            else:
                self.db.execute("DELETE FROM queue WHERE memory_id=?", (memory_id,))
            return mem

    # ---------------------------------------------------------------- queue
    def _enqueue(self, memory_id, operation, priority):
        existing = self.db.execute("SELECT operation, priority FROM queue WHERE memory_id=?",
                                   (memory_id,)).fetchone()
        if existing:
            # Coalesce: one row per memory, keep the most urgent priority.
            self.db.execute(
                "UPDATE queue SET operation=?, priority=MIN(priority, ?) WHERE memory_id=?",
                (operation, priority, memory_id))
        else:
            self.db.execute(
                "INSERT INTO queue (memory_id, operation, priority, enqueued_at) VALUES (?,?,?,?)",
                (memory_id, operation, priority, now_iso()))

    def requeue(self, memory_id, operation="upsert", priority=0):
        with self.lock:
            self._enqueue(memory_id, operation, priority)

    def take_batch(self, n: int) -> list[dict]:
        """Claim up to n queued operations and mark their memories syncing."""
        with self.lock:
            rows = self.db.execute(
                "SELECT q.*, m.status AS mstatus FROM queue q JOIN memories m USING (memory_id)"
                " WHERE q.in_flight=0 AND m.status != 'conflict'"
                " ORDER BY q.priority, q.seq LIMIT ?", (n,)).fetchall()
            out = []
            for r in rows:
                self.db.execute("UPDATE queue SET in_flight=1 WHERE seq=?", (r["seq"],))
                if r["operation"] == "upsert":
                    self.db.execute("UPDATE memories SET status='syncing' WHERE memory_id=?",
                                    (r["memory_id"],))
                out.append(dict(r))
            return out

    def complete(self, memory_id, cloud_version: int, snapshot: dict, synced_fields: set):
        """Upload accepted by the cloud. Fields edited mid-flight stay dirty."""
        with self.lock:
            mem = self.get(memory_id)
            if mem is None:
                return
            still_dirty = {f for f in mem["dirty"]
                           if f not in synced_fields or mem["fields"].get(f) != snapshot.get(f)}
            fields = dict(mem["fields"])
            for f, v in snapshot.items():
                if f not in still_dirty:
                    fields[f] = v
            status = "pending" if still_dirty else "synced"
            self.db.execute(
                "UPDATE memories SET base_version=?, base_snapshot=?, fields=?, dirty=?, status=?,"
                " synced_at=? WHERE memory_id=?",
                (cloud_version, json.dumps(snapshot), json.dumps(fields),
                 json.dumps(sorted(still_dirty)), status, now_iso(), memory_id))
            self.db.execute("DELETE FROM queue WHERE memory_id=?", (memory_id,))
            if still_dirty:
                self._enqueue(memory_id, "upsert", 1)

    def complete_removal(self, memory_id):
        with self.lock:
            self.db.execute("DELETE FROM queue WHERE memory_id=?", (memory_id,))
            mem = self.get(memory_id)
            if mem and mem["status"] != "deleted":
                self.db.execute("UPDATE memories SET status='local', synced_at=? WHERE memory_id=?",
                                (now_iso(), memory_id))

    def fail(self, memory_id, error: str):
        with self.lock:
            self.db.execute(
                "UPDATE queue SET in_flight=0, retry_count=retry_count+1, last_error=? WHERE memory_id=?",
                (error[:200], memory_id))
            self.db.execute("UPDATE memories SET status='pending' WHERE memory_id=? AND status='syncing'",
                            (memory_id,))

    def release_in_flight(self):
        with self.lock:
            self.db.execute("UPDATE queue SET in_flight=0")
            self.db.execute("UPDATE memories SET status='pending' WHERE status='syncing'")

    # ------------------------------------------------------------ conflicts
    def open_conflict(self, memory_id, label, field, edge_value, edge_ts, edge_by,
                      cloud_value, cloud_ts, cloud_by, cloud_version, edge_version):
        suggested = "edge" if (edge_ts or "") >= (cloud_ts or "") else "cloud"
        with self.lock:
            cur = self.db.execute(
                "INSERT INTO conflicts (memory_id, label, field, edge_value, edge_ts, edge_by,"
                " cloud_value, cloud_ts, cloud_by, cloud_version, edge_version, suggested, detected_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (memory_id, label, field, edge_value, edge_ts, edge_by, cloud_value, cloud_ts,
                 cloud_by, cloud_version, edge_version, suggested, now_iso()))
            self.db.execute("UPDATE memories SET status='conflict' WHERE memory_id=?", (memory_id,))
            self.db.execute("UPDATE queue SET in_flight=0 WHERE memory_id=?", (memory_id,))
            return cur.lastrowid

    def open_conflicts(self) -> list[dict]:
        with self.lock:
            rows = self.db.execute(
                "SELECT * FROM conflicts WHERE resolution IS NULL ORDER BY id").fetchall()
        return [dict(r) for r in rows]

    def conflict(self, conflict_id) -> dict | None:
        with self.lock:
            row = self.db.execute("SELECT * FROM conflicts WHERE id=?", (conflict_id,)).fetchone()
        return dict(row) if row else None

    def close_conflict(self, conflict_id, resolution):
        with self.lock:
            self.db.execute("UPDATE conflicts SET resolution=?, resolved_at=? WHERE id=?",
                            (resolution, now_iso(), conflict_id))

    def has_open_conflict(self, memory_id) -> bool:
        with self.lock:
            return self.db.execute(
                "SELECT 1 FROM conflicts WHERE memory_id=? AND resolution IS NULL",
                (memory_id,)).fetchone() is not None

    def resolve_field(self, memory_id, field, cloud_value, winner: str):
        """Settle one conflicting field.

        The snapshot takes the cloud value ("we have seen it"), so the next
        three-way merge no longer counts that field as a cloud change. If the
        edge wins the field stays dirty and is uploaded on top of the cloud
        version; if the cloud wins the local value is replaced and cleaned.
        Once no conflicts remain the memory is requeued for that merge.
        """
        with self.lock:
            mem = self.get(memory_id)
            if mem is None:
                return
            snap, fields, dirty = mem["base_snapshot"], mem["fields"], set(mem["dirty"])
            snap[field] = cloud_value
            if winner == "cloud":
                fields[field] = cloud_value
                dirty.discard(field)
            self.db.execute(
                "UPDATE memories SET base_snapshot=?, fields=?, dirty=? WHERE memory_id=?",
                (json.dumps(snap), json.dumps(fields), json.dumps(sorted(dirty)), memory_id))
            open_left = self.db.execute(
                "SELECT COUNT(*) FROM conflicts WHERE memory_id=? AND resolution IS NULL AND field != ?",
                (memory_id, field)).fetchone()[0]
            if not open_left:
                self.db.execute("UPDATE memories SET status='pending' WHERE memory_id=?", (memory_id,))
                self._enqueue(memory_id, "upsert", 0)

    # ---------------------------------------------------------------- stats
    def counts(self) -> dict:
        with self.lock:
            by_status = dict(self.db.execute(
                "SELECT status, COUNT(*) FROM memories GROUP BY status").fetchall())
            queued = self.db.execute(
                "SELECT COUNT(*) FROM queue q JOIN memories m USING (memory_id)"
                " WHERE m.status != 'conflict'").fetchone()[0]
            failing = self.db.execute("SELECT COUNT(*) FROM queue WHERE retry_count>0").fetchone()[0]
            conflicts = self.db.execute(
                "SELECT COUNT(*) FROM conflicts WHERE resolution IS NULL").fetchone()[0]
            resolved = self.db.execute(
                "SELECT COUNT(*) FROM conflicts WHERE resolution IS NOT NULL").fetchone()[0]
        return {
            "local_only": by_status.get("local", 0),
            "pending": by_status.get("pending", 0),
            "syncing": by_status.get("syncing", 0),
            "synced": by_status.get("synced", 0),
            "conflict": by_status.get("conflict", 0),
            "deleted": by_status.get("deleted", 0),
            "queued_ops": queued,
            "retrying": failing,
            "open_conflicts": conflicts,
            "resolved_conflicts": resolved,
        }


def _decode(row) -> dict:
    d = dict(row)
    for k in ("base_snapshot", "fields", "field_ts"):
        d[k] = json.loads(d[k] or "{}")
    d["dirty"] = json.loads(d["dirty"] or "[]")
    return d
