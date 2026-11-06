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
 *
 * In der Android-App (android/, window.GoAheadNative) zeichnet stattdessen ein Vordergrunddienst
 * auf – auch bei ausgeschaltetem Bildschirm. Diese Seite holt die Punkte dort ab (pullNative),
 * sobald sie sichtbar ist, und alle paar Sekunden, solange sie sichtbar bleibt.
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
  var NATIVE = G.native;   // Android-App oder null

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

  // ---------- Art der Tour, Fahrt-Erkennung, Kürzen ----------

  function setting(k, d) { var v = G.getSettings()[k]; return typeof v === "number" ? v : d; }

  // alle Punkte einer Tour in Reihenfolge: [{s, i, p}] und kumulierte Strecke
  function flatten(segments) {
    var out = [];
    var cum = [];
    var d = 0;
    segments.forEach(function (seg, si) {
      seg.forEach(function (p, i) {
        if (i > 0) d += L.latLng(seg[i - 1][0], seg[i - 1][1]).distanceTo(L.latLng(p[0], p[1]));
        out.push({ s: si, i: i, p: p });
        cum.push(d);
      });
    });
    return { pts: out, cum: cum };
  }

  // Geschwindigkeit (km/h) je Punkt: Luftlinie zum spätesten Punkt, der mindestens WIN_S Sekunden zurückliegt.
  // Luftlinie statt Weglänge: ein einzelner GPS-Ausreißer (hin und zurück) hebt sich so auf.
  var WIN_S = 20;
  function windowSpeeds(f) {
    var v = [];
    var k = 0;
    for (var i = 0; i < f.pts.length; i++) {
      var pi = f.pts[i];
      if (f.pts[k].s !== pi.s) k = i;   // neues Teilstück (nach Pause): Fenster neu beginnen
      var ti = pi.p[3];
      if (ti == null) { v.push(null); continue; }
      while (k + 1 < i && f.pts[k + 1].p[3] != null && ti - f.pts[k + 1].p[3] >= WIN_S * 1000) k++;
      var pk = f.pts[k];
      if (k >= i || pk.p[3] == null || ti - pk.p[3] < WIN_S * 1000) { v.push(null); continue; }
      var d = L.latLng(pk.p[0], pk.p[1]).distanceTo(L.latLng(pi.p[0], pi.p[1]));
      v.push(d / ((ti - pk.p[3]) / 1000) * 3.6);
    }
    return v;
  }

  // Fahrt erkennen: erste Stelle mit mehr als autoEndKmh über WIN_S; zurück bis dahin, wo man noch höchstens
  // so schnell wie beim Laufen war → dort kürzen. Rückgabe {keep: Anzahl Punkte, peak: km/h, at: Zeit} oder null
  function detectDrive(segments) {
    var f = flatten(segments);
    var v = windowSpeeds(f);
    var lim = setting("autoEndKmh", 80);
    var run = setting("runMaxKmh", 11);
    var trig = -1;
    // mindestens 3 Fenster hintereinander über der Grenze (sonst Ausreißer)
    var run3 = 0;
    for (var i = 0; i < v.length; i++) {
      if (v[i] != null && v[i] > lim) { if (++run3 >= 3) { trig = i - 2; break; } } else if (v[i] != null) run3 = 0;
    }
    if (trig < 0) return null;
    var peak = 0;
    for (var k = trig; k < v.length; k++) if (v[k] != null && v[k] > peak) peak = v[k];
    var cut = trig;
    while (cut > 0 && (v[cut] == null || v[cut] > run)) cut--;
    return { keep: Math.max(2, cut + 1), peak: peak, at: f.pts[cut].p[3] };
  }

  // Segmente auf die ersten n Punkte kürzen
  function cutSegments(segments, n) {
    var out = [];
    var left = n;
    segments.forEach(function (seg) {
      if (left <= 0) return;
      out.push(seg.slice(0, left));
      left -= seg.length;
    });
    return out.filter(function (sg) { return sg.length; });
  }

  // Zeit in Bewegung aus den Punkten (wie beim Import): Lücken über 2 min und Stillstand zählen nicht
  function movingFromPoints(segments) {
    var ms = 0;
    segments.forEach(function (sg) {
      for (var i = 1; i < sg.length; i++) {
        if (sg[i][3] == null || sg[i - 1][3] == null) continue;
        var dt = (sg[i][3] - sg[i - 1][3]) / 1000;
        var d = L.latLng(sg[i - 1][0], sg[i - 1][1]).distanceTo(L.latLng(sg[i][0], sg[i][1]));
        if (dt > 0 && dt <= 120 && d / dt >= 0.2) ms += dt * 1000;
      }
    });
    return ms;
  }

  function segLength(segments) { return segments.reduce(function (n, sg) { return n + lineLength(sg); }, 0); }

  function climbOf(segments) {
    var up = 0, ref = null;
    segments.forEach(function (sg) { sg.forEach(function (p) {
      if (p[2] == null) return;
      if (ref == null) { ref = p[2]; return; }
      if (p[2] - ref >= 3) { up += p[2] - ref; ref = p[2]; } else if (ref - p[2] >= 3) ref = p[2];
    }); });
    return up || null;
  }

  var KINDS = [["walk", "Wandern"], ["run", "Laufen"], ["bike", "Rad"], ["car", "Fahrzeug"]];
  function kindOf(w) {
    var v = avgKmh(w);
    if (v == null) return "";
    if (v <= setting("walkMaxKmh", 7)) return "walk";
    if (v <= setting("runMaxKmh", 11)) return "run";
    if (v <= setting("bikeMaxKmh", 32)) return "bike";
    return "car";
  }
  function kindLabel(k) { for (var i = 0; i < KINDS.length; i++) if (KINDS[i][0] === k) return KINDS[i][1]; return ""; }

  // ---------- Bildschirm anlassen (Screen Wake Lock) ----------

  var wakeLock = null;
  var wakeLockOk = null;   // null = unbekannt, true/false nach dem ersten Versuch

  function requestWakeLock() {
    if (NATIVE) return;   // App: Aufzeichnung läuft auch bei ausgeschaltetem Bildschirm
    if (walk && walk.companion) return;   // Begleiten: nichts aufzuzeichnen
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
    if (G.directionArrows) G.directionArrows(walk.planLine).addTo(planLayer);
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

  // ---------- Routenbezug: Kennzahlen, Position auf der Route, Abbiegungen ----------

  var stats = null;        // G.planner.routeStats der geplanten Route (Raster, Höhen, Länge)
  var turns = [];          // [{d, dir: "links"|"rechts", angle}]
  var progress = null;     // {idx, d (m entlang), off (m neben der Route)}
  var recent = [];         // letzte Positionen für die aktuelle Geschwindigkeit
  var speedNow = null;     // m/s
  var turnFlash = null;    // {text, until}
  var OFF_ROUTE_M = 50;    // weiter weg: keine Abbiegungs-Hinweise

  function routeOf(w) {
    // ältere Touren ohne gespeicherte Route: Linie als ein Abschnitt
    return w.route || { segments: [{ latlngs: w.planLine || [] }], closing: null, roundtrip: false, points: [] };
  }

  // ---------- Richtung automatisch umdrehen ----------
  //
  // Zu Beginn der Tour: Geht man entlang der Route rückwärts (netto mehr als „Richtung umdrehen nach“ % der
  // Streckenlänge, mindestens 50 m), wird die Tour umgedreht – Punkte, Abschnitte, Abbiegungen, Profil.
  // Hat man vorwärts genauso viel geschafft, gilt die Richtung als bestätigt und es wird nicht mehr geprüft.
  // Sprünge der Position auf der Route (z. B. Start = Ziel bei Rundtouren) zählen nicht.
  var revPrev = null;   // letzte Position entlang der Route (m)
  function checkReverse(moved) {
    if (!walk || walk.free || walk.companion || walk.dirChecked || !stats || !progress || progress.off > OFF_ROUTE_M) return;
    var pct = setting("reversePct", 1);
    if (!pct) return;
    var thr = Math.max(50, stats.dist * pct / 100);
    if (revPrev != null) {
      var delta = progress.d - revPrev;
      if (Math.abs(delta) <= moved * 1.5 + 30) walk.revNet = (walk.revNet || 0) + delta;
    }
    revPrev = progress.d;
    if ((walk.revNet || 0) >= thr) { walk.dirChecked = true; saveWalk(); return; }
    if ((walk.revNet || 0) <= -thr) reverseTour();
  }

  function reversedRoute(r) {
    function rev(seg) {
      var c = {};
      Object.keys(seg).forEach(function (k) { c[k] = seg[k]; });
      c.latlngs = seg.latlngs.slice().reverse();
      return c;
    }
    var pts = (r.points || []).slice();
    var segs = (r.segments || []).slice();
    if (r.roundtrip && r.closing && pts.length > 1) {
      // P0 → P1 … Pm → P0  wird zu  P0 → Pm … P1 → P0
      return { points: [pts[0]].concat(pts.slice(1).reverse()),
        segments: [rev(r.closing)].concat(segs.slice(1).reverse().map(rev)),
        closing: segs.length ? rev(segs[0]) : null, roundtrip: true };
    }
    return { points: pts.reverse(), segments: segs.reverse().map(rev), closing: null, roundtrip: false };
  }

  function reverseTour() {
    walk.route = reversedRoute(routeOf(walk));
    walk.planLine = G.planner.routeLine(walk.route);
    walk.reversed = !walk.reversed;
    walk.dirChecked = true;
    walk.turnsDone = {};
    revPrev = null;
    computeRouteData();
    var here = G.getPosition && G.getPosition();
    progress = here ? locateOnRoute(here.lat, here.lng) : null;
    lastProfileKey = "";
    sentTurnsKey = null;
    drawPlan();
    sendTurns();
    saveWalk();
    renderPanel();
    if (navigator.vibrate && !NATIVE) navigator.vibrate([100, 80, 100, 80, 100]);
    G.showStatus("↻ Richtung umgedreht – die Tour läuft jetzt andersherum.", 6000);
  }

  function computeRouteData() {
    stats = G.planner && walk && !walk.free ? G.planner.routeStats(routeOf(walk)) : null;
    turns = stats ? findTurns(stats.profile.pts) : [];
  }

  // Abbiegungen: Richtungsänderung > 35° über ±15 m, auf 5-m-Raster der Routenlinie
  function findTurns(pts) {
    if (!pts || pts.length < 3) return [];
    var grid = [];
    var j = 0;
    var total = pts[pts.length - 1].d;
    for (var d = 0; d <= total; d += 5) {
      while (j < pts.length - 2 && pts[j + 1].d < d) j++;
      var a = pts[j];
      var b = pts[j + 1];
      var t = b.d > a.d ? Math.min(1, Math.max(0, (d - a.d) / (b.d - a.d))) : 0;
      grid.push({ d: d, lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
    }
    function bearing(p, q) {
      var y = Math.sin((q.lng - p.lng) * Math.PI / 180) * Math.cos(q.lat * Math.PI / 180);
      var x = Math.cos(p.lat * Math.PI / 180) * Math.sin(q.lat * Math.PI / 180) -
        Math.sin(p.lat * Math.PI / 180) * Math.cos(q.lat * Math.PI / 180) * Math.cos((q.lng - p.lng) * Math.PI / 180);
      return Math.atan2(y, x) * 180 / Math.PI;
    }
    var K = 3;   // 3 × 5 m = 15 m
    var cand = [];
    for (var i = K; i < grid.length - K; i++) {
      var delta = bearing(grid[i], grid[i + K]) - bearing(grid[i - K], grid[i]);
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      if (Math.abs(delta) > 35) cand.push({ d: grid[i].d, angle: delta, lat: grid[i].lat, lng: grid[i].lng });
    }
    // benachbarte Kandidaten (innerhalb 25 m) zu einer Abbiegung zusammenfassen
    var out = [];
    cand.forEach(function (c) {
      var last = out[out.length - 1];
      if (last && c.d - last.d <= 25) {
        if (Math.abs(c.angle) > Math.abs(last.angle)) { last.d = c.d; last.angle = c.angle; last.lat = c.lat; last.lng = c.lng; }
      } else {
        out.push({ d: c.d, angle: c.angle, lat: c.lat, lng: c.lng });
      }
    });
    return out.map(function (t) {
      return { d: t.d, angle: Math.round(t.angle), dir: t.angle > 0 ? "rechts" : "links", lat: t.lat, lng: t.lng };
    });
  }

  // eigene Position auf die Route projizieren (Rasterpunkte; erst in der Nähe der letzten Stelle suchen)
  function locateOnRoute(lat, lng) {
    if (!stats || !stats.grid.length) return null;
    var g = stats.grid;
    var here = L.latLng(lat, lng);
    function search(from, to) {
      var best = { idx: -1, dist: Infinity };
      for (var i = Math.max(0, from); i <= Math.min(g.length - 1, to); i++) {
        var dd = here.distanceTo(L.latLng(g[i].lat, g[i].lng));
        if (dd < best.dist) best = { idx: i, dist: dd };
      }
      return best;
    }
    var best = null;
    if (progress) best = search(progress.idx - 8, progress.idx + 80);   // 200 m zurück, 2 km voraus
    if (!best || best.dist > OFF_ROUTE_M) {
      var all = search(0, g.length - 1);
      if (!best || all.dist < best.dist) best = all;
    }
    var scale = g[g.length - 1].d ? stats.dist / g[g.length - 1].d : 1;
    return { idx: best.idx, d: g[best.idx].d, dRoute: g[best.idx].d * scale, off: best.dist, e: g[best.idx].e };
  }

  function vibrateFor(dir) {
    // links: zwei kurze, rechts: ein langer Impuls (Android; iOS/Safari unterstützt keine Vibration)
    if (navigator.vibrate) navigator.vibrate(dir === "links" ? [150, 120, 150] : [450]);
  }

  function checkTurns() {
    if (!progress || progress.off > OFF_ROUTE_M || !turns.length || walk.paused) return;
    var warn = (G.getSettings().turnWarnM || 20);
    walk.turnsDone = walk.turnsDone || {};
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      var ahead = t.d - progress.d;
      if (ahead < 0) continue;
      if (ahead <= warn && !walk.turnsDone[i]) {
        walk.turnsDone[i] = true;
        if (!NATIVE) vibrateFor(t.dir);   // App: vibriert der Aufzeichnungsdienst (auch bei Bildschirm aus)
        turnFlash = { text: (t.dir === "links" ? "↰ links" : "↱ rechts") + " in " + Math.round(ahead) + " m", until: Date.now() + 6000 };
      }
      break;   // nur die nächste Abbiegung
    }
  }

  // App: kommende Abbiegungen an den Aufzeichnungsdienst geben (vibriert bei Bildschirm aus).
  // Nur noch nicht gemeldete (turnsDone) und noch nicht passierte – sonst vibrierte es doppelt.
  var sentTurnsKey = null;
  function sendTurns() {
    if (!NATIVE || !walk || walk.companion) return;
    var warn = (G.getSettings().turnWarnM || 20);
    var from = progress && progress.off <= OFF_ROUTE_M ? progress.d : -Infinity;
    var done = walk.turnsDone || {};
    var list = turns.filter(function (t, i) { return t.d > from && !done[i]; });
    var key = list.length + "|" + (list[0] ? list[0].d : "") + "|" + warn;
    if (key === sentTurnsKey) return;
    sentTurnsKey = key;
    NATIVE.call("setTurns", JSON.stringify(list.map(function (t) {
      return [Math.round(t.lat * 1e6) / 1e6, Math.round(t.lng * 1e6) / 1e6, t.dir === "links" ? "l" : "r"];
    })), Math.round(warn));
  }

  // App: neue Punkte vom Aufzeichnungsdienst übernehmen
  function pullNative() {
    if (!NATIVE || !walk || walk.companion) return 0;
    var raw = NATIVE.call("getPoints", walk.nativeIdx || 0);
    var pts;
    try { pts = JSON.parse(raw || "[]"); } catch (e) { return 0; }
    if (!pts.length) return 0;
    walk.nativeIdx = (walk.nativeIdx || 0) + pts.length;
    pts.forEach(function (q) { addPoint([q[0], q[1], q[2], q[3]], false); });
    setTimeout(checkAutoEnd, 0);
    walk.lastFix = Date.now();
    var q = pts[pts.length - 1];
    var prevQ = null;
    pts.forEach(function (pq) {
      progress = locateOnRoute(pq[0], pq[1]) || progress;
      checkReverse(prevQ ? L.latLng(prevQ[0], prevQ[1]).distanceTo(L.latLng(pq[0], pq[1])) : 0);
      prevQ = pq;
    });
    progress = locateOnRoute(q[0], q[1]) || progress;
    checkTurns();   // markiert Abbiegungen, die der Dienst inzwischen gemeldet hat (vibriert hier nicht)
    saveWalk();
    drawWalk();
    sendTurns();
    renderPanel();
    return pts.length;
  }
  function nativeRefresh() {
    if (!active || !walk) return;
    pullNative();
    sendTurns();
    nativeBattery = NATIVE.batteryOptimized();
    renderPanel();
  }
  var nativeBattery = false;
  if (NATIVE) {
    window.GOAHEAD_NATIVE_RESUME = nativeRefresh;   // ruft die App beim Zurückkehren auf
    document.addEventListener("visibilitychange", function () { if (!document.hidden) nativeRefresh(); });
  }

  // Fahrt erkannt (Spitze über „Automatisch beenden ab“): bis zum Einstieg kürzen und Tour speichern
  var autoEnding = false;
  function checkAutoEnd() {
    if (!walk || walk.paused || walk.companion || autoEnding) return;
    var det = detectDrive(walk.segments);
    if (!det) return;
    autoEnding = true;
    if (NATIVE) { pullNative(); NATIVE.call("pauseRecording"); }
    walk.segments = cutSegments(walk.segments, det.keep);
    walk.distance = segLength(walk.segments);
    walk.autoEnded = { peak: Math.round(det.peak), at: det.at };
    walk.paused = true;
    walk.pausedAt = Date.now();
    saveWalk();
    drawWalk();
    finish(walk.free ? walk.routeName : undefined);
    autoEnding = false;
  }

  // Punkt an das laufende Teilstück hängen: p = [lat, lon, höhe|null, zeit ms]
  function addPoint(p, draw) {
    var seg = walk.segments[walk.segments.length - 1];
    if (seg.length) {
      var last = seg[seg.length - 1];
      var d = L.latLng(last[0], last[1]).distanceTo(L.latLng(p[0], p[1]));
      if (d < MIN_STEP) return false;
      walk.distance += d;
    }
    seg.push(p);
    if (draw && currentLine) {
      currentLine.addLatLng([p[0], p[1]]);
      // weiße Kontur mitführen
      var layers = walkLayer.getLayers();
      var casing = layers[layers.length - 2];
      if (casing && casing.addLatLng) casing.addLatLng([p[0], p[1]]);
    }
    return true;
  }

  // ---------- Aufzeichnung ----------

  G.onPosition(function (pos) {
    if (!active || !walk) return;
    var c0 = pos.coords;
    // Position auf der Route und Geschwindigkeit (auch in der Pause, für die Anzeige)
    if (c0.accuracy <= MAX_ACCURACY) {
      progress = locateOnRoute(c0.latitude, c0.longitude) || progress;
      var lastR = recent.length ? recent[recent.length - 1].ll : null;
      var now = pos.timestamp || Date.now();
      recent.push({ t: now, ll: L.latLng(c0.latitude, c0.longitude) });
      while (recent.length > 2 && now - recent[0].t > 30000) recent.shift();
      if (c0.speed != null && !isNaN(c0.speed)) {
        speedNow = c0.speed;
      } else if (recent.length > 1) {
        var dt = (now - recent[0].t) / 1000;
        var dist = 0;
        for (var r = 1; r < recent.length; r++) dist += recent[r - 1].ll.distanceTo(recent[r].ll);
        speedNow = dt > 3 ? dist / dt : speedNow;
      }
      checkTurns();
      if (!walk.paused) checkReverse(lastR ? lastR.distanceTo(L.latLng(c0.latitude, c0.longitude)) : 0);
    }
    if (walk.paused) { renderPanel(); return; }
    if (walk.companion) { walk.lastFix = Date.now(); renderPanel(); return; }   // Begleiten: nur anzeigen
    var c = pos.coords;
    walk.lastFix = Date.now();
    walk.weak = c.accuracy > MAX_ACCURACY;
    // App: aufgezeichnet wird im Dienst; hier nur abholen
    if (NATIVE) { pullNative(); renderPanel(); return; }
    if (walk.weak) { renderPanel(); return; }
    var p = [Math.round(c.latitude * 1e6) / 1e6, Math.round(c.longitude * 1e6) / 1e6,
      c.altitude != null ? Math.round(c.altitude * 10) / 10 : null, pos.timestamp || Date.now()];
    if (!addPoint(p, true)) return;
    saveWalk();
    checkAutoEnd();
    if (!walk) return;
    renderPanel();
  });

  // ---------- Feld „Unterwegs“ ----------

  var panel = document.createElement("section");
  panel.id = "nav-panel";
  panel.className = "sheet";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Unterwegs");
  panel.innerHTML =
    '<div class="nav-head sheet-handle">' +
      '<span class="sheet-grip" aria-hidden="true"></span>' +
      '<span class="sheet-titles"><span class="nav-title-row"><span class="nav-offline" hidden></span><span class="nav-title"></span></span><span class="nav-state"></span></span>' +
      '<span class="sheet-head-btns">' +
        '<button type="button" class="icon-btn nav-pause"></button>' +
        '<button type="button" class="icon-btn nav-photo" title="Foto aufnehmen" aria-label="Foto aufnehmen">' + G.icon("camera") + "</button>" +
        '<button type="button" class="icon-btn nav-fit" title="Position und Start zeigen" aria-label="Position und Start zeigen">' + G.icon("fit") + "</button>" +
        '<button type="button" class="icon-btn nav-center" title="Auf meine Position" aria-label="Auf meine Position">' + G.icon("locate") + "</button>" +
        '<button type="button" class="icon-btn nav-end" title="Tour beenden" aria-label="Tour beenden">' + G.icon("stop") + "</button>" +
      "</span>" +
    "</div>" +
    '<div class="sheet-body">' +
    '<div class="icon-row nav-extra">' +
      '<button type="button" class="icon-btn nav-start" title="Zum Startpunkt" aria-label="Zum Startpunkt"><span class="icon-letter">S</span></button>' +
      '<button type="button" class="icon-btn nav-share" title="Stand teilen (für Begleitung)" aria-label="Stand teilen">' + G.icon("share") + "</button>" +
      '<button type="button" class="icon-btn nav-paste" title="Stand der Aufzeichnung einfügen" aria-label="Stand einfügen">' + G.icon("paste") + "</button>" +
    "</div>" +
    '<div class="nav-stats">' +
      '<div><span class="nav-val nav-dist">0,00</span><span class="nav-lbl">km gewandert</span></div>' +
      '<div><span class="nav-val nav-rest">–</span><span class="nav-lbl">km verbleibend</span></div>' +
      '<div><span class="nav-val nav-avg">–</span><span class="nav-lbl">Ø km/h</span></div>' +
      '<div><span class="nav-val nav-time">0:00:00</span><span class="nav-lbl">unterwegs</span></div>' +
      '<div><span class="nav-val nav-left">–</span><span class="nav-lbl">Restzeit</span></div>' +
      '<div><span class="nav-val nav-eta">–</span><span class="nav-lbl">Ankunft</span></div>' +
      '<div><span class="nav-val nav-speed">–</span><span class="nav-lbl">km/h aktuell</span></div>' +
      '<div><span class="nav-val nav-ele">–</span><span class="nav-lbl">Höhe m</span></div>' +
      '<div><span class="nav-val nav-plan">–</span><span class="nav-lbl nav-plan-lbl">km geplant</span></div>' +
    "</div>" +
    '<div class="nav-profile-box" hidden><svg class="pf-svg nav-pf" aria-label="Höhenprofil mit Position"></svg></div>' +
    "</div>";
  document.body.appendChild(panel);
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);
  // (Die Leiste liegt über Positions-Knopf und Quellenangabe – diese werden nicht verschoben.)
  G.makeResizable(panel, panel.querySelector(".nav-head"), "goahead.navHeight.v1");

  var el = {
    title: panel.querySelector(".nav-title"),
    offline: panel.querySelector(".nav-offline"),
    dist: panel.querySelector(".nav-dist"),
    rest: panel.querySelector(".nav-rest"),
    avg: panel.querySelector(".nav-avg"),
    time: panel.querySelector(".nav-time"),
    left: panel.querySelector(".nav-left"),
    eta: panel.querySelector(".nav-eta"),
    speed: panel.querySelector(".nav-speed"),
    ele: panel.querySelector(".nav-ele"),
    plan: panel.querySelector(".nav-plan"),
    planLbl: panel.querySelector(".nav-plan-lbl"),
    profBox: panel.querySelector(".nav-profile-box"),
    profSvg: panel.querySelector(".nav-pf"),
    state: panel.querySelector(".nav-state"),
    pause: panel.querySelector(".nav-pause"),
    end: panel.querySelector(".nav-end")
  };

  el.pause.addEventListener("click", function () {
    if (!walk) return;
    if (walk.paused) resume(); else pause();
  });
  panel.querySelector(".nav-center").addEventListener("click", function () { G.follow(); });
  function startPoint() {
    var line = walk && walk.planLine;
    if (line && line.length) return L.latLng(line[0][0], line[0][1]);
    // freie Aufnahme: Start = erster aufgezeichneter Punkt
    var s0 = walk && walk.segments && walk.segments[0] && walk.segments[0][0];
    return s0 ? L.latLng(s0[0], s0[1]) : null;
  }
  panel.querySelector(".nav-start").addEventListener("click", function () {
    var s0 = startPoint();
    if (!s0) return;
    if (G.stopFollowing) G.stopFollowing();
    map.setView(s0, Math.max(map.getZoom(), 16));
  });
  panel.querySelector(".nav-fit").addEventListener("click", function () {
    var s0 = startPoint();
    var me = G.getPosition && G.getPosition();
    if (!s0 && !me) return;
    if (G.stopFollowing) G.stopFollowing();
    if (s0 && me) {
      // unten Platz für die Leiste lassen
      map.fitBounds(L.latLngBounds([s0, me]), { paddingTopLeft: [40, 80], paddingBottomRight: [40, panel.offsetHeight + 40], maxZoom: 17 });
    } else {
      map.setView(s0 || me, Math.max(map.getZoom(), 16));
    }
  });
  panel.querySelector(".nav-end").addEventListener("click", askEnd);
  panel.querySelector(".nav-share").addEventListener("click", function () { if (walk && G.share) G.share.stand(standOf()); });
  panel.querySelector(".nav-paste").addEventListener("click", function () { if (G.share) G.share.paste(); });

  function renderPanel() {
    if (!walk) return;
    // freie Aufnahme: Felder, die nur mit Route Sinn ergeben, ausblenden
    [el.rest, el.left, el.eta, el.plan].forEach(function (v) { v.parentNode.hidden = !!walk.free; });
    el.title.textContent = walk.routeName;
    var comp = walk.companion;
    el.pause.hidden = !!comp;
    photoBtn.hidden = !!comp || !G.photos;
    panel.querySelector(".nav-share").hidden = !!comp || !G.share;
    panel.querySelector(".nav-paste").hidden = !comp || !G.share;
    el.end.title = comp ? "Begleiten beenden" : "Tour beenden";
    el.end.setAttribute("aria-label", el.end.title);
    if (comp) walk.distance = companionDistance();
    var moving = movingTime(walk);
    el.dist.textContent = num(walk.distance / 1000, 2);
    el.time.textContent = duration(moving);
    el.plan.textContent = walk.planLength ? num(walk.planLength / 1000, 1) : "–";
    el.planLbl.textContent = walk.planHours && G.planner ? "geplant ≈" + G.planner.hm(walk.planHours) + " h" : "km geplant";
    el.avg.textContent = moving > 60000 && walk.distance > 0 ? num(walk.distance / 1000 / (moving / 3600000), 1) : "–";
    el.speed.textContent = speedNow != null ? num(speedNow * 3.6, 1) : "–";
    if (stats && progress) {
      var restM = Math.max(0, stats.dist - progress.dRoute);
      el.rest.textContent = num(restM / 1000, 2);
      var leftH = G.planner.remainingHours(stats, progress.idx);
      el.left.textContent = G.planner.hm(leftH);
      var eta = new Date(Date.now() + leftH * 3600000);
      el.eta.textContent = eta.getHours() + ":" + (eta.getMinutes() < 10 ? "0" : "") + eta.getMinutes();
      el.ele.textContent = stats.hasEle && progress.e != null ? String(Math.round(progress.e)) : "–";
    } else {
      el.rest.textContent = stats ? num(stats.dist / 1000, 2) : "–";
      el.left.textContent = walk.planHours && G.planner ? G.planner.hm(walk.planHours) : "–";
      el.eta.textContent = "–";
      el.ele.textContent = "–";
    }
    renderNavProfile();
    renderOffline();
    var pt = walk.paused ? "Weiter aufzeichnen" : "Pause";
    el.pause.innerHTML = G.icon(walk.paused ? "play" : "pause");
    el.pause.title = pt;
    el.pause.setAttribute("aria-label", pt);
    el.pause.classList.toggle("on", walk.paused);
    // knapper Zustand, EINE Zeile (Kopfhöhe = --sheet-min): nur das Wichtigste, in dieser Rangfolge
    var st;
    var cls = "is-rec";
    if (comp) {
      // Begleiten: Stand-Zeit, sonst wie unterwegs (Abbiegung, neben der Route)
      if (turnFlash && Date.now() < turnFlash.until) { st = turnFlash.text; cls = "is-warn"; }
      else if (progress && progress.off > OFF_ROUTE_M) { st = "⚠ " + Math.round(progress.off) + " m neben der Route"; cls = "is-warn"; }
      else if (!walk.lastFix) st = "Begleiten · warte auf GPS";
      else st = "Begleiten" + (comp.at ? " · Stand " + hhmm(comp.at) : "");
      cls = cls === "is-warn" ? cls : "is-pause";
    }
    else if (walk.paused) { st = walk.interrupted ? "Pause (neu geladen)" : "Pause"; cls = "is-pause"; }
    else if (turnFlash && Date.now() < turnFlash.until) { st = turnFlash.text; cls = "is-warn"; }
    else if (progress && progress.off > OFF_ROUTE_M) { st = "⚠ " + Math.round(progress.off) + " m neben der Route"; cls = "is-warn"; }
    else if (!walk.lastFix) { st = "● Aufnahme · warte auf GPS"; }
    else if (walk.weak) { st = "⚠ GPS ungenau"; cls = "is-warn"; }
    else if (NATIVE && nativeBattery) { st = "⚠ Akku-Optimierung an"; cls = "is-warn"; }
    else if (!NATIVE && wakeLockOk === false) { st = "⚠ Bildschirm anlassen"; cls = "is-warn"; }
    else { st = "● Aufnahme"; }
    el.state.textContent = st;
    el.state.className = "nav-state " + cls;
  }

  function num(v, digits) { return v.toFixed(digits).replace(".", ","); }
  function hhmm(t) { var d = new Date(t); return d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes(); }

  // Höhenprofil mit eigener Position (nur wenn die Route Höhen hat)
  var lastProfileKey = "";
  function renderNavProfile() {
    var has = !!(stats && stats.hasEle && stats.grid.length > 1 && G.planner && G.planner.drawProfile);
    el.profBox.hidden = !has;
    if (!has) return;
    var key = (progress ? progress.idx : -1) + "|" + el.profBox.clientWidth;
    if (key === lastProfileKey) return;   // nur neu zeichnen, wenn sich etwas ändert
    lastProfileKey = key;
    G.planner.drawProfile(el.profSvg, stats, { width: el.profBox.clientWidth, markerD: progress ? progress.d : null });
  }

  // ---------- Offline-Karten entlang der Route ----------

  var offlineJob = null;
  function startOffline() {
    if (!G.offline || !walk || !walk.planLine || walk.planLine.length < 2) return;
    if (offlineJob) offlineJob.stop();
    var km0 = G.getSettings().offlineKm || 1;
    offlineJob = G.offline.saveCorridor(walk.planLine, km0, function (st) {
      if (!walk) return;
      walk.offline = { state: st.state, done: st.done, total: st.total, skipped: st.skipped };
      saveWalk();
      renderOffline();
    });
  }
  function stopOffline(clearCache) {
    if (offlineJob) { offlineJob.stop(); offlineJob = null; }
    if (clearCache && G.offline) G.offline.clear();
  }
  function renderOffline() {
    var o = walk && walk.offline;
    el.offline.hidden = !o || o.state === "unsupported";
    if (el.offline.hidden) return;
    el.offline.innerHTML = G.icon("offline");
    el.offline.className = "nav-offline is-" + o.state;
    var t = o.state === "done" ? "Karten entlang der Route offline gespeichert (" + o.total + " Kacheln)"
      : o.state === "retry" ? "Offline-Speichern: kein Empfang, wird wiederholt (" + o.done + "/" + o.total + ")"
      : "Karten werden offline gespeichert (" + o.done + "/" + o.total + ")";
    if (o.skipped && o.skipped.length) t += " – nicht offline: " + o.skipped.join(", ");
    el.offline.title = t;
    el.offline.setAttribute("aria-label", t);
  }

  var ticker = null;

  // ---------- Fotos unterwegs ----------

  // Kamera-Knopf in der Kopfzeile (immer erreichbar, auch bei hochgezogener Leiste)
  var photoBtn = panel.querySelector(".nav-photo");
  photoBtn.addEventListener("click", function () { if (walk && G.photos) G.photos.take(walk.id); });

  var walkPhotos = null;   // Fotos der laufenden Tour auf der Karte
  function showWalkPhotos() {
    if (walkPhotos) { map.removeLayer(walkPhotos.layer); walkPhotos = null; }
    if (walk && G.photos) walkPhotos = G.photos.layerFor(walk.id), walkPhotos.layer.addTo(map);
  }
  if (G.photos) {
    G.photos.onAdded(function (ph) { if (walk && walkPhotos && ph.walkId === walk.id) walkPhotos.add(ph); });
    G.photos.onDeleted(function () { if (walk) showWalkPhotos(); });
  }

  // ---------- Ablauf ----------

  function enter() {
    active = true;
    if (G.closeTracksPage) G.closeTracksPage();
    if (G.closeMenu) G.closeMenu();
    if (G.closeInfoPanel) G.closeInfoPanel();
    if (G.planner && G.planner.isActive()) G.planner.stop();
    document.body.classList.add("mode-nav");
    if (G.tourView) G.tourView.close();
    panel.hidden = false;
    photoBtn.hidden = !G.photos;
    showWalkPhotos();
    layer.addTo(map);
    drawPlan();
    drawWalk();
    computeRouteData();
    progress = null;
    revPrev = null;
    lastProfileKey = "";
    clearInterval(ticker);
    var tick = 0;
    ticker = setInterval(function () {
      if (!walk) return;
      if (NATIVE && !walk.companion && !document.hidden && ++tick % 3 === 0 && !walk.paused) pullNative();
      if (!walk.paused) renderPanel();
    }, 1000);
    if (NATIVE && !walk.companion) {
      sentTurnsKey = null;
      nativeBattery = NATIVE.batteryOptimized();
      pullNative();
      sendTurns();
    }
    renderPanel();
    // Offline-Karten (auch nach Neuladen: bereits gespeicherte Kacheln werden übersprungen)
    setTimeout(startOffline, 1500);
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
      route: { segments: rec.segments || [], closing: rec.closing || null, roundtrip: !!rec.roundtrip, points: rec.points || [] },
      planLength: (rec.stats && rec.stats.length) || lineLength(line),
      planHours: G.planner && G.planner.routeStats ? G.planner.routeStats(rec).hours : null,
      startedAt: Date.now(),
      paused: false,
      pausedAt: null,
      pausedTotal: 0,
      segments: [[]],
      distance: 0,
      lastFix: null,
      nativeIdx: 0
    };
    if (NATIVE) NATIVE.call("startRecording", true);
    saveWalk();
    enter();
    if (NATIVE && nativeBattery) setTimeout(NATIVE.batteryDialog, 800);
    if (line.length > 1) map.fitBounds(L.latLngBounds(line), { padding: [30, 30], maxZoom: 16 });
    // dann auf die eigene Position und ihr folgen
    setTimeout(function () { G.follow(); }, 600);
    requestWakeLock();
  }

  // ---------- Begleiten: Tour eines anderen Geräts mitverfolgen (ohne eigene Aufzeichnung) ----------
  //
  // km gewandert = geteilter Stand (falls vorhanden) + Strecke entlang der Route seit der Stelle des Stands;
  // ohne Stand: Strecke entlang der Route vom Start bis zur eigenen Position.
  function companionDistance() {
    var c = walk.companion;
    var d = progress ? progress.dRoute : (c.dRoute || 0);
    if (c.dist == null) return Math.max(0, d);
    return c.dist + Math.max(0, d - (c.dRoute || 0));
  }

  function startCompanion(rec, stand) {
    if (active && walk && !walk.companion) {
      G.showStatus("Es läuft bereits eine eigene Tour. Bitte zuerst beenden.", 5000);
      enter();
      return;
    }
    var line = G.planner ? G.planner.routeLine(rec) : [];
    walk = {
      id: "c" + Date.now().toString(36),
      companion: { dist: null, dRoute: 0, at: null },
      routeId: rec.id,
      routeName: rec.name,
      planLine: line,
      route: { segments: rec.segments || [], closing: rec.closing || null, roundtrip: !!rec.roundtrip, points: rec.points || [] },
      planLength: (rec.stats && rec.stats.length) || lineLength(line),
      planHours: G.planner && G.planner.routeStats ? G.planner.routeStats(rec).hours : null,
      startedAt: Date.now(),
      paused: false,
      pausedAt: null,
      pausedTotal: 0,
      segments: [[]],
      distance: 0,
      lastFix: null
    };
    if (stand) applyStandData(stand);
    saveWalk();
    enter();
    setTimeout(function () { G.follow(); }, 600);
  }

  // geteilter Stand: {route, name, startedAt, dist, moving, elapsed, dRoute, at, track}
  function applyStandData(st) {
    walk.companion = { dist: st.dist, dRoute: st.dRoute || 0, at: st.at };
    walk.startedAt = st.startedAt || walk.startedAt;
    // Pausen des Aufzeichnenden bis zum Stand übernehmen (danach zählt die Zeit als unterwegs)
    walk.pausedTotal = Math.max(0, (st.at - walk.startedAt) - (st.moving || 0));
    walk.segments = st.track && st.track.length ? st.track : [[]];
    if (st.route) {
      walk.route = st.route;
      walk.planLine = G.planner.routeLine(st.route);
      walk.reversed = !!st.reversed;
    }
  }

  function applyStand(st, rec) {
    if (!active || !walk || !walk.companion || (rec && walk.routeId !== rec.id)) {
      startCompanion(rec, st);
      G.showStatus("Begleiten mit Stand von " + hhmm(st.at) + ".", 4000);
      return;
    }
    applyStandData(st);
    computeRouteData();
    progress = null;
    lastProfileKey = "";
    drawPlan();
    drawWalk();
    saveWalk();
    var here = G.getPosition && G.getPosition();
    if (here) progress = locateOnRoute(here.lat, here.lng);
    renderPanel();
    G.showStatus("Stand von " + hhmm(st.at) + " übernommen.", 4000);
  }

  // eigenen Stand für die Begleitung zusammenstellen
  function standOf() {
    if (NATIVE) pullNative();
    return {
      name: walk.routeName,
      routeId: walk.routeId,
      route: walk.free ? null : routeOf(walk),
      reversed: !!walk.reversed,
      startedAt: walk.startedAt,
      at: Date.now(),
      dist: walk.distance,
      moving: movingTime(walk),
      dRoute: progress && progress.off <= OFF_ROUTE_M ? progress.dRoute : null,
      track: walk.segments.filter(function (sg) { return sg.length > 1; })
    };
  }

  // Aufnahme ohne geplante Route (spontane Tour)
  function startFree() {
    if (active && walk) {
      G.showStatus("Es läuft bereits eine Tour. Bitte zuerst beenden.", 5000);
      enter();
      return;
    }
    walk = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      free: true,
      routeId: null,
      routeName: "Tour vom " + new Date().toLocaleDateString("de-DE"),
      planLine: [],
      route: null,
      planLength: 0,
      planHours: null,
      startedAt: Date.now(),
      paused: false,
      pausedAt: null,
      pausedTotal: 0,
      segments: [[]],
      distance: 0,
      lastFix: null,
      nativeIdx: 0
    };
    if (NATIVE) NATIVE.call("startRecording", true);
    saveWalk();
    enter();
    G.follow();
    if (NATIVE && nativeBattery) setTimeout(NATIVE.batteryDialog, 800);
    requestWakeLock();
  }

  function pause() {
    if (NATIVE) { pullNative(); NATIVE.call("pauseRecording"); }
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
    if (NATIVE) { pullNative(); NATIVE.call("startRecording", false); }
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
    if (walk.companion) {
      G.actionSheet("Begleiten beenden?", walk.routeName, [{ label: "Beenden", danger: true, onClick: leave }]);
      return;
    }
    if (!walk.paused) pause();
    var pts = walk.segments.reduce(function (n, s) { return n + s.length; }, 0);
    G.actionSheet("Tour beenden?", km(walk.distance) + " · " + duration(movingTime(walk)) + " · " + pts + " Punkte", [
      { label: "✓ Beenden und unter „Erwandert“ speichern", primary: true, onClick: function () { finish(); } },
      { label: "▶ Weiterwandern", onClick: resume },
      { label: "Aufzeichnung verwerfen", danger: true, onClick: function () {
        G.actionSheet("Aufzeichnung wirklich verwerfen?", "Die gewanderte Strecke geht verloren.", [
          { label: "Verwerfen", danger: true, onClick: function () { leave(); G.showStatus("Aufzeichnung verworfen.", 3000); } }
        ]);
      } }
    ]);
  }

  function finish(nameGiven) {
    var segs = walk.segments.filter(function (s) { return s.length > 1; });
    if (walk.free && nameGiven === undefined && segs.length) {
      G.askText("Name der Tour", walk.routeName, function (name) {
        finish(String(name).trim() || walk.routeName);
      }, "Speichern");
      return;
    }
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
      name: walk.free ? nameGiven : walk.routeName + " – " + new Date(walk.startedAt).toLocaleDateString("de-DE"),
      free: !!walk.free,
      routeId: walk.routeId,
      routeName: walk.routeName,
      startedAt: new Date(walk.startedAt).toISOString(),
      endedAt: new Date(walk.autoEnded && walk.autoEnded.at ? walk.autoEnded.at : Date.now()).toISOString(),
      movingMs: walk.autoEnded ? movingFromPoints(segs) : movingTime(walk),
      autoEnded: walk.autoEnded || null,
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
      G.showStatus((rec.autoEnded ? "⚠ Fahrt erkannt (" + rec.autoEnded.peak + " km/h) – Tour bis zum Einstieg gekürzt und " : "Tour unter „Erwandert“ ") +
        "gespeichert: " + km(rec.distance) + ".", rec.autoEnded ? 10000 : 5000);
    }).catch(function (err) {
      // Aufzeichnung NICHT verwerfen: Sie bleibt als laufende Tour erhalten
      G.showStatus("Speichern fehlgeschlagen: " + err.message + " Die Aufzeichnung bleibt erhalten.", 10000);
    });
  }

  function leave() {
    if (NATIVE && walk && !walk.companion) NATIVE.call("stopRecording");   // erst nach dem Speichern bzw. Verwerfen: löscht die Punkte im Dienst
    active = false;
    walk = null;
    stats = null;
    progress = null;
    turns = [];
    stopOffline(true);
    saveWalk();
    clearInterval(ticker);
    releaseWakeLock();
    document.body.classList.remove("mode-nav");
    panel.hidden = true;
    if (walkPhotos) { map.removeLayer(walkPhotos.layer); walkPhotos = null; }
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
      box.innerHTML = '<p class="trk-empty">Noch keine erwanderten Touren.</p>';
      return;
    }
    var base = check && check.mode ? walks.filter(function (w) { return check[check.mode][w.id]; }) : walks;
    var hd = G.listTools ? G.listTools.head("walks", base, {
      yearOf: function (w) { return new Date(w.startedAt).getFullYear(); },
      metersOf: function (w) { return w.distance; },
      nameOf: function (w) { return w.name; },
      kindOf: kindOf,
      kinds: KINDS,
      tools: G.getSettings().listCheck ? '<button type="button" class="icon-btn list-check' + (check && check.mode ? " on" : "") +
        '" title="Liste prüfen (Doppelte, vermutlich geplante)" aria-label="Liste prüfen">' + G.icon("check") + "</button>" : ""
    }) : { html: "", items: base };
    var note = "";
    if (check && check.mode) {
      var n = Object.keys(check[check.mode]).length;
      var lbl = { dups: [" vermutlich doppelt", "Doppelte löschen"], planned: [" vermutlich geplant", "Nach „Geplant“ verschieben"],
        fast: [" Fahrzeug (Ø über " + setting("bikeMaxKmh", 32) + " km/h)", "Alle löschen"],
        drive: [" mit Fahrt am Ende", "Alle kürzen"] }[check.mode];
      note = '<div class="list-note"><span>' + n + lbl[0] + "</span>" +
        '<button type="button" class="list-check-act">' + lbl[1] + "</button>" +
        '<button type="button" class="icon-btn list-check-off" title="Prüfung beenden" aria-label="Prüfung beenden">' + G.icon("close") + "</button></div>";
    }
    box.innerHTML = hd.html + note + hd.items.map(function (w) {
      var info = [km(w.distance), duration(w.movingMs)];
      var v = avgKmh(w);
      if (v != null) info.push("Ø " + num(v, 1) + " km/h");
      if (check && (check.mode === "planned" || check.mode === "drive") && check.why[w.id]) info.push(check.why[w.id]);
      if (w.ascent) info.push("↑ ca. " + Math.round(w.ascent) + " m");
      info.push(new Date(w.startedAt).toLocaleDateString("de-DE"));
      return '<div class="trk-item trk-tap" role="button" tabindex="0" data-id="' + esc(w.id) + '">' +
        '<div class="trk-main"><span class="trk-swatch" style="background:' + COLOR_WALK + '"></span>' +
          '<span class="trk-text"><span class="trk-name">' +
            (w.autoEnded ? '<span class="warn-ic" title="Automatisch beendet (Fahrt erkannt)">' + G.icon("warn") + "</span>" : "") +
            (kindOf(w) ? '<span class="kind-ic" title="' + kindLabel(kindOf(w)) + '">' + G.icon(kindOf(w)) + "</span>" : "") +
            esc(w.name) + (shown[w.id] ? " 👁" : "") + "</span>" +
          '<span class="trk-info">' + esc(info.join(" · ")) + "</span></span>" +
        '</div><span class="trk-more" aria-hidden="true">›</span></div>';
    }).join("");
    if (G.listTools) G.listTools.wire(box, "walks", renderWalks);
    var cb = box.querySelector(".list-check");
    if (cb) cb.addEventListener("click", function (e) { e.stopPropagation(); runCheck(); });
    var off = box.querySelector(".list-check-off");
    if (off) off.addEventListener("click", function (e) { e.stopPropagation(); check = null; renderWalks(); });
    var act = box.querySelector(".list-check-act");
    if (act) act.addEventListener("click", function (e) { e.stopPropagation(); applyCheck(); });
  }

  // Durchschnitt in Bewegung (km/h); null, wenn keine Bewegungszeit bekannt ist
  function avgKmh(w) {
    return w.movingMs > 60000 && w.distance > 0 ? w.distance / 1000 / (w.movingMs / 3600000) : null;
  }

  // ---------- Liste prüfen: Doppelte, vermutlich geplante und zu schnelle Touren ----------
  //
  // Doppelt: gleicher Tag, gleicher Start (auf ~100 m) und gleiche Länge (auf 200 m). Behalten wird die erste.
  // Vermutlich geplant (Heuristik, nicht sicher – daher erst anzeigen, dann auf Wunsch verschieben):
  //   - keine Zeitstempel, oder
  //   - keine Pausen (Anteil der Zeit unter 0,3 m/s < 1 %) UND kein gleichmäßiger Aufnahmetakt (häufigster
  //     Abstand zwischen zwei Punkten < 30 % aller Abstände). Aufzeichnungen haben meist einen festen Takt
  //     und Stillstände; berechnete Zeiten einer Planung (z. B. aus komoot) nicht. Annahme, an echten Daten ungeprüft.
  var check = null;   // {dups: {id:1}, planned: {id:1}, why: {id: Text}, mode: "dups"|"planned"}

  function walkStats(w) {
    var total = 0, stop = 0, n = 0, timed = 0, pts = 0;
    var dts = {};
    w.segments.forEach(function (s) {
      for (var i = 0; i < s.length; i++) {
        pts++;
        if (s[i][3] != null) timed++;
        if (!i || s[i][3] == null || s[i - 1][3] == null) continue;
        var dt = (s[i][3] - s[i - 1][3]) / 1000;
        if (dt <= 0 || dt > 600) continue;
        var d = L.latLng(s[i - 1][0], s[i - 1][1]).distanceTo(L.latLng(s[i][0], s[i][1]));
        total += dt;
        if (d / dt < 0.3) stop += dt;
        var k = Math.round(dt);
        dts[k] = (dts[k] || 0) + 1;
        n++;
      }
    });
    var mode = 0;
    Object.keys(dts).forEach(function (k) { if (dts[k] > mode) mode = dts[k]; });
    return { timedShare: pts ? timed / pts : 0, n: n, stopShare: total ? stop / total : 0, takt: n ? mode / n : 0 };
  }

  function runCheck() {
    var seen = {};
    var dups = {}, planned = {}, why = {}, fast = {}, drive = {};
    walks.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; }).forEach(function (w) {
      var p = w.segments[0] && w.segments[0][0];
      if (p) {
        var key = String(w.startedAt).slice(0, 10) + "|" + Math.round((w.distance || 0) / 200) + "|" + p[0].toFixed(3) + "," + p[1].toFixed(3);
        if (seen[key]) dups[w.id] = 1; else seen[key] = 1;
      }
      if (kindOf(w) === "car") fast[w.id] = 1;
      var det = detectDrive(w.segments);
      if (det) { drive[w.id] = det; why[w.id] = "Fahrt " + Math.round(det.peak) + " km/h, kürzen auf " + num(segLength(cutSegments(w.segments, det.keep)) / 1000, 1) + " km"; }
      if (w.free || !w.importKey) return;   // eigene Aufzeichnungen aus GoAhead sind sicher erwandert
      var st = walkStats(w);
      if (st.timedShare < 0.5) { planned[w.id] = 1; why[w.id] = "ohne Zeitstempel"; }
      else if (st.n >= 20 && st.stopShare < 0.01 && st.takt < 0.3) {
        planned[w.id] = 1;
        why[w.id] = "Pausen " + Math.round(st.stopShare * 100) + " %, Takt " + Math.round(st.takt * 100) + " %";
      }
    });
    var nd = Object.keys(dups).length, np = Object.keys(planned).length, nf = Object.keys(fast).length, nv = Object.keys(drive).length;
    function show(mode) { return function () { check = { dups: dups, planned: planned, fast: fast, drive: drive, why: why, mode: mode }; renderWalks(); }; }
    var kmOf = function (set) { return walks.filter(function (w) { return set[w.id]; }).reduce(function (s, w) { return s + (w.distance || 0); }, 0) / 1000; };
    var acts = [];
    if (nd) acts.push({ label: "Doppelte zeigen (" + nd + ", " + num(kmOf(dups), 0) + " km)", onClick: show("dups") });
    if (np) acts.push({ label: "Vermutlich geplante zeigen (" + np + ", " + num(kmOf(planned), 0) + " km)", onClick: show("planned") });
    if (nv) acts.push({ label: "Mit Fahrt am Ende zeigen (" + nv + ")", onClick: show("drive") });
    if (nf) acts.push({ label: "Fahrzeug zeigen (Ø über " + setting("bikeMaxKmh", 32) + " km/h: " + nf + ", " + num(kmOf(fast), 0) + " km)", onClick: show("fast") });
    G.actionSheet("Liste prüfen", walks.length + " Touren: " + nd + " vermutlich doppelt, " + np + " vermutlich geplant, " + nv +
      " mit Fahrt (über " + setting("autoEndKmh", 80) + " km/h), " + nf + " im Schnitt schneller als Rad." +
      (nd || np || nf || nv ? " Erst ansehen, dann entscheiden." : ""), acts);
  }

  function applyCheck() {
    if (!check || !check.mode) return;
    var ids = Object.keys(check[check.mode]);
    if (check.mode === "drive") {
      var det = check.drive;
      G.actionSheet(ids.length + " Touren kürzen?", "Jede wird bis zum erkannten Einstieg ins Fahrzeug gekürzt und mit ⚠ markiert.", [
        { label: "Kürzen", primary: true, onClick: function () {
          var list = walks.filter(function (w) { return det[w.id]; }).map(function (w) { return trimmed(w, det[w.id].keep, det[w.id].peak); });
          G.db.putMany("walks", list).then(function () {
            check = null;
            loadWalks();
            G.showStatus(list.length + " Touren gekürzt.", 4000);
          }).catch(function (err) { G.showStatus("Kürzen fehlgeschlagen: " + err.message, 6000); });
        } }
      ]);
      return;
    }
    if (check.mode === "dups" || check.mode === "fast") {
      G.actionSheet(ids.length + (check.mode === "dups" ? " doppelte Touren löschen?" : " Touren löschen?"),
        check.mode === "dups" ? "Die jeweils erste bleibt erhalten." : "Einzelne lassen sich vorher über ihr Menü löschen oder behalten.", [
        { label: "Löschen", danger: true, onClick: function () {
          Promise.all(ids.map(function (id) { return G.db.del("walks", id); })).then(function () {
            check = null;
            loadWalks();
            G.showStatus(ids.length + " Touren gelöscht.", 4000);
          }).catch(function (err) { G.showStatus("Löschen fehlgeschlagen: " + err.message, 6000); });
        } }
      ]);
    } else {
      G.actionSheet(ids.length + " Touren nach „Geplant“ verschieben?", "Sie werden zu geplanten Routen (Wegpunkte etwa alle 1 km) und unter „Erwandert“ entfernt.", [
        { label: "Verschieben", primary: true, onClick: function () { moveToPlanned(walks.filter(function (w) { return check.planned[w.id]; })); } }
      ]);
    }
  }

  function moveToPlanned(list) {
    if (!G.backup || !G.backup.walkToRoute) return;
    var recs = list.map(function (w) { return G.backup.walkToRoute(w); });
    G.db.putMany("routes", recs).then(function () {
      return Promise.all(list.map(function (w) { return G.db.del("walks", w.id); }));
    }).then(function () {
      check = null;
      window.dispatchEvent(new Event("goahead:data"));
      G.showStatus(list.length + " Touren nach „Geplant“ verschoben.", 4000);
    }).catch(function (err) { G.showStatus("Verschieben fehlgeschlagen: " + err.message, 6000); });
  }

  function findWalk(id) {
    for (var i = 0; i < walks.length; i++) if (walks[i].id === id) return walks[i];
    return null;
  }

  // Kennzahlen einer erwanderten Tour für die Detail-Leiste
  function walkDetails(w) {
    var pts = [];
    w.segments.forEach(function (s) { s.forEach(function (p) { pts.push(p); }); });
    var hasEle = pts.some(function (p) { return p[2] != null; });
    var prof = G.planner && G.planner.routeStats && hasEle
      ? G.planner.routeStats({ segments: w.segments.map(function (s) {
        return { latlngs: s.map(function (p) { return [p[0], p[1], p[2]]; }), distance: lineLength(s) };
      }) })
      : null;
    var ele = pts.map(function (p) { return p[2]; }).filter(function (e) { return e != null; });
    var avg = w.movingMs > 60000 ? num(w.distance / 1000 / (w.movingMs / 3600000), 1) : "–";
    var t0 = new Date(w.startedAt);
    var t1 = w.endedAt ? new Date(w.endedAt) : null;
    function hhmm(d) { return d ? d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes() : "–"; }
    return {
      stats: [
        [num(w.distance / 1000, 2), "km"],
        [duration(w.movingMs || 0), "in Bewegung"],
        [avg, "Ø km/h"],
        [prof && prof.up != null ? String(Math.round(prof.up)) : (w.ascent ? String(Math.round(w.ascent)) : "–"), "↑ m"],
        [prof && prof.down != null ? String(Math.round(prof.down)) : "–", "↓ m"],
        [ele.length ? Math.round(Math.min.apply(null, ele)) + "–" + Math.round(Math.max.apply(null, ele)) : "–", "Höhe m"],
        [hhmm(t0), "Start"],
        [hhmm(t1), "Ende"],
        [t0.toLocaleDateString("de-DE"), "Datum"]
      ],
      profile: prof
    };
  }

  function showWalk(w) {
    if (G.tourView) G.tourView.close();   // andere offene Tour schließen (entfernt deren Linie)
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
    openWalkSheet(w);
  }

  // Detail-Leiste (ziehbar) mit Kennzahlen, Höhenprofil und Fotos; Fotos zusätzlich auf der Karte
  var openSheetOpts = null;   // {w, opts} der offenen Tour-Leiste
  function openWalkSheet(w) {
    if (!G.tourView) return;
    var d = walkDetails(w);
    var ph = G.photos ? G.photos.layerFor(w.id) : null;
    if (ph) ph.layer.addTo(map);
    var opts = {
      title: w.name,
      sub: (w.autoEnded ? "⚠ automatisch beendet (" + w.autoEnded.peak + " km/h) · " : "") +
        (kindOf(w) ? kindLabel(kindOf(w)) + " · " : "") +
        num(w.distance / 1000, 1) + " km · " + new Date(w.startedAt).toLocaleDateString("de-DE"),
      stats: d.stats,
      profile: d.profile,
      photos: [],
      onMenu: function () { walkMenu(w); },
      onClose: function () { if (trimState) trimState.end(); if (ph) map.removeLayer(ph.layer); hideWalk(w); }
    };
    openSheetOpts = { w: w, opts: opts };
    if (ph) ph.onLoad = function (list) { G.tourView.setPhotos(opts, list.slice()); };
    G.tourView.open(opts);
  }

  // gekürzte Kopie einer gespeicherten Tour (erste n Punkte)
  function trimmed(w, n, peak) {
    var segs = cutSegments(w.segments, n);
    var last = segs[segs.length - 1];
    var t = last[last.length - 1][3];
    var c = {};
    Object.keys(w).forEach(function (k) { c[k] = w[k]; });
    c.segments = segs;
    c.distance = segLength(segs);
    var mv = movingFromPoints(segs);
    c.movingMs = mv || Math.round((w.movingMs || 0) * (c.distance / (w.distance || 1)));
    c.ascent = climbOf(segs);
    if (t) c.endedAt = new Date(t).toISOString();
    c.trimmed = true;
    if (peak) c.autoEnded = { peak: Math.round(peak), at: t };
    return c;
  }

  // Kürzen in der Tour-Leiste: Schieberegler (Endpunkt) und Antippen der Linie; Vorschlag = erkannte Fahrt
  var trimState = null;
  function startTrim(w, opts) {
    var f = flatten(w.segments);
    var n = f.pts.length;
    if (n < 3) return;
    var det = detectDrive(w.segments);
    var keep = det ? det.keep : n;
    var cutLayer = L.layerGroup().addTo(map);
    function redraw() {
      cutLayer.clearLayers();
      var rest = f.pts.slice(keep - 1).map(function (q) { return [q.p[0], q.p[1]]; });
      if (rest.length > 1) L.polyline(rest, { color: "#868e96", weight: 6, opacity: 0.9, dashArray: "6 8", interactive: false }).addTo(cutLayer);
      var e = f.pts[keep - 1].p;
      L.circleMarker([e[0], e[1]], { radius: 9, color: "#ffffff", weight: 3, fillColor: "#e03131", fillOpacity: 1, interactive: false }).addTo(cutLayer);
      var box = document.querySelector(".trim-info");
      if (box) {
        var tt = e[3] ? new Date(e[3]) : null;
        box.textContent = "Behalten " + num(f.cum[keep - 1] / 1000, 2) + " km" + (tt ? " bis " + tt.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "") +
          " · weg " + num((f.cum[n - 1] - f.cum[keep - 1]) / 1000, 2) + " km";
      }
    }
    var html = '<div class="trim-box">' +
      '<div class="trim-info"></div>' +
      '<input type="range" class="trim-range" min="2" max="' + n + '" value="' + keep + '" aria-label="Ende der Tour">' +
      '<div class="icon-row"><button type="button" class="btn-primary trim-ok">Kürzen</button>' +
      '<button type="button" class="trim-cancel">Abbrechen</button></div></div>';
    function end() {
      map.removeLayer(cutLayer);
      G.setMapClickHandler(null);
      trimState = null;
      G.tourView.setExtra(opts, "");
    }
    G.tourView.setExtra(opts, html, function (box) {
      var r = box.querySelector(".trim-range");
      r.addEventListener("input", function () { keep = +r.value; redraw(); });
      box.querySelector(".trim-cancel").addEventListener("click", end);
      box.querySelector(".trim-ok").addEventListener("click", function () {
        var c = trimmed(w, keep, det && keep === det.keep ? det.peak : null);
        G.db.put("walks", c).then(function () {
          end();
          G.tourView.close();
          loadWalks();
          setTimeout(function () { var nw = findWalk(c.id); if (nw) showWalk(nw); }, 300);
          G.showStatus("Tour gekürzt auf " + num(c.distance / 1000, 2) + " km.", 4000);
        }).catch(function (err) { G.showStatus("Speichern fehlgeschlagen: " + err.message, 6000); });
      });
    });
    // Linie antippen setzt das Ende auf den nächsten Punkt
    G.setMapClickHandler(function (e) {
      var best = -1, bd = Infinity;
      for (var i = 1; i < n; i++) {
        var dd = e.latlng.distanceTo(L.latLng(f.pts[i].p[0], f.pts[i].p[1]));
        if (dd < bd) { bd = dd; best = i; }
      }
      if (best < 0 || bd > 200) return;
      keep = best + 1;
      var r = document.querySelector(".trim-range");
      if (r) r.value = String(keep);
      redraw();
    });
    trimState = { end: end };
    redraw();
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
        ? { label: "Von der Karte entfernen", onClick: function () { if (G.tourView && G.tourView.isOpen()) G.tourView.close(); else hideWalk(w); } }
        : { label: "👁 Ansehen (Karte und Details)", primary: true, onClick: function () { showWalk(w); } },
      { label: "↗ Teilen (z. B. WhatsApp)", onClick: function () {
        var fn = G.planner ? G.planner.fileNameFor(w.name) : "tour.gpx";
        var details = km(w.distance) + " · " + duration(w.movingMs) + " h unterwegs" +
          (w.ascent ? " · ↑ ca. " + Math.round(w.ascent) + " m" : "") + " · " + new Date(w.startedAt).toLocaleDateString("de-DE");
        G.shareGpx(fn, walkToGpx(w), w.name, w.name + "\n" + details + "\n(GPX-Datei, aufgezeichnet mit GoAhead)");
      } },
      { label: "⬇ GPX exportieren", onClick: function () {
        var fn = G.planner ? G.planner.fileNameFor(w.name) : "tour.gpx";
        G.downloadFile(fn, walkToGpx(w), "application/gpx+xml");
      } },
      { label: "✂ Ende abschneiden", onClick: function () {
        if (!G.tourView || !G.tourView.isOpen() || !openSheetOpts || openSheetOpts.w.id !== w.id) showWalk(w);
        if (openSheetOpts && openSheetOpts.w.id === w.id) startTrim(w, openSheetOpts.opts);
      } },
      { label: "⇄ Nach „Geplant“ verschieben", onClick: function () {
        G.actionSheet("„" + w.name + "“ nach „Geplant“ verschieben?", "Sie wird zur geplanten Route und unter „Erwandert“ entfernt.", [
          { label: "Verschieben", primary: true, onClick: function () { if (G.tourView) G.tourView.close(); moveToPlanned([w]); } }
        ]);
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
      var nState = NATIVE && !walk.companion ? NATIVE.call("recordingState") : null;
      if (nState === "rec" && walk.paused) NATIVE.call("pauseRecording");   // Zustand der Seite gilt
      if (!walk.paused && nState === "rec") {
        // App: Der Dienst hat weiter aufgezeichnet – nichts verloren, einfach fortsetzen
        walk.interrupted = false;
      } else if (!walk.paused && !walk.companion) {
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
  window.addEventListener("goahead:data", loadWalks);
  G.onSettingsChange(function (st) {
    if (!st.listCheck && check) check = null;
    renderWalks();
  });

  var RecordControl = L.Control.extend({
    onAdd: function () {
      var box = L.DomUtil.create("div", "leaflet-bar rec-control");
      var btn = L.DomUtil.create("a", "rec-toggle", box);
      btn.href = "#";
      btn.setAttribute("role", "button");
      btn.title = "Aufnahme ohne Route starten";
      btn.setAttribute("aria-label", "Aufnahme ohne Route starten");
      btn.innerHTML = G.icon("rec");
      L.DomEvent.on(btn, "click", function (e) {
        L.DomEvent.preventDefault(e);
        if (G.closeMenu) G.closeMenu();
        startFree();
      });
      L.DomEvent.disableClickPropagation(box);
      return box;
    }
  });
  if (G.addToToolbar) G.addToToolbar(new RecordControl());

  G.nav = {
    start: start,
    startFree: startFree,
    startCompanion: startCompanion,
    applyStand: applyStand,
    isActive: function () { return active; },
    getWalk: function () { return walk; },
    getTurns: function () { return turns; },
    getProgress: function () { return progress; }
  };
})();
