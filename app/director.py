"""Auto mode (?auto): a scripted timeline that makes the demo play itself for
screen recording. Interactive mode does not use this; the user is the director.

Timestamps are seconds relative to video start. Everything triggered here is
real work: real detections, real embeddings, real shard queries.
"""

import asyncio
import logging

logger = logging.getLogger(__name__)

# NOTE: query strings are validated against the mission footage by
# scripts/test_objects.py. The presenter narrates; the demo only acts.
TIMELINE = [
    (0.0, {"type": "scene", "title": "ACT 1 · EDGE MEMORY · ONLINE"}),
    (20.0, {"type": "warm"}),
    (23.0, {"type": "query", "text": "a leather lounge chair"}),
    (45.0, {"type": "query", "text": "bar stools"}),
    (52.0, {"type": "scene", "title": "ACT 2 · NETWORK LOST"}),
    (54.0, {"type": "net", "online": False}),
    (62.0, {"type": "query", "text": "bar stools", "scope": "cloud"}),
    (72.5, {"type": "query", "text": "a pool table"}),
    (80.0, {"type": "stage_conflict"}),
    (90.0, {"type": "teach", "text": "a freestanding bathtub"}),
    (100.0, {"type": "query", "text": "a bed with pillows"}),
    (106.0, {"type": "scene", "title": "ACT 3 · RECONNECT · SYNC · RESOLVE"}),
    (107.0, {"type": "net", "online": True}),
    (118.0, {"type": "resolve", "choice": "latest"}),
    (124.0, {"type": "scene", "title": "ACT 4 · EDGE + CLOUD"}),
    (133.0, {"type": "query", "text": "wine bottles on a tray", "scope": "both"}),
    (144.0, {"type": "closing"}),
]

TYPEWRITER_SECONDS = 1.6  # how long the frontend takes to "type" a query


class Director:
    def __init__(self, session, emit):
        self.session = session
        self.emit = emit

    async def run_timeline(self):
        # Anchor to an absolute clock: action handlers (queries take ~2s)
        # must not push later events off the video timeline.
        start = asyncio.get_running_loop().time()
        for at, action in TIMELINE:
            now = asyncio.get_running_loop().time()
            await asyncio.sleep(max(0.0, start + at - now))
            if action["type"] == "query":
                self.emit({"type": "query_typed", "text": action["text"]})
                # Warm the search path while the typewriter animation plays so
                # the timed search shows steady-state latency.
                await self.session.warm_query()
                await asyncio.sleep(TYPEWRITER_SECONDS)
                await self.session.run_query(action["text"], scope=action.get("scope", "edge"))
            elif action["type"] == "teach":
                await self.session.teach(action["text"])
            elif action["type"] == "warm":
                await self.session.warm_query()
            elif action["type"] in ("net", "stage_conflict", "resolve"):
                await self._sync_action(action)
            else:
                self.emit(action)
        logger.info("Timeline complete")

    async def _sync_action(self, action):
        sync = self.session.sync
        if sync is None:
            return
        if action["type"] == "net":
            await asyncio.to_thread(sync.set_online, action["online"])
        elif action["type"] == "stage_conflict":
            err = await asyncio.to_thread(sync.stage_conflict)
            if err:
                logger.warning("stage_conflict: %s", err)
        elif action["type"] == "resolve" and sync.ledger:
            for c in sync.ledger.open_conflicts():
                await asyncio.to_thread(sync.resolve, c["id"], action["choice"])
