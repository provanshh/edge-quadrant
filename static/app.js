/* Qdrant Edge mission control: renders real events streamed from the backend.
   Interactive by default (the user searches, cuts the link, teaches concepts).
   Append ?auto to the URL for the self-playing scripted version. */

const $ = (id) => document.getElementById(id);
const AUTO = location.search.includes("auto");
if (AUTO) document.body.classList.add("auto");

const state = {
  points: [],        // memory map dots: {x, y, born, hit, thumb, ts, kind, cls, obj}
  objPoints: {},     // obj id -> index into points
  tracks: new Map(), // overlay boxes: tid -> {cur, target, cls, obj, conf, seen}
  inventory: {},     // obj id -> {el, cls, caption, thumb, t}
  lastQueryUs: null,
  edgeCount: 0,
  objectCount: 0,
  detectAvg: null,
  embedAvg: null,
  started: false,
  // EdgeMind sync layer
  sync: null,          // last sync_state from the server
  memStatus: {},       // obj id -> sync status
  scope: "edge",       // search scope: edge | cloud | both
  conflictKey: "",     // ids of rendered conflicts (avoid re-render flicker)
  inspecting: null,    // obj id open in the inspector
  lastCloudUs: null,
  videoId: localStorage.getItem("edgemind-video") || "mission",
  videoName: null,
};

/* ---------- websocket (auto-reconnects across server restarts) ---------- */
let ws = null;
function setHint(text) {
  const el = document.querySelector(".title-hint");
  if (el) el.textContent = text;
}
function connect() {
  setHint("connecting…");
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    state.started = false;
    setHint("connecting…");
    setTimeout(connect, 800);
  };
}
connect();

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function requestStart() {
  if (state.started) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setHint("not connected · retrying…");
    return;
  }
  state.started = true;
  send({ cmd: "start", mode: AUTO ? "auto" : "interactive", video: state.videoId });
  setHint("starting…");
}

/* Start (or switch to) a specific video. A running mission is stopped and
   memory starts fresh for the new footage. */
function startVideoById(id, force = true) {
  state.videoId = id;
  localStorage.setItem("edgemind-video", id);
  if (!ws || ws.readyState !== WebSocket.OPEN) { setHint("not connected · retrying…"); return; }
  state.started = true;
  send({ cmd: "start", mode: "interactive", video: id, force });
  setHint("starting…");
}

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  if (!state.started && document.activeElement.tagName !== "INPUT") {
    e.preventDefault();
    requestStart();
  }
});
$("title-overlay").addEventListener("click", requestStart);

function handle(ev) {
  switch (ev.type) {
    case "ready":
      setHint(ev.running
        ? "a run is already in progress · restart the server for a clean take"
        : "press space or click to begin");
      break;
    case "phase":
      if (ev.name === "boot") {
        resetUI();
        $("title-overlay").classList.add("hidden");
        $("boot-overlay").classList.remove("hidden");
      }
      break;
    case "boot_line": bootLine(ev.text); break;
    case "video_start": startVideo(ev); break;
    case "frame_ingested": onFrame(ev); break;
    case "object_discovered": onObject(ev); break;
    case "object_enriched": onEnriched(ev); break;
    case "inventory": onInventory(ev); break;
    case "query_typed": typeQuery(ev.text); break;
    case "query_result": showResults(ev); break;
    case "scene": showScene(ev.title); break;
    case "mission_complete": onMissionComplete(ev); break;
    case "label_added": onLabelAdded(ev.text); break;
    case "closing": showClosing(); break;
    case "sync_state": renderSync(ev); break;
    case "activity": addActivity(ev); break;
    case "memory_status": setMemStatus(ev.obj, ev.status); break;
    case "inspect_result": renderInspector(ev); break;
    case "toast": toast(ev.text); break;
  }
}

/* ---------- reset (a new run must not inherit the previous one) ---------- */
function resetUI() {
  state.points.length = 0;
  state.objPoints = {};
  state.tracks.clear();
  state.inventory = {};
  state.lastQueryUs = null;
  state.edgeCount = 0;
  state.objectCount = 0;
  state.detectAvg = null;
  state.embedAvg = null;
  state.memStatus = {};
  state.conflictKey = "";
  state.lastCloudUs = null;
  $("activity").innerHTML = "";
  $("conflict-list").innerHTML = "";
  $("conflict-panel").classList.add("hidden");
  $("inspect-overlay").classList.add("hidden");

  const feed = $("feed");
  feed.pause();
  feed.currentTime = 0;

  $("boot-terminal").innerHTML = "";
  $("query-input").value = "";
  $("label-input").value = "";
  updateChips(0);
  $("results").innerHTML = "";
  $("search-badge").textContent = "";
  $("search-badge").className = "";
  $("inv-rail").innerHTML = "";
  $("inv-facets").innerHTML = "";
  $("inv-count").textContent = "0 unique objects";
  $("watch-lines").innerHTML = "";
  $("vocab-count").textContent = "";
  $("scene-badge").classList.remove("show");
  $("scene-badge").textContent = "";
  $("closing-overlay").classList.add("hidden");
  $("zoom-overlay").classList.add("hidden");
  $("map-tip").classList.add("hidden");
  $("replay-btn").classList.add("hidden");

  $("tick-detect").textContent = "—";
  $("tick-embed").textContent = "—";
  $("tick-upsert").textContent = "—";
  $("tick-count").textContent = "#0";
  $("m-vectors").textContent = "0";
  $("m-objects").textContent = "0";
  $("m-disk").innerHTML = `0.0<small> MB</small>`;
  $("m-detect").textContent = "—";
  $("map-count").textContent = "0 vectors";
}

