/* GoAhead – Route planen.
 *
 * Ablauf:
 *  - Tipp auf die Karte setzt einen Vorschlagspunkt (verschiebbar). Vom letzten
 *    bestätigten Punkt wird die Strecke dorthin berechnet und gestrichelt angezeigt.
 *  - „Punkt übernehmen“ rastet den Punkt ein; er wird Teil der Route und Ausgangspunkt
 *    für den nächsten Punkt.
 *  - Tipp auf einen Routenpunkt bietet „Löschen“ an; Vorgänger und Nachfolger werden
 *    neu verbunden.
 *  - „Rundtour“ verbindet den letzten Punkt mit dem Startpunkt.
 *
 * Routing (Fußwege, ohne API-Schlüssel):
 *  - BRouter, Profil "hiking-mountain" (https://brouter.de/brouter).
 *    Parameter laut Quelltext github.com/abrensch/brouter: lonlats=lon,lat|lon,lat,
 *    profile, format=geojson; Antwort: GeoJSON-LineString [lon,lat,ele],
 *    properties "track-length" (m) und "filtered ascend" (m).
 *  - OSRM der FOSSGIS (https://routing.openstreetmap.de/routed-foot/route/v1/driving/…),
 *    wie auf openstreetmap.org verwendet.
 *  - Scheitern beide: Luftlinie (deutlich gekennzeichnet).
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
    hiking: { label: "Wandern (BRouter)", engines: ["brouter", "osrm"] },
    foot: { label: "Fußweg (OSRM)", engines: ["osrm", "brouter"] },
    line: { label: "Luftlinie", engines: [] }
  };

  var COLOR_ROUTE = "#c2255c";
  var COLOR_CANDIDATE = "#f08c00";

  // ---------- Zustand ----------

  var plan = newPlanState();
  var candidate = null; // {latlng, loading, seg (Anhängen) | replace: Index, before, after (Ersetzen)}
  var selected = null;  // Index des markierten Punkts (zum Ersetzen oder Löschen)
  var active = false;
  var routeVersion = 0;  // verwirft veraltete Routing-Antworten

  function newPlanState() {
    return {
      points: [],      // [{lat, lng}]
      segments: [],    // segments[i]: Weg von points[i] nach points[i+1] -> {latlngs, distance, ascent, source}
      roundtrip: false,
      closing: null,   // Weg vom letzten Punkt zum Start (bei Rundtour)
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

  // Berechnet den Weg von a nach b mit dem gewählten Profil; nie fehlschlagend (Rückfall Luftlinie)
  function route(a, b) {
    var list = PROFILES[plan.profile].engines;
    var errors = [];
    function attempt(i) {
      if (i >= list.length) {
        if (errors.length) console.warn("[GoAhead] Routing fehlgeschlagen:", errors.join("; "));
        return Promise.resolve(straight(a, b, list.length ? "kein Weg gefunden" : null));
      }
      return engines[list[i]](a, b).catch(function (err) {
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

  function drawLine(group, latlngs, color, dashed, faded) {
    L.polyline(latlngs, { color: "#ffffff", weight: 8, opacity: faded ? 0.4 : 0.9, interactive: false }).addTo(group);
    L.polyline(latlngs, {
      color: color, weight: 5, opacity: faded ? 0.3 : 1, interactive: false,
      dashArray: dashed ? "8 8" : null
    }).addTo(group);
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

    plan.segments.forEach(function (seg, i) {
      if (!seg) return;
      // beim Ersetzen eines Punkts die bisherigen Anschlussstrecken blass zeigen
      var faded = selected !== null && (i === selected - 1 || i === selected);
      drawLine(routeLines, seg.latlngs, COLOR_ROUTE, seg.source === "Luftlinie", faded);
    });
    if (plan.roundtrip && plan.closing) {
      var fadedClosing = selected !== null && (selected === 0 || selected === n - 1);
      drawLine(routeLines, plan.closing.latlngs, COLOR_ROUTE, plan.closing.source === "Luftlinie", fadedClosing);
    }

    plan.points.forEach(function (p, i) {
      var kind = i === selected ? "sel" : (i === 0 ? "start" : (i === n - 1 ? "last" : "mid"));
      var m = L.marker([p.lat, p.lng], { icon: pointIcon(i === 0 ? "S" : String(i), kind), zIndexOffset: i === selected ? 700 : 500 });
      m.on("click", function (e) {
        L.DomEvent.stopPropagation(e);
        selectPoint(i);
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

  // ---------- Bearbeiten ----------

  function selectPoint(i) {
    routeVersion++;
    candidate = null;
    selected = selected === i ? null : i;   // erneutes Antippen hebt die Markierung auf
    render();
  }

  function clearSelection() {
    routeVersion++;
    candidate = null;
    selected = null;
    render();
  }

  function setCandidate(latlng) {
    var version = ++routeVersion;
    var ll = L.latLng(latlng);
    var n = plan.points.length;

    if (selected !== null) {
      // Ersatz für den markierten Punkt: Strecken von den Nachbarpunkten neu berechnen
      var idx = selected;
      var prev = idx > 0 ? plan.points[idx - 1] : null;
      var next = idx < n - 1 ? plan.points[idx + 1] : null;
      candidate = { latlng: ll, replace: idx, before: null, after: null, loading: !!(prev || next) };
      render();
      Promise.all([prev ? route(prev, ll) : null, next ? route(ll, next) : null]).then(function (r) {
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
    route(plan.points[n - 1], ll).then(function (seg) {
      if (version !== routeVersion || !candidate) return;
      candidate.seg = seg;
      candidate.loading = false;
      render();
    });
  }

  function confirmCandidate() {
    if (!candidate || candidate.loading) return;
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
    routeVersion++;
    markDirty();
    updateClosing();
    render();
  }

  function deletePoint(i) {
    var n = plan.points.length;
    if (i < 0 || i >= n) return;
    candidate = null;
    selected = null;
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
      // Vorgänger und Nachfolger neu verbinden
      var a = plan.points[i - 1];
      var b = plan.points[i + 1];
      plan.points.splice(i, 1);
      plan.segments.splice(i - 1, 2, straight(a, b, "wird berechnet"));
      var pending = plan.segments[i - 1];
      pending.pending = true;
      replaceWhenRouted(pending, a, b);
    }
    markDirty();
    updateClosing();
    render();
  }

  // Ersetzt einen vorläufigen Abschnitt (Luftlinie) durch die berechnete Strecke.
  // Ist der Abschnitt inzwischen entfernt (weil ein Nachbarpunkt geändert wurde), passiert nichts.
  function replaceWhenRouted(pending, a, b) {
    route(a, b).then(function (seg) {
      var j = plan.segments.indexOf(pending);
      if (j < 0) return;
      plan.segments[j] = seg;
      savePlan();
      render();
    });
  }

  function updateClosing() {
    if (!plan.roundtrip || plan.points.length < 2) {
      plan.closing = null;
      savePlan();
      return;
    }
    var a = plan.points[plan.points.length - 1];
    var b = plan.points[0];
    var key = a.lat + "," + a.lng + ">" + b.lat + "," + b.lng;
    if (plan.closing && plan.closing.key === key && !plan.closing.pending) return;
    var pending = straight(a, b, "wird berechnet");
    pending.key = key;
    pending.pending = true;
    plan.closing = pending;
    route(a, b).then(function (seg) {
      if (plan.closing !== pending) return;
      seg.key = key;
      plan.closing = seg;
      savePlan();
      render();
    });
  }

  function toggleRoundtrip() {
    plan.roundtrip = !plan.roundtrip;
    markDirty();
    updateClosing();
    render();
  }

  function newPlan() {
    if (plan.dirty && plan.points.length && !window.confirm("Ungespeicherte Änderungen verwerfen und neu beginnen?")) return;
    var profile = plan.profile;
    plan = newPlanState();
    plan.profile = profile;
    candidate = null;
    selected = null;
    routeVersion++;
    savePlan();
    render();
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
      if (s.ascent == null) ascKnown = false; else asc += s.ascent;
      if (s.source === "Luftlinie") lines++;
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
      resultsEl.innerHTML = '<p class="plan-hint">Position ' + c.lat.toFixed(5).replace(".", ",") + " / " +
        c.lng.toFixed(5).replace(".", ",") + " – als Vorschlagspunkt gesetzt.</p>";
      return;
    }
    // Nominatim: höchstens eine Anfrage pro Sekunde
    if (Date.now() - lastSearch < 1100) return;
    lastSearch = Date.now();
    resultsEl.innerHTML = '<p class="plan-hint">Suche …</p>';
    var url = NOMINATIM_URL + "?format=jsonv2&limit=6&countrycodes=de&accept-language=de&q=" + encodeURIComponent(q);
    fetchJson(url, 12000).then(function (list) {
      if (!list || !list.length) {
        resultsEl.innerHTML = '<p class="plan-hint">Nichts gefunden.</p>';
        return;
      }
      resultsEl.innerHTML = list.map(function (r, i) {
        return '<button type="button" class="plan-result" data-i="' + i + '">' + esc(r.display_name) + "</button>";
      }).join("") + '<p class="plan-credit">Suche: © OpenStreetMap-Mitwirkende (Nominatim)</p>';
      resultsEl.querySelectorAll(".plan-result").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var r = list[parseInt(btn.getAttribute("data-i"), 10)];
          resultsEl.innerHTML = "";
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

  // ---------- Planungsfeld ----------

  var panel = document.createElement("section");
  panel.id = "plan-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Route planen");
  panel.innerHTML =
    '<div class="plan-head">' +
      '<span class="plan-title"><span class="plan-name">Route planen</span><span class="plan-dirty" hidden> · ungespeichert</span></span>' +
      '<button type="button" class="plan-exit">Beenden</button>' +
    "</div>" +
    '<form class="plan-search" autocomplete="off">' +
      '<input type="search" enterkeyhint="search" placeholder="Adresse oder Koordinaten (auch UTM 32)">' +
      '<button type="submit" aria-label="Suchen">' +
        '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M15 15l5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>' +
      "</button>" +
    "</form>" +
    '<div class="plan-results"></div>' +
    '<p class="plan-status"></p>' +
    '<div class="plan-actions">' +
      '<button type="button" class="plan-confirm">✓ Punkt übernehmen</button>' +
      '<button type="button" class="plan-del" hidden>🗑 Punkt löschen</button>' +
      '<button type="button" class="plan-unsel" hidden>Abbrechen</button>' +
      '<button type="button" class="plan-here" title="Eigene Position als Vorschlagspunkt">📍 Hier</button>' +
      '<button type="button" class="plan-round" aria-pressed="false">⟲ Rundtour</button>' +
      '<button type="button" class="plan-save">💾 Speichern</button>' +
      '<button type="button" class="plan-new">Neu</button>' +
    "</div>" +
    '<div class="plan-foot">' +
      '<span class="plan-sum"></span>' +
      '<select class="plan-profile" aria-label="Routing-Profil"></select>' +
    "</div>";
  document.body.appendChild(panel);
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);

  var el = {
    name: panel.querySelector(".plan-name"),
    dirty: panel.querySelector(".plan-dirty"),
    status: panel.querySelector(".plan-status"),
    confirm: panel.querySelector(".plan-confirm"),
    del: panel.querySelector(".plan-del"),
    unsel: panel.querySelector(".plan-unsel"),
    here: panel.querySelector(".plan-here"),
    round: panel.querySelector(".plan-round"),
    save: panel.querySelector(".plan-save"),
    newBtn: panel.querySelector(".plan-new"),
    sum: panel.querySelector(".plan-sum"),
    profile: panel.querySelector(".plan-profile"),
    results: panel.querySelector(".plan-results"),
    input: panel.querySelector(".plan-search input")
  };

  Object.keys(PROFILES).forEach(function (k) {
    var o = document.createElement("option");
    o.value = k;
    o.textContent = PROFILES[k].label;
    el.profile.appendChild(o);
  });

  panel.querySelector(".plan-search").addEventListener("submit", function (e) {
    e.preventDefault();
    el.input.blur();
    search(el.input.value, el.results);
  });
  el.confirm.addEventListener("click", confirmCandidate);
  el.del.addEventListener("click", function () { if (selected !== null) deletePoint(selected); });
  el.unsel.addEventListener("click", clearSelection);
  el.round.addEventListener("click", toggleRoundtrip);
  el.save.addEventListener("click", saveRoute);
  el.newBtn.addEventListener("click", newPlan);
  panel.querySelector(".plan-exit").addEventListener("click", function () {
    if (plan.dirty && plan.points.length &&
        !window.confirm("Die Änderungen sind noch nicht gespeichert. Trotzdem beenden?\n(Der Entwurf bleibt erhalten und ist beim nächsten Planen wieder da.)")) return;
    stop();
  });
  el.here.addEventListener("click", function () {
    var pos = G.getPosition && G.getPosition();
    if (!pos) {
      G.showStatus("Noch keine GPS-Position verfügbar.", 4000);
      return;
    }
    goTo(pos);
    setCandidate(pos);
  });
  el.profile.addEventListener("change", function () {
    plan.profile = el.profile.value;
    savePlan();
    if (candidate) setCandidate(candidate.latlng);   // Vorschlag neu berechnen
  });

  function pointLabel(i) { return i === 0 ? "Startpunkt" : "Punkt " + i; }

  function candidateDistance() {
    var d = 0;
    [candidate.seg, candidate.before, candidate.after].forEach(function (s) { if (s) d += s.distance; });
    return d;
  }

  function candidateIsLine() {
    return [candidate.seg, candidate.before, candidate.after].some(function (s) { return s && s.source === "Luftlinie" && s.note; });
  }

  function renderPanel() {
    var n = plan.points.length;
    var replacing = candidate && candidate.replace !== undefined && candidate.replace !== null;
    var msg;
    if (candidate && candidate.loading) {
      msg = replacing ? "Neue Strecke über den Ersatzpunkt wird berechnet …" : "Strecke zum Vorschlagspunkt wird berechnet …";
    } else if (replacing) {
      msg = (candidateIsLine() ? "Kein Weg gefunden, Luftlinie. " : "") +
        "Vorschlag (orange) ersetzt " + pointLabel(candidate.replace) +
        (candidate.before || candidate.after ? " – Anschlussstrecken " + km(candidateDistance()) : "") +
        ". Passt es? Nochmal auf den neuen Punkt tippen oder übernehmen.";
    } else if (selected !== null) {
      msg = pointLabel(selected) + " markiert (blau): Auf die Karte tippen, um einen Ersatzpunkt vorzuschlagen – oder den Punkt löschen.";
    } else if (candidate && !n) {
      msg = "Startpunkt gewählt. Nochmal auf den Punkt tippen oder „Punkt übernehmen“ (verschieben ist möglich).";
    } else if (candidate && candidate.seg && candidate.seg.source === "Luftlinie") {
      msg = (candidate.seg.note ? "Kein Weg gefunden. " : "") + "Vorschlag als Luftlinie (orange): " +
        km(candidate.seg.distance) + ". Passt es? Nochmal auf den Punkt tippen oder übernehmen.";
    } else if (candidate && candidate.seg) {
      msg = "Vorschlag (orange): " + km(candidate.seg.distance) + " über " + candidate.seg.source +
        ". Passt es? Nochmal auf den Punkt tippen oder übernehmen.";
    } else if (!n) {
      msg = "Auf die Karte tippen, um den Startpunkt zu setzen.";
    } else {
      msg = "Auf die Karte tippen für den nächsten Punkt. Tipp auf einen Routenpunkt: ändern oder löschen.";
    }
    el.status.textContent = msg;

    el.name.textContent = plan.savedId ? plan.name : (plan.name || "Route planen");
    el.dirty.hidden = !(plan.dirty && n);
    el.confirm.textContent = replacing ? "✓ Ersatzpunkt übernehmen" : "✓ Punkt übernehmen";
    el.confirm.disabled = !candidate || !!candidate.loading;
    var sel = selected !== null;
    el.del.hidden = !sel;
    el.unsel.hidden = !sel;
    el.round.hidden = sel;
    el.save.hidden = sel;
    el.newBtn.hidden = sel;
    el.save.disabled = !n || (!plan.dirty && !!plan.savedId);
    el.round.setAttribute("aria-pressed", plan.roundtrip ? "true" : "false");
    el.round.classList.toggle("on", plan.roundtrip);
    el.profile.value = plan.profile;

    if (!n) {
      el.sum.textContent = "Noch keine Punkte";
    } else {
      var t = totals();
      var parts = [n + (n === 1 ? " Punkt" : " Punkte"), km(t.dist)];
      if (t.asc != null) parts.push("↑ " + Math.round(t.asc) + " m");
      if (plan.roundtrip) parts.push("Rundtour");
      if (t.lines) parts.push(t.lines + "× Luftlinie");
      el.sum.textContent = parts.join(" · ");
    }
    // Höhe des Planungsfelds für die darüber liegenden Bedienelemente
    if (!panel.hidden) document.documentElement.style.setProperty("--plan-h", panel.offsetHeight + "px");
  }

  // ---------- Speichern und „Geplant“ ----------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function defaultName() {
    return "Route vom " + new Date().toLocaleDateString("de-DE");
  }

  function saveRoute() {
    if (!plan.points.length || !G.db) return;
    var name = plan.name;
    if (!plan.savedId) {
      name = window.prompt("Name der Route:", plan.name || defaultName());
      if (name === null) return;
      name = name.trim() || defaultName();
    }
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
    if (!savedRoutes.length) {
      box.innerHTML = '<p class="trk-empty">Noch keine geplanten Routen. Eine Route planen und im Planungsfeld „Speichern“ wählen.</p>';
      return;
    }
    box.innerHTML = savedRoutes.map(function (r) {
      var st = r.stats || {};
      var info = [];
      if (st.length) info.push(km(st.length));
      if (st.ascent != null) info.push("↑ " + Math.round(st.ascent) + " m");
      info.push((st.points || r.points.length) + " Punkte");
      if (r.roundtrip) info.push("Rundtour");
      info.push(new Date(r.updatedAt).toLocaleDateString("de-DE"));
      var editing = plan.savedId === r.id && plan.dirty;
      return '<div class="trk-item" data-id="' + esc(r.id) + '">' +
        '<div class="trk-main"><span class="trk-swatch" style="background:' + COLOR_ROUTE + '"></span>' +
          '<span class="trk-text"><span class="trk-name">' + esc(r.name) + "</span>" +
          '<span class="trk-info">' + esc(info.join(" · ")) + (editing ? " · <em>ungespeicherte Änderungen</em>" : "") + "</span></span>" +
        "</div>" +
        '<div class="trk-actions">' +
          '<button type="button" data-act="edit" title="Verändern" aria-label="Verändern">✎</button>' +
          '<button type="button" data-act="delete" title="Löschen" aria-label="Löschen">🗑</button>' +
        "</div></div>";
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
      var actEl = e.target.closest("[data-act]");
      var item = e.target.closest(".trk-item");
      if (!actEl || !item) return;
      var rec = findRoute(item.getAttribute("data-id"));
      if (!rec) return;
      if (actEl.getAttribute("data-act") === "edit") editRoute(rec);
      else if (actEl.getAttribute("data-act") === "delete") deleteRoute(rec);
    });
  })();

  // ---------- Modus ein/aus ----------

  function start() {
    if (active) return;
    active = true;
    selected = null;
    candidate = null;
    if (G.closeMenu) G.closeMenu();
    if (G.closeInfoPanel) G.closeInfoPanel();
    if (G.stopFollowing) G.stopFollowing();
    document.body.classList.add("mode-plan");
    panel.hidden = false;
    layer.addTo(map);
    G.setMapClickHandler(function (e) { setCandidate(e.latlng); });
    render();
    if (plan.points.length) {
      var b = L.latLngBounds(plan.points.map(function (p) { return [p.lat, p.lng]; }));
      map.fitBounds(b, { padding: [40, 40], maxZoom: 16 });
    }
    // laufende Berechnungen (z. B. nach Neustart) ergänzen
    plan.segments.forEach(function (s, i) {
      if (s && s.pending) replaceWhenRouted(s, plan.points[i], plan.points[i + 1]);
    });
    if (plan.closing && plan.closing.pending) { plan.closing = null; updateClosing(); }
  }

  function stop() {
    if (!active) return;
    active = false;
    candidate = null;
    selected = null;
    routeVersion++;
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
    parseCoordinates: parseCoordinates,
    getPlan: function () { return plan; }
  };
})();
