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

  var T = window.GOAHEAD_I18N.t;
  var dec = window.GOAHEAD_I18N.dec;
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
  var fresh = null;      // eben eingefügter, noch vorläufiger Zwischenpunkt {index, ref, wasDirty}
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
      dirty: false,    // Änderungen seit dem letzten Speichern
      loop: null       // automatisch berechnete Rundtour: {km, dir} (für „andere Variante“)
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
    return JSON.stringify({ points: plan.points, segments: plan.segments, roundtrip: plan.roundtrip, closing: plan.closing, loop: plan.loop || null });
  }

  // vor jeder Änderung aufrufen
  function pushHistory() {
    fresh = null;   // jede weitere Änderung übernimmt einen vorläufigen Zwischenpunkt
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
    plan.loop = s.loop || null;
    candidate = null;
    selected = null;
    armed = false;
    fresh = null;
    routeVersion++;
    markDirty();
    resumePending();
    render();
  }

  // Vorläufigen Zwischenpunkt wieder wegnehmen (Tipp woanders = Versehen):
  // Stand vor dem Einfügen wiederherstellen, ohne Spur im Rückgängig-Verlauf.
  function discardFresh() {
    if (!fresh) return false;
    var wasDirty = fresh.wasDirty;
    restore(past.pop());
    plan.dirty = wasDirty;
    savePlan();
    if (typeof renderRoutesList === "function") renderRoutesList();
    render();
    return true;
  }

  // Abschnittsbezug nach dem Wegnehmen des vorläufigen Punkts umrechnen
  function refAfterDiscard(ref, f) {
    if (ref === "closing") return "closing";
    if (f.ref === "closing") return ref === f.index - 1 ? "closing" : ref;
    if (ref === f.ref || ref === f.ref + 1) return f.ref;
    return ref > f.ref + 1 ? ref - 1 : ref;
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
        // Höhe (dritter Wert) behalten, wenn vorhanden – für Höhenprofil, Höhenmeter und Dauer
        var latlngs = f.geometry.coordinates.map(function (c) {
          return c.length > 2 && c[2] != null ? [round6(c[1]), round6(c[0]), Math.round(c[2] * 10) / 10] : [round6(c[1]), round6(c[0])];
        });
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
    var list = PROFILES[currentProfile()].engines;
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
    if (n > 1 && G.directionArrows) G.directionArrows(routeLine(plan)).addTo(routeLines);

    plan.points.forEach(function (p, i) {
      var isFresh = fresh && fresh.index === i;
      var kind = isFresh ? "cand" : i === selected ? (armed ? "del" : "sel") : (i === 0 ? "start" : (i === n - 1 ? "last" : "mid"));
      var label = isFresh ? "+" : i === selected && armed ? "−" : (i === 0 ? "S" : String(i));
      var m = L.marker([p.lat, p.lng], {
        icon: pointIcon(label, kind),
        draggable: true,
        title: i === 0 ? T("Startpunkt") : T("Punkt {0}", i),
        zIndexOffset: i === selected ? 700 : 500
      });
      m.on("click", function (e) {
        L.DomEvent.stopPropagation(e);
        onPointTap(i);
      });
      // Punkt ziehen = Ersatzvorschlag an der neuen Stelle
      m.on("dragend", function () {
        fresh = null;   // gezogen = gewollt; wird zum normalen Verschiebe-Vorschlag
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

  // Regel für alle vorläufigen (orangen) Punkte: antippen = übernehmen, ziehen = verschieben,
  // Tipp woanders = Versehen, wieder wegnehmen.
  function discardCandidate() {
    if (!candidate) return false;
    candidate = null;
    selected = null;
    armed = false;
    routeVersion++;
    render();
    return true;
  }

  function onMapTap(latlng) {
    if (loopArmed) {                    // Rundtour: dieser Tipp ist der Startpunkt
      var la = loopArmed;
      computeLoop(latlng, la.km, la.dir);
      return;
    }
    if (fresh && !candidate) {          // vorläufiger Zwischenpunkt: Tipp woanders nimmt ihn weg
      discardFresh();
      return;
    }
    if (discardCandidate()) return;     // Vorschlagspunkt: Tipp woanders nimmt ihn weg
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
    if (fresh) {
      if (fresh.index === i) {          // Tipp auf den vorläufigen Punkt: übernehmen
        fresh = null;
        selected = null;
        armed = false;
        render();
        return;
      }
      var fi = fresh.index;             // Tipp auf einen anderen Punkt: vorläufigen wegnehmen
      discardFresh();
      if (i > fi) i--;
    }
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
    if (fresh && !candidate) {
      // Tipp auf eine Strecke nimmt den vorläufigen Punkt weg; ein schneller zweiter Tipp
      // gilt trotzdem als Doppeltipp (Weg/direkt), fügt aber keinen neuen Punkt ein
      var f = fresh;
      discardFresh();
      if (lastSegTap) clearTimeout(lastSegTap.timer);
      lastSegTap = { ref: refAfterDiscard(ref, f), t: Date.now(), timer: null };
      return;
    }
    if (candidate) {                     // offener Vorschlag: Tipp auf eine Strecke nimmt ihn weg
      discardCandidate();
      if (lastSegTap) clearTimeout(lastSegTap.timer);
      lastSegTap = { ref: ref, t: Date.now(), timer: null };
      return;
    }
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
      if (d < best.d) best = { d: d, k: k, q: map.unproject(c, zoom), t: a.distanceTo(b) ? a.distanceTo(c) / a.distanceTo(b) : 0 };
    }
    var q = [round6(best.q.lat), round6(best.q.lng)];
    var e0 = latlngs[best.k][2];
    var e1 = latlngs[best.k + 1][2];
    if (e0 != null && e1 != null) q.push(Math.round((e0 + (e1 - e0) * best.t) * 10) / 10);
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
    var wasDirty = plan.dirty;
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
    // vorläufig, bis er angetippt (übernehmen) oder gezogen wird; Tipp woanders nimmt ihn weg
    fresh = { index: selected, ref: ref, wasDirty: wasDirty };
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

  // ---------- Rundtour nach Länge (BRouter) ----------
  //
  // BRouter berechnet mit engineMode=4 und nur einem Punkt eine Runde (geprüft im Quelltext abrensch/brouter,
  // RoutingEngine.doRoundTrip/buildPointsFromCircle und RoutingParamCollector, sowie per Actions-Lauf
  // „BRouter-Rundtour prüfen“ gegen brouter.de: CORS *, Antwort wie beim normalen Routing).
  // roundTripDistance ist NICHT die Länge, sondern der Radius des Kreises, auf dem BRouter Wegpunkte setzt.
  // Gemessen war die Länge das 5,4- bis 8,9-Fache des Radius. BRouter vermeidet doppelte Wege nicht sicher
  // (Stichwege zu Wegpunkten) – daher mehrere Richtungen, Prüfung auf doppelte Wege, Auswahl (computeLoop).
  // Immer BRouter (auch wenn OSRM eingestellt ist – OSRM kennt keine Rundtour).
  var LOOP_KEY = "goahead.loopKm.v1";
  var LOOP_TOL = 0.06;      // ±6 % gilt als getroffen
  var loopArmed = null;     // km, wenn auf den Startpunkt gewartet wird
  var loopBusy = false;

  function loopRequest(start, radius, dir) {
    var url = BROUTER_URL + "?lonlats=" + start.lng.toFixed(6) + "," + start.lat.toFixed(6) +
      "&profile=hiking-mountain&alternativeidx=0&format=geojson&engineMode=4" +
      "&roundTripDistance=" + Math.round(radius) + "&roundTripStartDirection=" + Math.round(dir);
    return fetchJson(url, 30000).then(function (gj) {
      var f = gj && gj.features && gj.features[0];
      if (!f || !f.geometry || !f.geometry.coordinates || f.geometry.coordinates.length < 3) throw new Error("keine Runde gefunden");
      var latlngs = f.geometry.coordinates.map(function (c) {
        return c.length > 2 && c[2] != null ? [round6(c[1]), round6(c[0]), Math.round(c[2] * 10) / 10] : [round6(c[1]), round6(c[0])];
      });
      var dist = parseFloat((f.properties || {})["track-length"]);
      return { latlngs: latlngs, distance: isNaN(dist) ? lengthOf(latlngs) : dist };
    });
  }

  // Doppelt gegangene Strecke einer Runde: Linie alle 10 m abtasten; ein Punkt gilt als doppelt, wenn ein
  // anderer Teil der Runde (mehr als 60 m entlang der Strecke entfernt) näher als 15 m liegt.
  // Gesondert: der „Stiel“ am Start – Anfang und Ende der Runde auf demselben Weg (Start in einer Sackgasse
  // bzw. an einem Weg ohne Abzweig). Rückgabe {ov: Anteil doppelt, core: Anteil doppelt ohne Stiel, stem: m}.
  function overlapInfo(latlngs) {
    var pts = [];
    var s = 0, step = 10, next = 0;
    for (var i = 1; i < latlngs.length; i++) {
      var a = L.latLng(latlngs[i - 1][0], latlngs[i - 1][1]), b = L.latLng(latlngs[i][0], latlngs[i][1]);
      var d = a.distanceTo(b);
      while (next <= s + d && d > 0) {
        var t = (next - s) / d;
        pts.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, s: next });
        next += step;
      }
      s += d;
    }
    if (pts.length < 10) return { ov: 0, core: 0, stem: 0 };
    var total = s;
    var kx = 111320 * Math.cos(pts[0].lat * Math.PI / 180), ky = 110540, cell = 25;
    var grid = {};
    pts.forEach(function (p, k) {
      p.x = p.lng * kx; p.y = p.lat * ky;
      var key = Math.floor(p.x / cell) + "," + Math.floor(p.y / cell);
      (grid[key] = grid[key] || []).push(k);
    });
    // Stiel: Punkte gleich weit vom Anfang und vom Ende liegen höchstens 20 m auseinander
    var stem = 0;
    for (var h = 0; h < pts.length / 2; h++) {
      var p1 = pts[h], p2 = pts[pts.length - 1 - h];
      if ((p1.x - p2.x) * (p1.x - p2.x) + (p1.y - p2.y) * (p1.y - p2.y) > 400) break;
      stem = p1.s;
    }
    var doubled = 0, doubledCore = 0, coreCount = 0;
    pts.forEach(function (p) {
      var cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), hit = false;
      for (var dx = -1; dx <= 1 && !hit; dx++) {
        for (var dy = -1; dy <= 1 && !hit; dy++) {
          var list = grid[(cx + dx) + "," + (cy + dy)];
          if (!list) continue;
          for (var k = 0; k < list.length; k++) {
            var q = pts[list[k]];
            var along = Math.abs(q.s - p.s);
            if (along <= 60 || total - along <= 60) continue;   // Nachbarpunkt bzw. Start = Ziel
            if ((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y) < 225) { hit = true; break; }
          }
        }
      }
      var inStem = stem > 0 && (p.s <= stem + 20 || p.s >= total - stem - 20);
      if (hit) doubled++;
      if (!inStem) { coreCount++; if (hit) doubledCore++; }
    });
    return { ov: doubled / pts.length, core: coreCount ? doubledCore / coreCount : 0, stem: stem };
  }

  // Stichwege herausschneiden: Abschnitte, die auf demselben Weg hin und wieder zurück führen
  // (Punkt j … Umkehr … Punkt i an derselben Stelle, und Hin- und Rückweg liegen spiegelbildlich
  // höchstens 20 m auseinander). Kleine Schleifen (z. B. um einen Block) bleiben, nur Hin-und-zurück fällt weg.
  function removeSpurs(latlngs) {
    var ll = latlngs.slice();
    var kx = 111320 * Math.cos(ll[0][0] * Math.PI / 180), ky = 110540;
    function d(a, b) { var dx = (a[1] - b[1]) * kx, dy = (a[0] - b[0]) * ky; return Math.sqrt(dx * dx + dy * dy); }
    for (var pass = 0; pass < 50; pass++) {
      var cum = [0];
      for (var c = 1; c < ll.length; c++) cum.push(cum[c - 1] + d(ll[c - 1], ll[c]));
      var at = function (sAlong, from, to) {   // Punkt bei Strecke sAlong zwischen den Indizes from..to
        var k = from;
        while (k < to && cum[k + 1] < sAlong) k++;
        var seg = cum[k + 1] - cum[k], t = seg ? (sAlong - cum[k]) / seg : 0;
        return [ll[k][0] + (ll[k + 1][0] - ll[k][0]) * t, ll[k][1] + (ll[k + 1][1] - ll[k][1]) * t];
      };
      var cut = null;
      for (var i = 2; i < ll.length && !cut; i++) {
        for (var j = i - 2; j >= 0; j--) {
          var len = cum[i] - cum[j];
          if (len > 4000) break;
          if (len < 20 || d(ll[i], ll[j]) > 10) continue;
          var half = len / 2, ok = true;
          for (var t = 0.1; t < 0.95 && ok; t += 0.1) {
            if (d(at(cum[j] + t * half, j, i), at(cum[i] - t * half, j, i)) > 20) ok = false;
          }
          if (ok) { cut = [j, i]; break; }
        }
      }
      if (!cut) break;
      ll.splice(cut[0] + 1, cut[1] - cut[0]);   // Punkte zwischen j und i (inkl. i) weg; j bleibt
    }
    return ll;
  }

  // Auswahl: 1. Runden ganz ohne doppelte Wege (Toleranz), 2. sonst Runden, die nur am Start-Stiel doppelt
  // sind (Start in einer Sackgasse – unvermeidlich, wenn keine Richtung ohne Stiel auskommt), 3. sonst die mit
  // den wenigsten doppelten Wegen. Darin: Länge ±6 % → am nächsten; sonst nächstlängere bzw. -kürzere.
  // erlaubter Anteil doppelt gegangener Strecke (Einstellung loopOverlapPct, Standard 0 %)
  function overlapOk() {
    var v = G.getSettings().loopOverlapPct;
    return (typeof v === "number" && v >= 0 ? v : 0) / 100 + 1e-9;
  }
  function okFull(c) { return c.ov <= overlapOk(); }
  function okCore(c) { return c.core <= overlapOk(); }
  function cleanPool(cands) {
    var full = cands.filter(okFull);
    if (full.length) return full;
    return cands.filter(okCore);
  }
  function pickLoop(cands, target, preferShorter) {
    if (!cands.length) return null;
    var pool = cleanPool(cands);
    if (!pool.length) {
      var minOv = Math.min.apply(null, cands.map(function (c) { return c.core; }));
      pool = cands.filter(function (c) { return c.core <= minOv + 0.02; });
    }
    var hit = pool.filter(function (c) { return Math.abs(c.distance - target) / target <= LOOP_TOL; });
    if (hit.length) return hit.sort(function (a, b) { return Math.abs(a.distance - target) - Math.abs(b.distance - target); })[0];
    var longer = pool.filter(function (c) { return c.distance > target; }).sort(function (a, b) { return a.distance - b.distance; });
    var shorter = pool.filter(function (c) { return c.distance < target; }).sort(function (a, b) { return b.distance - a.distance; });
    return preferShorter ? (shorter[0] || longer[0]) : (longer[0] || shorter[0]);
  }

  // Suche (ohne Rückfrage):
  //  - 6 Richtungen, Radius aus dem gemessenen Verhältnis Länge/Radius;
  //  - keine Runde innerhalb der Toleranz: 6 weitere Richtungen, danach Runden mit größerem Radius (×1,6, ×2,5),
  //    bis eine passt – längere Runden ohne doppelte Wege gibt es praktisch immer;
  //  - dann bis zu 3 Nachbesserungen der Länge an der besten passenden Richtung (bei „nächstlängere“
  //    eher etwas zu lang als zu kurz).
  // Warnung, wenn die Länge um mehr als „Rundtour: Warnung ab Abweichung“ (Standard 20 %) abweicht.
  function computeLoop(start, km, dir) {
    if (loopBusy) return;
    loopBusy = true;
    loopArmed = null;
    var target = km * 1000;
    var factor = 6.5;              // Länge / Radius, wird aus den Antworten nachgeführt
    var ratios = [];
    var cands = [];
    var n = 0;
    var preferShorter = (G.getSettings().loopPrefer === "shorter");
    function ask(d, radius) {
      n++;
      G.showStatus(T("Rundtour {0} km wird gesucht … ({1})", dec(km), n));
      return loopRequest(start, radius, d).then(function (res) {
        // erst Stichwege entfernen, dann Länge und doppelte Wege bewerten
        var before = lengthOf(res.latlngs);
        res.latlngs = removeSpurs(res.latlngs);
        var after = lengthOf(res.latlngs);
        if (before > 0) res.distance = res.distance * after / before;
        var o = overlapInfo(res.latlngs);
        res.ov = o.ov;
        res.core = o.core;
        res.stem = o.stem;
        res.dir = d;
        res.radius = radius;
        cands.push(res);
        ratios.push(res.distance / radius);
        factor = ratios.reduce(function (x, y) { return x + y; }, 0) / ratios.length;
        return res;
      }, function () { return null; });
    }
    function done() {
      return cands.some(function (c) { return okFull(c) && Math.abs(c.distance - target) / target <= LOOP_TOL; });
    }
    // Richtungen: erst 6 im 60°-Raster, dann 6 dazwischen; danach mit größerem Radius
    var steps = [];
    for (var k = 0; k < 6; k++) steps.push({ d: (dir + k * 60) % 360, f: 1 });
    for (k = 0; k < 6; k++) steps.push({ d: (dir + 30 + k * 60) % 360, f: 1, onlyIfNone: true });
    [1.6, 2.5].forEach(function (f) { for (var m = 0; m < 6; m++) steps.push({ d: (dir + m * 60) % 360, f: f, onlyIfNone: true }); });
    var idx = 0;
    function search() {
      if (done() || idx >= steps.length) return Promise.resolve();
      var step = steps[idx++];
      if (step.onlyIfNone && cleanPool(cands).length) return Promise.resolve();
      return ask(step.d, step.f * target / factor).then(search);
    }
    function refine(i) {
      if (i >= 3 || done()) return Promise.resolve();
      var pool = cleanPool(cands);
      if (!pool.length) return Promise.resolve();
      var base = pool.slice().sort(function (a, b) { return Math.abs(a.distance - target) - Math.abs(b.distance - target); })[0];
      if (Math.abs(base.distance - target) / target <= LOOP_TOL) return Promise.resolve();
      var want = target * (preferShorter ? 0.97 : 1.03);
      var r = Math.max(200, base.radius * Math.min(3, Math.max(0.33, want / base.distance)));
      // dieselbe Anfrage (Richtung, Radius auf 2 %) nicht wiederholen
      if (cands.some(function (c) { return c.dir === base.dir && Math.abs(c.radius - r) / r < 0.02; })) return Promise.resolve();
      return ask(base.dir, r).then(function () { return refine(i + 1); });
    }
    search().then(function () { return refine(0); }).then(function () {
      loopBusy = false;
      var res = pickLoop(cands, target, preferShorter);
      if (!res) throw new Error("keine Runde gefunden");
      applyLoop(res, km, res.dir);
      var dev = (res.distance - target) / target;
      var warnAt = (function () { var v = G.getSettings().loopWarnPct; return typeof v === "number" ? v : 20; })() / 100;
      var msg = T("Rundtour: {0} km (gewünscht {1} km)", dec((res.distance / 1000).toFixed(1)), dec(km));
      var warn = false;
      if (Math.abs(dev) > warnAt) { msg += " · ⚠ " + T("{0} % Länge", (dev > 0 ? "+" : "") + Math.round(dev * 100)); warn = true; }
      if (!okCore(res)) {
        msg += " · ⚠ " + T("{0} % doppelt", res.core < 0.1 ? dec((res.core * 100).toFixed(1)) : Math.round(res.core * 100));
        warn = true;
      }
      G.showStatus(msg + ".", warn ? 10000 : 5000);
    }).catch(function (err) {
      loopBusy = false;
      console.warn("[GoAhead] Rundtour:", err);
      G.showStatus("Keine Rundtour gefunden. Bitte Internetverbindung prüfen oder einen anderen Startpunkt wählen.", 8000);
    });
  }

  // Runde → Planung: Wegpunkte etwa alle 1–3 km, Abschnitte dazwischen, letzter Abschnitt = Rückweg zum Start
  function applyLoop(res, km, dir) {
    var ll = res.latlngs;
    var total = lengthOf(ll);
    var scale = total ? res.distance / total : 1;
    var spacing = Math.min(3000, Math.max(1000, res.distance / 6)) / scale;
    var cuts = [0];
    var acc = 0;
    for (var i = 1; i < ll.length - 1; i++) {
      acc += L.latLng(ll[i - 1][0], ll[i - 1][1]).distanceTo(L.latLng(ll[i][0], ll[i][1]));
      if (acc >= spacing) { cuts.push(i); acc = 0; }
    }
    if (cuts.length < 3) cuts = [0, Math.floor(ll.length / 3), Math.floor(2 * ll.length / 3)];
    function part(a, b) {
      var pl = ll.slice(a, b + 1);
      return { latlngs: pl, distance: lengthOf(pl) * scale, ascent: null, source: "BRouter", mode: "route" };
    }
    pushHistory();
    var keepName = plan.savedId ? plan.name : "";
    var savedId = plan.savedId, createdAt = plan.createdAt;
    plan = newPlanState();
    plan.savedId = savedId;
    plan.createdAt = createdAt;
    plan.name = keepName || T("Rundtour {0} km", dec((res.distance / 1000).toFixed(1)));
    plan.points = cuts.map(function (c) { return { lat: ll[c][0], lng: ll[c][1] }; });
    for (var k = 1; k < cuts.length; k++) plan.segments.push(part(cuts[k - 1], cuts[k]));
    plan.roundtrip = true;
    var last = plan.points[plan.points.length - 1];
    plan.closing = part(cuts[cuts.length - 1], ll.length - 1);
    plan.closing.key = closingKey(last, plan.points[0]);
    plan.loop = { km: km, dir: dir };
    plan.dirty = true;
    candidate = null;
    selected = null;
    armed = false;
    fresh = null;
    savePlan();
    render();
    fitPlan();
  }

  function askLoopKm(then) {
    var last = "10";
    try { last = window.localStorage.getItem(LOOP_KEY) || last; } catch (e) { /* Standard */ }
    G.askText("Rundtour – Länge in km", last, function (v) {
      var km = parseFloat(String(v).replace(",", "."));
      if (!(km >= 1 && km <= 200)) { G.showStatus("Bitte eine Länge zwischen 1 und 200 km angeben.", 5000); return; }
      try { window.localStorage.setItem(LOOP_KEY, String(km)); } catch (e) { /* egal */ }
      then(km);
    }, "Weiter");
  }

  // Knopf „Rundtour“: ohne Route → Länge abfragen, dann Startpunkt (oder vorhandenen ersten Punkt) nehmen;
  // bei berechneter Runde → Varianten; bei eigener Planung mit mehreren Punkten → wie bisher schließen/öffnen
  function onRoundButton() {
    if (loopBusy) return;
    if (plan.loop) {
      var lp = plan.loop;
      var start = plan.points[0];
      G.actionSheet(T("Rundtour {0} km", dec(lp.km)), "", [
        { label: "↻ Andere Variante", primary: true, onClick: function () { computeLoop(start, lp.km, (lp.dir + 30) % 360); } },
        { label: "Länge ändern", onClick: function () { askLoopKm(function (km) { computeLoop(start, km, lp.dir); }); } },
        { label: "Als eigene Planung weiter (Rückweg öffnen)", onClick: function () { plan.loop = null; toggleRoundtrip(); } }
      ]);
      return;
    }
    if (plan.points.length >= 2) { toggleRoundtrip(); return; }
    askLoopKm(function (km) {
      var dir = Math.floor(Math.random() * 360);
      if (plan.points.length === 1) { computeLoop(plan.points[0], km, dir); return; }
      loopArmed = { km: km, dir: dir };
      G.showStatus(T("Rundtour {0} km – Startpunkt auf der Karte antippen.", dec(km)));
    });
  }

  function toggleRoundtrip() {
    pushHistory();
    plan.roundtrip = !plan.roundtrip;
    markDirty();
    updateClosing();
    render();
  }

  // Routing-Dienst kommt aus den Einstellungen (Standard: BRouter)
  function currentProfile() {
    var st = G.getSettings ? G.getSettings() : null;
    return st && st.routing === "osrm" ? "foot" : "hiking";
  }

  // ---------- Höhenprofil, Höhenmeter, Dauer ----------

  var PROFILE_STEP = 25;      // m: Raster für Profil und Dauer
  var CLIMB_THRESHOLD = 3;    // m: kleinere Höhenänderungen zählen nicht (Rauschen)

  // Punkte der gesamten Route mit Entfernung ab Start und Höhe (Lücken linear aufgefüllt)
  function buildProfile(segments, closing, roundtrip) {
    var segs = (segments || []).slice();
    if (roundtrip && closing) segs.push(closing);
    var pts = [];
    var d = 0;
    var prev = null;
    segs.forEach(function (seg) {
      if (!seg || !seg.latlngs) return;
      seg.latlngs.forEach(function (ll, i) {
        var e = ll.length > 2 && ll[2] != null ? ll[2] : null;
        if (prev && i === 0 && prev[0] === ll[0] && prev[1] === ll[1]) {
          if (e != null && pts[pts.length - 1].e == null) pts[pts.length - 1].e = e;
          return;   // Anschlusspunkt doppelt
        }
        if (prev) d += L.latLng(prev[0], prev[1]).distanceTo(L.latLng(ll[0], ll[1]));
        pts.push({ d: d, e: e, lat: ll[0], lng: ll[1] });
        prev = ll;
      });
    });
    var known = pts.filter(function (p) { return p.e != null; }).length;
    if (known) {
      // Lücken zwischen bekannten Höhen über die Strecke interpolieren, Ränder mit dem nächsten Wert füllen
      var last = -1;
      for (var i = 0; i < pts.length; i++) {
        if (pts[i].e == null) continue;
        if (last < 0) {
          for (var j = 0; j < i; j++) pts[j].e = pts[i].e;
        } else if (i - last > 1) {
          for (var k = last + 1; k < i; k++) {
            var t = (pts[k].d - pts[last].d) / ((pts[i].d - pts[last].d) || 1);
            pts[k].e = pts[last].e + (pts[i].e - pts[last].e) * t;
          }
        }
        last = i;
      }
      for (var m = last + 1; m < pts.length; m++) pts[m].e = pts[last].e;
    }
    return { pts: pts, dist: d, hasEle: known > 0 };
  }

  // gleichmäßiges Raster (alle PROFILE_STEP m) für Diagramm und Dauer
  function resample(prof) {
    var out = [];
    var pts = prof.pts;
    if (pts.length < 2) return out;
    var j = 0;
    for (var d = 0; d <= prof.dist; d += PROFILE_STEP) {
      while (j < pts.length - 2 && pts[j + 1].d < d) j++;
      var a = pts[j];
      var b = pts[j + 1];
      var t = b.d > a.d ? Math.min(1, Math.max(0, (d - a.d) / (b.d - a.d))) : 0;
      out.push({
        d: d,
        e: prof.hasEle ? a.e + (b.e - a.e) * t : null,
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t
      });
    }
    var endPt = pts[pts.length - 1];
    if (!out.length || out[out.length - 1].d < prof.dist) out.push({ d: prof.dist, e: endPt.e, lat: endPt.lat, lng: endPt.lng });
    return out;
  }

  function slopeClass(de, dd, thr) {
    if (!dd) return "flat";
    var g = de / dd;
    return g > thr ? "up" : (g < -thr ? "down" : "flat");
  }

  // Kennzahlen einer Route (Plan oder gespeicherter Datensatz)
  function routeStats(r) {
    var dist = 0;
    var lines = 0;
    var segs = (r.segments || []).slice();
    if (r.roundtrip && r.closing) segs.push(r.closing);
    segs.forEach(function (s) {
      if (!s) return;
      dist += s.distance || 0;
      if (s.source === "Luftlinie" && !s.pending) lines++;
    });
    var prof = buildProfile(r.segments, r.closing, r.roundtrip);
    var grid = resample(prof);
    var up = 0;
    var down = 0;
    var hours = 0;
    var st = G.getSettings ? G.getSettings() : { speedFlat: 4.5, speedUp: 3, speedDown: 4, slopePercent: 5 };
    var thr = st.slopePercent / 100;
    if (prof.hasEle && grid.length) {
      var ref = grid[0].e;
      grid.forEach(function (p) {
        var diff = p.e - ref;
        if (diff >= CLIMB_THRESHOLD) { up += diff; ref = p.e; }
        else if (diff <= -CLIMB_THRESHOLD) { down -= diff; ref = p.e; }
      });
    }
    for (var i = 1; i < grid.length; i++) {
      var dd = grid[i].d - grid[i - 1].d;
      var cls = prof.hasEle ? slopeClass(grid[i].e - grid[i - 1].e, dd, thr) : "flat";
      var v = cls === "up" ? st.speedUp : (cls === "down" ? st.speedDown : st.speedFlat);
      hours += dd / 1000 / v;
    }
    // Profil-Länge (Geometrie) und Routing-Länge weichen leicht ab: Dauer auf die Routing-Länge umrechnen
    if (prof.dist > 0 && dist > 0) hours *= dist / prof.dist;
    return {
      dist: dist,
      up: prof.hasEle ? up : null,
      down: prof.hasEle ? down : null,
      hours: hours,
      lines: lines,
      grid: grid,
      hasEle: prof.hasEle,
      profile: prof,
      thr: thr
    };
  }

  function totals() {
    var t = routeStats(plan);
    return { dist: t.dist, asc: t.up, desc: t.down, hours: t.hours, lines: t.lines, stats: t };
  }

  function hm(hours) {
    var mins = Math.round(hours * 60);
    return Math.floor(mins / 60) + ":" + (mins % 60 < 10 ? "0" : "") + (mins % 60);
  }

  // kurze Zusammenfassung für Listen, Teilen und GPX
  function statsText(t, withSpeeds) {
    var parts = [km(t.dist)];
    if (t.up != null) parts.push("↑ " + Math.round(t.up) + " m", "↓ " + Math.round(t.down) + " m");
    if (t.hours) parts.push("≈ " + hm(t.hours) + " h");
    var txt = parts.join(" · ");
    if (withSpeeds && G.getSettings) {
      var st = G.getSettings();
      txt += " " + T("(Gehzeit bei {0} km/h eben, {1} km/h bergauf, {2} km/h bergab)", dec(st.speedFlat), dec(st.speedUp), dec(st.speedDown));
    }
    return txt;
  }

  function km(m) { return dec((m / 1000).toFixed(1)) + " km"; }

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
      resultsEl.innerHTML = '<p class="plan-hint">Suche gerade nicht möglich. Bitte Internetverbindung prüfen.</p>';
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
        '<span class="plan-title"><span class="plan-name" data-noi18n></span><span class="plan-dirty" title="ungespeichert" hidden></span></span>' +
        '<span class="plan-sum"></span>' +
      "</span>" +
      '<span class="sheet-head-btns">' +
        iconBtn("plan-exit", "close", "Planung beenden") +
      "</span>" +
    "</div>" +
    '<div class="sheet-body">' +
      '<div class="icon-row">' +
        iconBtn("plan-save", "save", "Speichern") +
        iconBtn("plan-undo", "undo", "Rückgängig") +
        iconBtn("plan-redo", "redo", "Wiederholen") +
        '<button type="button" class="icon-btn plan-start" title="Zum Startpunkt" aria-label="Zum Startpunkt"><span class="icon-letter">S</span></button>' +
        iconBtn("plan-round", "roundtrip", "Rundtour") +

        iconBtn("plan-find", "search", "Adresse oder Koordinaten suchen") +
      "</div>" +
      '<div class="plan-profile-box" hidden><svg class="pf-svg" aria-label="Höhenprofil"></svg></div>' +
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

    find: panel.querySelector(".plan-find"),

    profBox: panel.querySelector(".plan-profile-box"),
    profSvg: panel.querySelector(".pf-svg"),
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
  el.round.addEventListener("click", onRoundButton);

  el.start.addEventListener("click", function () {
    if (plan.points.length) goTo(plan.points[0]);
  });
  // Beenden: Gespeichertes ohne Änderungen → Planung leeren (die Route liegt unter „Geplant“), sonst nachfragen.
  // „Verwerfen“ löscht den Entwurf wirklich – „Route planen“ beginnt danach leer.
  panel.querySelector(".plan-exit").addEventListener("click", function () {
    if (!(plan.dirty && plan.points.length)) { clearPlan(); stop(); return; }
    G.actionSheet("Planung beenden?", plan.savedId ? "Die Änderungen sind noch nicht gespeichert. Die gespeicherte Route bleibt unverändert."
      : "Die Route ist noch nicht gespeichert.", [
      { label: "Speichern und beenden", primary: true, onClick: function () { saveRoute(function () { clearPlan(); stop(); }); } },
      { label: "Später weiterplanen", onClick: stop },
      { label: "Verwerfen", danger: true, onClick: function () { clearPlan(); stop(); } }
    ]);
  });

  // leere Planung (Profil bleibt); der verworfene Stand ist danach auch nicht mehr über „Rückgängig“ erreichbar
  function clearPlan() {
    var profile = plan.profile;
    plan = newPlanState();
    plan.profile = profile;
    candidate = null;
    selected = null;
    armed = false;
    fresh = null;
    routeVersion++;
    resetHistory();
    savePlan();
  }

  function renderPanel() {
    var n = plan.points.length;
    el.name.textContent = plan.name || T("Neue Route");
    el.dirty.hidden = !(plan.dirty && n);

    // Kennzahlen; Vorschlag zusätzlich in Orange
    var html = "";
    if (n) {
      var t = totals();
      lastStats = t.stats;
      html = T("{0} Pkt", n) + " · " + km(t.dist) +
        (t.asc != null ? " · ↑" + Math.round(t.asc) + " ↓" + Math.round(t.desc) + " m" : "") +
        (t.hours ? " · ≈" + hm(t.hours) + " h" : "");
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
    renderProfile(n ? lastStats : null);
  }

  // ---------- Höhenprofil als Säulendiagramm (Farbe nach Steigung/Ebene/Gefälle) ----------

  var lastStats = null;
  var profMarker = null;
  var SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(name, attrs, parent) {
    var e = document.createElementNS(SVG_NS, name);
    Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }

  // Bei BRouter-Routing (mit Höhen) wird das Profil automatisch gezeigt
  function renderProfile(t) {
    var has = !!(t && t.hasEle && t.grid.length > 1) && currentProfile() === "hiking";
    el.profBox.hidden = !has;
    if (!has) { hideProfileMarker(); return; }
    drawProfile(el.profSvg, t, {
      width: el.profBox.clientWidth,
      onPick: function (p) {
        if (!profMarker) {
          profMarker = L.circleMarker([p.lat, p.lng], { radius: 7, color: "#ffffff", weight: 3, fillColor: COLOR_CANDIDATE, fillOpacity: 1, interactive: false });
        }
        profMarker.setLatLng([p.lat, p.lng]).addTo(layer);
      },
      onRelease: function () { setTimeout(hideProfileMarker, 2500); }
    });
  }

  // Säulen-Höhenprofil in ein <svg> zeichnen (auch für „Unterwegs“).
  // opts: width, markerD (Position in m, z. B. eigener Standort), onPick(punkt), onRelease()
  function drawProfile(svg, t, opts) {
    opts = opts || {};
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var W = Math.max(200, opts.width || 320);
    var H = 76;
    var padL = 34;
    var padB = 14;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    var grid = t.grid;
    var minE = Infinity;
    var maxE = -Infinity;
    grid.forEach(function (p) { minE = Math.min(minE, p.e); maxE = Math.max(maxE, p.e); });
    if (maxE - minE < 20) { var mid = (maxE + minE) / 2; minE = mid - 10; maxE = mid + 10; }
    var total = grid[grid.length - 1].d || 1;
    var plotW = W - padL;
    var plotH = H - padB - 4;
    function x(d) { return padL + d / total * plotW; }
    function y(e) { return 4 + plotH - (e - minE) / (maxE - minE) * plotH; }
    // Säulen: pro Bildpunkt-Spalte höchstens eine, Farbe nach Neigung
    var cols = Math.min(grid.length - 1, Math.floor(plotW / 3));
    var per = (grid.length - 1) / cols;
    for (var c = 0; c < cols; c++) {
      var i0 = Math.floor(c * per);
      var i1 = Math.max(i0 + 1, Math.floor((c + 1) * per));
      var a = grid[i0];
      var b = grid[Math.min(i1, grid.length - 1)];
      var cls = slopeClass(b.e - a.e, b.d - a.d, t.thr);
      var top = y(Math.max(a.e, b.e));
      svgEl("rect", { x: x(a.d), y: top, width: Math.max(1, x(b.d) - x(a.d) - 0.5), height: 4 + plotH - top, "class": "pf-" + cls }, svg);
    }
    svgEl("text", { x: padL - 4, y: 12, "text-anchor": "end", "class": "pf-label" }, svg).textContent = Math.round(maxE) + " m";
    svgEl("text", { x: padL - 4, y: 4 + plotH, "text-anchor": "end", "class": "pf-label" }, svg).textContent = Math.round(minE) + " m";
    svgEl("text", { x: W - 2, y: H - 2, "text-anchor": "end", "class": "pf-label" }, svg).textContent = km(t.dist);
    svgEl("text", { x: padL, y: H - 2, "class": "pf-label" }, svg).textContent = "0";
    // feste Marke (z. B. eigene Position unterwegs)
    if (opts.markerD != null) {
      var mx = x(Math.max(0, Math.min(total, opts.markerD)));
      svgEl("line", { x1: mx, x2: mx, y1: 2, y2: 4 + plotH, "class": "pf-me" }, svg);
      var k0 = Math.min(grid.length - 1, Math.max(0, Math.round(opts.markerD / PROFILE_STEP)));
      svgEl("circle", { cx: mx, cy: y(grid[k0].e), r: 4.5, "class": "pf-me-dot" }, svg);
    }
    var cursor = svgEl("line", { x1: 0, x2: 0, y1: 2, y2: 4 + plotH, "class": "pf-cursor", visibility: "hidden" }, svg);
    var readout = svgEl("text", { x: padL + 4, y: 12, "class": "pf-readout", visibility: "hidden" }, svg);

    // Tippen/Ziehen im Profil: Stelle anzeigen (und z. B. auf der Karte markieren)
    function show(ev) {
      var r = svg.getBoundingClientRect();
      var px = (ev.clientX - r.left) / r.width * W;
      var d = Math.max(0, Math.min(total, (px - padL) / plotW * total));
      var k = Math.min(grid.length - 1, Math.round(d / PROFILE_STEP));
      var p = grid[k];
      cursor.setAttribute("x1", x(p.d));
      cursor.setAttribute("x2", x(p.d));
      cursor.setAttribute("visibility", "visible");
      readout.textContent = km(p.d * (t.dist / total)) + " · " + Math.round(p.e) + " m";
      readout.setAttribute("x", x(p.d) > W / 2 ? x(p.d) - 4 : x(p.d) + 4);
      readout.setAttribute("text-anchor", x(p.d) > W / 2 ? "end" : "start");
      readout.setAttribute("visibility", "visible");
      if (opts.onPick) opts.onPick(p);
    }
    svg.onpointerdown = function (ev) { svg.setPointerCapture(ev.pointerId); show(ev); };
    svg.onpointermove = function (ev) { if (ev.buttons || ev.pointerType === "mouse") show(ev); };
    svg.onpointerup = function () { if (opts.onRelease) opts.onRelease(); };
  }

  // Gehzeit ab einer Stelle des Rasters bis zum Ziel (für „Unterwegs“)
  function remainingHours(t, fromIdx) {
    var st = G.getSettings();
    var thr = st.slopePercent / 100;
    var g = t.grid;
    var h = 0;
    for (var i = Math.max(1, fromIdx + 1); i < g.length; i++) {
      var dd = g[i].d - g[i - 1].d;
      var cls = t.hasEle ? slopeClass(g[i].e - g[i - 1].e, dd, thr) : "flat";
      var v = cls === "up" ? st.speedUp : (cls === "down" ? st.speedDown : st.speedFlat);
      h += dd / 1000 / v;
    }
    var total = g.length ? g[g.length - 1].d : 0;
    return total > 0 && t.dist > 0 ? h * t.dist / total : h;
  }

  function hideProfileMarker() {
    if (profMarker) layer.removeLayer(profMarker);
  }

  // ---------- Speichern und „Geplant“ ----------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function defaultName() {
    return T("Route vom {0}", new Date().toLocaleDateString(G.i18n.locale));
  }

  function saveRoute(done) {
    if (typeof done !== "function") done = null;
    if (!plan.points.length) return;
    if (!G.db) {
      G.showStatus("Speichern ist auf diesem Gerät gerade nicht möglich.", 6000);
      return;
    }
    if (plan.savedId) {
      writeRoute(plan.name, done);
      return;
    }
    G.askText("Name der Route", plan.name || defaultName(), function (name) {
      writeRoute(String(name).trim() || defaultName(), done);
    }, "Speichern");
  }

  function writeRoute(name, done) {
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
      profile: currentProfile(),
      stats: { length: t.dist, ascent: t.asc, descent: t.desc, hours: t.hours, points: plan.points.length, lines: t.lines }
    };
    G.db.put("routes", rec).then(function () {
      plan.savedId = rec.id;
      plan.name = rec.name;
      plan.createdAt = rec.createdAt;
      plan.dirty = false;
      savePlan();
      render();
      loadRoutes();
      G.showStatus(T("Route „{0}“ gespeichert.", rec.name), 3000);
      if (done) done();
    }).catch(function (err) {
      console.warn("[GoAhead] Speichern:", err);
      G.showStatus("Die Route konnte nicht gespeichert werden.", 6000);
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

  window.addEventListener("goahead:data", function () { loadRoutes(); });

  function renderRoutesList() {
    var box = G.tracksPanel && G.tracksPanel("planned");
    if (!box) return;
    // Knopf „Geteilte Tour einfügen“ (share.js) im Listenkopf – auch bei leerer Liste
    var pasteBtn = '<button type="button" class="icon-btn plan-paste" title="Geteilte Tour oder Stand einfügen" ' +
      'aria-label="Geteilte Tour oder Stand einfügen">' + G.icon("paste") + "</button>";
    if (!savedRoutes.length) {
      box.innerHTML = '<div class="list-head list-head-one"><span class="list-sum"></span>' + pasteBtn + "</div>" +
        '<p class="trk-empty">Noch keine geplanten Routen.</p>';
      return;
    }
    var hd = G.listTools ? G.listTools.head("routes", savedRoutes, {
      yearOf: function (r) { return new Date(r.createdAt || r.updatedAt).getFullYear(); },
      metersOf: function (r) { return (r.stats && r.stats.length) || 0; },
      nameOf: function (r) { return r.name; },
      tools: pasteBtn
    }) : { html: pasteBtn, items: savedRoutes };
    box.innerHTML = hd.html + hd.items.map(function (r) {
      var info = [statsText(routeStats(r))];
      info.push(T("{0} Punkte", r.points.length));
      if (r.roundtrip) info.push(T("Rundtour"));
      info.push(new Date(r.updatedAt).toLocaleDateString(G.i18n.locale));
      var editing = plan.savedId === r.id && plan.dirty;
      return '<div class="trk-item trk-tap" role="button" tabindex="0" data-id="' + esc(r.id) + '">' +
        '<div class="trk-main"><span class="trk-swatch" style="background:' + COLOR_ROUTE + '"></span>' +
          '<span class="trk-text"><span class="trk-name" data-noi18n>' + esc(r.name) + (viewed[r.id] ? " 👁" : "") + "</span>" +
          '<span class="trk-info">' + esc(info.join(" · ")) + (editing ? " · <em>" + T("ungespeicherte Änderungen") + "</em>" : "") + "</span></span>" +
        "</div>" +
        '<span class="trk-more" aria-hidden="true">›</span></div>';
    }).join("");
    if (G.listTools) G.listTools.wire(box, "routes", renderRoutesList);
  }

  function findRoute(id) {
    for (var i = 0; i < savedRoutes.length; i++) if (savedRoutes[i].id === id) return savedRoutes[i];
    return null;
  }

  function editRoute(rec, force) {
    var sameDraft = plan.savedId === rec.id;
    if (plan.dirty && plan.points.length && !force) {
      if (sameDraft) {
        G.actionSheet("Ungespeicherte Änderungen", "An dieser Route wurde zuletzt etwas geändert, aber nicht gespeichert.", [
          { label: "Mit den Änderungen weitermachen", primary: true, onClick: openPlanner },
          { label: "Gespeicherten Stand laden", danger: true, onClick: function () { editRoute(rec, true); } }
        ]);
      } else {
        G.actionSheet("Andere Planung offen", "Die gerade geplante Route ist noch nicht gespeichert. Ihre Änderungen gehen verloren.", [
          { label: T("Verwerfen und „{0}“ öffnen", rec.name), danger: true, onClick: function () { editRoute(rec, true); } }
        ]);
      }
      return;
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
    fitPlan();   // Karte auf die Route – die passende Karte (Mosaik) ergibt sich aus dem Ausschnitt
  }

  // Kopie als neue, noch ungespeicherte Planung (Vorlage für ähnliche Touren)
  function copyRoute(rec, force) {
    if (plan.dirty && plan.points.length && !force) {
      G.actionSheet("Andere Planung offen", "Die gerade geplante Route ist noch nicht gespeichert. Ihre Änderungen gehen verloren.", [
        { label: "Verwerfen und Kopie planen", danger: true, onClick: function () { copyRoute(rec, true); } }
      ]);
      return;
    }
    var profile = plan.profile;
    plan = newPlanState();
    plan.points = clone(rec.points);
    plan.segments = clone(rec.segments);
    plan.roundtrip = !!rec.roundtrip;
    plan.closing = rec.closing ? clone(rec.closing) : null;
    plan.profile = PROFILES[rec.profile] ? rec.profile : profile;
    plan.name = T("{0} (Kopie)", rec.name);
    plan.dirty = true;   // erst „Speichern“ legt sie unter „Geplant“ ab
    candidate = null;
    selected = null;
    armed = false;
    resetHistory();
    savePlan();
    openPlanner();
    fitPlan();
  }

  function fitPlan() {
    var line = routeLine(plan);
    if (line.length < 2) return;
    if (G.stopFollowing) G.stopFollowing();
    map.fitBounds(L.latLngBounds(line.map(function (p) { return [p[0], p[1]]; })), { padding: [30, 30], maxZoom: 16 });
  }

  // Nur ansehen: Route auf der Karte zeigen (ohne Planungsmodus); Antippen der Linie öffnet das Menü
  var viewed = {};   // id -> Kartenlayer
  function viewRoute(rec) {
    if (G.tourView) G.tourView.close();
    if (!viewed[rec.id]) {
      var line = routeLine(rec).map(function (p) { return [p[0], p[1]]; });
      var g = L.layerGroup();
      L.polyline(line, { color: "#ffffff", weight: 9, opacity: 0.85, interactive: false }).addTo(g);
      var main = L.polyline(line, { color: COLOR_ROUTE, weight: 5, opacity: 0.9 }).addTo(g);
      // breite unsichtbare Linie zum Antippen
      var hit = L.polyline(line, { color: "#000000", weight: 22, opacity: 0 }).addTo(g);
      L.circleMarker(line[0], { radius: 7, color: "#ffffff", weight: 2, fillColor: "#2f9e44", fillOpacity: 1, interactive: false }).addTo(g);
      if (G.directionArrows) G.directionArrows(line).addTo(g);
      [main, hit].forEach(function (l) {
        l.on("click", function (e) { L.DomEvent.stopPropagation(e); routeMenu(rec); });
      });
      viewed[rec.id] = g.addTo(map);
    }
    if (G.closeTracksPage) G.closeTracksPage();
    if (G.closeMenu) G.closeMenu();
    if (G.stopFollowing) G.stopFollowing();
    var b = L.latLngBounds(routeLine(rec).map(function (p) { return [p[0], p[1]]; }));
    if (b.isValid()) map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
    renderRoutesList();
    if (G.tourView) {
      var t = routeStats(rec);
      G.tourView.open({
        title: rec.name,
        sub: statsText(t),
        stats: [
          [km(t.dist).replace(" km", ""), "km"],
          [t.up != null ? String(Math.round(t.up)) : "–", "↑ m"],
          [t.down != null ? String(Math.round(t.down)) : "–", "↓ m"],
          [hm(t.hours), "Gehzeit ≈ h"],
          [String(rec.points.length), "Punkte"],
          [new Date(rec.createdAt || rec.updatedAt).toLocaleDateString(G.i18n.locale), "angelegt"]
        ],
        profile: t,
        onMenu: function () { routeMenu(rec); },
        onClose: function () { unviewRoute(rec); }
      });
    }
  }
  function unviewRoute(rec) {
    if (viewed[rec.id]) { map.removeLayer(viewed[rec.id]); delete viewed[rec.id]; }
    renderRoutesList();
  }

  function openPlanner() {
    if (G.closeTracksPage) G.closeTracksPage();
    if (active) stop();
    start();
  }

  function deleteRoute(rec, force) {
    if (!force) {
      G.actionSheet("Route löschen?", T("„{0}“ wird vom Gerät gelöscht.", rec.name), [
        { label: "Löschen", danger: true, onClick: function () { deleteRoute(rec, true); } }
      ]);
      return;
    }
    G.db.del("routes", rec.id).then(function () {
      if (viewed[rec.id]) { map.removeLayer(viewed[rec.id]); delete viewed[rec.id]; }
      if (plan.savedId === rec.id) {
        // die gerade geöffnete Planung bleibt als ungespeicherter Entwurf erhalten
        plan.savedId = null;
        plan.dirty = plan.points.length > 0;
        savePlan();
        if (active) render();
      }
      return loadRoutes();
    }).catch(function (err) {
      console.warn("[GoAhead] Löschen:", err);
      G.showStatus("Die Route konnte nicht gelöscht werden.", 6000);
    });
  }

  (function wireRoutesList() {
    var box = G.tracksPanel && G.tracksPanel("planned");
    if (!box) return;
    box.addEventListener("click", function (e) {
      if (e.target.closest(".plan-paste")) { if (G.share) G.share.paste(); return; }
      var item = e.target.closest(".trk-item");
      if (!item) return;
      var rec = findRoute(item.getAttribute("data-id"));
      if (rec) routeMenu(rec);
    });
  })();

  function routeMenu(rec) {
    var sub = [statsText(routeStats(rec)), T("{0} Punkte", rec.points.length), rec.roundtrip ? T("Rundtour") : null]
      .filter(Boolean).join(" · ");
    var actions = [];
    if (G.nav) actions.push({ label: "▶ Los geht's", primary: true, onClick: function () { G.nav.start(rec); } });
    actions.push(viewed[rec.id]
      ? { label: "Von der Karte entfernen", onClick: function () { if (G.tourView && G.tourView.isOpen()) G.tourView.close(); else unviewRoute(rec); } }
      : { label: "👁 Ansehen", onClick: function () { viewRoute(rec); } });
    actions.push({ label: "✎ Verändern", onClick: function () { editRoute(rec); } });
    actions.push({ label: "⧉ Kopieren und neu planen", onClick: function () { copyRoute(rec); } });
    if (G.nav && G.nav.startCompanion) actions.push({ label: "👥 Begleiten (ohne Aufzeichnung)", onClick: function () { G.nav.startCompanion(rec); } });
    if (G.share) actions.push({ label: "↗ Für Begleitung teilen (GoAhead-Link)", onClick: function () { G.share.tour(rec); } });
    actions.push({ label: "↗ Teilen (z. B. WhatsApp)", onClick: function () { shareRoute(rec); } });
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
  function routeDetails(rec) {
    return statsText(routeStats(rec), true) + " · " + T("{0} Punkte", rec.points.length) + (rec.roundtrip ? " · " + T("Rundtour") : "");
  }

  function routeToGpx(rec) {
    var desc = routeDetails(rec);
    var lines = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="GoAhead" xmlns="http://www.topografix.com/GPX/1/1">',
      "  <metadata><name>" + xmlEsc(rec.name) + "</name><desc>" + xmlEsc(desc) + "</desc><time>" + new Date().toISOString() + "</time></metadata>"];
    rec.points.forEach(function (p, i) {
      lines.push('  <wpt lat="' + p.lat + '" lon="' + p.lng + '"><name>' + (i === 0 ? "Start" : "Punkt " + i) + "</name></wpt>");
    });
    lines.push("  <trk><name>" + xmlEsc(rec.name) + "</name><desc>" + xmlEsc(desc) + "</desc><trkseg>");
    // Höhen aus dem Profil (BRouter-Werte, Lücken interpoliert)
    var prof = buildProfile(rec.segments, rec.closing, rec.roundtrip);
    var pts = prof.pts.length ? prof.pts : rec.points.map(function (p) { return { lat: p.lat, lng: p.lng, e: null }; });
    pts.forEach(function (p) {
      lines.push('    <trkpt lat="' + p.lat + '" lon="' + p.lng + '">' + (prof.hasEle && p.e != null ? "<ele>" + Math.round(p.e * 10) / 10 + "</ele>" : "") + "</trkpt>");
    });
    lines.push("  </trkseg></trk>", "</gpx>");
    return lines.join("\n");
  }

  function exportRouteGpx(rec) {
    G.downloadFile(fileNameFor(rec.name), routeToGpx(rec), "application/gpx+xml");
  }

  function shareRoute(rec) {
    G.shareGpx(fileNameFor(rec.name), routeToGpx(rec), rec.name, rec.name + "\n" + routeDetails(rec) + "\n" + T("(GPX-Datei, erstellt mit GoAhead)"));
  }

  // ---------- Modus ein/aus ----------

  function start() {
    if (active) return;
    if (G.tourView) G.tourView.close();
    active = true;
    selected = null;
    armed = false;
    fresh = null;
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
    loopArmed = null;
    if (!active) return;
    active = false;
    candidate = null;
    selected = null;
    armed = false;
    fresh = null;
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
      btn.tabIndex = 0;   // ohne href: langer Druck zeigt sonst die Link-Adresse an
      btn.setAttribute("role", "button");
      btn.title = "Route planen";
      btn.setAttribute("aria-label", "Route planen");
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
        '<path d="M6 18c4 0 3-6 7-6s4-5 5-6" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="3 3" style="stroke: var(--c-icon-route)"/>' +
        '<circle cx="6" cy="18" r="2.6" style="fill: var(--c-icon-start)"/><path d="M18 2.5a3 3 0 0 1 3 3c0 2.2-3 5-3 5s-3-2.8-3-5a3 3 0 0 1 3-3z" style="fill: var(--c-icon-route)"/></svg>';
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
  if (G.onSettingsChange) G.onSettingsChange(function () {
    if (active) render();
    renderRoutesList();
  });

  // für Tests und spätere Module
  G.planner = {
    start: start,
    stop: stop,
    undo: undo,
    redo: redo,
    parseCoordinates: parseCoordinates,
    getPlan: function () { return plan; },
    routeLine: routeLine,
    routeStats: routeStats,
    drawProfile: drawProfile,
    remainingHours: remainingHours,
    statsText: statsText,
    hm: hm,
    xmlEsc: xmlEsc,
    fileNameFor: fileNameFor,
    isActive: function () { return active; }
  };
})();