/* ---------- boot ---------- */
function bootLine(text) {
  const div = document.createElement("div");
  div.className = "line";
  div.textContent = text;
  $("boot-terminal").appendChild(div);
}

function startVideo(ev) {
  $("boot-overlay").classList.add("hidden");
  if (ev && ev.vocab) $("vocab-count").textContent = `· ${ev.vocab} concepts`;
  const feed = $("feed");
  if (ev && ev.video_url) {
    state.videoId = ev.video_id;
    state.videoName = ev.video_name;
    if (!feed.src.endsWith(ev.video_url)) feed.src = ev.video_url;
  }
  updateChips(0);
  feed.play().catch(() => {});
  if (!AUTO) $("query-input").focus();
}

/* ---------- mission clock ---------- */
setInterval(() => {
  const t = $("feed").currentTime;
  $("mission-clock").textContent = `T+${fmt(t)}`;
}, 250);

/* ---------- ingest ---------- */
function onFrame(ev) {
  state.edgeCount = ev.count;
  state.objectCount = ev.objects;
  state.detectAvg = state.detectAvg === null ? ev.detect_ms : state.detectAvg * 0.8 + ev.detect_ms * 0.2;
  state.embedAvg = state.embedAvg === null ? ev.embed_ms : state.embedAvg * 0.8 + ev.embed_ms * 0.2;

  state.points.push({
    x: ev.xy[0], y: ev.xy[1],
    born: performance.now(), hit: 0,
    thumb: ev.thumb, ts: ev.video_ts, kind: "frame",
  });

  updateBoxes(ev.boxes || []);

  const total = ev.count + ev.objects;
  $("tick-detect").textContent = `${ev.detect_ms.toFixed(0)}ms`;
  $("tick-embed").textContent = `${ev.embed_ms.toFixed(0)}ms`;
  $("tick-upsert").textContent = `${(ev.upsert_us / 1000).toFixed(1)}ms`;
  $("tick-count").textContent = `#${total}`;
  $("m-vectors").textContent = total;
  $("m-objects").textContent = ev.objects;
  $("m-disk").innerHTML = `${(ev.bytes / 1e6).toFixed(1)}<small> MB</small>`;
  $("m-detect").innerHTML = `${state.detectAvg.toFixed(0)}<small> ms</small>`;
  $("map-count").textContent = `${total} vectors`;

  updateChips(ev.video_ts);
}

/* Chips unlock once the robot has actually seen their subject. */
function updateChips(ts) {
  document.querySelectorAll(".chip").forEach((chip) => {
    // Timed unlocks only make sense for the bundled walkthrough footage.
    const after = state.videoId === "mission" ? parseFloat(chip.dataset.after || "0") : 0;
    const locked = ts < after;
    chip.disabled = locked;
    chip.title = locked ? "the robot has not seen this yet" : "";
  });
}

/* ---------- live detection overlay ---------- */
const overlay = $("overlay");
const octx = overlay.getContext("2d");

function updateBoxes(boxes) {
  const now = performance.now();
  const seen = new Set();
  for (const b of boxes) {
    seen.add(b.tid);
    const t = state.tracks.get(b.tid);
    if (t) {
      t.target = b.box;
      t.cls = b.cls;
      t.obj = b.obj;
      t.conf = b.conf;
      t.seen = now;
    } else {
      state.tracks.set(b.tid, {
        cur: [...b.box], target: b.box,
        cls: b.cls, obj: b.obj, conf: b.conf,
        born: now, seen: now,
      });
    }
  }
  for (const [tid, t] of state.tracks) {
    if (!seen.has(tid) && now - t.seen > 1100) state.tracks.delete(tid);
  }
}

/* Video uses object-fit: cover — map normalized coords to the visible crop. */
function contentRect(videoEl, w, h) {
  const vw = videoEl.videoWidth || 1920, vh = videoEl.videoHeight || 1080;
  const scale = Math.max(w / vw, h / vh);
  const cw = vw * scale, ch = vh * scale;
  return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
}

function drawOverlay(now, dt) {
  const wrap = $("feed-wrap");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  // Re-allocate on EITHER dimension change: a stale-height bitmap gets
  // stretched by CSS and smears strokes into bands.
  if (overlay.width !== w * 2 || overlay.height !== h * 2) {
    overlay.width = w * 2; overlay.height = h * 2;
  }
  const c = octx;
  c.setTransform(2, 0, 0, 2, 0, 0);
  c.clearRect(0, 0, w, h);
  if (!state.tracks.size) return;

  const r = contentRect($("feed"), w, h);
  const k = 1 - Math.exp(-dt * 9);  // smooth pursuit between detection ticks

  c.font = "600 13.5px " + getComputedStyle(document.body).fontFamily;
  for (const t of state.tracks.values()) {
    for (let i = 0; i < 4; i++) t.cur[i] += (t.target[i] - t.cur[i]) * k;
    const age = (now - t.seen) / 1000;
    if (age > 1.1) continue;
    const fade = age < 0.7 ? 1 : 1 - (age - 0.7) / 0.4;
    const birth = Math.min(1, (now - t.born) / 250);

    const x = r.x + t.cur[0] * r.w, y = r.y + t.cur[1] * r.h;
    const bw = (t.cur[2] - t.cur[0]) * r.w, bh = (t.cur[3] - t.cur[1]) * r.h;
    const confirmed = !!t.obj;
    const alpha = (confirmed ? 0.95 : 0.45) * fade * birth;

    c.strokeStyle = confirmed ? `rgba(52, 240, 176, ${alpha})` : `rgba(138, 164, 255, ${alpha})`;
    c.lineWidth = confirmed ? 1.6 : 1;
    c.strokeRect(x, y, bw, bh);

    if (confirmed && bw > 46) {
      const label = t.cls;
      const tw = c.measureText(label).width + 11;
      c.fillStyle = `rgba(5, 5, 12, ${0.82 * fade})`;
      c.fillRect(x - 0.8, y - 20, tw, 19);
      c.fillStyle = `rgba(52, 240, 176, ${alpha})`;
      c.fillText(label, x + 4, y - 6);
    }
  }
}

