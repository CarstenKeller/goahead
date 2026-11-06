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

  var T = window.GOAHEAD_I18N.t;
  if (!G || !G.map) return;
  var map = G.map;
  var esc = G.escapeHtml;

  var COLORS = ["#1971c2", "#e8590c", "#0c8599", "#2f9e44", "#f08c00", "#c2255c"];

  // ---------- IndexedDB ----------

  var dbPromise = null;

  // Version 3: Speicher "tracks" (GPX), "routes" (geplant, planner.js), "walks" (erwandert, nav.js)
  // Version 4: zusätzlich "photos" (Fotos unterwegs, photos.js)
  var DB_VERSION = 4;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error("Dieser Browser kann keine Daten auf dem Gerät speichern."));
        return;
      }
      var req = window.indexedDB.open("goahead", DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        ["tracks", "routes", "walks", "photos"].forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        });
      };
      req.onsuccess = function () {
        var db = req.result;
        // Fordert eine neuere App-Version (in einem anderen Tab) die Datenbank an: Verbindung freigeben
        db.onversionchange = function () {
          db.close();
          dbPromise = null;
          G.showStatus("GoAhead wurde in einem anderen Fenster aktualisiert. Bitte neu laden.", 10000);
        };
        resolve(db);
      };
      // Ein anderer Tab mit älterer App-Version hält die Datenbank offen und verhindert die Umstellung
      req.onblocked = function () {
        G.showStatus("GoAhead ist noch in einem anderen Fenster geöffnet. Bitte das andere Fenster schließen und neu laden.", 15000);
      };
      req.onerror = function () { reject(req.error || new Error("Speicher nicht verfügbar")); };
    });
    // Fehlschlag nicht dauerhaft merken, damit ein späterer Versuch neu öffnen kann
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function withTimeout(promise, ms) {
    var timer;
    return Promise.race([
      promise,
      new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
          reject(new Error("Der Speicher antwortet nicht. Ist GoAhead noch in einem anderen Fenster geöffnet? Dieses schließen und neu laden."));
        }, ms);
      })
    ]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  function storeIn(name, mode, action) {
    return withTimeout(openDb(), 8000).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, mode);
        var result;
        var req = action(tx.objectStore(name));
        if (req) req.onsuccess = function () { result = req.result; };
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("Speichern abgebrochen")); };
      });
    });
  }

  function store(mode, action) { return storeIn("tracks", mode, action); }

  // Für andere Module (z. B. planner.js: Speicher "routes")
  G.db = {
    all: function (name) { return storeIn(name, "readonly", function (s) { return s.getAll(); }); },
    put: function (name, rec) { return storeIn(name, "readwrite", function (s) { return s.put(rec); }); },
    del: function (name, id) { return storeIn(name, "readwrite", function (s) { return s["delete"](id); }); },
    // viele Datensätze in EINER Transaktion (Sammel-Import, Wiederherstellen)
    putMany: function (name, recs) {
      return storeIn(name, "readwrite", function (s) { recs.forEach(function (r) { s.put(r); }); return null; });
    }
  };

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
      throw new Error(T("„{0}“ ist keine gültige GPX-Datei.", fileName));
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
      throw new Error(T("„{0}“ enthält weder Track noch Route noch Wegpunkte.", fileName));
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
            visible: files.length <= 5,   // bei vielen Dateien nicht alle auf einmal auf die Karte
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
        var vis = imported.filter(function (r) { return r.visible; });
        vis.forEach(function (rec, i) { showTrack(rec, i === vis.length - 1); });
        if (vis.length) closePage();
        requestPersistentStorage();
      }
      renderList();
      var msg = imported.length ? T(imported.length === 1 ? "1 Track importiert und gespeichert." : "{0} Tracks importiert und gespeichert.", imported.length) : "";
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

  function formatKm(m) {
    return G.i18n.dec((m / 1000).toFixed(1)) + " km";
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(G.i18n.locale);
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
      if (st.ascent) info.push(T("↑ ca. {0} m", Math.round(st.ascent)));
      if (st.waypoints) info.push(T(st.waypoints === 1 ? "1 Wegpunkt" : "{0} Wegpunkte", st.waypoints));
      info.push(formatDate(r.importedAt));
      return '<div class="trk-item" data-id="' + esc(r.id) + '">' +
        '<label class="trk-main">' +
          '<input type="checkbox" data-act="toggle"' + (r.visible ? " checked" : "") + ">" +
          '<span class="trk-swatch" style="background:' + esc(r.color) + '"></span>' +
          '<span class="trk-text"><span class="trk-name" data-noi18n>' + esc(r.name) + "</span>" +
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
      dbPut(rec).catch(function () { G.showStatus("Die Änderung konnte nicht gespeichert werden.", 6000); });
    } else if (act === "zoom" && e.type === "click") {
      if (!rec.visible) {
        rec.visible = true;
        dbPut(rec);
        renderList();
      }
      showTrack(rec, true);
      closePage();
      if (G.closeMenu) G.closeMenu();
    } else if (act === "download" && e.type === "click") {
      G.downloadFile(rec.fileName || (rec.name + ".gpx"), rec.gpx, "application/gpx+xml");
    } else if (act === "delete" && e.type === "click") {
      G.actionSheet("Track löschen?", T("„{0}“ wird vom Gerät gelöscht.", rec.name), [{ label: "Löschen", danger: true, onClick: function () {
        dbDelete(rec.id).then(function () {
          hideTrack(rec);
          delete layers[rec.id];
          delete parsedCache[rec.id];
          records = records.filter(function (r) { return r.id !== rec.id; });
          renderList();
        }).catch(function () { G.showStatus("Der Track konnte nicht gelöscht werden.", 6000); });
      } }]);
    }
  }

  // ---------- Eigene Seite „Tracks“ mit Reitern GPX / Geplant / Erwandert ----------

  var TAB_KEY = "goahead.tracksTab.v1";
  var pageEl = null;

  function buildPage() {
    pageEl = document.createElement("section");
    pageEl.id = "tracks-page";
    pageEl.className = "page";
    pageEl.hidden = true;
    pageEl.setAttribute("aria-label", "Tracks");
    pageEl.innerHTML =
      '<header class="page-head">' +
        '<button type="button" class="page-back" aria-label="Zurück zur Karte">' +
          '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        "</button>" +
        "<h1>Tracks</h1>" +
      "</header>" +
      '<nav class="page-tabs" role="tablist">' +
        '<button type="button" role="tab" data-tab="gpx">GPX</button>' +
        '<button type="button" role="tab" data-tab="planned">Geplant</button>' +
        '<button type="button" role="tab" data-tab="walked">Erwandert</button>' +
      "</nav>" +
      '<div class="page-body">' +
        '<div class="page-panel" data-panel="gpx" role="tabpanel">' +
          '<button type="button" class="trk-import">GPX/ZIP importieren …</button>' +
          '<input type="file" multiple hidden>' +
          '<div class="trk-list"></div>' +
          '<p class="trk-note">Tracks werden nur auf diesem Gerät gespeichert.</p>' +
        "</div>" +
        '<div class="page-panel" data-panel="planned" role="tabpanel" hidden>' +
          '<p class="trk-empty">Noch keine geplanten Routen.</p>' +
        "</div>" +
        '<div class="page-panel" data-panel="walked" role="tabpanel" hidden>' +
          '<p class="trk-empty">Noch keine erwanderten Touren.</p>' +
        "</div>" +
      "</div>";
    document.body.appendChild(pageEl);

    var input = pageEl.querySelector('input[type="file"]');
    // Viele Android-Dateiauswahlen kennen keinen GPX-Typ; daher großzügig
    input.accept = ".gpx,.zip,.txt,application/gpx+xml,application/xml,text/xml,application/zip,application/octet-stream";
    pageEl.querySelector(".trk-import").addEventListener("click", function () { input.click(); });
    input.addEventListener("change", function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.value = "";
      // Sammel-Import (backup.js): fragt, wohin (GPX / Geplant / Erwandert), liest auch ZIP-Dateien
      if (G.backup && G.backup.importFiles) G.backup.importFiles(files);
      else importFiles(files);
    });

    listEl = pageEl.querySelector(".trk-list");
    listEl.addEventListener("change", onListAction);
    listEl.addEventListener("click", onListAction);

    pageEl.querySelector(".page-back").addEventListener("click", closePage);
    pageEl.querySelector(".page-tabs").addEventListener("click", function (e) {
      var b = e.target.closest("[data-tab]");
      if (b) selectTab(b.getAttribute("data-tab"));
    });

    var tab = "gpx";
    try { tab = window.localStorage.getItem(TAB_KEY) || "gpx"; } catch (e) { /* Standard */ }
    selectTab(tab);
    renderList();
  }

  function selectTab(tab) {
    if (!pageEl.querySelector('[data-panel="' + tab + '"]')) tab = "gpx";
    pageEl.querySelectorAll("[data-tab]").forEach(function (b) {
      var on = b.getAttribute("data-tab") === tab;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.classList.toggle("active", on);
    });
    pageEl.querySelectorAll("[data-panel]").forEach(function (p) {
      p.hidden = p.getAttribute("data-panel") !== tab;
    });
    try { window.localStorage.setItem(TAB_KEY, tab); } catch (e) { /* egal */ }
  }

  function openPage(tab) {
    if (G.closeMenu) G.closeMenu();
    if (tab) selectTab(tab);
    pageEl.hidden = false;
  }

  function closePage() {
    pageEl.hidden = true;
  }

  buildPage();

  var TracksControl = L.Control.extend({
    onAdd: function () {
      var box = L.DomUtil.create("div", "leaflet-bar trk-control");
      var btn = L.DomUtil.create("a", "trk-toggle", box);
      btn.tabIndex = 0;   // ohne href: langer Druck zeigt sonst die Link-Adresse an
      btn.setAttribute("role", "button");
      btn.title = "Tracks";
      btn.setAttribute("aria-label", "Tracks");
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
        '<path d="M3 19c3-1 3-6 6-7s5 3 8 1 2-7 4-8" fill="none" stroke-width="2.5" stroke-linecap="round" style="stroke: var(--c-icon-blue)"/>' +
        '<circle cx="3" cy="19" r="2" fill="currentColor"/><circle cx="21" cy="5" r="2" fill="currentColor"/></svg>';
      L.DomEvent.on(btn, "click", function (e) {
        L.DomEvent.preventDefault(e);
        openPage();
      });
      L.DomEvent.disableClickPropagation(box);
      return box;
    }
  });
  if (G.addToToolbar) {
    G.addToToolbar(new TracksControl());
  } else {
    new TracksControl().addTo(map);
  }
  G.openTracksPage = openPage;
  G.importGpxTracks = importFiles;
  G.closeTracksPage = closePage;
  G.tracksPanel = function (tab) { return pageEl.querySelector('[data-panel="' + tab + '"]'); };

  // ---------- Beim Start gespeicherte Tracks laden ----------

  function loadAll() {
    return dbAll().then(function (all) {
      Object.keys(layers).forEach(function (id) { map.removeLayer(layers[id]); });
      layers = {};
      parsedCache = {};
      records = all || [];
      records.forEach(function (rec) { if (rec.visible) showTrack(rec, false); });
      renderList();
    }).catch(function (err) {
      console.warn("[GoAhead] Tracks konnten nicht geladen werden:", err);
      if (listEl) listEl.innerHTML = '<p class="trk-empty">Die gespeicherten Daten lassen sich gerade nicht öffnen. Bitte die App neu starten.</p>';
    });
  }
  loadAll();
  // Nach Sammel-Import oder Wiederherstellen (backup.js) neu einlesen
  window.addEventListener("goahead:data", loadAll);
})();
