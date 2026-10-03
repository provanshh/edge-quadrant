/* EdgeMind · USER mode.
   A plain-language dashboard over the same live event stream the operator
   view uses. Relies on globals from app.js (state, send, handle, $, fmt,
   clock, nfmt, escapeHtml, toast, openInspector, runUserQuery, requestStart,
   startVideoById, showZoomRaw). */

(() => {
  const U = {
    mode: localStorage.getItem("edgemind-mode") || "operator",
    serverRunning: false,
    running: false,
    recent: [],            // [{obj, cls, t, thumb, caption}] newest first
    classThumb: {},        // cls -> thumb of first sighting
    classes: [],           // [[cls, count]] from the inventory event
    history: [],           // [{t, edge, cloud}] for the growth chart
    chartHover: -1,
    lastDiscovery: 0,
    bell: [],
    unread: 0,
    seenConflicts: new Set(),
    dismissed: new Set(),
    conflicts: [],
    cmCurrent: null,
    lastLink: null,
    videos: [],
    selVideo: null,
    seeAll: false,
    lastSync: null,
  };

  const RECENT_LIMIT = 6;
  const SCOPE_TEXT = { edge: "This device", cloud: "Cloud", both: "Both" };
  const STATUS_TEXT = {
    synced: "Backed up", pending: "Waiting", syncing: "Uploading",
    local: "Device only", conflict: "Decide",
  };

  /* ---------------------------------------------------------------- mode */
  function setMode(mode) {
    U.mode = mode;
    localStorage.setItem("edgemind-mode", mode);
    const user = mode === "user";
    document.body.classList.toggle("user-mode", user);
    document.documentElement.classList.toggle("user-mode", user);
    const wrap = $("feed-wrap");
    const target = user ? $("u-feed-slot") : $("feed-panel");
    if (wrap.parentElement !== target) {
      target.appendChild(wrap);
      setTimeout(() => {
        const f = $("feed");
        if (U.running && f.paused && !f.ended) f.play().catch(() => {});
      }, 50);
    }
    document.querySelectorAll(".mode-toggle").forEach((b) => {
      b.title = user ? "switch to the detailed operator view" : "switch to the simple user view";
    });
    if (user) requestAnimationFrame(drawChart);
  }
  document.querySelectorAll(".mode-toggle").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    setMode(U.mode === "user" ? "operator" : "user");
  }));

  /* -------------------------------------------------------- title screen */
  $("title-actions").addEventListener("click", (e) => e.stopPropagation());
  $("ta-start").addEventListener("click", () => {
    if (U.serverRunning) startVideoById(state.videoId, true);
    else requestStart();
  });
  $("ta-upload").addEventListener("click", openUpload);
  $("ta-help").addEventListener("click", () => openModal("help-modal"));
  $("op-video-btn").addEventListener("click", openUpload);

  /* ------------------------------------------------------- event wiring */
  const base = handle;
  // eslint-disable-next-line no-global-assign
  handle = (ev) => {
    base(ev);
    try { onUserEvent(ev); } catch (err) { console.error("user view:", err); }
  };

  function onUserEvent(ev) {
    switch (ev.type) {
      case "ready": U.serverRunning = !!ev.running; break;
      case "phase": if (ev.name === "boot") resetUser(); break;
      case "video_start": onVideoStart(ev); break;
      case "frame_ingested": onFrame(ev); break;
      case "object_discovered": onObject(ev); break;
      case "object_enriched": onEnriched(ev); break;
      case "inventory": onInventory(ev); break;
      case "memory_status": onStatus(ev.obj, ev.status); break;
      case "sync_state": onSync(ev); break;
      case "query_result": onResults(ev); break;
      case "activity": addTimeline(ev); break;
      case "inspect_result": friendlyInspector(ev); break;
      case "label_added": toast(`Now also looking for “${ev.text}”`); break;
      case "mission_complete": onComplete(); break;
    }
  }

  function resetUser() {
    U.running = false;
    U.recent = [];
    U.classThumb = {};
    U.classes = [];
    U.history = [];
    U.seenConflicts.clear();
    U.dismissed.clear();
    U.conflicts = [];
    U.lastDiscovery = 0;
    $("u-recent").innerHTML = `<div class="u-shimmer"></div><div class="u-shimmer"></div><div class="u-shimmer"></div>`;
    $("u-known").innerHTML = `<div class="u-empty-sm">Things it sees will show up here.</div>`;
    $("u-known-count").textContent = "0";
    $("u-timeline").innerHTML = "";
    $("u-results").innerHTML = emptyResults();
    $("u-search-meta").textContent = "";
    $("u-query").value = "";
    renderChips();
    ["u-s-things", "u-s-frames"].forEach((id) => { $(id).textContent = "0"; });
    $("u-s-speed").textContent = "—";
    $("u-s-storage").textContent = "0 MB";
    $("u-replay").classList.add("hidden");
    closeModal("conflict-modal");
    drawChart();
  }

  function onVideoStart(ev) {
    U.running = true;
    U.serverRunning = true;
    $("u-feed-empty").classList.add("hidden");
    $("u-live").classList.add("on");
    $("u-replay").classList.add("hidden");
    $("u-video-name").textContent = ev.video_name || "Demo · house walkthrough";
    $("ta-video-name").textContent = ev.video_name || "demo video";
  }

  function onComplete() {
    U.running = false;
    $("u-live").classList.remove("on");
    $("u-replay").classList.remove("hidden");
    notify("🎬", "Finished watching the video", "Everything it saw is saved. You can still search it.");
  }

  function onFrame(ev) {
    setNum("u-s-things", ev.objects);
    setNum("u-s-frames", ev.count);
    $("u-s-storage").textContent = `${(ev.bytes / 1e6).toFixed(1)} MB`;
  }

  /* ---------------------------------------------------- recent memories */
  function onObject(ev) {
    U.lastDiscovery = performance.now();
    if (!U.classThumb[ev.cls]) U.classThumb[ev.cls] = ev.thumb;
    U.recent.unshift({ obj: ev.obj, cls: ev.cls, t: ev.t, thumb: ev.thumb, caption: null });
    const list = $("u-recent");
    list.querySelectorAll(".u-shimmer").forEach((s) => s.remove());
    list.prepend(recentRow(U.recent[0], true));
    trimRecent();
  }

  function recentRow(r, fresh) {
    const row = document.createElement("div");
    row.className = "u-row-item" + (fresh ? " flash" : "");
    row.dataset.obj = r.obj;
    const st = state.memStatus[r.obj] || "pending";
    row.innerHTML =
      `<img src="data:image/jpeg;base64,${r.thumb}" alt="">
       <div><b>${escapeHtml(r.cls)}</b><small>${subline(r)}</small></div>
       <span class="u-pill ${st}">${STATUS_TEXT[st] || st}</span>
       <span class="u-go">↗</span>`;
    row.addEventListener("click", () => openInspector(r.obj));
    return row;
  }
  function subline(r) {
    return r.caption ? `${escapeHtml(r.caption)} · ${fmt(r.t)}` : `${r.obj} · seen at ${fmt(r.t)}`;
  }
  function trimRecent() {
    const list = $("u-recent");
    const limit = U.seeAll ? 200 : RECENT_LIMIT;
    while (list.children.length > limit) list.lastChild.remove();
  }
  $("u-see-all").addEventListener("click", () => {
    U.seeAll = !U.seeAll;
    $("u-see-all").textContent = U.seeAll ? "Show less" : "See all";
    $("u-recent").classList.toggle("all", U.seeAll);
    const list = $("u-recent");
    list.innerHTML = "";
    U.recent.slice(0, U.seeAll ? 200 : RECENT_LIMIT).forEach((r) => list.appendChild(recentRow(r, false)));
    if (!U.recent.length) list.innerHTML = `<div class="u-empty-sm">Nothing remembered yet.</div>`;
  });

  function onEnriched(ev) {
    const r = U.recent.find((x) => x.obj === ev.obj);
    if (!r) return;
    r.caption = ev.caption;
    const row = $("u-recent").querySelector(`[data-obj="${ev.obj}"] small`);
    if (row) row.innerHTML = subline(r);
  }

  function onStatus(obj, status) {
    const row = $("u-recent").querySelector(`[data-obj="${obj}"]`);
    if (status === "deleted") {
      U.recent = U.recent.filter((r) => r.obj !== obj);
      if (row) row.remove();
      return;
    }
    if (!row) return;
    const pill = row.querySelector(".u-pill");
    pill.className = `u-pill ${status}`;
    pill.textContent = STATUS_TEXT[status] || status;
  }

  /* ---------------------------------------------- what it knows (side) */
  function onInventory(ev) {
    U.classes = ev.classes || [];
    const total = U.classes.reduce((a, [, n]) => a + n, 0);
    $("u-known-count").textContent = total;
    const wrap = $("u-known");
    wrap.innerHTML = "";
    U.classes.slice(0, 12).forEach(([cls, n], i) => {
      const item = document.createElement("div");
      item.className = "u-known-item";
      item.style.animationDelay = `${i * 25}ms`;
      const th = U.classThumb[cls];
      item.innerHTML = `${th ? `<img src="data:image/jpeg;base64,${th}" alt="">` : `<img alt="">`}
        <div><b>${escapeHtml(cls)}</b><small>Tap to find it</small></div><span class="u-count">${n}</span>`;
      item.addEventListener("click", () => { goTo("u-search"); runQuery(cls, cls); });
      wrap.appendChild(item);
    });
    renderChips();
  }

  let chipKey = "";
  function renderChips() {
    const top = U.classes.slice(0, 6).map(([c]) => c);
    const key = top.join("|");
    if (key === chipKey && $("u-chips").children.length) return;
    chipKey = key;
    const wrap = $("u-chips");
    wrap.innerHTML = "";
    [...top, "needs repair"].forEach((text, i) => {
      const b = document.createElement("button");
      b.className = "u-chip";
      b.style.animationDelay = `${i * 30}ms`;
      b.textContent = text;
      b.addEventListener("click", () => runQuery(text, top.includes(text) ? text : null));
      wrap.appendChild(b);
    });
  }

  /* ------------------------------------------------------- sync state */
  function onSync(s) {
    const c = s.counts || {};
    const objects = s.edge ? s.edge.objects : 0;
    const frames = s.edge ? s.edge.frames : 0;
    const waiting = (c.pending || 0) + (c.syncing || 0);
    const conflicts = c.open_conflicts || 0;
    const link = s.link;
    $("u-dev-name").textContent = s.device_id || "edge-01";

    setTile("u-t-edge", objects,
      objects ? `${nfmt(frames)} snapshots${c.local_only ? ` · ${c.local_only} kept private` : ""}` : "Nothing yet");
    setTile("u-t-cloud", c.synced || 0,
      s.cloud && s.cloud.total != null ? `${nfmt(s.cloud.total)} across all devices` : "Cloud not reachable");
    setTile("u-t-pending", waiting,
      waiting === 0 ? "All caught up"
        : !s.online ? "Will upload when back online"
        : link !== "online" ? "Waiting for the cloud"
        : "Uploading now…");
    setTile("u-t-conflict", conflicts, conflicts ? "Tap to choose which note to keep" : "All clear");
    $("u-tile-conflict").classList.toggle("alert", conflicts > 0);

    // connection widgets
    const on = link === "online";
    const TEXT = { online: "Connected", offline: "Offline", unreachable: "Cloud not reachable" };
    const SUB = {
      online: "Memories back up to the cloud automatically.",
      offline: "No internet. The device still remembers and answers searches. Changes upload later.",
      unreachable: "Internet is on, but the cloud can't be reached. Everything is saved on the device.",
    };
    $("u-conn").classList.toggle("off", !on);
    $("u-conn-text").textContent = TEXT[link];
    $("u-conn-sub").textContent = SUB[link];
    const sw = $("u-net-switch");
    sw.classList.toggle("on", !!s.online);
    sw.setAttribute("aria-checked", String(!!s.online));
    const chip = $("u-chip-conn");
    chip.classList.toggle("off", !on);
    chip.querySelector("span").textContent = on ? "Online" : TEXT[link];
    $("u-net-btn").textContent = s.online ? "Go offline" : "Go online";
    $("u-hero-sub").textContent = on
      ? "The device watches the video, remembers what it sees, and backs it up to the cloud."
      : "You're offline. The device keeps remembering and searching. Backups resume when you reconnect.";

    if (U.lastLink && U.lastLink !== link) {
      if (on) notify("🌐", "Back online", waiting ? `Uploading ${waiting} saved memories…` : "Everything is backed up");
      else if (link === "offline") notify("📴", "You're offline", "Everything still works on the device");
      else notify("☁", "Cloud not reachable", "Changes are saved on the device");
    }
    U.lastLink = link;

    // how-it-works strip
    const steps = {};
    document.querySelectorAll(".u-step").forEach((el) => { steps[el.dataset.step] = el; });
    const recent = performance.now() - U.lastDiscovery < 3000;
    stepState(steps.see, U.running || objects > 0, U.running);
    stepState(steps.remember, objects > 0, recent);
    stepState(steps.offline, !on, !on);
    steps.offline.classList.toggle("warn", !on);
    stepState(steps.sync, (c.synced || 0) > 0 && on, on && ((s.drain && s.drain.active) || (c.syncing || 0) > 0));

    // growth chart (one sample per second)
    const now = Date.now();
    const last = U.history[U.history.length - 1];
    if (!last || now - last.t >= 1000) {
      if (objects > 0 || U.history.length) U.history.push({ t: now, edge: objects, cloud: c.synced || 0 });
      if (U.history.length > 600) U.history.shift();
      drawChart();
    }

    // conflicts: auto-open the friendly chooser for new ones
    U.conflicts = s.conflicts || [];
    const fresh = U.conflicts.filter((x) => !U.seenConflicts.has(x.id));
    fresh.forEach((x) => U.seenConflicts.add(x.id));
    if (fresh.length) {
      const name = clsOf(fresh[0].label);
      notify("⚖", `Two different notes for the ${name}`, "Your decision is needed");
      if (U.mode === "user" && $("conflict-modal").classList.contains("hidden")) openConflict();
    }
    if (U.cmCurrent && !$("conflict-modal").classList.contains("hidden")
        && !U.conflicts.some((x) => x.id === U.cmCurrent.id) && $("cm-done").classList.contains("hidden")) {
      nextConflictOrClose();
    }
  }

  function stepState(el, on, hot) {
    el.classList.toggle("on", !!on);
    el.classList.toggle("hot", !!hot);
  }

  function setTile(id, v, sub) {
    const el = $(id);
    const prev = Number(el.dataset.v || 0);
    if (prev !== v) {
      countTo(el, prev, v);
      const tile = el.closest(".u-tile");
      tile.classList.remove("bump");
      void tile.offsetWidth;
      tile.classList.add("bump");
    }
    $(`${id}-s`).textContent = sub;
  }
  function setNum(id, v) {
    const el = $(id);
    const prev = Number(el.dataset.v || 0);
    if (prev !== v) countTo(el, prev, v);
  }
  function countTo(el, from, to) {
    el.dataset.v = to;
    const start = performance.now(), dur = 550;
    const step = (now) => {
      const k = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = nfmt(Math.round(from + (to - from) * e));
      if (k < 1 && Number(el.dataset.v) === to) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function clsOf(label) {
    const info = state.inventory[label];
    return info ? info.cls : label;
  }

  /* ------------------------------------------------------ growth chart */
  const chart = $("u-chart");
  const cctx = chart.getContext("2d");
  function drawChart() {
    const w = chart.clientWidth, h = chart.clientHeight;
    if (!w) return;
    if (chart.width !== w * 2 || chart.height !== h * 2) { chart.width = w * 2; chart.height = h * 2; }
    const c = cctx;
    c.setTransform(2, 0, 0, 2, 0, 0);
    c.clearRect(0, 0, w, h);
    const H = U.history;
    const padL = 30, padR = 10, padT = 14, padB = 22;
    const iw = w - padL - padR, ih = h - padT - padB;
    const maxV = Math.max(5, ...H.map((p) => Math.max(p.edge, p.cloud))) * 1.15;

    c.font = "500 11px " + getComputedStyle(document.body).fontFamily;
    c.fillStyle = "#9a9ca1";
    c.strokeStyle = "#ececE6";
    c.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = padT + ih - (ih * i) / 3;
      c.beginPath(); c.moveTo(padL, y); c.lineTo(w - padR, y); c.stroke();
      c.fillText(String(Math.round((maxV * i) / 3)), 2, y + 4);
    }
    if (H.length < 2) {
      c.fillStyle = "#9a9ca1";
      c.textAlign = "center";
      c.fillText("The chart fills in as the device remembers things", padL + iw / 2, padT + ih / 2);
      c.textAlign = "left";
      return;
    }
    const t0 = H[0].t, t1 = H[H.length - 1].t;
    const X = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * iw;
    const Y = (v) => padT + ih - (v / maxV) * ih;

    // x labels
    c.fillStyle = "#9a9ca1";
    [0, 0.5, 1].forEach((k) => {
      const t = t0 + (t1 - t0) * k;
      const label = fmt((t - t0) / 1000);
      c.textAlign = k === 0 ? "left" : k === 1 ? "right" : "center";
      c.fillText(label, padL + iw * k, h - 5);
    });
    c.textAlign = "left";

    // on-device area + line
    const grad = c.createLinearGradient(0, padT, 0, padT + ih);
    grad.addColorStop(0, "rgba(138, 108, 255, .28)");
    grad.addColorStop(1, "rgba(138, 108, 255, 0)");
    c.beginPath();
    H.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p.edge)) : c.moveTo(X(p.t), Y(p.edge))));
    c.lineTo(X(t1), padT + ih); c.lineTo(X(t0), padT + ih); c.closePath();
    c.fillStyle = grad; c.fill();
    c.beginPath();
    H.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p.edge)) : c.moveTo(X(p.t), Y(p.edge))));
    c.strokeStyle = "#8a6cff"; c.lineWidth = 2.4; c.lineJoin = "round"; c.stroke();

    // cloud line (dotted)
    c.beginPath();
    H.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p.cloud)) : c.moveTo(X(p.t), Y(p.cloud))));
    c.setLineDash([4, 4]); c.strokeStyle = "#141414"; c.lineWidth = 1.6; c.stroke(); c.setLineDash([]);

    // hover guide
    const tip = $("u-chart-tip");
    const hi = U.chartHover;
    if (hi >= 0 && hi < H.length) {
      const p = H[hi], x = X(p.t);
      c.strokeStyle = "rgba(20,20,20,.25)"; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, padT); c.lineTo(x, padT + ih); c.stroke();
      [[p.edge, "#8a6cff"], [p.cloud, "#141414"]].forEach(([v, col]) => {
        c.beginPath(); c.arc(x, Y(v), 4.5, 0, Math.PI * 2);
        c.fillStyle = "#fff"; c.fill(); c.lineWidth = 2; c.strokeStyle = col; c.stroke();
      });
      tip.classList.remove("hidden");
      tip.textContent = `${fmt((p.t - t0) / 1000)} · ${p.edge} on device · ${p.cloud} in cloud`;
      tip.style.left = `${chart.offsetLeft + x}px`;
      tip.style.top = `${chart.offsetTop + Y(p.edge)}px`;
    } else {
      tip.classList.add("hidden");
    }
  }
  chart.addEventListener("mousemove", (e) => {
    const H = U.history;
    if (H.length < 2) return;
    const rect = chart.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (e.clientX - rect.left - 30) / (rect.width - 40)));
    const t = H[0].t + (H[H.length - 1].t - H[0].t) * k;
    let best = 0;
    H.forEach((p, i) => { if (Math.abs(p.t - t) < Math.abs(H[best].t - t)) best = i; });
    U.chartHover = best;
    drawChart();
  });
  chart.addEventListener("mouseleave", () => { U.chartHover = -1; drawChart(); });
  window.addEventListener("resize", () => drawChart());

  /* ------------------------------------------------------------ search */
  function runQuery(text, cls) {
    $("u-query").value = text;
    $("u-search-meta").innerHTML = `Searching ${SCOPE_TEXT[state.scope].toLowerCase()}…`;
    $("u-results").innerHTML = `<div class="u-shimmer" style="grid-column:1/-1"></div>`;
    $("query-input").value = text;
    runUserQuery(text, cls || null);
  }
  $("u-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && $("u-query").value.trim()) runQuery($("u-query").value.trim());
  });
  $("u-query-btn").addEventListener("click", () => {
    const t = $("u-query").value.trim();
    if (t) runQuery(t); else $("u-query").focus();
  });

  const dd = $("u-scope-dd");
  dd.querySelector(".u-dd-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    dd.querySelector(".u-dd-menu").classList.toggle("hidden");
  });
  dd.querySelectorAll(".u-dd-menu button").forEach((b) => b.addEventListener("click", () => {
    setScope(b.dataset.scope);
    dd.querySelector(".u-dd-menu").classList.add("hidden");
    const t = $("u-query").value.trim();
    if (t) runQuery(t);
  }));
  function setScope(scope) {
    state.scope = scope;
    $("u-scope-label").textContent = `Search in: ${SCOPE_TEXT[scope]}`;
    dd.querySelectorAll(".u-dd-menu button").forEach((x) => x.classList.toggle("on", x.dataset.scope === scope));
    document.querySelectorAll("#scope-seg button").forEach((x) => x.classList.toggle("on", x.dataset.scope === scope));
  }
  document.querySelectorAll("#scope-seg button").forEach((b) => b.addEventListener("click", () => setScope(b.dataset.scope)));

  function emptyResults() {
    return `<div class="u-empty"><div class="u-empty-ic">⌕</div><b>Try asking a question</b>
      <small>Results appear here, with where and when each thing was seen.</small></div>`;
  }

  function onResults(ev) {
    const objects = ev.objects || [];
    const moments = ev.moments || [];
    const scope = ev.scope || "edge";
    const meta = $("u-search-meta");
    const wrap = $("u-results");
    wrap.innerHTML = "";
    $("u-query").value = ev.text || $("u-query").value;

    let warn = "";
    if (ev.cloud_error) {
      warn = scope === "cloud"
        ? `<span class="warn">☁ The cloud can't be reached right now. Switch to “This device”, which works offline.</span>`
        : `<span class="warn">☁ The cloud can't be reached, so these answers come from this device.</span> `;
    }
    if (!objects.length && !moments.length) {
      meta.innerHTML = warn;
      wrap.innerHTML = `<div class="u-empty"><div class="u-empty-ic">🤔</div><b>Nothing found yet</b>
        <small>It may not have seen that yet. Try different words, or wait for the video to show it.</small></div>`;
      return;
    }
    const ms = scope === "cloud" && ev.cloud_latency_us != null ? ev.cloud_latency_us / 1000 : ev.latency_us / 1000;
    if (scope !== "cloud") $("u-s-speed").textContent = ms < 1 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`;
    const weak = objects.length === 0 || objects.every((o) => o.weak);
    const where = { edge: "on this device", cloud: "in the cloud", both: "on the device and in the cloud" }[scope];
    meta.innerHTML = warn + `Found <b>${objects.length || moments.length}</b> ${where} in <b>${ms.toFixed(ms < 1 ? 2 : 1)} ms</b>`
      + (weak ? ` · <span class="warn">not a strong match, it may not have seen this yet</span>` : "");

    objects.slice(0, 8).forEach((o, i) => {
      const src = o.source || "edge";
      const label = o.weak ? ["weak", "Weak match"] : i === 0 ? ["best", "Best match"] : ["good", "Good match"];
      const loc = src === "cloud"
        ? `From ${escapeHtml(o.device || "another device")} · in the cloud`
        : `Seen at ${fmt(o.t_first)} · ${src === "both" ? "on device + cloud" : "on this device"}`;
      const card = document.createElement("div");
      card.className = "u-res" + (o.weak ? " weak" : "");
      card.style.animationDelay = `${i * 60}ms`;
      card.innerHTML =
        `<div class="u-res-img"><img src="data:image/jpeg;base64,${o.thumb}" alt=""><span class="u-pill ${label[0]}">${label[1]}</span></div>
         <div class="u-res-body"><b>${escapeHtml(o.cls)}</b>
           ${o.caption ? `<p>${escapeHtml(o.caption)}</p>` : ""}
           ${o.note ? `<span class="u-note">✎ ${escapeHtml(o.note)}</span>` : ""}
           <small>${loc}</small></div>`;
      card.addEventListener("click", () => {
        if (src !== "cloud" && state.inventory[o.obj]) { openInspector(o.obj); return; }
        showZoomRaw(o.thumb, `<b>${escapeHtml(o.cls)}</b>${o.caption ? `<br>“${escapeHtml(o.caption)}”` : ""}`
          + (o.note ? `<br>✎ ${escapeHtml(o.note)}` : "") + `<br>${loc}`);
      });
      wrap.appendChild(card);
    });

    if (moments.length) {
      const head = document.createElement("div");
      head.className = "u-moments-title";
      head.textContent = "Moments in the video";
      wrap.appendChild(head);
      moments.slice(0, 4).forEach((m, i) => {
        const card = document.createElement("div");
        card.className = "u-res";
        card.style.animationDelay = `${(objects.length + i) * 60}ms`;
        card.innerHTML = `<div class="u-res-img"><img src="data:image/jpeg;base64,${m.thumb}" alt=""></div>
          <div class="u-res-body"><b>Scene at ${fmt(m.video_ts)}</b><small>A full snapshot from the video</small></div>`;
        card.addEventListener("click", () => showZoomRaw(m.thumb, `Snapshot at ${fmt(m.video_ts)}`));
        wrap.appendChild(card);
      });
    }
  }

  /* ---------------------------------------------------------- timeline */
  const OBJ = "(OBJ-\\d+)";
  const RULES = [
    [new RegExp(`^${OBJ} (.+?) → Edge · kept on device \\(privacy`), (m) => ["🔒", `Remembered a ${m[2]}, kept private on this device`, "info", "remember"]],
    [new RegExp(`^${OBJ} (.+?) → Edge · kept on device`), (m) => ["❖", `Remembered a ${m[2]} (device only)`, "dim", "remember"]],
    [new RegExp(`^${OBJ} (.+?) → Edge ✓ · offline`), (m) => ["💾", `Remembered a ${m[2]}, will upload when back online`, "info", "remember"]],
    [new RegExp(`^${OBJ} (.+?) → Edge`), (m) => ["❖", `Remembered a ${m[2]}`, "dim", "remember"]],
    [/Network unavailable/, () => ["📴", "Internet lost. Everything still works on the device", "warn", null, true]],
    [/Network restored/, () => ["🌐", "Back online. Uploading saved memories", "ok", null]],
    [/(\d+) changes? waiting in the sync queue/, (m) => ["⏳", `${m[1]} change${m[1] === "1" ? "" : "s"} waiting to upload`, "info"]],
    [/Synchronizing (\d+)/, (m) => ["⇡", `Uploading ${m[1]} saved memor${m[1] === "1" ? "y" : "ies"} to the cloud`, "info"]],
    [/Synchronization complete/, () => ["✅", "All memories are backed up", "ok", null, true]],
    [/^↑ (\d+) synced → cloud · (.+)$/, (m) => ["☁", `Backed up: ${names(m[2])}`, "ok"]],
    [/removed from cloud/, () => ["☁", "Removed from the cloud backup", "info"]],
    [new RegExp(`CONFLICT · ${OBJ}`), (m) => ["⚖", `Two different notes for the ${clsOf(m[1])}. Your decision is needed`, "conflict"]],
    [new RegExp(`Conflict resolved · ${OBJ} / \\w+ → “(.*)”`), (m) => ["✅", `Kept “${m[2]}” for the ${clsOf(m[1])}`, "ok", null, true]],
    [new RegExp(`HQ console (?:edited|set) ${OBJ}.*“(.*)”`), (m) => ["🏢", `HQ wrote a note on the ${clsOf(m[1])}: “${m[2]}”`, "info", null, true]],
    [new RegExp(`${OBJ} updated from cloud`), (m) => ["⇣", `Got an update from HQ for the ${clsOf(m[1])}`, "info"]],
    [new RegExp(`${OBJ} merged cloud edit`), (m) => ["🤝", `Combined HQ's change with yours for the ${clsOf(m[1])}`, "ok"]],
    [new RegExp(`✎ ${OBJ} .*edited on device`), (m) => ["✏️", `You updated the ${clsOf(m[1])}`, "info"]],
    [new RegExp(`🗑 ${OBJ} forgotten`), (m) => ["🗑", `Forgot the ${clsOf(m[1])}`, "warn"]],
    [new RegExp(`${OBJ} (shared|retracted|kept on device|.*) by operator`), (m) => ["🔁", `You changed where the ${clsOf(m[1])} is stored`, "info"]],
    [/Cloud memory (online|reachable)/, () => ["☁", "Connected to the cloud backup", "ok"]],
    [/Cloud (unreachable|memory unavailable)/, () => ["☁", "Cloud backup not reachable. Saving on the device", "warn"]],
    [/Mission .* initialized/, () => ["▶", "Started watching a new video with a fresh memory", "info"]],
    [/New video added/, (m, t) => ["🎞", t.replace(/^🎞\s*/, ""), "ok", null, true]],
    [/Privacy rule (on|off|ON|OFF)/, (m) => ["🔒", `Privacy rule turned ${m[1].toLowerCase()}`, "info"]],
    [/Conflict policy → (.*)/, (m) => ["⚙", `Conflicts: ${m[1]}`, "info"]],
    [/^Link /, () => null],
    [/Manual sync requested/, () => ["↻", "Syncing now", "info"]],
    [/Sync requested but the device is offline/, () => ["📴", "Can't sync while offline. Changes stay saved", "warn"]],
  ];
  function names(list) {
    const parts = list.split(/,\s*/).map((l) => clsOf(l.trim().split(/\s+/)[0]));
    return parts.length > 4 ? `${parts.slice(0, 4).join(", ")} +${parts.length - 4} more` : parts.join(", ");
  }

  function addTimeline(ev) {
    const wrap = $("u-timeline");
    if (wrap.querySelector(`[data-id="${ev.id}"]`)) return;
    let out = null;
    for (const [re, fn] of RULES) {
      const m = ev.text.match(re);
      if (m) { out = fn(m, ev.text); break; }
    }
    if (out === null && RULES.some(([re]) => re.test(ev.text))) return;
    if (!out) out = ["•", ev.text.replace(/^[^\w“]+/, ""), ev.level];
    const [icon, text, level, kind, bell] = out;
    if (bell) notify(icon, text);
    // Routine lines (remembered / backed up) interleave, so fold into the
    // matching row if it is among the newest few.
    const recentOf = (k) => [...wrap.children].slice(0, 3).find((x) => x.dataset.kind === k && x.dataset.level !== "info");
    if (ev.level === "dim" && /synced → cloud/.test(ev.text)) {
      const top = recentOf("backup");
      if (top) {
        top._n = (top._n || 1) + 1;
        top.querySelector(".u-ev-text").innerHTML = `Backed up new memories to the cloud<small>${top._n} uploads · latest: ${escapeHtml(text.replace("Backed up: ", ""))}</small>`;
        top.querySelector(".u-ev-time").textContent = clock(ev.ts);
        return;
      }
      return pushEv(wrap, ev, "☁", "Backed up new memories to the cloud", "ok", "backup", text.replace("Backed up: ", ""));
    }
    if (kind === "remember") {
      const name = text.replace(/^Remembered an? /, "").replace(/[,(].*$/, "").trim();
      const top = level === "dim" ? recentOf("remember") : null;
      if (top) {
        top._names = top._names || [];
        top._names.push(name);
        const n = top._names.length;
        const shown = top._names.slice(-3).join(", ");
        top.querySelector(".u-ev-text").innerHTML = `Remembered ${n} new things<small>${escapeHtml(shown)}${n > 3 ? "…" : ""}</small>`;
        top.querySelector(".u-ev-time").textContent = clock(ev.ts);
        return;
      }
      const el = pushEv(wrap, ev, icon, text, level, "remember");
      el._names = [name];
      return;
    }
    pushEv(wrap, ev, icon, text, level, kind);
  }

  function pushEv(wrap, ev, icon, text, level, kind, sub) {
    wrap.querySelectorAll(".u-empty-sm").forEach((x) => x.remove());
    const el = document.createElement("div");
    el.className = `u-ev ${level || "info"}`;
    el.dataset.id = ev.id;
    el.dataset.kind = kind || "";
    el.dataset.level = level || "";
    el.innerHTML = `<span class="u-ev-ic">${icon}</span>
      <div class="u-ev-text">${escapeHtml(text)}${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</div>
      <span class="u-ev-time">${clock(ev.ts)}</span>`;
    wrap.prepend(el);
    while (wrap.children.length > 60) wrap.lastChild.remove();
    return el;
  }

  /* ------------------------------------------------------ notifications */
  function notify(icon, text, sub) {
    U.bell.unshift({ icon, text, sub, at: new Date() });
    U.bell = U.bell.slice(0, 20);
    if ($("u-bell-menu").classList.contains("hidden")) U.unread++;
    renderBell();
  }
  function renderBell() {
    const cnt = $("u-bell-count");
    cnt.textContent = U.unread > 9 ? "9+" : U.unread;
    cnt.classList.toggle("hidden", U.unread === 0);
    const list = $("u-bell-list");
    list.innerHTML = U.bell.length ? "" : `<div class="u-empty-sm">Nothing yet</div>`;
    U.bell.forEach((b) => {
      const d = document.createElement("div");
      d.className = "u-bell-item";
      d.innerHTML = `<span>${b.icon}</span><div>${escapeHtml(b.text)}<small>${b.sub ? escapeHtml(b.sub) + " · " : ""}${b.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div>`;
      list.appendChild(d);
    });
  }
  $("u-bell").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("u-bell-menu");
    menu.classList.toggle("hidden");
    U.unread = 0;
    renderBell();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".u-bell-wrap")) $("u-bell-menu").classList.add("hidden");
    if (!e.target.closest(".u-dd")) dd.querySelector(".u-dd-menu").classList.add("hidden");
  });

  /* --------------------------------------------------------- navigation */
  const SECTIONS = ["u-overview", "u-camera", "u-memory", "u-search", "u-activity"];
  function goTo(id) {
    const el = $(id);
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - 20;
    window.scrollTo({ top: y, behavior: "smooth" });
    el.animate([{ boxShadow: "0 0 0 0 rgba(217,242,79,0)" }, { boxShadow: "0 0 0 6px rgba(217,242,79,.8)" },
      { boxShadow: "0 0 0 0 rgba(217,242,79,0)" }], { duration: 1100, delay: 250 });
  }
  document.querySelectorAll("[data-target]").forEach((b) => b.addEventListener("click", () => goTo(b.dataset.target)));
  window.addEventListener("scroll", () => {
    if (U.mode !== "user") return;
    let cur = SECTIONS[0];
    for (const id of SECTIONS) if ($(id).getBoundingClientRect().top < 160) cur = id;
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) cur = "u-activity";
    document.querySelectorAll("[data-target]").forEach((b) => b.classList.toggle("on", b.dataset.target === cur));
  }, { passive: true });

  /* ------------------------------------------------------------- tiles */
  document.querySelectorAll(".u-tile").forEach((tile) => tile.addEventListener("click", () => {
    const go = tile.dataset.go;
    if (go === "cloud") { setScope("cloud"); goTo("u-search"); $("u-query").focus({ preventScroll: true }); }
    else if (go === "sync") { send({ cmd: "sync_now" }); toast(state.sync && !state.sync.online ? "You're offline. Changes will upload when you reconnect" : "Syncing now…"); }
    else if (go === "conflict") { if (U.conflicts.length) openConflict(true); else toast("Nothing to decide right now 👍"); }
    else goTo(go);
  }));

  /* -------------------------------------------------------- connection */
  function toggleNet() { send({ cmd: "net", online: !(state.sync ? state.sync.online : true) }); }
  $("u-net-switch").addEventListener("click", toggleNet);
  $("u-net-btn").addEventListener("click", toggleNet);
  $("u-sync-now").addEventListener("click", () => send({ cmd: "sync_now" }));
  $("u-try-conflict").addEventListener("click", () => {
    send({ cmd: "stage_conflict" });
    toast(state.sync && state.sync.online
      ? "Simulated: HQ and this device wrote different notes. Watch for the question!"
      : "Simulated while offline. Go online to see the conflict");
  });

  /* ------------------------------------------------------------ camera */
  $("u-play-big").addEventListener("click", () => {
    if (U.serverRunning && !U.running) startVideoById(state.videoId, true);
    else requestStart();
  });
  $("u-replay").addEventListener("click", () => startVideoById(state.videoId, true));
  $("u-change-video").addEventListener("click", openUpload);
  $("u-upload-cta").addEventListener("click", openUpload);
  function teach() {
    const text = $("u-teach").value.trim();
    if (!text) return;
    send({ cmd: "label", text });
    $("u-teach").value = "";
  }
  $("u-teach").addEventListener("keydown", (e) => { if (e.key === "Enter") teach(); });
  $("u-teach-btn").addEventListener("click", teach);

  /* ------------------------------------------------------------ modals */
  function openModal(id) { $(id).classList.remove("hidden"); }
  function closeModal(id) { $(id).classList.add("hidden"); }
  document.querySelectorAll(".u-modal").forEach((m) => {
    m.addEventListener("click", (e) => {
      if (e.target === m || e.target.closest("[data-close]")) {
        if (m.id === "conflict-modal" && U.cmCurrent) U.dismissed.add(U.cmCurrent.id);
        closeModal(m.id);
      }
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document.querySelectorAll(".u-modal:not(.hidden)").forEach((m) => {
      if (m.id === "conflict-modal" && U.cmCurrent) U.dismissed.add(U.cmCurrent.id);
      closeModal(m.id);
    });
  });
  $("u-help-btn").addEventListener("click", () => openModal("help-modal"));

  /* conflict chooser */
  function openConflict(explicit) {
    const list = U.conflicts.filter((c) => explicit || !U.dismissed.has(c.id));
    const c = list[0];
    if (!c) { closeModal("conflict-modal"); return; }
    U.cmCurrent = c;
    const inv = state.inventory[c.label];
    $("cm-img").src = inv ? `data:image/jpeg;base64,${inv.thumb}` : "";
    $("cm-img").style.visibility = inv ? "visible" : "hidden";
    $("cm-cls").textContent = inv ? inv.cls : c.label;
    $("cm-edge-v").textContent = c.edge_value ? `“${c.edge_value}”` : "(no note)";
    $("cm-cloud-v").textContent = c.cloud_value ? `“${c.cloud_value}”` : "(no note)";
    $("cm-edge-t").textContent = `Written at ${clock(c.edge_ts)}`;
    $("cm-cloud-t").textContent = `Written at ${clock(c.cloud_ts)} by HQ`;
    document.querySelectorAll(".cm-opt").forEach((o) => {
      const sug = o.dataset.choice === c.suggested;
      o.classList.toggle("suggested", sug);
      o.querySelector(".cm-badge").classList.toggle("hidden", !sug);
    });
    $("cm-more").textContent = U.conflicts.length > 1 ? `${U.conflicts.length - 1} more after this` : "";
    $("cm-body").classList.remove("hidden");
    $("cm-done").classList.add("hidden");
    openModal("conflict-modal");
  }
  function choose(choice) {
    const c = U.cmCurrent;
    if (!c) return;
    send({ cmd: "resolve", id: c.id, choice });
    U.dismissed.add(c.id);
    $("cm-body").classList.add("hidden");
    $("cm-done").classList.remove("hidden");
    setTimeout(nextConflictOrClose, 1300);
  }
  function nextConflictOrClose() {
    const rest = U.conflicts.filter((x) => !U.dismissed.has(x.id) && (!U.cmCurrent || x.id !== U.cmCurrent.id));
    U.cmCurrent = null;
    if (rest.length) openConflict();
    else closeModal("conflict-modal");
  }
  document.querySelectorAll(".cm-opt").forEach((o) => o.addEventListener("click", () => choose(o.dataset.choice)));
  $("cm-latest").addEventListener("click", () => choose("latest"));

  /* upload + video picker */
  function openUpload() {
    openModal("upload-modal");
    U.selVideo = state.videoId;
    $("up-progress").classList.add("hidden");
    loadVideos();
  }
  async function loadVideos() {
    try {
      const r = await fetch("/api/videos");
      const data = await r.json();
      U.videos = data.videos || [];
      U.serverRunning = data.running;
      U.currentVideo = data.current;
      renderVideos();
    } catch {
      $("video-list").innerHTML = `<div class="u-empty-sm">Couldn't load the list of videos.</div>`;
    }
  }
  function durText(s) {
    if (!s) return "";
    return s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`;
  }
  function renderVideos() {
    const wrap = $("video-list");
    wrap.innerHTML = "";
    U.videos.forEach((v, i) => {
      const playing = U.currentVideo === v.id && U.running;
      const item = document.createElement("div");
      item.className = "vid-item" + (U.selVideo === v.id ? " sel" : "");
      item.style.animationDelay = `${i * 40}ms`;
      const when = v.builtin ? "Built-in demo" : `Uploaded ${new Date(v.created * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
      item.innerHTML = `<span class="vid-ic">${v.builtin ? "★" : "🎞"}</span>
        <div><b>${escapeHtml(v.name)}</b><small>${durText(v.duration)} · ${when}</small></div>
        ${playing ? `<span class="vid-tag playing">Playing</span>` : `<span></span>`}
        ${v.builtin ? `<span></span>` : `<button class="vid-del" title="Delete this video">×</button>`}`;
      item.addEventListener("click", (e) => {
        if (e.target.closest(".vid-del")) return;
        U.selVideo = v.id;
        renderVideos();
      });
      const del = item.querySelector(".vid-del");
      if (del) del.addEventListener("click", async () => {
        if (!confirm(`Delete “${v.name}” from this device?`)) return;
        const r = await fetch(`/api/videos/${v.id}`, { method: "DELETE" });
        if (!r.ok) { toast((await r.json()).detail || "Couldn't delete the video"); return; }
        if (U.selVideo === v.id) U.selVideo = "mission";
        if (state.videoId === v.id) { state.videoId = "mission"; localStorage.setItem("edgemind-video", "mission"); }
        loadVideos();
      });
      wrap.appendChild(item);
    });
    const sel = U.videos.find((v) => v.id === U.selVideo);
    const btn = $("up-start");
    btn.disabled = !sel;
    btn.textContent = sel && U.running && U.currentVideo === sel.id ? "⟳ Restart this video" : "▶ Start watching";
  }
  $("up-start").addEventListener("click", () => {
    if (!U.selVideo) return;
    const v = U.videos.find((x) => x.id === U.selVideo);
    $("ta-video-name").textContent = v ? v.name : "video";
    closeModal("upload-modal");
    startVideoById(U.selVideo, true);
    if (U.mode === "user") window.scrollTo({ top: 0, behavior: "smooth" });
  });

  const dz = $("drop-zone");
  const fileInput = $("file-input");
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); fileInput.value = ""; });
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) uploadFile(f); });
  // a file dropped anywhere on the page opens the uploader
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.target.closest && e.target.closest("#drop-zone")) return;
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) { openUpload(); uploadFile(f); }
  });

  function uploadFile(file) {
    const okType = (file.type || "").startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi|mpe?g|3gp)$/i.test(file.name);
    const prog = $("up-progress"), bar = $("up-bar"), barWrap = bar.parentElement, status = $("up-status");
    prog.classList.remove("hidden");
    barWrap.className = "up-bar";
    status.className = "";
    $("up-name").textContent = file.name;
    $("up-pct").textContent = "";
    bar.style.width = "0";
    if (!okType) { status.textContent = "That doesn't look like a video file. Try an MP4 or MOV."; status.className = "err"; return; }
    if (file.size > 1024 * 1024 * 1024) { status.textContent = "That video is bigger than 1 GB. Please pick a shorter one."; status.className = "err"; return; }

    const form = new FormData();
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/videos");
    status.textContent = "Uploading…";
    $("up-start").disabled = true;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      bar.style.width = `${pct}%`;
      $("up-pct").textContent = `${pct}%`;
    };
    xhr.upload.onload = () => {
      barWrap.classList.add("indet");
      $("up-pct").textContent = "";
      status.textContent = "Preparing the video so the device can watch it smoothly…";
    };
    xhr.onload = () => {
      barWrap.classList.remove("indet");
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* keep {} */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.video) {
        barWrap.classList.add("done");
        $("up-pct").textContent = "✓";
        status.textContent = `Ready! “${data.video.name}” (${durText(data.video.duration)}) is selected below.`;
        U.selVideo = data.video.id;
        loadVideos();
      } else {
        status.textContent = `Upload failed: ${data.detail || xhr.statusText || "unknown error"}`;
        status.className = "err";
        renderVideos();
      }
    };
    xhr.onerror = () => { barWrap.classList.remove("indet"); status.textContent = "Upload failed: the connection was lost."; status.className = "err"; };
    xhr.send(form);
  }

  /* ---------------------------------------------- friendlier inspector */
  function friendlyInspector(r) {
    if (U.mode !== "user") return;
    const pill = $("ins-status");
    if (pill) pill.textContent = STATUS_TEXT[r.status] || pill.textContent;
    const label = document.querySelector(".ins-label");
    if (label) label.innerHTML = `Your note <span>(saved on the device first, uploaded when online)</span>`;
    $("ins-forget").textContent = "🗑 Forget this";
    $("ins-save").textContent = "Save";
  }

  /* -------------------------------------------------------------- init */
  async function init() {
    try {
      const data = await (await fetch("/api/videos")).json();
      U.videos = data.videos || [];
      U.currentVideo = data.current;
      if (!U.videos.some((v) => v.id === state.videoId)) {
        state.videoId = "mission";
        localStorage.setItem("edgemind-video", "mission");
      }
      const v = U.videos.find((x) => x.id === state.videoId);
      if (v) {
        $("ta-video-name").textContent = v.builtin ? "demo video" : `“${v.name}”`;
        $("u-video-name").textContent = v.name;
      }
    } catch { /* server not ready yet; defaults are fine */ }
  }
  renderChips();
  setScope(state.scope || "edge");
  setMode(U.mode);
  init();
})();