/* ---------- object inventory ---------- */
function onObject(ev) {
  state.objectCount = ev.total;
  $("inv-count").textContent = `${ev.total} unique object${ev.total === 1 ? "" : "s"}`;

  state.points.push({
    x: ev.xy[0], y: ev.xy[1],
    born: performance.now(), hit: 0,
    thumb: ev.thumb, ts: ev.t, kind: "obj", cls: ev.cls, obj: ev.obj,
  });
  state.objPoints[ev.obj] = state.points.length - 1;

  const card = document.createElement("div");
  card.className = "inv-item";
  card.innerHTML =
    `<img src="data:image/jpeg;base64,${ev.thumb}"><span class="inv-cls">${ev.obj} · ${ev.cls}</span>` +
    `<span class="sync-badge"><i class="sd"></i><em></em></span>`;
  card.addEventListener("click", () => openInspector(ev.obj));
  state.inventory[ev.obj] = { el: card, cls: ev.cls, caption: null, thumb: ev.thumb, t: ev.t };
  setMemStatus(ev.obj, state.memStatus[ev.obj] || "pending");

  const rail = $("inv-rail");
  rail.prepend(card);
  while (rail.children.length > 90) rail.lastChild.remove();
}

/* ---------- EdgeMind: per-memory sync status on the inventory rail ---------- */
const STATUS_LABEL = {
  synced: "CLOUD", pending: "QUEUED", syncing: "SYNCING",
  local: "DEVICE", conflict: "CONFLICT",
};
function setMemStatus(obj, status) {
  state.memStatus[obj] = status;
  const info = state.inventory[obj];
  if (!info) return;
  if (status === "deleted") {
    info.el.remove();
    delete state.inventory[obj];
    return;
  }
  const dot = info.el.querySelector(".sync-badge .sd");
  const label = info.el.querySelector(".sync-badge em");
  dot.className = `sd ${status}`;
  label.textContent = STATUS_LABEL[status] || status.toUpperCase();
  info.el.classList.toggle("st-conflict", status === "conflict");
  if (state.inspecting === obj) send({ cmd: "inspect", obj });
}

function onEnriched(ev) {
  const info = state.inventory[ev.obj];
  if (info) {
    info.caption = ev.caption;
    info.el.title = `“${ev.caption}”`;
    info.el.classList.add("captioned");
  }
}

function onInventory(ev) {
  const wrap = $("inv-facets");
  wrap.innerHTML = "";
  for (const [cls, count] of ev.classes.slice(0, 9)) {
    const b = document.createElement("button");
    b.className = "facet";
    b.innerHTML = `${cls} <b>${count}</b>`;
    b.addEventListener("click", () => {
      $("query-input").value = cls;
      runUserQuery(cls, cls);
    });
    wrap.appendChild(b);
  }
}

/* ---------- open vocabulary: teach the detector a concept ---------- */
$("label-input").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const text = $("label-input").value.trim();
  if (text) send({ cmd: "label", text });
});

function onLabelAdded(text) {
  $("label-input").value = "";
  const el = $("watch-lines");
  const div = document.createElement("div");
  div.className = "watch-line";
  div.textContent = `◎ ${text}`;
  el.prepend(div);
  while (el.children.length > 3) el.lastChild.remove();
}

/* ---------- search ---------- */
const input = $("query-input");
input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const text = input.value.trim();
  if (!text) return;
  runUserQuery(text);
});
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    input.value = chip.textContent;
    runUserQuery(chip.textContent);
  });
});

function runUserQuery(text, cls) {
  $("results").innerHTML = "";
  const badge = $("search-badge");
  badge.textContent = "searching…";
  badge.className = "";
  send({ cmd: "query", text, cls: cls || null, scope: state.scope });
}

document.querySelectorAll("#scope-seg button").forEach((b) => {
  b.addEventListener("click", () => {
    state.scope = b.dataset.scope;
    document.querySelectorAll("#scope-seg button").forEach((x) => x.classList.toggle("on", x === b));
    const text = input.value.trim();
    if (text) runUserQuery(text);
  });
});

/* ---------- search (auto mode typewriter) ---------- */
let typeTimer = null;
function typeQuery(text) {
  clearInterval(typeTimer);
  $("results").innerHTML = "";
  $("search-badge").textContent = "";
  input.value = "";
  let i = 0;
  typeTimer = setInterval(() => {
    input.value = text.slice(0, ++i);
    if (i >= text.length) clearInterval(typeTimer);
  }, Math.min(70, 1300 / text.length));
}

