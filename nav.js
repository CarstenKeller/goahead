/* GoAhead – Unterwegs: eine geplante Route abgehen und die gewanderte Strecke aufzeichnen.
 *
 * - „Los geht's“ (Tracks → Geplant) startet den Navigationsmodus: geplante Route,
 *   eigene Position (Folgemodus) und die gewanderte Strecke werden angezeigt.
 * - Pause / Weiter / Beenden. Nach dem Beenden landet die Aufzeichnung unter
 *   Tracks → Erwandert (IndexedDB, Speicher "walks").
 * - Der Zwischenstand wird laufend lokal gesichert; nach einem Neuladen der Seite
 *   geht es pausiert weiter.
 *
 * Grenze von Web-Apps: Aufgezeichnet wird nur, solange die App sichtbar ist. Die App
 * hält deshalb den Bildschirm an (Screen Wake Lock), wo der Browser das unterstützt.
 */
(function () {
  "use strict";

  var G = window.GOAHEAD;
  if (!G || !G.map) return;
  var map = G.map;
  var esc = G.escapeHtml;

  var WALK_KEY = "goahead.walk.v1";
  var COLOR_PLAN = "#c2255c";
  var COLOR_WALK = "#1971c2";
  var MAX_ACCURACY = 50;   // ungenauere Positionen (m) werden nicht aufgezeichnet
  var MIN_STEP = 5;        // Mindestabstand (m) zwischen zwei aufgezeichneten Punkten

  var walk = null;         // laufende Tour
  var active = false;

  // ---------- Hilfen ----------

  function km(m) { return (m / 1000).toFixed(2).replace(".", ",") + " km"; }

  function duration(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return h + ":" + (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function lineLength(latlngs) {
    var d = 0;
    for (var i = 1; i < latlngs.length; i++) d += L.latLng(latlngs[i - 1][0], latlngs[i - 1][1]).distanceTo(L.latLng(latlngs[i][0], latlngs[i][1]));
    return d;
  }

  function movingTime(w) {
    var end = w.paused ? w.pausedAt : Date.now();
    return end - w.startedAt - (w.pausedTotal || 0);
  }

  function saveWalk() {
    try {
      if (walk) {
        walk.savedAt = Date.now();
        window.localStorage.setItem(WALK_KEY, JSON.stringify(walk));
      }
      else window.localStorage.removeItem(WALK_KEY);
    } catch (e) { /* Speicher voll – Aufzeichnung läuft im Speicher weiter */ }
  }

  // ---------- Bildschirm anlassen (Screen Wake Lock) ----------

  var wakeLock = null;
  var wakeLockOk = null;   // null = unbekannt, true/false nach dem ersten Versuch

  function requestWakeLock() {
    if (!("wakeLock" in navigator)) { wakeLockOk = false; renderPanel(); return; }
    navigator.wakeLock.request("screen").then(function (lock) {
      wakeLock = lock;
      wakeLockOk = true;
      lock.addEventListener("release", function () { wakeLock = null; });
      renderPanel();
    }).catch(function () { wakeLockOk = false; renderPanel(); });
  }

  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }

  // Beim Zurückkehren in die App wird die Sperre vom Browser aufgehoben – neu anfordern
  document.addEventListener("visibilitychange", function () {
    if (active && !document.hidden && !wakeLock) requestWakeLock();
  });

  // ---------- Karte ----------

  var layer = L.layerGroup();
  var planLayer = L.layerGroup().addTo(layer);
  var walkLayer = L.layerGroup().addTo(layer);
  var currentLine = null;

  function drawPlan() {
    planLayer.clearLayers();
    if (!walk || !walk.planLine || walk.planLine.length < 2) return;
    L.polyline(walk.planLine, { color: "#ffffff", weight: 9, opacity: 0.8, interactive: false }).addTo(planLayer);
    L.polyline(walk.planLine, { color: COLOR_PLAN, weight: 5, opacity: 0.75, interactive: false }).addTo(planLayer);
    var s = walk.planLine[0];
    L.circleMarker(s, { radius: 7, color: "#ffffff", weight: 2, fillColor: "#2f9e44", fillOpacity: 1, interactive: false }).addTo(planLayer);
  }

  function walkPolyline(latlngs) {
    L.polyline(latlngs, { color: "#ffffff", weight: 8, opacity: 0.9, interactive: false }).addTo(walkLayer);
    return L.polyline(latlngs, { color: COLOR_WALK, weight: 5, opacity: 1, interactive: false }).addTo(walkLayer);
  }

  function drawWalk() {
    walkLayer.clearLayers();
    currentLine = null;
    if (!walk) return;
    walk.segments.forEach(function (seg, i) {
      var line = walkPolyline(seg.map(function (p) { return [p[0], p[1]]; }));
      if (i === walk.segments.length - 1) currentLine = line;
    });
  }

  // ---------- Aufzeichnung ----------

  G.onPosition(function (pos) {
    if (!active || !walk || walk.paused) return;
    var c = pos.coords;
    walk.lastFix = Date.now();
    if (c.accuracy > MAX_ACCURACY) { walk.weak = true; renderPanel(); return; }
    walk.weak = false;
    var seg = walk.segments[walk.segments.length - 1];
    var p = [Math.round(c.latitude * 1e6) / 1e6, Math.round(c.longitude * 1e6) / 1e6,
      c.altitude != null ? Math.round(c.altitude * 10) / 10 : null, pos.timestamp || Date.now()];
    if (seg.length) {
      var last = seg[seg.length - 1];
      var d = L.latLng(last[0], last[1]).distanceTo(L.latLng(p[0], p[1]));
      if (d < MIN_STEP) return;
      walk.distance += d;
    }
    seg.push(p);
    if (currentLine) {
      currentLine.addLatLng([p[0], p[1]]);
      // weiße Kontur mitführen
      var layers = walkLayer.getLayers();
      var casing = layers[layers.length - 2];
      if (casing && casing.addLatLng) casing.addLatLng([p[0], p[1]]);
    }
    saveWalk();
    renderPanel();
  });

  // ---------- Feld „Unterwegs“ ----------

  var panel = document.createElement("section");
  panel.id = "nav-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Unterwegs");
  panel.innerHTML =
    '<div class="nav-head sheet-handle">' +
      '<span class="sheet-grip" aria-hidden="true"></span>' +
      '<span class="nav-title"></span>' +
    "</div>" +
    '<div class="nav-stats">' +
      '<div><span class="nav-val nav-dist">0,00 km</span><span class="nav-lbl">gewandert</span></div>' +
      '<div><span class="nav-val nav-time">0:00:00</span><span class="nav-lbl">unterwegs</span></div>' +
      '<div><span class="nav-val nav-plan">–</span><span class="nav-lbl">geplant</span></div>' +
    "</div>" +
    '<p class="nav-state"></p>' +
    '<div class="nav-actions">' +
      '<button type="button" class="nav-pause">⏸ Pause</button>' +
      '<button type="button" class="nav-center">◎ Position</button>' +
      '<button type="button" class="nav-end">■ Beenden</button>' +
    "</div>";
  document.body.appendChild(panel);
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);
  G.makeResizable(panel, panel.querySelector(".nav-head"), "goahead.navHeight.v1", function (h) {
    document.documentElement.style.setProperty("--nav-h", h + "px");
  });

  var el = {
    title: panel.querySelector(".nav-title"),
    dist: panel.querySelector(".nav-dist"),
    time: panel.querySelector(".nav-time"),
    plan: panel.querySelector(".nav-plan"),
    state: panel.querySelector(".nav-state"),
    pause: panel.querySelector(".nav-pause")
  };

  el.pause.addEventListener("click", function () {
    if (!walk) return;
    if (walk.paused) resume(); else pause();
  });
  panel.querySelector(".nav-center").addEventListener("click", function () { G.follow(); });
  panel.querySelector(".nav-end").addEventListener("click", askEnd);

  function renderPanel() {
    if (!walk) return;
    el.title.textContent = "Unterwegs: " + walk.routeName;
    el.dist.textContent = km(walk.distance);
    el.time.textContent = duration(movingTime(walk));
    el.plan.textContent = walk.planLength ? km(walk.planLength) : "–";
    el.pause.textContent = walk.paused ? "▶ Weiter" : "⏸ Pause";
    el.pause.classList.toggle("on", walk.paused);
    var msg;
    if (walk.paused) msg = walk.interrupted
      ? "Pausiert – die Seite wurde neu geladen. Mit „Weiter“ geht die Aufzeichnung weiter."
      : "Pausiert – es wird nichts aufgezeichnet.";
    else if (!walk.lastFix) msg = "Aufzeichnung läuft – warte auf GPS …";
    else if (walk.weak) msg = "Aufzeichnung läuft – GPS gerade zu ungenau, Punkte werden übersprungen.";
    else msg = "Aufzeichnung läuft.";
    if (!walk.paused && wakeLockOk === true) msg += " Der Bildschirm bleibt an.";
    if (!walk.paused && wakeLockOk === false) msg += " Hinweis: Bildschirm nicht ausschalten und die App nicht verlassen – sonst stoppt die Aufzeichnung.";
    el.state.textContent = msg;
    if (!panel.hidden) document.documentElement.style.setProperty("--nav-h", panel.offsetHeight + "px");
  }

  var ticker = null;

  // ---------- Ablauf ----------

  function enter() {
    active = true;
    if (G.closeTracksPage) G.closeTracksPage();
    if (G.closeMenu) G.closeMenu();
    if (G.closeInfoPanel) G.closeInfoPanel();
    if (G.planner && G.planner.isActive()) G.planner.stop();
    document.body.classList.add("mode-nav");
    panel.hidden = false;
    layer.addTo(map);
    drawPlan();
    drawWalk();
    clearInterval(ticker);
    ticker = setInterval(function () { if (walk && !walk.paused) el.time.textContent = duration(movingTime(walk)); }, 1000);
    renderPanel();
  }

  function start(rec) {
    if (active && walk) {
      G.showStatus("Es läuft bereits eine Tour. Bitte zuerst beenden.", 5000);
      enter();
      return;
    }
    var line = G.planner ? G.planner.routeLine(rec) : [];
    walk = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      routeId: rec.id,
      routeName: rec.name,
      planLine: line,
      planLength: (rec.stats && rec.stats.length) || lineLength(line),
      startedAt: Date.now(),
      paused: false,
      pausedAt: null,
      pausedTotal: 0,
      segments: [[]],
      distance: 0,
      lastFix: null
    };
    saveWalk();
    enter();
    if (line.length > 1) map.fitBounds(L.latLngBounds(line), { padding: [30, 30], maxZoom: 16 });
    // dann auf die eigene Position und ihr folgen
    setTimeout(function () { G.follow(); }, 600);
    requestWakeLock();
  }

  function pause() {
    walk.paused = true;
    walk.pausedAt = Date.now();
    saveWalk();
    renderPanel();
  }

  function resume() {
    walk.pausedTotal = (walk.pausedTotal || 0) + (Date.now() - (walk.pausedAt || Date.now()));
    walk.paused = false;
    walk.pausedAt = null;
    walk.interrupted = false;
    walk.lastFix = null;
    // neues Teilstück, damit die Pause nicht als gerade Linie überbrückt wird
    if (walk.segments[walk.segments.length - 1].length) walk.segments.push([]);
    saveWalk();
    drawWalk();
    renderPanel();
    G.follow();
    requestWakeLock();
  }

  function askEnd() {
    if (!walk) return;
    if (!walk.paused) pause();
    var pts = walk.segments.reduce(function (n, s) { return n + s.length; }, 0);
    G.actionSheet("Tour beenden?", km(walk.distance) + " · " + duration(movingTime(walk)) + " · " + pts + " Punkte", [
      { label: "✓ Beenden und unter „Erwandert“ speichern", primary: true, onClick: finish },
      { label: "▶ Weiterwandern", onClick: resume },
      { label: "Aufzeichnung verwerfen", danger: true, onClick: function () {
        G.actionSheet("Aufzeichnung wirklich verwerfen?", "Die gewanderte Strecke geht verloren.", [
          { label: "Verwerfen", danger: true, onClick: function () { leave(); G.showStatus("Aufzeichnung verworfen.", 3000); } }
        ]);
      } }
    ]);
  }

  function finish() {
    var segs = walk.segments.filter(function (s) { return s.length > 1; });
    if (!segs.length) {
      G.actionSheet("Keine Strecke aufgezeichnet", "Es liegen weniger als zwei GPS-Punkte vor. Trotzdem beenden?", [
        { label: "Beenden ohne Speichern", danger: true, onClick: leave },
        { label: "▶ Weiterwandern", onClick: resume }
      ]);
      return;
    }
    var ascent = 0;
    segs.forEach(function (s) {
      for (var i = 1; i < s.length; i++) {
        if (s[i][2] != null && s[i - 1][2] != null && s[i][2] > s[i - 1][2]) ascent += s[i][2] - s[i - 1][2];
      }
    });
    var rec = {
      id: walk.id,
      name: walk.routeName + " – " + new Date(walk.startedAt).toLocaleDateString("de-DE"),
      routeId: walk.routeId,
      routeName: walk.routeName,
      startedAt: new Date(walk.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      movingMs: movingTime(walk),
      distance: walk.distance,
      ascent: ascent || null,
      segments: segs
    };
    if (!G.db) {
      G.showStatus("Lokaler Speicher nicht verfügbar – Aufzeichnung kann nicht gespeichert werden.", 8000);
      return;
    }
    G.db.put("walks", rec).then(function () {
      leave();
      loadWalks();
      G.showStatus("Tour unter „Erwandert“ gespeichert: " + km(rec.distance) + ".", 5000);
    }).catch(function (err) {
      // Aufzeichnung NICHT verwerfen: Sie bleibt als laufende Tour erhalten
      G.showStatus("Speichern fehlgeschlagen: " + err.message + " Die Aufzeichnung bleibt erhalten.", 10000);
    });
  }

  function leave() {
    active = false;
    walk = null;
    saveWalk();
    clearInterval(ticker);
    releaseWakeLock();
    document.body.classList.remove("mode-nav");
    panel.hidden = true;
    map.removeLayer(layer);
  }

  // ---------- Liste „Erwandert“ ----------

  var walks = [];
  var shown = {};   // id -> Kartenlayer der angezeigten Aufzeichnungen

  function loadWalks() {
    if (!G.db) return;
    G.db.all("walks").then(function (all) {
      walks = (all || []).sort(function (a, b) { return a.startedAt < b.startedAt ? 1 : -1; });
      renderWalks();
    }).catch(function (err) { console.warn("[GoAhead] Erwanderte Touren nicht lesbar:", err); });
  }

  function renderWalks() {
    var box = G.tracksPanel && G.tracksPanel("walked");
    if (!box) return;
    if (!walks.length) {
      box.innerHTML = '<p class="trk-empty">Noch keine erwanderten Touren. Eine geplante Route unter „Geplant“ antippen und „Los geht\'s“ wählen.</p>';
      return;
    }
    box.innerHTML = walks.map(function (w) {
      var info = [km(w.distance), duration(w.movingMs)];
      if (w.ascent) info.push("↑ ca. " + Math.round(w.ascent) + " m");
      info.push(new Date(w.startedAt).toLocaleDateString("de-DE"));
      return '<div class="trk-item trk-tap" role="button" tabindex="0" data-id="' + esc(w.id) + '">' +
        '<div class="trk-main"><span class="trk-swatch" style="background:' + COLOR_WALK + '"></span>' +
          '<span class="trk-text"><span class="trk-name">' + esc(w.name) + (shown[w.id] ? " 👁" : "") + "</span>" +
          '<span class="trk-info">' + esc(info.join(" · ")) + "</span></span>" +
        '</div><span class="trk-more" aria-hidden="true">›</span></div>';
    }).join("");
  }

  function findWalk(id) {
    for (var i = 0; i < walks.length; i++) if (walks[i].id === id) return walks[i];
    return null;
  }

  function showWalk(w) {
    if (!shown[w.id]) {
      var g = L.layerGroup();
      w.segments.forEach(function (s) {
        var ll = s.map(function (p) { return [p[0], p[1]]; });
        L.polyline(ll, { color: "#ffffff", weight: 8, opacity: 0.9, interactive: false }).addTo(g);
        L.polyline(ll, { color: COLOR_WALK, weight: 4, opacity: 1, interactive: false }).addTo(g);
      });
      shown[w.id] = g.addTo(map);
    }
    var all = [];
    w.segments.forEach(function (s) { s.forEach(function (p) { all.push([p[0], p[1]]); }); });
    if (G.stopFollowing) G.stopFollowing();
    if (G.closeTracksPage) G.closeTracksPage();
    map.fitBounds(L.latLngBounds(all), { padding: [30, 30], maxZoom: 17 });
    renderWalks();
  }

  function hideWalk(w) {
    if (shown[w.id]) { map.removeLayer(shown[w.id]); delete shown[w.id]; }
    renderWalks();
  }

  function walkToGpx(w) {
    var x = G.planner ? G.planner.xmlEsc : function (t) { return String(t); };
    var lines = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="GoAhead" xmlns="http://www.topografix.com/GPX/1/1">',
      "  <metadata><name>" + x(w.name) + "</name><time>" + w.startedAt + "</time></metadata>",
      "  <trk><name>" + x(w.name) + "</name>"];
    w.segments.forEach(function (s) {
      lines.push("    <trkseg>");
      s.forEach(function (p) {
        lines.push('      <trkpt lat="' + p[0] + '" lon="' + p[1] + '">' +
          (p[2] != null ? "<ele>" + p[2] + "</ele>" : "") +
          (p[3] ? "<time>" + new Date(p[3]).toISOString() + "</time>" : "") + "</trkpt>");
      });
      lines.push("    </trkseg>");
    });
    lines.push("  </trk>", "</gpx>");
    return lines.join("\n");
  }

  function walkMenu(w) {
    var sub = km(w.distance) + " · " + duration(w.movingMs) + " · " + new Date(w.startedAt).toLocaleString("de-DE");
    G.actionSheet(w.name, sub, [
      shown[w.id]
        ? { label: "Von der Karte entfernen", onClick: function () { hideWalk(w); } }
        : { label: "👁 Auf der Karte zeigen", primary: true, onClick: function () { showWalk(w); } },
      { label: "⬇ GPX exportieren", onClick: function () {
        var fn = G.planner ? G.planner.fileNameFor(w.name) : "tour.gpx";
        G.downloadFile(fn, walkToGpx(w), "application/gpx+xml");
      } },
      { label: "🗑 Löschen", danger: true, onClick: function () {
        G.actionSheet("„" + w.name + "“ löschen?", "Die Aufzeichnung wird vom Gerät gelöscht.", [
          { label: "Löschen", danger: true, onClick: function () {
            hideWalk(w);
            G.db.del("walks", w.id).then(loadWalks).catch(function (err) {
              G.showStatus("Löschen fehlgeschlagen: " + err.message, 6000);
            });
          } }
        ]);
      } }
    ]);
  }

  (function wireList() {
    var box = G.tracksPanel && G.tracksPanel("walked");
    if (!box) return;
    box.addEventListener("click", function (e) {
      var item = e.target.closest(".trk-item");
      var w = item && findWalk(item.getAttribute("data-id"));
      if (w) walkMenu(w);
    });
  })();

  // ---------- Start der App: laufende Tour wiederherstellen ----------

  try {
    var saved = JSON.parse(window.localStorage.getItem(WALK_KEY) || "null");
    if (saved && Array.isArray(saved.segments)) {
      walk = saved;
      if (!walk.paused) {
        // Seite wurde während der Aufzeichnung neu geladen: pausiert fortsetzen
        // Pause ab der letzten Sicherung, damit die Zeit ohne Aufzeichnung nicht mitzählt
        walk.paused = true;
        walk.pausedAt = walk.savedAt || Date.now();
        walk.interrupted = true;
      }
      saveWalk();
      enter();
    }
  } catch (e) { /* keine laufende Tour */ }

  loadWalks();

  G.nav = {
    start: start,
    isActive: function () { return active; },
    getWalk: function () { return walk; }
  };
})();
