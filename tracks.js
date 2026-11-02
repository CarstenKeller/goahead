/* GoAhead – GPX-Tracks importieren, lokal speichern und anzeigen.
 *
 * Gespeichert wird die Original-GPX-Datei in IndexedDB (Datenbank "goahead",
 * Objektspeicher "tracks"). Die Daten bleiben nur auf diesem Gerät in diesem
 * Browser. Der Browser kann sie bei Speichermangel löschen; die App bittet
 * deshalb um dauerhaften Speicher (navigator.storage.persist).
 */
(function () {
  "use strict";

  var G = window.GOAHEAD;
  if (!G || !G.map) return;
  var map = G.map;
  var esc = G.escapeHtml;

  var COLORS = ["#1971c2", "#e8590c", "#0c8599", "#2f9e44", "#f08c00", "#c2255c"];

  // ---------- IndexedDB ----------

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error("Dieser Browser bietet keinen lokalen Speicher (IndexedDB)."));
        return;
      }
      var req = window.indexedDB.open("goahead", 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("tracks")) {
          db.createObjectStore("tracks", { keyPath: "id" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("IndexedDB nicht verfügbar")); };
    });
    return dbPromise;
  }

  function store(mode, action) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("tracks", mode);
        var result;
        var req = action(tx.objectStore("tracks"));
        if (req) req.onsuccess = function () { result = req.result; };
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("Speichern abgebrochen")); };
      });
    });
  }

  function dbAll() { return store("readonly", function (s) { return s.getAll(); }); }
  function dbPut(rec) { return store("readwrite", function (s) { return s.put(rec); }); }
  function dbDelete(id) { return store("readwrite", function (s) { return s["delete"](id); }); }

  // ---------- GPX lesen ----------

  function childText(el, name) {
    for (var i = 0; i < el.children.length; i++) {
      if (el.children[i].localName === name) return el.children[i].textContent.trim();
    }
    return "";
  }

  function readPoints(parent, name) {
    var out = [];
    var els = parent.getElementsByTagNameNS("*", name);
    for (var i = 0; i < els.length; i++) {
      var lat = parseFloat(els[i].getAttribute("lat"));
      var lon = parseFloat(els[i].getAttribute("lon"));
      if (isNaN(lat) || isNaN(lon)) continue;
      var ele = parseFloat(childText(els[i], "ele"));
      out.push(isNaN(ele) ? [lat, lon] : [lat, lon, ele]);
    }
    return out;
  }

  function parseGpx(text, fileName) {
    var doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length || !doc.documentElement ||
        doc.documentElement.localName !== "gpx") {
      throw new Error("„" + fileName + "“ ist keine gültige GPX-Datei.");
    }
    var root = doc.documentElement;
    var lines = [];
    var i;

    var segs = root.getElementsByTagNameNS("*", "trkseg");
    for (i = 0; i < segs.length; i++) {
      var pts = readPoints(segs[i], "trkpt");
      if (pts.length > 1) lines.push(pts);
    }
    var rtes = root.getElementsByTagNameNS("*", "rte");
    for (i = 0; i < rtes.length; i++) {
      var rpts = readPoints(rtes[i], "rtept");
      if (rpts.length > 1) lines.push(rpts);
    }

    var waypoints = [];
    var wpts = root.getElementsByTagNameNS("*", "wpt");
    for (i = 0; i < wpts.length; i++) {
      var lat = parseFloat(wpts[i].getAttribute("lat"));
      var lon = parseFloat(wpts[i].getAttribute("lon"));
      if (isNaN(lat) || isNaN(lon)) continue;
      waypoints.push({ lat: lat, lon: lon, name: childText(wpts[i], "name"), desc: childText(wpts[i], "desc") });
    }

    if (!lines.length && !waypoints.length) {
      throw new Error("„" + fileName + "“ enthält weder Track noch Route noch Wegpunkte.");
    }

    // Name: Metadaten, sonst erster Track bzw. erste Route, sonst Dateiname
    var name = "";
    var meta = root.getElementsByTagNameNS("*", "metadata")[0];
    if (meta) name = childText(meta, "name");
    var trk = root.getElementsByTagNameNS("*", "trk")[0] || rtes[0];
    if (!name && trk) name = childText(trk, "name");
    if (!name) name = fileName.replace(/\.gpx$/i, "");

    return { name: name, lines: lines, waypoints: waypoints };
  }

  function stats(parsed) {
    var length = 0;
    var ascent = 0;
    var descent = 0;
    var points = 0;
    parsed.lines.forEach(function (line) {
      points += line.length;
      for (var i = 1; i < line.length; i++) {
        length += L.latLng(line[i - 1][0], line[i - 1][1]).distanceTo(L.latLng(line[i][0], line[i][1]));
        if (line[i].length > 2 && line[i - 1].length > 2) {
          var d = line[i][2] - line[i - 1][2];
          if (d > 0) ascent += d; else descent -= d;
        }
      }
    });
    return { length: length, ascent: ascent, descent: descent, points: points, waypoints: parsed.waypoints.length };
  }

  // ---------- Darstellung auf der Karte ----------

  var layers = {};      // id -> L.LayerGroup
  var parsedCache = {}; // id -> Ergebnis von parseGpx
  var records = [];     // gespeicherte Datensätze (ohne Änderung der Reihenfolge)

  function buildLayer(rec, parsed) {
    var group = L.layerGroup();
    parsed.lines.forEach(function (line) {
      var latlngs = line.map(function (p) { return [p[0], p[1]]; });
      // weiße Kontur, damit die Linie auf jeder Karte erkennbar ist
      L.polyline(latlngs, { color: "#ffffff", weight: 8, opacity: 0.9, interactive: false }).addTo(group);
      L.polyline(latlngs, { color: rec.color, weight: 4, opacity: 1, interactive: false }).addTo(group);
    });
    parsed.waypoints.forEach(function (w) {
      var m = L.circleMarker([w.lat, w.lon], {
        radius: 7, color: "#ffffff", weight: 2, fillColor: rec.color, fillOpacity: 1
      }).addTo(group);
      var html = "<strong>" + esc(w.name || "Wegpunkt") + "</strong>" + (w.desc ? "<br>" + esc(w.desc) : "") +
        '<br><span class="trk-src">' + esc(rec.name) + "</span>";
      m.bindPopup(html, { maxWidth: 260 });
      // Antippen eines Wegpunkts soll keine Wege-Abfrage auslösen
      m.on("click", function (e) { L.DomEvent.stopPropagation(e); });
    });
    return group;
  }

  function getParsed(rec) {
    if (!parsedCache[rec.id]) parsedCache[rec.id] = parseGpx(rec.gpx, rec.fileName || rec.name);
    return parsedCache[rec.id];
  }

  function showTrack(rec, fit) {
    var parsed;
    try {
      parsed = getParsed(rec);
    } catch (e) {
      G.showStatus(e.message, 6000);
      return;
    }
    if (!layers[rec.id]) layers[rec.id] = buildLayer(rec, parsed);
    layers[rec.id].addTo(map);
    if (fit) fitTrack(rec);
  }

  function hideTrack(rec) {
    if (layers[rec.id]) map.removeLayer(layers[rec.id]);
  }

  function fitTrack(rec) {
    var parsed = getParsed(rec);
    var pts = [];
    parsed.lines.forEach(function (l) { l.forEach(function (p) { pts.push([p[0], p[1]]); }); });
    parsed.waypoints.forEach(function (w) { pts.push([w.lat, w.lon]); });
    if (!pts.length) return;
    // Folgemodus beenden, sonst zieht das nächste GPS-Signal die Karte zur Position zurück
    if (G.stopFollowing) G.stopFollowing();
    // unten Platz lassen, falls das Infofenster offen ist
    map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [30, 30], paddingBottomRight: [30, 60], maxZoom: 17 });
  }

  // ---------- Import ----------

  function readFile(file) {
    if (file.text) return file.text();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsText(file);
    });
  }

  function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var imported = [];
    var errors = [];

    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return readFile(file).then(function (text) {
          var parsed = parseGpx(text, file.name);
          var rec = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            name: parsed.name,
            fileName: file.name,
            importedAt: new Date().toISOString(),
            color: COLORS[(records.length + imported.length) % COLORS.length],
            visible: true,
            stats: stats(parsed),
            gpx: text
          };
          parsedCache[rec.id] = parsed;
          return dbPut(rec).then(function () { imported.push(rec); });
        }).catch(function (err) {
          errors.push(err.message || String(err));
        });
      });
    });

    return chain.then(function () {
      if (imported.length) {
        records = records.concat(imported);
        imported.forEach(function (rec, i) { showTrack(rec, i === imported.length - 1); });
        if (G.closeMenu) G.closeMenu();
        requestPersistentStorage();
      }
      renderList();
      var msg = imported.length ? imported.length + " Track(s) importiert und gespeichert." : "";
      if (errors.length) msg += (msg ? " " : "") + errors.join(" ");
      if (msg) G.showStatus(msg, errors.length ? 8000 : 4000);
    });
  }

  function requestPersistentStorage() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(function (granted) {
          console.info("[GoAhead] Dauerhafter Speicher " + (granted ? "gewährt" : "nicht gewährt"));
        });
      }
    } catch (e) { /* egal */ }
  }

  // ---------- Bedienelement: Liste der Tracks ----------

  var listEl = null;
  var panelEl = null;

  function formatKm(m) {
    return (m / 1000).toFixed(1).replace(".", ",") + " km";
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString("de-DE");
    } catch (e) {
      return "";
    }
  }

  function renderList() {
    if (!listEl) return;
    if (!records.length) {
      listEl.innerHTML = '<p class="trk-empty">Noch keine Tracks gespeichert.</p>';
      return;
    }
    var sorted = records.slice().sort(function (a, b) { return a.importedAt < b.importedAt ? 1 : -1; });
    listEl.innerHTML = sorted.map(function (r) {
      var st = r.stats || {};
      var info = [];
      if (st.length) info.push(formatKm(st.length));
      if (st.ascent) info.push("↑ ca. " + Math.round(st.ascent) + " m");
      if (st.waypoints) info.push(st.waypoints + (st.waypoints === 1 ? " Wegpunkt" : " Wegpunkte"));
      info.push(formatDate(r.importedAt));
      return '<div class="trk-item" data-id="' + esc(r.id) + '">' +
        '<label class="trk-main">' +
          '<input type="checkbox" data-act="toggle"' + (r.visible ? " checked" : "") + ">" +
          '<span class="trk-swatch" style="background:' + esc(r.color) + '"></span>' +
          '<span class="trk-text"><span class="trk-name">' + esc(r.name) + "</span>" +
          '<span class="trk-info">' + esc(info.join(" · ")) + "</span></span>" +
        "</label>" +
        '<div class="trk-actions">' +
          '<button type="button" data-act="zoom" title="Auf Track zoomen" aria-label="Auf Track zoomen">⤢</button>' +
          '<button type="button" data-act="download" title="GPX herunterladen" aria-label="GPX herunterladen">⬇</button>' +
          '<button type="button" data-act="delete" title="Löschen" aria-label="Löschen">🗑</button>' +
        "</div></div>";
    }).join("");
  }

  function findRecord(id) {
    for (var i = 0; i < records.length; i++) if (records[i].id === id) return records[i];
    return null;
  }

  function onListAction(e) {
    var target = e.target;
    var item = target.closest(".trk-item");
    if (!item) return;
    var rec = findRecord(item.getAttribute("data-id"));
    if (!rec) return;
    var actEl = target.closest("[data-act]");
    var act = actEl ? actEl.getAttribute("data-act") : null;

    if (act === "toggle" && e.type === "change") {
      rec.visible = target.checked;
      if (rec.visible) showTrack(rec, false); else hideTrack(rec);
      dbPut(rec).catch(function (err) { G.showStatus("Speichern fehlgeschlagen: " + err.message, 6000); });
    } else if (act === "zoom" && e.type === "click") {
      if (!rec.visible) {
        rec.visible = true;
        dbPut(rec);
        renderList();
      }
      showTrack(rec, true);
      panelEl.hidden = true;
      if (G.closeMenu) G.closeMenu();
    } else if (act === "download" && e.type === "click") {
      var blob = new Blob([rec.gpx], { type: "application/gpx+xml" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = rec.fileName || (rec.name + ".gpx");
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } else if (act === "delete" && e.type === "click") {
      if (!window.confirm("Track „" + rec.name + "“ vom Gerät löschen?")) return;
      dbDelete(rec.id).then(function () {
        hideTrack(rec);
        delete layers[rec.id];
        delete parsedCache[rec.id];
        records = records.filter(function (r) { return r.id !== rec.id; });
        renderList();
      }).catch(function (err) { G.showStatus("Löschen fehlgeschlagen: " + err.message, 6000); });
    }
  }

  var TracksControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      var box = L.DomUtil.create("div", "leaflet-bar trk-control");
      var btn = L.DomUtil.create("a", "trk-toggle", box);
      btn.href = "#";
      btn.setAttribute("role", "button");
      btn.title = "GPX-Tracks";
      btn.setAttribute("aria-label", "GPX-Tracks");
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
        '<path d="M3 19c3-1 3-6 6-7s5 3 8 1 2-7 4-8" fill="none" stroke="#1971c2" stroke-width="2.5" stroke-linecap="round"/>' +
        '<circle cx="3" cy="19" r="2" fill="#333"/><circle cx="21" cy="5" r="2" fill="#333"/></svg>';

      panelEl = L.DomUtil.create("div", "trk-panel", box);
      panelEl.hidden = true;
      var head = L.DomUtil.create("div", "trk-head", panelEl);
      head.innerHTML = '<span class="trk-title">GPX-Tracks</span>';

      var input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      // Viele Android-Dateiauswahlen kennen keinen GPX-Typ; daher großzügig
      input.accept = ".gpx,application/gpx+xml,application/xml,text/xml,application/octet-stream";
      input.hidden = true;
      panelEl.appendChild(input);

      var importBtn = L.DomUtil.create("button", "trk-import", panelEl);
      importBtn.type = "button";
      importBtn.textContent = "GPX importieren …";
      importBtn.addEventListener("click", function () { input.click(); });
      input.addEventListener("change", function () {
        importFiles(input.files).then(function () { input.value = ""; });
      });

      listEl = L.DomUtil.create("div", "trk-list", panelEl);
      listEl.addEventListener("change", onListAction);
      listEl.addEventListener("click", onListAction);

      var note = L.DomUtil.create("p", "trk-note", panelEl);
      note.textContent = "Tracks werden nur auf diesem Gerät gespeichert.";

      L.DomEvent.on(btn, "click", function (e) {
        L.DomEvent.preventDefault(e);
        panelEl.hidden = !panelEl.hidden;
      });
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      map.on("click", function () { panelEl.hidden = true; });
      renderList();
      return box;
    }
  });
  if (G.addToToolbar) {
    G.addToToolbar(new TracksControl(), function () { if (panelEl) panelEl.hidden = true; });
  } else {
    new TracksControl().addTo(map);
  }

  // ---------- Beim Start gespeicherte Tracks laden ----------

  dbAll().then(function (all) {
    records = all || [];
    records.forEach(function (rec) { if (rec.visible) showTrack(rec, false); });
    renderList();
  }).catch(function (err) {
    console.warn("[GoAhead] Tracks konnten nicht geladen werden:", err);
    if (listEl) listEl.innerHTML = '<p class="trk-empty">Lokaler Speicher nicht verfügbar: ' + esc(err.message || String(err)) + "</p>";
  });
})();