function showResults(ev) {
  const objects = ev.objects || [];
  const moments = ev.moments || [];
  const scope = ev.scope || "edge";
  const wrap = $("results");
  const badge = $("search-badge");
  wrap.innerHTML = "";

  if (ev.cloud_error) {
    const note = document.createElement("div");
    note.className = "cloud-err";
    note.textContent = scope === "cloud"
      ? `☁ ${ev.cloud_error} · switch scope to EDGE: on-device memory still answers`
      : `☁ ${ev.cloud_error} · showing on-device results only`;
    wrap.appendChild(note);
  }
  if (!objects.length && !moments.length) {
    badge.textContent = ev.cloud_error ? "cloud unavailable" : "no memories yet";
    badge.className = "off";
    return;
  }
  if (scope !== "cloud") state.lastQueryUs = ev.latency_us;
  state.lastCloudUs = ev.cloud_latency_us ?? state.lastCloudUs;
  const ms = ev.latency_us / 1000;
  const cms = ev.cloud_latency_us != null ? ev.cloud_latency_us / 1000 : null;
  const weak = objects.length === 0 || objects.every((o) => o.weak);
  let timing;
  if (scope === "edge") timing = `${ms.toFixed(2)} ms · hybrid · on-device`;
  else if (scope === "cloud") timing = cms != null ? `${cms.toFixed(1)} ms · hybrid · cloud` : "cloud";
  else timing = `edge ${ms.toFixed(2)} ms` + (cms != null ? ` · cloud ${cms.toFixed(1)} ms` : "");
  badge.textContent = weak ? `weak match · maybe not seen yet · ${timing}` : timing;
  badge.className = weak ? "off" : "";

  objects.forEach((o, i) => {
    const div = document.createElement("div");
    div.className = o.weak ? "obj-card weak" : "obj-card";
    div.style.animationDelay = `${i * 90}ms`;
    const cap = o.caption
      ? `“${o.caption}”`
      : `<span class="capping">captioning…</span>`;
    const src = o.source || "edge";
    const srcLabel = src === "both" ? "EDGE+CLOUD" : src.toUpperCase();
    const where = src === "cloud"
      ? `${o.device || "fleet"}${o.cloud_version ? ` · v${o.cloud_version}` : ""}`
      : `seen T+${fmt(o.t_first)}`;
    div.innerHTML =
      `<img src="data:image/jpeg;base64,${o.thumb}">
       <div class="obj-body">
         <div class="obj-head"><span class="obj-cls">${o.cls}<span class="src-badge ${src}">${srcLabel}</span></span>
           <span class="obj-score">${o.score !== null ? o.score.toFixed(3) : ""}</span></div>
         <div class="obj-cap">${cap}</div>
         ${o.note ? `<div class="obj-note">✎ ${escapeHtml(o.note)}</div>` : ""}
         <div class="obj-meta">${o.obj || ""} · ${where} · ${o.sightings || 1}× sightings</div>
       </div>`;
    div.addEventListener("click", () => {
      if (src !== "cloud" && state.inventory[o.obj]) { openInspector(o.obj); return; }
      showZoomRaw(o.thumb,
        `<b>“${ev.text}”</b> · ${o.cls} · score ${o.score !== null ? o.score.toFixed(3) : "—"}` +
        (o.caption ? `<br>“${o.caption}”` : "") +
        (o.note ? `<br>✎ ${escapeHtml(o.note)}` : "") +
        `<br>${src === "cloud" ? `cloud memory from ${o.device} · ${o.mission || ""}` : `first seen T+${fmt(o.t_first)} · last T+${fmt(o.t_last)}`}`);
    });
    wrap.appendChild(div);

    const idx = src !== "cloud" ? state.objPoints[o.obj] : undefined;
    if (idx !== undefined) { state.points[idx].hit = performance.now(); }
  });

  if (moments.length) {
    const head = document.createElement("div");
    head.className = "moments-head";
    head.textContent = "MOMENTS · full-frame matches";
    wrap.appendChild(head);
    const row = document.createElement("div");
    row.className = "moments-row";
    moments.forEach((r) => {
      const d = document.createElement("div");
      d.className = "result";
      d.innerHTML = `<img src="data:image/jpeg;base64,${r.thumb}"><div class="score">${r.score.toFixed(3)}</div>`;
      d.addEventListener("click", () => showZoomRaw(r.thumb,
        `<b>“${ev.text}”</b> · score ${r.score.toFixed(3)} · remembered at T+${fmt(r.video_ts)}`));
      row.appendChild(d);

      let best = -1, bestD = 1e9;
      state.points.forEach((p, idx) => {
        if (p.kind !== "frame") return;
        const dd = (p.x - r.xy[0]) ** 2 + (p.y - r.xy[1]) ** 2;
        if (dd < bestD) { bestD = dd; best = idx; }
      });
      if (best >= 0) state.points[best].hit = performance.now();
    });
    wrap.appendChild(row);
  }
}

function fmt(t) {
  t = Math.max(0, t || 0);
  const m = String(Math.floor(t / 60)).padStart(2, "0");
  const s = String(Math.floor(t % 60)).padStart(2, "0");
  return `${m}:${s}`;
}

/* ---------- result zoom ---------- */
function showZoomRaw(thumbB64, metaHtml) {
  $("zoom-img").src = `data:image/jpeg;base64,${thumbB64}`;
  $("zoom-meta").innerHTML = metaHtml;
  $("zoom-overlay").classList.remove("hidden");
}
$("zoom-overlay").addEventListener("click", () => $("zoom-overlay").classList.add("hidden"));

/* ---------- narrative ---------- */
function showScene(title) {
  const el = $("scene-badge");
  el.textContent = title;
  el.classList.add("show");
}

