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

  var plan = {
    points: [],      // [{lat, lng}]
    segments: [],    // segments[i]: Weg von points[i] nach points[i+1] -> {latlngs, distance, ascent, source}
    roundtrip: false,
    closing: null,   // Weg vom letzten Punkt zum Start (bei Rundtour)
    profile: "hiking"
  };
  var candidate = null; // {latlng, seg, loading}
  var active = false;
  var routeVersion = 0;  // verwirft veraltete Routing-Antworten

  function loadPlan() {
    try {
      var p = JSON.parse(window.localStorage.getItem(PLAN_KEY) || "null");
      if (p && Array.isArray(p.points)) {
        plan.points = p.points;
        plan.segments = p.segments || [];
        plan.roundtrip = !!p.roundtrip;
        plan.closing = p.closing || null;
        plan.profile = PROFILES[p.profile] ? p.profile : "hiking";
      }
    } catch (e) { /* neue Planung */ }
  }

  function savePlan() {
    try { window.localStorage.setItem(PLAN_KEY, JSON.stringify(plan)); } catch (e) { /* Speicher voll o. ä. */ }
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

  function drawLine(group, latlngs, color, dashed) {
    L.polyline(latlngs, { color: "#ffffff", weight: 8, opacity: 0.9, interactive: false }).addTo(group);
    L.polyline(latlngs, {
      color: color, weight: 5, opacity: 1, interactive: false,
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

    plan.segments.forEach(function (seg) {
      if (seg) drawLine(routeLines, seg.latlngs, COLOR_ROUTE, seg.source === "Luftlinie");
    });
    if (plan.roundtrip && plan.closing) drawLine(routeLines, plan.closing.latlngs, COLOR_ROUTE, plan.closing.source === "Luftlinie");

    plan.points.forEach(function (p, i) {
      var last = i === plan.points.length - 1;
      var kind = i === 0 ? "start" : (last ? "last" : "mid");
      var m = L.marker([p.lat, p.lng], { icon: pointIcon(i === 0 ? "S" : String(i), kind), zIndexOffset: 500 });
      m.on("click", function (e) {
        L.DomEvent.stopPropagation(e);
        openPointMenu(i, m);
      });
      m.addTo(pointMarkers);
    });

    renderCandidate();
    renderPanel();
  }

  function renderCandidate() {
    candidateLayer.clearLayers();
    if (!candidate) return;
    if (candidate.seg) drawLine(candidateLayer, candidate.seg.latlngs, COLOR_CANDIDATE, true);
    var m = L.marker(candidate.latlng, {
      icon: pointIcon("+", "cand" + (candidate.loading ? " plan-pt-loading" : "")),
      draggable: true,
      zIndexOffset: 800
    });
    m.on("dragend", function () { setCandidate(m.getLatLng()); });
    m.on("click", function (e) { L.DomEvent.stopPropagation(e); });
    m.addTo(candidateLayer);
  }

  function openPointMenu(i, marker) {
    var label = i === 0 ? "Startpunkt" : "Punkt " + i;
    var html = '<div class="plan-pop"><strong>' + esc(label) + "</strong><br>" +
      '<button type="button" class="plan-del">Punkt löschen</button></div>';
    marker.bindPopup(html, { closeButton: true, autoPan: true }).openPopup();
    var el = marker.getPopup().getElement();
    var btn = el && el.querySelector(".plan-del");
    if (btn) btn.addEventListener("click", function () {
      map.closePopup();
      deletePoint(i);
    });
  }

  // ---------- Bearbeiten ----------

  function setCandidate(latlng) {
    var version = ++routeVersion;
    candidate = { latlng: L.latLng(latlng), seg: null, loading: plan.points.length > 0 };
    render();
    if (!plan.points.length) return;   // erster Punkt = Startpunkt, keine Strecke
    var from = plan.points[plan.points.length - 1];
    route(from, candidate.latlng).then(function (seg) {
      if (version !== routeVersion || !candidate) return;
      candidate.seg = seg;
      candidate.loading = false;
      render();
    });
  }

  function confirmCandidate() {
    if (!candidate || candidate.loading) return;
    var p = { lat: round6(candidate.latlng.lat), lng: round6(candidate.latlng.lng) };
    if (plan.points.length) plan.segments.push(candidate.seg);
    plan.points.push(p);
    candidate = null;
    routeVersion++;
    savePlan();
    updateClosing();
    render();
  }

  function deletePoint(i) {
    var n = plan.points.length;
    if (i < 0 || i >= n) return;
    candidate = null;
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
    savePlan();
    updateClosing();
    render();
  }

  // Ersetzt einen vorläufigen Abschnitt (Luftlinie) durch die berechnete Strecke.
  // Ist der Abschnitt inzwischen entfernt (weil ein Nachbarpunkt gelöscht wurde), passiert nichts.
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
    updateClosing();
    savePlan();
    render();
  }

  function newPlan() {
    if (plan.points.length && !window.confirm("Aktuelle Planung verwerfen und neu beginnen?")) return;
    plan.points = [];
    plan.segments = [];
    plan.closing = null;
    plan.roundtrip = false;
    candidate = null;
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
      '<span class="plan-title">Route planen</span>' +
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
      '<button type="button" class="plan-here" title="Eigene Position als Vorschlagspunkt">📍 Hier</button>' +
      '<button type="button" class="plan-round" aria-pressed="false">⟲ Rundtour</button>' +
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
    status: panel.querySelector(".plan-status"),
    confirm: panel.querySelector(".plan-confirm"),
    round: panel.querySelector(".plan-round"),
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
  el.round.addEventListener("click", toggleRoundtrip);
  panel.querySelector(".plan-new").addEventListener("click", newPlan);
  panel.querySelector(".plan-exit").addEventListener("click", stop);
  panel.querySelector(".plan-here").addEventListener("click", function () {
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

  function renderPanel() {
    var n = plan.points.length;
    var msg;
    if (candidate && candidate.loading) msg = "Strecke zum Vorschlagspunkt wird berechnet …";
    else if (candidate && !n) msg = "Startpunkt gewählt. Mit „Punkt übernehmen“ festlegen (oder den Punkt verschieben).";
    else if (candidate && candidate.seg && candidate.seg.source === "Luftlinie") {
      msg = (candidate.seg.note ? "Kein Weg gefunden. " : "") + "Vorschlag als Luftlinie (orange): " +
        km(candidate.seg.distance) + ". Passt es? Dann übernehmen.";
    } else if (candidate && candidate.seg) {
      msg = "Vorschlag (orange): " + km(candidate.seg.distance) + " über " + candidate.seg.source + ". Passt es? Dann übernehmen.";
    } else if (!n) msg = "Auf die Karte tippen, um den Startpunkt zu setzen.";
    else msg = "Auf die Karte tippen, um den nächsten Punkt vorzuschlagen. Tipp auf einen Punkt: löschen.";
    el.status.textContent = msg;
    el.confirm.disabled = !candidate || !!candidate.loading;
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

  // ---------- Modus ein/aus ----------

  function start() {
    if (active) return;
    active = true;
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
    routeVersion++;
    map.closePopup();
    G.setMapClickHandler(null);
    document.body.classList.remove("mode-plan");
    panel.hidden = true;
    map.removeLayer(layer);
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

  // für Tests und spätere Module
  G.planner = {
    start: start,
    stop: stop,
    parseCoordinates: parseCoordinates,
    getPlan: function () { return plan; }
  };
})();
