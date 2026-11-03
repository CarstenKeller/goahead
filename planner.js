/* GoAhead – Route planen.
 *
 * Bedienung direkt auf der Karte (keine Erklärtexte, Knöpfe nur als Symbole):
 *  - Tipp auf die Karte: Vorschlagspunkt mit vorgeschlagener Strecke (orange, gestrichelt).
 *    Nochmal auf den Vorschlagspunkt tippen: einrasten.
 *  - Routenpunkt: 1. Tipp markiert ihn (blau, verschieben: Tipp auf die Karte oder Punkt ziehen
 *    → Ersatzvorschlag, Tipp darauf rastet ein); 2. Tipp: Löschmodus (rot, „−“); 3. Tipp: löschen.
 *  - Strecke zwischen zwei Punkten: einfacher Tipp fügt dort einen Zwischenpunkt ein,
 *    Doppeltipp wechselt zwischen „Weg“ (Routing) und „direkt“ (gerade Linie, gestrichelt).
 *  - Knöpfe: Rückgängig/Wiederholen, zum Start (S), Rundtour, Routing-Profil, Suche,
 *    Speichern, Beenden.
 *
 * Routing (Fußwege, ohne API-Schlüssel):
 *  - BRouter, Profil "hiking-mountain" (https://brouter.de/brouter).
 *    Parameter laut Quelltext github.com/abrensch/brouter: lonlats=lon,lat|lon,lat,
 *    profile, format=geojson; Antwort: GeoJSON-LineString [lon,lat,ele],
 *    properties "track-length" (m) und "filtered ascend" (m).
 *  - OSRM der FOSSGIS (https://routing.openstreetmap.de/routed-foot/route/v1/driving/…),
 *    wie auf openstreetmap.org verwendet.
 *  - Findet kein Dienst einen Weg: gerade Linie (gestrichelt, als „kein Weg“ markiert).
 * Adresssuche: Nominatim (OpenStreetMap), nur auf Knopfdruck (Nutzungsregeln: max. 1 Anfrage/s).
 */