function onMissionComplete(ev) {
  $("replay-btn").classList.remove("hidden");
}
$("replay-btn").addEventListener("click", () => {
  // Replay is an explicit fresh run; bypass the start latch.
  send({ cmd: "start", mode: AUTO ? "auto" : "interactive", video: state.videoId });
});

function showClosing() {
  $("closing-overlay").classList.remove("hidden");
}

/* ---------- memory map canvas + hover ---------- */
const map = $("map");
const mctx = map.getContext("2d");
const MAP_PAD = 18;
let hoverIdx = -1;

map.addEventListener("mousemove", (e) => {
  const rect = map.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const w = rect.width, h = rect.height;
  let best = -1, bestD = 18 * 18;
  state.points.forEach((p, idx) => {
    const x = MAP_PAD + p.x * (w - MAP_PAD * 2);
    const y = MAP_PAD + p.y * (h - MAP_PAD * 2);
    const d = (x - mx) ** 2 + (y - my) ** 2;
    if (d < bestD) { bestD = d; best = idx; }
  });
  hoverIdx = best;
  const tip = $("map-tip");
  if (best >= 0) {
    const p = state.points[best];
    tip.querySelector("img").src = `data:image/jpeg;base64,${p.thumb}`;
    tip.querySelector("span").textContent = p.kind === "obj"
      ? `${p.obj} · ${p.cls} · T+${fmt(p.ts)}`
      : `memory #${best + 1} · T+${fmt(p.ts)}`;
    tip.style.left = `${Math.min(mx + 14, w - 190)}px`;
    tip.style.top = `${Math.min(my + 14, h - 140)}px`;
    tip.classList.remove("hidden");
  } else {
    tip.classList.add("hidden");
  }
});
map.addEventListener("mouseleave", () => {
  hoverIdx = -1;
  $("map-tip").classList.add("hidden");
});

function drawMap(now) {
  const w = map.clientWidth, h = map.clientHeight;
  if (map.width !== w * 2 || map.height !== h * 2) { map.width = w * 2; map.height = h * 2; }
  const c = mctx;
  c.setTransform(2, 0, 0, 2, 0, 0);
  c.clearRect(0, 0, w, h);

  // grid
  c.strokeStyle = "rgba(108, 140, 255, 0.10)";
  c.lineWidth = 1;
  for (let gx = 0; gx <= w; gx += 36) {
    c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke();
  }
  for (let gy = 0; gy <= h; gy += 36) {
    c.beginPath(); c.moveTo(0, gy); c.lineTo(w, gy); c.stroke();
  }

  for (let i = 0; i < state.points.length; i++) {
    const p = state.points[i];
    const x = MAP_PAD + p.x * (w - MAP_PAD * 2);
    const y = MAP_PAD + p.y * (h - MAP_PAD * 2);
    const age = (now - p.born) / 1000;
    const birth = Math.min(1, age / 0.6);
    const hitAge = p.hit ? (now - p.hit) / 1000 : 99;
    const isObj = p.kind === "obj";

    if (age < 0.6) {
      c.beginPath();
      c.arc(x, y, 11 * (1 - birth) + 2, 0, 7);
      c.strokeStyle = `rgba(52, 240, 176, ${0.85 * (1 - birth)})`;
      c.stroke();
    }

    const isHit = hitAge < 6;
    const isHover = i === hoverIdx;
    c.beginPath();
    c.arc(x, y, isHover ? 4.6 : isHit ? 3.8 : isObj ? 3.1 : 2.6, 0, 7);
    c.fillStyle = isHover
      ? "rgba(52, 240, 176, 1)"
      : isHit
        ? `rgba(239, 45, 94, ${Math.max(0.65, 1 - hitAge / 8)})`
        : isObj
          ? `rgba(255, 190, 102, ${0.55 + 0.35 * birth})`
          : `rgba(138, 164, 255, ${0.45 + 0.4 * birth})`;
    c.fill();

    if (isHit && hitAge < 1.6) {
      c.beginPath();
      c.arc(x, y, 5 + hitAge * 15, 0, 7);
      c.strokeStyle = `rgba(239, 45, 94, ${0.9 * (1 - hitAge / 1.6)})`;
      c.lineWidth = 2;
      c.stroke();
    }
  }
}

/* ---------- latency bar canvas (log scale) ---------- */
const lat = $("latbar");
const lctx = lat.getContext("2d");
const LOG_MIN = Math.log10(0.05);   // 0.05 ms
const LOG_MAX = Math.log10(500);    // 500 ms

function lx(ms, w) {
  return ((Math.log10(ms) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * w;
}

function drawLat() {
  const w = lat.clientWidth, h = lat.clientHeight;
  if (lat.width !== w * 2 || lat.height !== h * 2) { lat.width = w * 2; lat.height = h * 2; }
  const c = lctx;
  c.setTransform(2, 0, 0, 2, 0, 0);
  c.clearRect(0, 0, w, h);

  const barY = 4, barH = 20, tickY = barY + barH + 15;

  c.font = "12px monospace";
  c.fillStyle = "rgba(176, 180, 210, 0.85)";
  for (const t of [0.1, 1, 10, 100]) {
    const x = lx(t, w);
    c.fillRect(x, barY, 1.5, barH + 5);
    c.fillText(`${t}ms`, x + 4, tickY);
  }

  const cx1 = lx(80, w), cx2 = lx(200, w);
  c.fillStyle = "rgba(255, 190, 102, 0.22)";
  c.fillRect(cx1, barY, cx2 - cx1, barH);
  c.strokeStyle = "rgba(255, 190, 102, 0.7)";
  c.strokeRect(cx1, barY, cx2 - cx1, barH);

  const ms = state.lastQueryUs !== null ? state.lastQueryUs / 1000 : null;
  if (ms !== null) {
    const x = lx(Math.max(0.051, ms), w);
    c.fillStyle = "#34f0b0";
    c.fillRect(x - 2, barY - 3, 4, barH + 6);
  }
  // Measured cloud search (Qdrant Server round trip), when one has run.
  const cms = state.lastCloudUs !== null ? state.lastCloudUs / 1000 : null;
  if (cms !== null) {
    const x = lx(Math.min(499, Math.max(0.051, cms)), w);
    c.fillStyle = "#7cc4ff";
    c.fillRect(x - 2, barY - 3, 4, barH + 6);
    c.font = "bold 11px monospace";
    c.fillText(`cloud ${cms.toFixed(1)}ms`, Math.min(x + 5, w - 90), barY + barH + 15 + 13);
  }

  const legY = h - 6;
  c.font = "bold 13px monospace";
  c.fillStyle = "#34f0b0";
  c.fillRect(0, legY - 11, 12, 12);
  c.fillText(ms !== null ? `local search ${ms.toFixed(2)} ms` : "local search", 18, legY);
  const cloudX = w / 2 + 6;
  c.fillStyle = "rgba(255, 190, 102, 0.5)";
  c.fillRect(cloudX, legY - 11, 12, 12);
  c.strokeStyle = "rgba(255, 190, 102, 0.9)";
  c.strokeRect(cloudX, legY - 11, 12, 12);
  c.fillStyle = "rgba(255, 200, 120, 1)";
  c.fillText("cloud rtt (typical)", cloudX + 18, legY);
}

let lastTick = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  drawOverlay(now, dt);
  drawMap(now);
  drawLat();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* =====================================================================
   EdgeMind: edge <-> cloud layer
   ===================================================================== */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function clock(ts) {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  if (isNaN(d)) return "—";
  return d.toLocaleTimeString([], { hour12: false });
}
function ago(sec) {
  if (sec < 5) return "just now";
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  return `${Math.floor(sec / 3600)} h ago`;
}
function nfmt(n) { return n == null ? "—" : Number(n).toLocaleString(); }

let toastTimer = null;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3600);
}

/* ---------- connection switch ---------- */
function toggleNetwork() {
  const online = state.sync ? state.sync.online : true;
  send({ cmd: "net", online: !online });
}
$("net-btn").addEventListener("click", toggleNetwork);
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "o" || document.activeElement.tagName === "INPUT") return;
  if (!state.started) return;
  toggleNetwork();
});

/* ---------- sync state ---------- */
function renderSync(s) {
  state.sync = s;
  const link = s.link;  // online | offline | unreachable
  const LINK_TEXT = { online: "ONLINE", offline: "OFFLINE", unreachable: "CLOUD UNREACHABLE" };

  document.body.classList.toggle("is-offline", link !== "online");
  const pill = $("net-pill");
  pill.className = `net-pill ${link}`;
  $("net-text").textContent = LINK_TEXT[link];
  const btn = $("net-btn");
  btn.textContent = s.online ? "SIMULATE OFFLINE" : "RESTORE CONNECTION";
  btn.classList.toggle("restore", !s.online);
  $("hud-offline").classList.toggle("hidden", link === "online");
  $("hud-offline").textContent = link === "offline"
    ? "⚠ OFFLINE · AI MEMORY STILL ACTIVE"
    : "⚠ CLOUD UNREACHABLE · AI MEMORY STILL ACTIVE";
  $("unit-id").textContent = (s.device_id || "edge-01").toUpperCase();

  $("cloud-kind").textContent = `→ ${s.cloud_label}` + (s.cloud_rtt_ms != null && link === "online" ? ` · rtt ${s.cloud_rtt_ms} ms` : "");
  $("link-device").textContent = s.device_id || "";
  const ls = $("link-status");
  ls.className = link;
  $("ls-text").textContent = LINK_TEXT[link];
  const syncEl = $("ls-sync");
  syncEl.textContent = link === "online" ? "LIVE" : "PAUSED";
  syncEl.className = link === "online" ? "ok" : "paused";

  const c = s.counts || {};
  const edgeTotal = (s.edge.objects || 0) + (s.edge.frames || 0);
  $("s-edge").textContent = nfmt(edgeTotal);
  $("s-edge-sub").textContent = `${nfmt(s.edge.objects)} objects · ${nfmt(s.edge.frames)} frames`;
  const cloud = s.cloud || {};
  $("s-cloud").textContent = nfmt(cloud.total);
  const devs = (cloud.devices || []).length;
  $("s-cloud-sub").textContent = cloud.total == null ? "not connected"
    : `${nfmt(cloud.device)} from this unit${devs > 1 ? ` · ${devs} devices` : ""}` + (link === "online" ? "" : " · last known");

  const pending = (c.queued_ops || 0);
  const pend = $("s-pending");
  pend.textContent = nfmt(pending);
  pend.className = `stat-v ${pending ? "amber" : "zero"}`;
  $("s-pending-sub").textContent = pending
    ? (link === "online" ? "uploading…" : "held until reconnect") + (c.retrying ? ` · ${c.retrying} retrying` : "")
    : "queue empty";
  const conf = c.open_conflicts || 0;
  const confEl = $("s-conflicts");
  confEl.textContent = conf;
  confEl.className = `stat-v ${conf ? "red" : "zero"}`;
  $("s-conflicts-sub").textContent = conf ? "needs a decision" : `${c.resolved_conflicts || 0} resolved`;

  $("f-local").textContent = nfmt(c.local_only || 0);
  $("f-queued").textContent = nfmt(c.pending || 0);
  $("f-syncing").textContent = nfmt(c.syncing || 0);
  $("f-synced").textContent = nfmt(c.synced || 0);

  // progress
  const d = s.drain || {};
  const bar = $("progress-bar"), txt = $("progress-text"), eng = $("engine-state");
  if (link !== "online" && pending) {
    bar.style.width = "100%";
    bar.className = "paused";
    txt.textContent = `${pending} change${pending === 1 ? "" : "s"} queued · will sync when connected`;
    eng.textContent = link === "offline" ? "paused · offline" : "retrying · cloud down";
    eng.className = "paused";
  } else if (d.active && d.total > 0) {
    const pct = Math.round((100 * d.done) / d.total);
    bar.style.width = `${pct}%`;
    bar.className = "active";
    txt.textContent = `↻ Synchronizing · ${d.done} / ${d.total} memories · ${pct}%`;
    eng.textContent = "synchronizing";
    eng.className = "active";
  } else if (link === "online" && pending) {
    bar.style.width = "100%";
    bar.className = "active";
    txt.textContent = `↻ Syncing ${pending} fresh memor${pending === 1 ? "y" : "ies"}…`;
    eng.textContent = "streaming";
    eng.className = "active";
  } else {
    bar.style.width = "100%";
    bar.className = "";
    txt.textContent = conf
      ? `⚠ ${conf} conflict${conf === 1 ? "" : "s"} waiting · everything else up to date`
      : (link === "online" ? "✓ Up to date · edge and cloud in sync" : "✓ Nothing to sync");
    eng.textContent = link === "online" ? "idle · watching" : "paused";
    eng.className = link === "online" ? "" : "paused";
  }
  $("tick-sync").textContent = link !== "online" ? (pending ? `queued ${pending}` : "offline")
    : (pending ? `↑${pending}` : "✓");

  // policy toggles
  const p = s.policy || {};
  document.querySelectorAll("#seg-conflict button").forEach((b) =>
    b.classList.toggle("on", b.dataset.v === p.conflict_mode));
  document.querySelectorAll("#seg-privacy button").forEach((b) =>
    b.classList.toggle("on", (b.dataset.v === "on") === !!p.privacy_rule));

  renderConflicts(s.conflicts || []);
  updateLastSync();
}