(function () {
  "use strict";

  var G = window.GOAHEAD;
  if (!G || !G.map) return;
  var map = G.map;
  var esc = G.escapeHtml;

  var PLAN_KEY = "goahead.plan.v1";
  var BROUTER_URL = "https://brouter.de/brouter";
  var OSRM_URL = "https://routing.openstreetmap.de/routed-foot/route/v1/driving/";
  var NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

  var PROFILES = {
    hiking: { label: "Wandern (BRouter)", icon: "hiking", engines: ["brouter", "osrm"] },
    foot: { label: "Fußweg (OSRM)", icon: "road", engines: ["osrm", "brouter"] }
  };

  var COLOR_ROUTE = "#c2255c";
  var COLOR_CANDIDATE = "#f08c00";
  var DOUBLE_TAP_MS = 380;
  var HISTORY_MAX = 20;   // Rückgängig/Wiederholen: mindestens 5 Schritte gefordert

  // ---------- Zustand ----------

  var plan = newPlanState();
  var candidate = null;  // {latlng, loading, seg (Anhängen) | replace: Index, before, after (Ersetzen)}
  var selected = null;   // Index des markierten Punkts
  var armed = false;     // markierter Punkt im Löschmodus
  var active = false;
  var routeVersion = 0;  // verwirft veraltete Routing-Antworten
  var past = [];         // Rückgängig-Stapel (JSON-Schnappschüsse)
  var future = [];       // Wiederholen-Stapel

  function newPlanState() {
    return {
      points: [],      // [{lat, lng}]
      segments: [],    // segments[i]: Weg von points[i] nach points[i+1]
                       //   {latlngs, distance, ascent, source, mode: "route"|"line", pending?, note?}
      roundtrip: false,
      closing: null,   // Weg vom letzten Punkt zum Start (bei Rundtour), zusätzlich key
      profile: "hiking",
      savedId: null,   // gespeicherte Route, die gerade bearbeitet wird
      name: "",
      createdAt: null,
      dirty: false     // Änderungen seit dem letzten Speichern
    };
  }

  function loadPlan() {
    try {
      var p = JSON.parse(window.localStorage.getItem(PLAN_KEY) || "null");
      if (p && Array.isArray(p.points)) {
        plan = newPlanState();
        Object.keys(plan).forEach(function (k) { if (p[k] !== undefined) plan[k] = p[k]; });
        if (!PROFILES[plan.profile]) plan.profile = "hiking";
        // ältere Entwürfe ohne Speicher-Kennung gelten als ungespeichert
        if (p.dirty === undefined) plan.dirty = plan.points.length > 0;
      }
    } catch (e) { /* neue Planung */ }
  }

  function savePlan() {
    try { window.localStorage.setItem(PLAN_KEY, JSON.stringify(plan)); } catch (e) { /* Speicher voll o. ä. */ }
  }

  function markDirty() {
    plan.dirty = true;
    savePlan();
    if (typeof renderRoutesList === "function") renderRoutesList();
  }

  // ---------- Rückgängig / Wiederholen ----------

  function snapshot() {
    return JSON.stringify({ points: plan.points, segments: plan.segments, roundtrip: plan.roundtrip, closing: plan.closing });
  }

  // vor jeder Änderung aufrufen
  function pushHistory() {
    past.push(snapshot());
    if (past.length > HISTORY_MAX) past.shift();
    future = [];
  }

  function resetHistory() {
    past = [];
    future = [];
  }

  function restore(json) {
    var s = JSON.parse(json);
    plan.points = s.points;
    plan.segments = s.segments;
    plan.roundtrip = s.roundtrip;
    plan.closing = s.closing;
    candidate = null;
    selected = null;
    armed = false;
    routeVersion++;
    markDirty();
    resumePending();
    render();
  }

  function undo() {
    if (!past.length) return;
    future.push(snapshot());
    restore(past.pop());
  }

  function redo() {
    if (!future.length) return;
    past.push(snapshot());
    restore(future.pop());
  }

  // ---------- Routing ----------

  function fetchJson(url, ms) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = null;
    return Promise.race([
      fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }),
      new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
          reject(new Error("keine Antwort nach " + Math.round(ms / 1000) + " s"));
          if (ctrl) ctrl.abort();
        }, ms);
      })
    ]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  function lengthOf(latlngs) {
    var d = 0;
    for (var i = 1; i < latlngs.length; i++) d += L.latLng(latlngs[i - 1]).distanceTo(L.latLng(latlngs[i]));
    return d;
  }

  function round6(v) { return Math.round(v * 1e6) / 1e6; }

  var engines = {
    brouter: function (a, b) {
      var url = BROUTER_URL + "?lonlats=" + a.lng.toFixed(6) + "," + a.lat.toFixed(6) + "|" +
        b.lng.toFixed(6) + "," + b.lat.toFixed(6) + "&profile=hiking-mountain&alternativeidx=0&format=geojson";
      return fetchJson(url, 15000).then(function (gj) {
        var f = gj && gj.features && gj.features[0];
        if (!f || !f.geometry || !f.geometry.coordinates || f.geometry.coordinates.length < 2) throw new Error("keine Route");
        var latlngs = f.geometry.coordinates.map(function (c) { return [round6(c[1]), round6(c[0])]; });
        var props = f.properties || {};
        var dist = parseFloat(props["track-length"]);
        var asc = parseFloat(props["filtered ascend"]);
        return { latlngs: latlngs, distance: isNaN(dist) ? lengthOf(latlngs) : dist, ascent: isNaN(asc) ? null : asc, source: "BRouter" };
      });
    },
    osrm: function (a, b) {
      var url = OSRM_URL + a.lng.toFixed(6) + "," + a.lat.toFixed(6) + ";" + b.lng.toFixed(6) + "," + b.lat.toFixed(6) +
        "?overview=full&geometries=geojson";
      return fetchJson(url, 15000).then(function (res) {
        var r = res && res.code === "Ok" && res.routes && res.routes[0];
        if (!r || !r.geometry || !r.geometry.coordinates || r.geometry.coordinates.length < 2) throw new Error("keine Route");
        var latlngs = r.geometry.coordinates.map(function (c) { return [round6(c[1]), round6(c[0])]; });
        return { latlngs: latlngs, distance: r.distance || lengthOf(latlngs), ascent: null, source: "OSRM" };
      });
    }
  };

  function straight(a, b, note) {
    var latlngs = [[a.lat, a.lng], [b.lat, b.lng]];
    return { latlngs: latlngs, distance: lengthOf(latlngs), ascent: null, source: "Luftlinie", note: note || null };
  }

  function segMode(seg) { return seg && seg.mode === "line" ? "line" : "route"; }

  // gerade Linie, ausdrücklich gewählt („direkt“)
  function lineSeg(a, b) {
    var s = straight(a, b, null);
    s.source = "direkt";
    s.mode = "line";
    return s;
  }

  // vorläufiger Abschnitt, bis das Routing antwortet
  function pendingSeg(a, b, mode) {
    var s = straight(a, b, "wird berechnet");
    s.mode = mode;
    s.pending = true;
    return s;
  }

  // Berechnet den Weg von a nach b; nie fehlschlagend (Rückfall gerade Linie, markiert als „kein Weg“)
  function route(a, b, mode) {
    if (mode === "line") return Promise.resolve(lineSeg(a, b));
    var list = PROFILES[plan.profile].engines;
    var errors = [];
    function attempt(i) {
      if (i >= list.length) {
        if (errors.length) console.warn("[GoAhead] Routing fehlgeschlagen:", errors.join("; "));
        var s = straight(a, b, "kein Weg gefunden");
        s.mode = "route";
        return Promise.resolve(s);
      }
      return engines[list[i]](a, b).then(function (s) { s.mode = "route"; return s; }).catch(function (err) {
        errors.push(list[i] + ": " + err.message);
        return attempt(i + 1);
      });
    }
    return attempt(0);
  }

  // ---------- Darstellung ----------

  var layer = L.layerGroup();
  var routeLines = L.layerGroup().addTo(layer);
  var pointMarkers = L.layerGroup().addTo(layer);
  var candidateLayer = L.layerGroup().addTo(layer);

  function isDashed(seg) { return seg.source === "Luftlinie" || seg.source === "direkt"; }

  function drawLine(group, latlngs, color, dashed, faded) {
    L.polyline(latlngs, { color: "#ffffff", weight: 8, opacity: faded ? 0.4 : 0.9, interactive: false }).addTo(group);
    L.polyline(latlngs, {
      color: color, weight: 5, opacity: faded ? 0.3 : 1, interactive: false,
      dashArray: dashed ? "8 8" : null
    }).addTo(group);
  }

  // Abschnitt der Route mit breiter, unsichtbarer Tippfläche (ref = Index oder "closing")
  function drawSegment(seg, ref, faded) {
    drawLine(routeLines, seg.latlngs, COLOR_ROUTE, isDashed(seg), faded);
    var hit = L.polyline(seg.latlngs, { color: "#000000", opacity: 0.01, weight: 26, interactive: true }).addTo(routeLines);
    hit.on("click", function (e) {
      L.DomEvent.stopPropagation(e);
      onSegmentTap(ref, e.latlng);
    });
    // Doppeltipp auf eine Strecke soll die Karte nicht zoomen
    hit.on("dblclick", function (e) { L.DomEvent.stopPropagation(e); });
  }

  function pointIcon(label, kind) {
    return L.divIcon({
      className: "",
      html: '<div class="plan-pt plan-pt-' + kind + '">' + esc(label) + "</div>",
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
  }

  function render() {
    routeLines.clearLayers();
    pointMarkers.clearLayers();
    var n = plan.points.length;
    var moving = selected !== null && !armed;

    plan.segments.forEach(function (seg, i) {
      if (!seg) return;
      // beim Verschieben eines Punkts die bisherigen Anschlussstrecken blass zeigen
      drawSegment(seg, i, moving && candidate && (i === selected - 1 || i === selected));
    });
    if (plan.roundtrip && plan.closing) {
      drawSegment(plan.closing, "closing", moving && candidate && (selected === 0 || selected === n - 1));
    }

    plan.points.forEach(function (p, i) {
      var kind = i === selected ? (armed ? "del" : "sel") : (i === 0 ? "start" : (i === n - 1 ? "last" : "mid"));
      var label = i === selected && armed ? "−" : (i === 0 ? "S" : String(i));
      var m = L.marker([p.lat, p.lng], {
        icon: pointIcon(label, kind),
        draggable: true,
        title: i === 0 ? "Startpunkt" : "Punkt " + i,
        zIndexOffset: i === selected ? 700 : 500
      });
      m.on("click", function (e) {
        L.DomEvent.stopPropagation(e);
        onPointTap(i);
      });
      // Punkt ziehen = Ersatzvorschlag an der neuen Stelle
      m.on("dragend", function () {
        selected = i;
        armed = false;
        setCandidate(m.getLatLng());
      });
      m.addTo(pointMarkers);
    });

    renderCandidate();
    renderPanel();
  }

  function renderCandidate() {
    candidateLayer.clearLayers();
    if (!candidate) return;
    [candidate.seg, candidate.before, candidate.after].forEach(function (seg) {
      if (seg) drawLine(candidateLayer, seg.latlngs, COLOR_CANDIDATE, true);
    });
    var m = L.marker(candidate.latlng, {
      icon: pointIcon("+", "cand" + (candidate.loading ? " plan-pt-loading" : "")),
      draggable: true,
      title: "Vorschlag – antippen zum Übernehmen",
      zIndexOffset: 800
    });
    m.on("dragend", function () { setCandidate(m.getLatLng()); });
    // nochmal auf den Vorschlagspunkt tippen = einrasten
    m.on("click", function (e) {
      L.DomEvent.stopPropagation(e);
      confirmCandidate();
    });
    m.addTo(candidateLayer);
  }

  // ---------- Bedienung auf der Karte ----------

  function onMapTap(latlng) {
    if (selected !== null && armed) {   // Löschmodus durch Tipp daneben abbrechen
      selected = null;
      armed = false;
      render();
      return;
    }
    setCandidate(latlng);
  }

  // Routenpunkt: markieren → Löschmodus → löschen
  function onPointTap(i) {
    routeVersion++;
    candidate = null;
    if (selected !== i) {
      selected = i;
      armed = false;
    } else if (!armed) {
      armed = true;
    } else {
      deletePoint(i);
      return;
    }
    render();
  }

  // Strecke: einfacher Tipp = Zwischenpunkt, Doppeltipp = Weg/direkt umschalten
  var lastSegTap = null;
  function onSegmentTap(ref, latlng) {
    if (selected !== null && !armed) {   // beim Verschieben zählt der Tipp als neue Stelle
      setCandidate(latlng);
      return;
    }
    var now = Date.now();
    if (lastSegTap && lastSegTap.ref === ref && now - lastSegTap.t < DOUBLE_TAP_MS) {
      clearTimeout(lastSegTap.timer);
      lastSegTap = null;
      toggleSegmentMode(ref);
      return;
    }
    if (lastSegTap) clearTimeout(lastSegTap.timer);
    lastSegTap = {
      ref: ref,
      t: now,
      timer: setTimeout(function () {
        lastSegTap = null;
        insertPoint(ref, latlng);
      }, DOUBLE_TAP_MS)
    };
  }

  // ---------- Bearbeiten ----------

  function setCandidate(latlng) {
    var version = ++routeVersion;
    var ll = L.latLng(latlng);
    var n = plan.points.length;
    armed = false;

    if (selected !== null) {
      // Ersatz für den markierten Punkt: Strecken von den Nachbarpunkten neu berechnen
      var idx = selected;
      var prev = idx > 0 ? plan.points[idx - 1] : null;
      var next = idx < n - 1 ? plan.points[idx + 1] : null;
      candidate = { latlng: ll, replace: idx, before: null, after: null, loading: !!(prev || next) };
      render();
      Promise.all([
        prev ? route(prev, ll, segMode(plan.segments[idx - 1])) : null,
        next ? route(ll, next, segMode(plan.segments[idx])) : null
      ]).then(function (r) {
        if (version !== routeVersion || !candidate) return;
        candidate.before = r[0];
        candidate.after = r[1];
        candidate.loading = false;
        render();
      });
      return;
    }

    candidate = { latlng: ll, seg: null, loading: n > 0 };
    render();
    if (!n) return;   // erster Punkt = Startpunkt, keine Strecke
    route(plan.points[n - 1], ll, "route").then(function (seg) {
      if (version !== routeVersion || !candidate) return;
      candidate.seg = seg;
      candidate.loading = false;
      render();
    });
  }

  function confirmCandidate() {
    if (!candidate || candidate.loading) return;
    pushHistory();
    var p = { lat: round6(candidate.latlng.lat), lng: round6(candidate.latlng.lng) };
    if (candidate.replace !== undefined && candidate.replace !== null) {
      var idx = candidate.replace;
      plan.points[idx] = p;
      if (idx > 0) plan.segments[idx - 1] = candidate.before;
      if (idx < plan.points.length - 1) plan.segments[idx] = candidate.after;
      selected = null;
    } else {
      if (plan.points.length) plan.segments.push(candidate.seg);
      plan.points.push(p);
    }
    candidate = null;
    armed = false;
    routeVersion++;
    markDirty();
    updateClosing();
    render();
  }

  function deletePoint(i) {
    var n = plan.points.length;
    if (i < 0 || i >= n) return;
    pushHistory();
    candidate = null;
    selected = null;
    armed = false;
    routeVersion++;
    if (n === 1) {
      plan.points = [];
      plan.segments = [];
    } else if (i === 0) {
      plan.points.shift();
      plan.segments.shift();
    } else if (i === n - 1) {
      plan.points.pop();
      plan.segments.pop();
    } else {
      // Vorgänger und Nachfolger neu verbinden (direkt nur, wenn beide Abschnitte direkt waren)
      var a = plan.points[i - 1];
      var b = plan.points[i + 1];
      var mode = segMode(plan.segments[i - 1]) === "line" && segMode(plan.segments[i]) === "line" ? "line" : "route";
      plan.points.splice(i, 1);
      var seg = mode === "line" ? lineSeg(a, b) : pendingSeg(a, b, "route");
      plan.segments.splice(i - 1, 2, seg);
      if (seg.pending) replaceWhenRouted(seg, a, b);
    }
    markDirty();
    updateClosing();
    render();
  }

  // Nächstgelegene Stelle auf einer Linie: Index des Teilstücks und Punkt
  function splitLine(latlngs, latlng) {
    var zoom = map.getZoom();
    var p = map.project(latlng, zoom);
    var best = { d: Infinity, k: 0, q: latlng };
    for (var k = 0; k < latlngs.length - 1; k++) {
      var a = map.project(L.latLng(latlngs[k]), zoom);
      var b = map.project(L.latLng(latlngs[k + 1]), zoom);
      var c = L.LineUtil.closestPointOnSegment(p, a, b);
      var d = c.distanceTo(p);
      if (d < best.d) best = { d: d, k: k, q: map.unproject(c, zoom) };
    }
    var q = [round6(best.q.lat), round6(best.q.lng)];
    return {
      p: q,
      a: latlngs.slice(0, best.k + 1).concat([q]),
      b: [q].concat(latlngs.slice(best.k + 1))
    };
  }

  // Teil eines Abschnitts als eigener Abschnitt (Anstieg anteilig geschätzt)
  function partOf(orig, latlngs) {
    var d = lengthOf(latlngs);
    return {
      latlngs: latlngs,
      distance: d,
      ascent: orig.ascent != null && orig.distance ? orig.ascent * d / orig.distance : null,
      source: orig.source,
      mode: segMode(orig),
      note: orig.note || null
    };
  }

  function closingKey(a, b) { return a.lat + "," + a.lng + ">" + b.lat + "," + b.lng; }

  // Zwischenpunkt auf einer Strecke einfügen; der neue Punkt ist danach markiert (verschiebbar)
  function insertPoint(ref, latlng) {
    var seg = ref === "closing" ? plan.closing : plan.segments[ref];
    if (!seg || seg.pending) return;
    pushHistory();
    var cut = splitLine(seg.latlngs, latlng);
    var p = { lat: cut.p[0], lng: cut.p[1] };
    var sa = partOf(seg, cut.a);
    var sb = partOf(seg, cut.b);
    if (ref === "closing") {
      plan.points.push(p);
      plan.segments.push(sa);
      sb.key = closingKey(p, plan.points[0]);
      plan.closing = sb;
      selected = plan.points.length - 1;
    } else {
      plan.points.splice(ref + 1, 0, p);
      plan.segments.splice(ref, 1, sa, sb);
      selected = ref + 1;
    }
    armed = false;
    candidate = null;
    routeVersion++;
    markDirty();
    render();
  }

  // Abschnitt zwischen „Weg“ (Routing) und „direkt“ (gerade Linie) umschalten
  function toggleSegmentMode(ref) {
    var n = plan.points.length;
    var seg = ref === "closing" ? plan.closing : plan.segments[ref];
    if (!seg) return;
    var a = ref === "closing" ? plan.points[n - 1] : plan.points[ref];
    var b = ref === "closing" ? plan.points[0] : plan.points[ref + 1];
    pushHistory();
    var next = segMode(seg) === "line" ? pendingSeg(a, b, "route") : lineSeg(a, b);
    if (ref === "closing") {
      next.key = closingKey(a, b);
      plan.closing = next;
    } else {
      plan.segments[ref] = next;
    }
    if (next.pending) replaceWhenRouted(next, a, b);
    candidate = null;
    selected = null;
    armed = false;
    markDirty();
    render();
  }

  // Ersetzt einen vorläufigen Abschnitt durch die berechnete Strecke.
  // Ist er inzwischen entfernt (Punkt geändert, Rückgängig), passiert nichts.
  function replaceWhenRouted(pending, a, b) {
    route(a, b, pending.mode || "route").then(function (seg) {
      var j = plan.segments.indexOf(pending);
      if (j >= 0) {
        plan.segments[j] = seg;
      } else if (plan.closing === pending) {
        seg.key = pending.key;
        plan.closing = seg;
      } else {
        return;
      }
      savePlan();
      render();
    });
  }

  // vorläufige Abschnitte (z. B. nach Neustart oder Rückgängig) neu berechnen
  function resumePending() {
    plan.segments.forEach(function (s, i) {
      if (s && s.pending) replaceWhenRouted(s, plan.points[i], plan.points[i + 1]);
    });
    if (plan.closing && plan.closing.pending && plan.points.length > 1) {
      replaceWhenRouted(plan.closing, plan.points[plan.points.length - 1], plan.points[0]);
    }
  }

  function updateClosing() {
    if (!plan.roundtrip || plan.points.length < 2) {
      plan.closing = null;
      savePlan();
      return;
    }
    var a = plan.points[plan.points.length - 1];
    var b = plan.points[0];
    var key = closingKey(a, b);
    if (plan.closing && plan.closing.key === key) return;
    var mode = plan.closing ? segMode(plan.closing) : "route";
    var next = mode === "line" ? lineSeg(a, b) : pendingSeg(a, b, "route");
    next.key = key;
    plan.closing = next;
    if (next.pending) replaceWhenRouted(next, a, b);
    savePlan();
  }

  function toggleRoundtrip() {
    pushHistory();
    plan.roundtrip = !plan.roundtrip;
    markDirty();
    updateClosing();
    render();
  }

  function cycleProfile() {
    var keys = Object.keys(PROFILES);
    plan.profile = keys[(keys.indexOf(plan.profile) + 1) % keys.length];
    savePlan();
    renderPanel();
    G.showStatus("Routing: " + PROFILES[plan.profile].label, 2000);
    if (candidate) setCandidate(candidate.latlng);   // Vorschlag neu berechnen
  }

  function totals() {
    var dist = 0;
    var asc = 0;
    var ascKnown = true;
    var lines = 0;
    var segs = plan.segments.slice();
    if (plan.roundtrip && plan.closing) segs.push(plan.closing);
    segs.forEach(function (s) {
      if (!s) return;
      dist += s.distance || 0;
      if (s.ascent == null) { if (s.source !== "direkt") ascKnown = false; } else asc += s.ascent;
      if (s.source === "Luftlinie" && !s.pending) lines++;
    });
    return { dist: dist, asc: ascKnown && segs.length ? asc : null, lines: lines };
  }

  function km(m) { return (m / 1000).toFixed(1).replace(".", ",") + " km"; }

  // ---------- Suche: Adresse oder Koordinaten ----------

  // UTM (ETRS89/GRS80) -> geographische Koordinaten; Formeln nach Snyder, „Map Projections“ (USGS 1987)
  function utmToLatLng(E, N, zone) {
    var a = 6378137;
    var f = 1 / 298.257222101;
    var k0 = 0.9996;
    var e2 = f * (2 - f);
    var ep2 = e2 / (1 - e2);
    var x = E - 500000;
    var M = N / k0;
    var mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
    var e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    var phi1 = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu) +
      (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu) +
      (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu) +
      (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
    var sin1 = Math.sin(phi1);
    var cos1 = Math.cos(phi1);
    var tan1 = Math.tan(phi1);
    var N1 = a / Math.sqrt(1 - e2 * sin1 * sin1);
    var T1 = tan1 * tan1;
    var C1 = ep2 * cos1 * cos1;
    var R1 = a * (1 - e2) / Math.pow(1 - e2 * sin1 * sin1, 1.5);
    var D = x / (N1 * k0);
    var lat = phi1 - (N1 * tan1 / R1) * (D * D / 2 -
      (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4) / 24 +
      (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Math.pow(D, 6) / 720);
    var lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
    var lon = lon0 + (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6 +
      (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5) / 120) / cos1;
    return { lat: lat * 180 / Math.PI, lng: lon * 180 / Math.PI };
  }

  // Erkennt „51.758, 9.030“, „51,758 9,030“, „9.03 51.75“ (Lon/Lat in NRW), „32U 494000 5735000“, „494000 5735000“
  function parseCoordinates(text) {
    var t = String(text).trim();
    var zone = 32;
    var zm = t.match(/^(\d{2})\s*[C-HJ-NP-X]?\s+(?=\d)/i);
    if (zm) {
      zone = parseInt(zm[1], 10);
      t = t.slice(zm[0].length);
    }
    if (/^-?\d+,\d+\s*[;\s]\s*-?\d+,\d+$/.test(t)) t = t.replace(/(\d),(\d)/g, "$1.$2");   // Dezimalkommas
    var nums = t.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length !== 2 || /[a-zäöüß]/i.test(t.replace(/[NOSWE]/g, ""))) return null;
    var a = parseFloat(nums[0]);
    var b = parseFloat(nums[1]);
    // UTM: Rechtswert ~ 100000–900000, Hochwert ~ 5 Mio. – 6,5 Mio.
    function isE(v) { return v >= 100000 && v <= 900000; }
    function isN(v) { return v >= 5000000 && v <= 6500000; }
    if (isE(a) && isN(b)) return utmToLatLng(a, b, zone);
    if (isN(a) && isE(b)) return utmToLatLng(b, a, zone);
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
      // In Deutschland ist die Breite (47–56) größer als die Länge (5–16): vertauschte Eingabe erkennen
      if (a >= 5 && a <= 16 && b >= 46 && b <= 56) return { lat: b, lng: a };
      return { lat: a, lng: b };
    }
    return null;
  }

  function goTo(latlng, zoom) {
    if (G.stopFollowing) G.stopFollowing();
    map.setView(latlng, zoom || Math.max(map.getZoom(), 16));
  }

  var lastSearch = 0;

  function search(text, resultsEl) {
    resultsEl.innerHTML = "";
    var q = String(text || "").trim();
    if (!q) return;
    var c = parseCoordinates(q);
    if (c) {
      goTo(c, 16);
      setCandidate(c);
      closeSearch();
      return;
    }
    // Nominatim: höchstens eine Anfrage pro Sekunde
    if (Date.now() - lastSearch < 1100) return;
    lastSearch = Date.now();
    resultsEl.innerHTML = '<p class="plan-hint">…</p>';
    var url = NOMINATIM_URL + "?format=jsonv2&limit=6&countrycodes=de&accept-language=de&q=" + encodeURIComponent(q);
    fetchJson(url, 12000).then(function (list) {
      if (!list || !list.length) {
        resultsEl.innerHTML = '<p class="plan-hint">Nichts gefunden.</p>';
        return;
      }
      resultsEl.innerHTML = list.map(function (r, i) {
        return '<button type="button" class="plan-result" data-i="' + i + '">' + esc(r.display_name) + "</button>";
      }).join("") + '<p class="plan-credit">© OpenStreetMap-Mitwirkende (Nominatim)</p>';
      resultsEl.querySelectorAll(".plan-result").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var r = list[parseInt(btn.getAttribute("data-i"), 10)];
          closeSearch();
          if (G.stopFollowing) G.stopFollowing();
          var bb = r.boundingbox && r.boundingbox.map(parseFloat);
          if (bb && bb.length === 4 && !bb.some(isNaN)) {
            map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 17 });
          } else {
            goTo([parseFloat(r.lat), parseFloat(r.lon)], 16);
          }
        });
      });
    }).catch(function (err) {
      resultsEl.innerHTML = '<p class="plan-hint">Suche fehlgeschlagen: ' + esc(err.message) + "</p>";
    });
  }

  // ---------- Planungsfeld (kompakt: Symbole statt Beschriftung, keine Erklärtexte) ----------

  function iconBtn(cls, iconName, title) {
    return '<button type="button" class="icon-btn ' + cls + '" title="' + title + '" aria-label="' + title + '">' +
      (iconName ? G.icon(iconName) : "") + "</button>";
  }

  var panel = document.createElement("section");
  panel.id = "plan-panel";
  panel.className = "sheet";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Route planen");
  panel.innerHTML =
    '<div class="plan-head sheet-handle">' +
      '<span class="sheet-grip" aria-hidden="true"></span>' +
      '<span class="sheet-titles">' +
        '<span class="plan-title"><span class="plan-name"></span><span class="plan-dirty" title="ungespeichert" hidden></span></span>' +
        '<span class="plan-sum"></span>' +
      "</span>" +
      '<span class="sheet-head-btns">' +
        iconBtn("plan-save", "save", "Speichern") +
        iconBtn("plan-exit", "close", "Planung beenden") +
      "</span>" +
    "</div>" +
    '<div class="sheet-body">' +
      '<div class="icon-row">' +
        iconBtn("plan-undo", "undo", "Rückgängig") +
        iconBtn("plan-redo", "redo", "Wiederholen") +
        '<button type="button" class="icon-btn plan-start" title="Zum Startpunkt" aria-label="Zum Startpunkt"><span class="icon-letter">S</span></button>' +
        iconBtn("plan-round", "roundtrip", "Rundtour") +
        iconBtn("plan-profile", null, "Routing") +
        iconBtn("plan-find", "search", "Adresse oder Koordinaten suchen") +
      "</div>" +
      '<form class="plan-search" autocomplete="off" hidden>' +
        '<input type="search" enterkeyhint="search" placeholder="Adresse oder Koordinaten (auch UTM 32)">' +
        iconBtn("plan-go", "search", "Suchen").replace('type="button"', 'type="submit"') +
      "</form>" +
      '<div class="plan-results"></div>' +
    "</div>";
  document.body.appendChild(panel);
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);
  // (Die Leiste liegt über Positions-Knopf und Quellenangabe – diese werden nicht verschoben.)
  G.makeResizable(panel, panel.querySelector(".plan-head"), "goahead.planHeight.v1");

  var el = {
    name: panel.querySelector(".plan-name"),
    dirty: panel.querySelector(".plan-dirty"),
    sum: panel.querySelector(".plan-sum"),
    save: panel.querySelector(".plan-save"),
    undo: panel.querySelector(".plan-undo"),
    redo: panel.querySelector(".plan-redo"),
    start: panel.querySelector(".plan-start"),
    round: panel.querySelector(".plan-round"),
    profile: panel.querySelector(".plan-profile"),
    find: panel.querySelector(".plan-find"),
    form: panel.querySelector(".plan-search"),
    input: panel.querySelector(".plan-search input"),
    results: panel.querySelector(".plan-results")
  };

  function closeSearch() {
    el.form.hidden = true;
    el.results.innerHTML = "";
    el.find.classList.remove("on");
  }

  el.form.addEventListener("submit", function (e) {
    e.preventDefault();
    el.input.blur();
    search(el.input.value, el.results);
  });
  el.find.addEventListener("click", function () {
    if (el.form.hidden) {
      el.form.hidden = false;
      el.find.classList.add("on");
      el.input.focus();
    } else {
      closeSearch();
    }
  });
  el.save.addEventListener("click", saveRoute);
  el.undo.addEventListener("click", undo);
  el.redo.addEventListener("click", redo);
  el.round.addEventListener("click", toggleRoundtrip);
  el.profile.addEventListener("click", cycleProfile);
  el.start.addEventListener("click", function () {
    if (plan.points.length) goTo(plan.points[0]);
  });
  panel.querySelector(".plan-exit").addEventListener("click", function () {
    if (plan.dirty && plan.points.length &&
        !window.confirm("Die Änderungen sind noch nicht gespeichert. Trotzdem beenden?\n(Der Entwurf bleibt erhalten.)")) return;
    stop();
  });

  function renderPanel() {
    var n = plan.points.length;
    el.name.textContent = plan.name || "Neue Route";
    el.dirty.hidden = !(plan.dirty && n);

    // Kennzahlen; Vorschlag zusätzlich in Orange
    var html = "";
    if (n) {
      var t = totals();
      html = n + " Pkt · " + km(t.dist) + (t.asc != null ? " · ↑ " + Math.round(t.asc) + " m" : "");
      if (t.lines) html += ' · <span class="plan-warn" title="Abschnitte ohne gefundenen Weg">⚠ ' + t.lines + "</span>";
    }
    if (candidate) {
      var add = 0;
      var noWay = false;
      [candidate.seg, candidate.before, candidate.after].forEach(function (s) {
        if (s) { add += s.distance; if (s.source === "Luftlinie") noWay = true; }
      });
      html += (html ? " · " : "") + '<span class="plan-cand">' +
        (candidate.loading ? "…" : (add ? "+" + km(add) : "Start")) + (noWay ? " ⚠" : "") + "</span>";
    }
    el.sum.innerHTML = html || "–";

    el.save.disabled = !n || (!plan.dirty && !!plan.savedId);
    el.undo.disabled = !past.length;
    el.redo.disabled = !future.length;
    el.start.disabled = !n;
    el.round.classList.toggle("on", plan.roundtrip);
    el.round.setAttribute("aria-pressed", plan.roundtrip ? "true" : "false");
    var prof = PROFILES[plan.profile];
    el.profile.innerHTML = G.icon(prof.icon);
    el.profile.title = "Routing: " + prof.label + " (antippen zum Wechseln)";
    el.profile.setAttribute("aria-label", el.profile.title);
  }

  // ---------- Speichern und „Geplant“ ----------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function defaultName() {
    return "Route vom " + new Date().toLocaleDateString("de-DE");
  }

  function saveRoute() {
    if (!plan.points.length) return;
    if (!G.db) {
      G.showStatus("Lokaler Speicher nicht verfügbar – Speichern nicht möglich.", 6000);
      return;
    }
    if (plan.savedId) {
      writeRoute(plan.name);
      return;
    }
    G.askText("Name der Route", plan.name || defaultName(), function (name) {
      writeRoute(String(name).trim() || defaultName());
    }, "Speichern");
  }

  function writeRoute(name) {
    var t = totals();
    var now = new Date().toISOString();
    var rec = {
      id: plan.savedId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      name: name,
      createdAt: plan.createdAt || now,
      updatedAt: now,
      points: clone(plan.points),
      segments: clone(plan.segments),
      roundtrip: plan.roundtrip,
      closing: plan.closing ? clone(plan.closing) : null,
      profile: plan.profile,
      stats: { length: t.dist, ascent: t.asc, points: plan.points.length, lines: t.lines }
    };
    G.db.put("routes", rec).then(function () {
      plan.savedId = rec.id;
      plan.name = rec.name;
      plan.createdAt = rec.createdAt;
      plan.dirty = false;
      savePlan();
      render();
      loadRoutes();
      G.showStatus("Route „" + rec.name + "“ gespeichert.", 3000);
    }).catch(function (err) {
      G.showStatus("Speichern fehlgeschlagen: " + err.message, 6000);
    });
  }

  var savedRoutes = [];

  function loadRoutes() {
    if (!G.db) return Promise.resolve();
    return G.db.all("routes").then(function (all) {
      savedRoutes = (all || []).sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; });
      renderRoutesList();
    }).catch(function (err) {
      console.warn("[GoAhead] Geplante Routen nicht lesbar:", err);
    });
  }

  function renderRoutesList() {
    var box = G.tracksPanel && G.tracksPanel("planned");
    if (!box) return;
    var newBtn = '<button type="button" class="trk-import plan-newroute">＋ Neue Route planen</button>';
    if (!savedRoutes.length) {
      box.innerHTML = newBtn + '<p class="trk-empty">Noch keine geplanten Routen.</p>';
      return;
    }
    box.innerHTML = newBtn + savedRoutes.map(function (r) {
      var st = r.stats || {};
      var info = [];
      if (st.length) info.push(km(st.length));
      if (st.ascent != null) info.push("↑ " + Math.round(st.ascent) + " m");
      info.push((st.points || r.points.length) + " Punkte");
      if (r.roundtrip) info.push("Rundtour");
      info.push(new Date(r.updatedAt).toLocaleDateString("de-DE"));
      var editing = plan.savedId === r.id && plan.dirty;
      return '<div class="trk-item trk-tap" role="button" tabindex="0" data-id="' + esc(r.id) + '">' +
        '<div class="trk-main"><span class="trk-swatch" style="background:' + COLOR_ROUTE + '"></span>' +
          '<span class="trk-text"><span class="trk-name">' + esc(r.name) + "</span>" +
          '<span class="trk-info">' + esc(info.join(" · ")) + (editing ? " · <em>ungespeicherte Änderungen</em>" : "") + "</span></span>" +
        "</div>" +
        '<span class="trk-more" aria-hidden="true">›</span></div>';
    }).join("");
  }

  function findRoute(id) {
    for (var i = 0; i < savedRoutes.length; i++) if (savedRoutes[i].id === id) return savedRoutes[i];
    return null;
  }

  function editRoute(rec) {
    var sameDraft = plan.savedId === rec.id;
    if (plan.dirty && plan.points.length) {
      var q = sameDraft
        ? "Für diese Route gibt es ungespeicherte Änderungen. Mit den Änderungen weitermachen?\n(Abbrechen = Änderungen verwerfen und gespeicherten Stand laden)"
        : "Die aktuelle Planung hat ungespeicherte Änderungen. Verwerfen und „" + rec.name + "“ laden?";
      var ok = window.confirm(q);
      if (sameDraft && ok) { openPlanner(); return; }
      if (!sameDraft && !ok) return;
    }
    var profile = plan.profile;
    plan = newPlanState();
    plan.points = clone(rec.points);
    plan.segments = clone(rec.segments);
    plan.roundtrip = !!rec.roundtrip;
    plan.closing = rec.closing ? clone(rec.closing) : null;
    plan.profile = PROFILES[rec.profile] ? rec.profile : profile;
    plan.savedId = rec.id;
    plan.name = rec.name;
    plan.createdAt = rec.createdAt;
    plan.dirty = false;
    candidate = null;
    selected = null;
    armed = false;
    resetHistory();
    savePlan();
    openPlanner();
  }

  function openPlanner() {
    if (G.closeTracksPage) G.closeTracksPage();
    if (active) stop();
    start();
  }

  function deleteRoute(rec) {
    if (!window.confirm("Geplante Route „" + rec.name + "“ löschen?")) return;
    G.db.del("routes", rec.id).then(function () {
      if (plan.savedId === rec.id) {
        // die gerade geöffnete Planung bleibt als ungespeicherter Entwurf erhalten
        plan.savedId = null;
        plan.dirty = plan.points.length > 0;
        savePlan();
        if (active) render();
      }
      return loadRoutes();
    }).catch(function (err) {
      G.showStatus("Löschen fehlgeschlagen: " + err.message, 6000);
    });
  }

  (function wireRoutesList() {
    var box = G.tracksPanel && G.tracksPanel("planned");
    if (!box) return;
    box.addEventListener("click", function (e) {
      if (e.target.closest(".plan-newroute")) { newPlan(); return; }
      var item = e.target.closest(".trk-item");
      if (!item) return;
      var rec = findRoute(item.getAttribute("data-id"));
      if (rec) routeMenu(rec);
    });
  })();

  function routeMenu(rec) {
    var st = rec.stats || {};
    var sub = [st.length ? km(st.length) : null, (st.points || rec.points.length) + " Punkte", rec.roundtrip ? "Rundtour" : null]
      .filter(Boolean).join(" · ");
    var actions = [];
    if (G.nav) actions.push({ label: "▶ Los geht's", primary: true, onClick: function () { G.nav.start(rec); } });
    actions.push({ label: "✎ Verändern", onClick: function () { editRoute(rec); } });
    actions.push({ label: "⬇ GPX exportieren", onClick: function () { exportRouteGpx(rec); } });
    actions.push({ label: "🗑 Löschen", danger: true, onClick: function () { deleteRoute(rec); } });
    G.actionSheet(rec.name, sub, actions);
  }

  // Gesamte Linie einer geplanten Route (Abschnitte aneinandergehängt, inkl. Rundtour-Rückweg)
  function routeLine(rec) {
    var out = [];
    var segs = (rec.segments || []).slice();
    if (rec.roundtrip && rec.closing) segs.push(rec.closing);
    segs.forEach(function (seg) {
      if (!seg || !seg.latlngs) return;
      seg.latlngs.forEach(function (ll, i) {
        if (i === 0 && out.length) {
          var last = out[out.length - 1];
          if (last[0] === ll[0] && last[1] === ll[1]) return;   // doppelte Anschlusspunkte weglassen
        }
        out.push(ll);
      });
    });
    if (!out.length) out = rec.points.map(function (p) { return [p.lat, p.lng]; });
    return out;
  }

  function xmlEsc(t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c];
    });
  }

  function fileNameFor(name) {
    // Buchstaben, Ziffern, Bindestrich, Punkt bleiben (z. B. Datum 3.11.2026); Rest entfällt
    return (String(name).replace(/[^\w\-.äöüÄÖÜß ]+/g, "").replace(/\.+$/, "").trim().replace(/\s+/g, "_").replace(/_+/g, "_") || "route") + ".gpx";
  }

  // GPX 1.1: Track (berechnete Linie) und Wegpunkte (geplante Punkte)
  function routeToGpx(rec) {
    var lines = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="GoAhead" xmlns="http://www.topografix.com/GPX/1/1">',
      "  <metadata><name>" + xmlEsc(rec.name) + "</name><time>" + new Date().toISOString() + "</time></metadata>"];
    rec.points.forEach(function (p, i) {
      lines.push('  <wpt lat="' + p.lat + '" lon="' + p.lng + '"><name>' + (i === 0 ? "Start" : "Punkt " + i) + "</name></wpt>");
    });
    lines.push("  <trk><name>" + xmlEsc(rec.name) + "</name><trkseg>");
    routeLine(rec).forEach(function (ll) {
      lines.push('    <trkpt lat="' + ll[0] + '" lon="' + ll[1] + '"></trkpt>');
    });
    lines.push("  </trkseg></trk>", "</gpx>");
    return lines.join("\n");
  }

  function exportRouteGpx(rec) {
    G.downloadFile(fileNameFor(rec.name), routeToGpx(rec), "application/gpx+xml");
  }

  // Neue, leere Planung beginnen (Knopf in Tracks → Geplant)
  function newPlan() {
    function go() {
      var profile = plan.profile;
      plan = newPlanState();
      plan.profile = profile;
      candidate = null;
      selected = null;
      armed = false;
      routeVersion++;
      resetHistory();
      savePlan();
      openPlanner();
    }
    if (plan.dirty && plan.points.length) {
      G.actionSheet("Ungespeicherte Planung verwerfen?", plan.name || "Neue Route", [
        { label: "Verwerfen und neu beginnen", danger: true, onClick: go }
      ]);
    } else {
      go();
    }
  }

  // ---------- Modus ein/aus ----------

  function start() {
    if (active) return;
    active = true;
    selected = null;
    armed = false;
    candidate = null;
    if (G.closeMenu) G.closeMenu();
    if (G.closeInfoPanel) G.closeInfoPanel();
    if (G.stopFollowing) G.stopFollowing();
    document.body.classList.add("mode-plan");
    panel.hidden = false;
    layer.addTo(map);
    G.setMapClickHandler(function (e) { onMapTap(e.latlng); });
    render();
    if (plan.points.length) {
      var b = L.latLngBounds(plan.points.map(function (p) { return [p.lat, p.lng]; }));
      map.fitBounds(b, { padding: [40, 40], maxZoom: 16 });
    }
    resumePending();
  }

  function stop() {
    if (!active) return;
    active = false;
    candidate = null;
    selected = null;
    armed = false;
    routeVersion++;
    closeSearch();
    map.closePopup();
    G.setMapClickHandler(null);
    document.body.classList.remove("mode-plan");
    panel.hidden = true;
    map.removeLayer(layer);
    renderRoutesList();
  }

  // ---------- Menüknopf ----------

  var PlannerControl = L.Control.extend({
    onAdd: function () {
      var box = L.DomUtil.create("div", "leaflet-bar plan-control");
      var btn = L.DomUtil.create("a", "plan-toggle", box);
      btn.href = "#";
      btn.setAttribute("role", "button");
      btn.title = "Route planen";
      btn.setAttribute("aria-label", "Route planen");
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
        '<path d="M6 18c4 0 3-6 7-6s4-5 5-6" fill="none" stroke="' + COLOR_ROUTE + '" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="3 3"/>' +
        '<circle cx="6" cy="18" r="2.6" fill="#2f9e44"/><path d="M18 2.5a3 3 0 0 1 3 3c0 2.2-3 5-3 5s-3-2.8-3-5a3 3 0 0 1 3-3z" fill="' + COLOR_ROUTE + '"/></svg>';
      L.DomEvent.on(btn, "click", function (e) {
        L.DomEvent.preventDefault(e);
        start();
      });
      L.DomEvent.disableClickPropagation(box);
      return box;
    }
  });
  if (G.addToToolbar) G.addToToolbar(new PlannerControl());

  loadPlan();
  loadRoutes();

  // für Tests und spätere Module
  G.planner = {
    start: start,
    stop: stop,
    newPlan: newPlan,
    undo: undo,
    redo: redo,
    parseCoordinates: parseCoordinates,
    getPlan: function () { return plan; },
    routeLine: routeLine,
    xmlEsc: xmlEsc,
    fileNameFor: fileNameFor,
    isActive: function () { return active; }
  };
})();