function updateLastSync() {
  const s = state.sync;
  if (!s) return;
  $("last-sync-v").textContent = s.last_sync_at
    ? `${clock(s.last_sync_at)} · ${ago(Date.now() / 1000 - s.last_sync_at)}`
    : "never";
}
setInterval(updateLastSync, 1000);

/* ---------- activity log ---------- */
function addActivity(ev) {
  const wrap = $("activity");
  if (wrap.querySelector(`[data-id="${ev.id}"]`)) return;
  const row = document.createElement("div");
  row.className = `act ${ev.level} cat-${ev.cat}`;
  row.dataset.id = ev.id;
  row.innerHTML = `<span class="t">${clock(ev.ts)}</span><span class="m">${escapeHtml(ev.text)}</span>`;
  wrap.prepend(row);
  while (wrap.children.length > 160) wrap.lastChild.remove();
  $("activity-count").textContent = `${wrap.children.length} events`;
}

/* ---------- conflicts ---------- */
function renderConflicts(list) {
  const key = list.map((c) => c.id).join(",");
  const panel = $("conflict-panel");
  panel.classList.toggle("hidden", list.length === 0);
  $("conflict-count").textContent = list.length ? `${list.length} open` : "";
  if (key === state.conflictKey) return;
  state.conflictKey = key;
  const wrap = $("conflict-list");
  wrap.innerHTML = "";
  for (const c of list) {
    const inv = state.inventory[c.label];
    const sugEdge = c.suggested === "edge";
    const card = document.createElement("div");
    card.className = "conflict-card";
    card.innerHTML = `
      <div class="cf-head">${inv ? `<img src="data:image/jpeg;base64,${inv.thumb}">` : ""}
        ${escapeHtml(c.label)} <span>/ ${escapeHtml(c.field)} · ${inv ? escapeHtml(inv.cls) : ""}</span></div>
      <div class="cf-sides">
        <div class="cf-side edge ${sugEdge ? "suggested" : ""}">
          <div class="cf-tag">EDGE · ${escapeHtml(c.edge_by || "")}</div>
          <div class="cf-val">“${escapeHtml(c.edge_value ?? "∅")}”</div>
          <div class="cf-ts">${clock(c.edge_ts)} · v${c.edge_version}</div>
        </div>
        <div class="cf-vs">VS</div>
        <div class="cf-side cloud ${sugEdge ? "" : "suggested"}">
          <div class="cf-tag">CLOUD · ${escapeHtml(c.cloud_by || "")}</div>
          <div class="cf-val">“${escapeHtml(c.cloud_value ?? "∅")}”</div>
          <div class="cf-ts">${clock(c.cloud_ts)} · v${c.cloud_version}</div>
        </div>
      </div>
      <div class="cf-actions">
        <button data-choice="edge">KEEP EDGE</button>
        <button data-choice="cloud">KEEP CLOUD</button>
        <button data-choice="latest">KEEP LATEST</button>
      </div>`;
    card.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      card.style.opacity = ".4";
      send({ cmd: "resolve", id: c.id, choice: b.dataset.choice });
    }));
    wrap.appendChild(card);
  }
}

/* ---------- controls ---------- */
$("btn-sync").addEventListener("click", () => send({ cmd: "sync_now" }));
$("btn-hq").addEventListener("click", () => send({ cmd: "hq_edit" }));
$("btn-conflict").addEventListener("click", () => send({ cmd: "stage_conflict" }));
document.querySelectorAll("#seg-conflict button").forEach((b) =>
  b.addEventListener("click", () => send({ cmd: "policy", conflict_mode: b.dataset.v })));
document.querySelectorAll("#seg-privacy button").forEach((b) =>
  b.addEventListener("click", () => send({ cmd: "policy", privacy_rule: b.dataset.v === "on" })));

/* ---------- memory inspector ---------- */
function openInspector(obj) {
  const info = state.inventory[obj];
  if (!info) return;
  state.inspecting = obj;
  $("ins-img").src = `data:image/jpeg;base64,${info.thumb}`;
  $("ins-obj").textContent = obj;
  $("ins-cls").textContent = info.cls;
  $("ins-caption").textContent = info.caption ? `“${info.caption}”` : "captioning…";
  $("ins-grid").innerHTML = "";
  $("ins-note").value = "";
  $("ins-note").dataset.loaded = "";
  $("inspect-overlay").classList.remove("hidden");
  send({ cmd: "inspect", obj });
}

function renderInspector(r) {
  if (r.obj !== state.inspecting) return;
  const st = $("ins-status");
  st.className = `pill ${r.status}`;
  st.textContent = STATUS_LABEL[r.status] || r.status;
  if (r.caption) $("ins-caption").textContent = `“${r.caption}”`;
  const friendly = document.body.classList.contains("user-mode");
  const rows = friendly ? [
    ["Where it lives", r.scope === "sync" ? "On this device + backed up to the cloud" : "Only on this device"],
    ["Why", (r.scope_reason || "").replace("privacy rule: sensitive area", "Private room, so it stays on the device")
      .replace("object knowledge shared with fleet", "Useful for the whole team").replace("operator: ", "You chose: ")],
    ["Backup", r.status === "synced" ? "✓ Up to date in the cloud"
      : r.status === "local" ? "Not backed up (device only)"
      : r.status === "conflict" ? "⚠ Waiting for your decision"
      : `Waiting to upload${r.dirty.length ? ` (${r.dirty.join(", ")} changed)` : ""}`],
    ["Seen", `${r.sightings ?? "—"} times · first at ${fmt(r.t_first)}`],
  ] : [
    ["scope", r.scope === "sync" ? "shared with fleet" : "device-only"],
    ["policy", r.scope_reason || "—"],
    ["edge version", `v${r.local_version}` + (r.dirty.length ? ` · unsynced: ${r.dirty.join(", ")}` : "")],
    ["cloud version", r.base_version ? `v${r.base_version} (last synced ${r.synced_at ? clock(r.synced_at) : "—"})` : "never uploaded"],
    ["sightings", `${r.sightings ?? "—"}× · first seen T+${fmt(r.t_first)}`],
    ["memory id", r.memory_id.slice(0, 18) + "…"],
  ];
  let html = rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${escapeHtml(v)}</span>`).join("");
  if (friendly) {
    if (r.cloud && r.cloud.note && r.cloud.note !== r.note) {
      html += `<span class="k">Cloud note</span><span class="v cloud">“${escapeHtml(r.cloud.note)}”</span>`;
    }
  } else if (r.cloud) {
    html += `<span class="k">cloud copy</span><span class="v cloud">v${r.cloud.version} · by ${escapeHtml(r.cloud.updated_by)}` +
      (r.cloud.note ? ` · note “${escapeHtml(r.cloud.note)}”` : "") + `</span>`;
  } else if (!friendly && !r.link_up && r.base_version) {
    html += `<span class="k">cloud copy</span><span class="v cloud">unreachable · offline</span>`;
  }
  $("ins-grid").innerHTML = html;
  const note = $("ins-note");
  if (!note.dataset.loaded || document.activeElement !== note) {
    note.value = r.note || "";
    note.dataset.loaded = "1";
  }
  const scopeBtn = $("ins-scope");
  scopeBtn.textContent = friendly
    ? (r.scope === "sync" ? "🔒 Keep only on this device" : "☁ Back up to cloud")
    : (r.scope === "sync" ? "🔒 KEEP ON DEVICE ONLY" : "☁ SHARE TO CLOUD");
  scopeBtn.dataset.target = r.scope === "sync" ? "local" : "sync";
}

function closeInspector() {
  state.inspecting = null;
  $("inspect-overlay").classList.add("hidden");
}
$("ins-close").addEventListener("click", closeInspector);
$("inspect-overlay").addEventListener("click", (e) => { if (e.target.id === "inspect-overlay") closeInspector(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeInspector(); });
function saveNote() {
  const obj = state.inspecting;
  if (!obj) return;
  send({ cmd: "annotate", obj, note: $("ins-note").value.trim() });
  $("ins-note").blur();
  setTimeout(() => send({ cmd: "inspect", obj }), 250);
}
$("ins-save").addEventListener("click", saveNote);
$("ins-note").addEventListener("keydown", (e) => { if (e.key === "Enter") saveNote(); });
$("ins-scope").addEventListener("click", () => {
  const obj = state.inspecting;
  if (obj) send({ cmd: "scope", obj, scope: $("ins-scope").dataset.target });
});
$("ins-forget").addEventListener("click", () => {
  const obj = state.inspecting;
  if (!obj) return;
  send({ cmd: "forget", obj });
  closeInspector();
});
