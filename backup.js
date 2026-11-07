/* GoAhead – Sicherung und Sammel-Import.
 *
 * Sicherung: alle lokalen Daten (Tracks, geplante Routen, erwanderte Touren, Einstellungen)
 *   als eine JSON-Datei – zum Aufbewahren und zum Umzug (z. B. Chrome → Android-App,
 *   altes → neues Handy). Wiederherstellen ergänzt: Einträge mit gleicher Kennung werden
 *   überschrieben, alle anderen bleiben.
 *
 * Sammel-Import: viele GPX-Dateien auf einmal, auch in ZIP-Archiven (z. B. die einzeln aus
 *   komoot heruntergeladenen Touren, gesammelt gezippt). Ziel wählbar:
 *   - Geplant: Route mit Wegpunkten etwa alle 1 km; die Linie bleibt wie in der Datei
 *     (beim Verändern wird nur der Abschnitt um einen geänderten Punkt neu berechnet).
 *   - Erwandert: Aufzeichnung mit Zeitstempeln.
 *   - GPX: wie bisher unter „GPX“.
 *   „Automatisch“ ordnet Dateien mit Zeitstempeln an fast allen Punkten als erwandert ein.
 *   Ob komoot in geplante Touren Zeitstempel schreibt, ist ungeprüft – daher die Wahl.
 *   Bereits importierte Dateien (gleicher Name, gleiche Länge, gleicher Start) werden übersprungen.
 *
 * ZIP: eigener kleiner Leser (zentrales Verzeichnis, Verfahren „stored“ und „deflate“), entpackt
 *   mit DecompressionStream("deflate-raw") des Browsers (Chrome ab 80, Safari ab 16.4). ZIP64 nicht.
 */
(function () {
  "use strict";

  var G = window.GOAHEAD;

  var T = window.GOAHEAD_I18N.t;
  if (!G || !G.map) return;

  var STORES = ["tracks", "routes", "walks", "photos", "marklayers"];
  var POINT_SPACING = 1000;   // m: Abstand der Wegpunkte bei importierten Routen
  var CLIMB_THRESHOLD = 3;    // m: wie planner.js
  // Nicht wiederherstellen: laufende Tour und Planungsentwurf des Geräts (sonst gingen diese verloren)
  var LOCAL_SKIP = ["goahead.walk.v1", "goahead.plan.v1"];

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() < 9 ? "0" : "") + (d.getMonth() + 1) + "-" + (d.getDate() < 10 ? "0" : "") + d.getDate();
  }

  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function changed() {
    try { window.dispatchEvent(new Event("goahead:data")); } catch (e) { /* alte Browser */ }
  }

  function dist(a, b) { return L.latLng(a[0], a[1]).distanceTo(L.latLng(b[0], b[1])); }

  // ---------- Sicherung ----------

  function collect() {
    return Promise.all(STORES.map(function (n) { return G.db.all(n); })).then(function (res) {
      var local = {};
      try {
        for (var i = 0; i < window.localStorage.length; i++) {
          var k = window.localStorage.key(i);
          if (k && k.indexOf("goahead.") === 0 && LOCAL_SKIP.indexOf(k) < 0) local[k] = window.localStorage.getItem(k);
        }
      } catch (e) { /* kein Zugriff */ }
      var data = { app: "GoAhead", format: 1, version: G.version, createdAt: new Date().toISOString(), stores: {}, local: local };
      STORES.forEach(function (n, i) { data.stores[n] = res[i] || []; });
      // Fotos: Bild (Blob) als data:-URL, damit es in die JSON-Datei passt
      return Promise.all(data.stores.photos.map(function (ph) {
        if (!(ph.blob instanceof Blob)) return ph;
        return blobToDataUrl(ph.blob).then(function (url) {
          var c = {};
          Object.keys(ph).forEach(function (k) { if (k !== "blob") c[k] = ph[k]; });
          c.dataUrl = url;
          return c;
        });
      })).then(function (photos) { data.stores.photos = photos; return data; });
    });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  // Fotos aus der Sicherung: data:-URL wieder als Blob speichern
  function revivePhotos(list) {
    return Promise.all(list.map(function (ph) {
      if (!ph.dataUrl) return ph;
      return fetch(ph.dataUrl).then(function (r) { return r.blob(); }).then(function (b) {
        var c = {};
        Object.keys(ph).forEach(function (k) { if (k !== "dataUrl") c[k] = ph[k]; });
        c.blob = b;
        return c;
      });
    }));
  }

  function save() {
    if (!G.db) { G.showStatus("Speichern ist auf diesem Gerät gerade nicht möglich.", 5000); return; }
    G.showStatus("Sicherung wird erstellt …");
    collect().then(function (data) {
      var text = JSON.stringify(data);
      var name = "goahead-sicherung-" + today() + ".json";
      var sub = T("{0} geplant · {1} erwandert · {2} GPX · {3} Fotos · {4} MB", data.stores.routes.length, data.stores.walks.length,
        data.stores.tracks.length, data.stores.photos.length, G.i18n.dec((text.length / 1048576).toFixed(1)));
      if (G.hideStatus) G.hideStatus();
      var actions = [{ label: "⬇ Speichern (Downloads)", primary: true, onClick: function () { G.downloadFile(name, text, "application/json"); } }];
      if (G.native) {
        actions.push({ label: "↗ Teilen (z. B. Google Drive, E-Mail)", onClick: function () {
          if (!G.native.call("shareFile", name, "application/json", text, "GoAhead-Sicherung", "GoAhead-Sicherung " + today())) {
            G.showStatus("Teilen hat nicht geklappt.", 5000);
          }
        } });
      } else {
        var file = null;
        try { file = new File([text], name, { type: "application/json" }); } catch (e) { /* alte Browser */ }
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          actions.push({ label: "↗ Teilen (z. B. Google Drive, E-Mail)", onClick: function () {
            navigator.share({ files: [file], title: "GoAhead-Sicherung" }).catch(function (err) {
              if (!err || err.name !== "AbortError") G.showStatus("Teilen hat nicht geklappt.", 6000);
            });
          } });
        }
      }
      G.actionSheet("Sicherung", sub, actions);
    }).catch(function (err) {
      console.warn("[GoAhead] Sicherung:", err);
      G.showStatus("Die Sicherung konnte nicht erstellt werden.", 8000);
    });
  }

  var restoreInput = document.createElement("input");
  restoreInput.type = "file";
  restoreInput.hidden = true;
  restoreInput.accept = ".json,application/json,text/plain,application/octet-stream";
  document.body.appendChild(restoreInput);
  restoreInput.addEventListener("change", function () {
    var f = restoreInput.files && restoreInput.files[0];
    restoreInput.value = "";
    if (f) readText(f).then(restoreFrom).catch(function (err) {
      console.warn("[GoAhead] Sicherung:", err);
      G.showStatus("Diese Datei ist keine lesbare GoAhead-Sicherung.", 8000);
    });
  });

  function restore() { restoreInput.click(); }

  function restoreFrom(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("keine gültige Sicherungsdatei"); }
    if (!data || data.app !== "GoAhead" || !data.stores) throw new Error("keine GoAhead-Sicherung");
    var counts = STORES.map(function (n) { return (data.stores[n] || []).length; });
    var when = data.createdAt ? new Date(data.createdAt).toLocaleString(G.i18n.locale) : "?";
    G.actionSheet(T("Sicherung vom {0} wiederherstellen?", when),
      T("{0} geplant · {1} erwandert · {2} GPX. Gleiche Einträge werden überschrieben, andere bleiben.", counts[1], counts[2], counts[0]), [
        { label: "Wiederherstellen", primary: true, onClick: function () {
          var chain = Promise.resolve();
          STORES.forEach(function (n) {
            var recs = (data.stores[n] || []).filter(function (r) { return r && r.id; });
            if (!recs.length) return;
            chain = chain.then(function () {
              return (n === "photos" ? revivePhotos(recs) : Promise.resolve(recs)).then(function (r) { return G.db.putMany(n, r); });
            });
          });
          chain.then(function () {
            var hasLocal = false;
            try {
              Object.keys(data.local || {}).forEach(function (k) {
                if (k.indexOf("goahead.") === 0 && LOCAL_SKIP.indexOf(k) < 0) {
                  window.localStorage.setItem(k, data.local[k]);
                  hasLocal = true;
                }
              });
            } catch (e) { /* Speicher voll o. ä. – Daten sind trotzdem zurück */ }
            changed();
            G.showStatus(T("Wiederhergestellt: {0} geplant, {1} erwandert, {2} GPX.", counts[1], counts[2], counts[0]) +
              (hasLocal ? " " + T("Einstellungen gelten nach dem Neuladen.") : ""), 6000);
            // Einstellungen werden beim Start gelesen: neu laden (laufende Tour bleibt erhalten)
            if (hasLocal) setTimeout(function () { window.location.reload(); }, 2500);
          }).catch(function (err) {
            console.warn("[GoAhead] Wiederherstellen:", err);
            G.showStatus("Wiederherstellen hat nicht geklappt.", 8000);
          });
        } }
      ]);
  }

  // ---------- Dateien lesen (auch ZIP) ----------

  function readBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(file);
    });
  }

  function readText(file) {
    return readBuffer(file).then(function (buf) { return new TextDecoder("utf-8").decode(buf); });
  }

  function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") {
      return Promise.reject(new Error("ZIP-Dateien lassen sich hier nicht öffnen – bitte die GPX-Dateien einzeln wählen."));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  // ZIP-Einträge, deren Name passt; Rückgabe [{name, bytes}]
  function unzip(buf, wanted) {
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);
    var eocd = -1;
    for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return Promise.reject(new Error("ZIP-Datei beschädigt"));
    var count = dv.getUint16(eocd + 10, true);
    var p = dv.getUint32(eocd + 16, true);
    if (p === 0xffffffff || count === 0xffff) return Promise.reject(new Error("Dieses ZIP-Format lässt sich nicht öffnen – bitte die GPX-Dateien einzeln wählen."));
    var dec = new TextDecoder("utf-8");
    var jobs = [];
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) return Promise.reject(new Error("ZIP-Datei beschädigt"));
      var method = dv.getUint16(p + 10, true);
      var size = dv.getUint32(p + 20, true);
      var nLen = dv.getUint16(p + 28, true);
      var xLen = dv.getUint16(p + 30, true);
      var cLen = dv.getUint16(p + 32, true);
      var off = dv.getUint32(p + 42, true);
      var name = dec.decode(u8.subarray(p + 46, p + 46 + nLen));
      p += 46 + nLen + xLen + cLen;
      if (/\/$/.test(name) || /(^|\/)__MACOSX\//.test(name) || !wanted(name)) continue;
      var start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      var data = u8.subarray(start, start + size);
      var short = name.split("/").pop();
      if (method === 0) jobs.push(Promise.resolve({ name: short, bytes: data }));
      else if (method === 8) jobs.push(inflateRaw(data).then((function (nm) { return function (b) { return { name: nm, bytes: b }; }; })(short)));
      else jobs.push(Promise.resolve({ name: short, error: T("„{0}“ lässt sich nicht entpacken.", short) }));
    }
    return Promise.all(jobs);
  }

  function isZip(buf) {
    return buf.byteLength > 4 && new DataView(buf).getUint32(0, true) === 0x04034b50;
  }

  function isGpxName(n) { return /\.gpx(\.txt)?$/i.test(n) || /\.xml$/i.test(n); }

  // Alle gewählten Dateien → [{name, text}] (ZIP-Inhalte, auch ZIP in ZIP, aufgelöst)
  function expand(files, errors) {
    var out = [];
    var dec = new TextDecoder("utf-8");
    function fromBuffer(name, buf, depth) {
      if (isZip(buf)) {
        if (depth > 1) return Promise.resolve();
        return unzip(buf, function (n) { return isGpxName(n) || /\.zip$/i.test(n); }).then(function (entries) {
          var chain = Promise.resolve();
          entries.forEach(function (e) {
            if (e.error) { errors.push(e.error); return; }
            chain = chain.then(function () {
              var b = e.bytes.buffer.slice(e.bytes.byteOffset, e.bytes.byteOffset + e.bytes.byteLength);
              return fromBuffer(e.name, b, depth + 1);
            });
          });
          return chain;
        });
      }
      out.push({ name: name, text: dec.decode(buf) });
      return Promise.resolve();
    }
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return readBuffer(f).then(function (buf) { return fromBuffer(f.name, buf, 0); })
          .catch(function (err) { console.warn("[GoAhead] Import:", err); errors.push(T("„{0}“ lässt sich nicht öffnen.", f.name)); });
      });
    });
    return chain.then(function () { return out; });
  }

  // ---------- GPX lesen (mit Zeitstempeln) ----------

  function childText(el, name) {
    for (var i = 0; i < el.children.length; i++) {
      if (el.children[i].localName === name) return el.children[i].textContent.trim();
    }
    return "";
  }

  function parse(text, fileName) {
    var doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length || !doc.documentElement || doc.documentElement.localName !== "gpx") {
      throw new Error(T("„{0}“ ist keine gültige GPX-Datei.", fileName));
    }
    var root = doc.documentElement;
    var lines = [];
    var timed = 0;
    var total = 0;
    function read(parent, tag) {
      var els = parent.getElementsByTagNameNS("*", tag);
      var pts = [];
      for (var i = 0; i < els.length; i++) {
        var lat = parseFloat(els[i].getAttribute("lat"));
        var lon = parseFloat(els[i].getAttribute("lon"));
        if (isNaN(lat) || isNaN(lon)) continue;
        var ele = parseFloat(childText(els[i], "ele"));
        var t = Date.parse(childText(els[i], "time"));
        total++;
        if (!isNaN(t)) timed++;
        pts.push([lat, lon, isNaN(ele) ? null : Math.round(ele * 10) / 10, isNaN(t) ? null : t]);
      }
      return pts;
    }
    var segs = root.getElementsByTagNameNS("*", "trkseg");
    for (var i = 0; i < segs.length; i++) { var a = read(segs[i], "trkpt"); if (a.length > 1) lines.push(a); }
    if (!lines.length) {
      var rtes = root.getElementsByTagNameNS("*", "rte");
      for (var j = 0; j < rtes.length; j++) { var b = read(rtes[j], "rtept"); if (b.length > 1) lines.push(b); }
    }
    if (!lines.length) throw new Error(T("„{0}“ enthält keine Strecke.", fileName));
    var name = "";
    var metaTime = NaN;
    var meta = root.getElementsByTagNameNS("*", "metadata")[0];
    if (meta) { name = childText(meta, "name"); metaTime = Date.parse(childText(meta, "time")); }
    var trk = root.getElementsByTagNameNS("*", "trk")[0] || root.getElementsByTagNameNS("*", "rte")[0];
    if (!name && trk) name = childText(trk, "name");
    if (!name) name = fileName.replace(/\.txt$/i, "").replace(/\.gpx$/i, "");
    var length = 0;
    lines.forEach(function (l) { for (var k = 1; k < l.length; k++) length += dist(l[k - 1], l[k]); });
    var first = lines[0][0];
    var lastLine = lines[lines.length - 1];
    var t0 = first[3];
    var t1 = lastLine[lastLine.length - 1][3];
    return {
      name: name,
      fileName: fileName,
      lines: lines,
      length: length,
      // „aufgezeichnet“: fast alle Punkte mit Zeit und die Zeit läuft vorwärts
      recorded: total > 0 && timed / total >= 0.9 && t0 != null && t1 != null && t1 > t0,
      metaTime: isNaN(metaTime) ? null : metaTime,
      t0: t0,
      key: name + "|" + Math.round(length / 10) + "|" + first[0].toFixed(5) + "," + first[1].toFixed(5)
    };
  }

  function climb(eles) {
    var up = 0, down = 0, ref = null;
    eles.forEach(function (e) {
      if (e == null) return;
      if (ref == null) { ref = e; return; }
      var d = e - ref;
      if (d >= CLIMB_THRESHOLD) { up += d; ref = e; } else if (d <= -CLIMB_THRESHOLD) { down -= d; ref = e; }
    });
    return { up: up, down: down };
  }

  // ---------- Umwandeln ----------

  function toRoute(g) {
    // alle Teilstücke aneinander; doppelte Punkte weglassen
    var line = [];
    g.lines.forEach(function (l) {
      l.forEach(function (p) {
        var last = line[line.length - 1];
        if (last && last[0] === p[0] && last[1] === p[1]) return;
        line.push(p);
      });
    });
    // Wegpunkte etwa alle POINT_SPACING m, dazu Start und Ziel
    var cuts = [0];
    var acc = 0;
    for (var i = 1; i < line.length; i++) {
      acc += dist(line[i - 1], line[i]);
      if (acc >= POINT_SPACING && i < line.length - 1) { cuts.push(i); acc = 0; }
    }
    cuts.push(line.length - 1);
    var points = cuts.map(function (c) { return { lat: line[c][0], lng: line[c][1] }; });
    var segments = [];
    for (var s = 1; s < cuts.length; s++) {
      var part = line.slice(cuts[s - 1], cuts[s] + 1);
      var d = 0;
      for (var k = 1; k < part.length; k++) d += dist(part[k - 1], part[k]);
      segments.push({
        latlngs: part.map(function (p) { return p[2] != null ? [p[0], p[1], p[2]] : [p[0], p[1]]; }),
        distance: d,
        ascent: climb(part.map(function (p) { return p[2]; })).up,
        source: "Import",
        mode: "route"
      });
    }
    var when = new Date(g.metaTime || g.t0 || Date.now()).toISOString();
    var rec = {
      id: newId(),
      name: g.name,
      createdAt: when,
      updatedAt: when,
      points: points,
      segments: segments,
      roundtrip: false,
      closing: null,
      profile: "hiking",
      importKey: g.key,
      importedFrom: g.fileName
    };
    var t = G.planner && G.planner.routeStats ? G.planner.routeStats(rec) : null;
    rec.stats = { length: t ? t.dist : g.length, ascent: t ? t.up : null, descent: t ? t.down : null,
      hours: t ? t.hours : null, points: points.length, lines: 0 };
    return rec;
  }

  function toWalk(g) {
    var segs = g.lines;
    var distance = 0;
    var moving = 0;
    var eles = [];
    segs.forEach(function (l) {
      for (var i = 0; i < l.length; i++) {
        eles.push(l[i][2]);
        if (!i) continue;
        var d = dist(l[i - 1], l[i]);
        distance += d;
        // Bewegungszeit (Schätzung): Lücken über 2 min und Stillstand zählen nicht
        if (l[i][3] != null && l[i - 1][3] != null) {
          var dt = (l[i][3] - l[i - 1][3]) / 1000;
          if (dt > 0 && dt <= 120 && d / dt >= 0.2) moving += dt * 1000;
        }
      }
    });
    var last = segs[segs.length - 1];
    var start = g.t0 || g.metaTime || Date.now();
    var end = last[last.length - 1][3] || start;
    var c = climb(eles);
    return {
      id: newId(),
      name: g.name,
      routeId: null,
      routeName: g.name,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
      movingMs: moving,
      distance: distance,
      ascent: c.up || null,
      segments: segs,
      importKey: g.key,
      importedFrom: g.fileName
    };
  }

  // ---------- Sammel-Import ----------

  function importFiles(files) {
    files = Array.prototype.slice.call(files || []);
    if (!files.length) return;
    var errors = [];
    G.showStatus("Dateien werden gelesen …");
    expand(files, errors).then(function (items) {
      var parsed = [];
      items.forEach(function (it) {
        try { parsed.push(parse(it.text, it.name)); } catch (e) { errors.push(e.message); }
      });
      if (G.hideStatus) G.hideStatus();
      if (!parsed.length) {
        G.showStatus(errors.length ? errors.slice(0, 3).join(" ") : "Keine GPX-Dateien gefunden.", 8000);
        return;
      }
      var rec = parsed.filter(function (g) { return g.recorded; }).length;
      var plan = parsed.length - rec;
      var sub = T("{0} Tour(en): {1} mit Zeitstempeln (aufgezeichnet), {2} ohne", parsed.length, rec, plan) +
        (errors.length ? " · " + T("{0} nicht lesbar", errors.length) : "");
      G.actionSheet("Importieren nach …", sub, [
        { label: T("Automatisch: {0} → Erwandert, {1} → Geplant", rec, plan), primary: true, onClick: function () { run(parsed, "auto", errors); } },
        { label: "Alle unter „Geplant“", onClick: function () { run(parsed, "routes", errors); } },
        { label: "Alle unter „Erwandert“", onClick: function () { run(parsed, "walks", errors); } },
        { label: "Alle unter „GPX“", onClick: function () {
          G.importGpxTracks(items.map(function (it) { return new File([it.text], it.name, { type: "application/gpx+xml" }); }));
        } }
      ]);
    }).catch(function (err) {
      console.warn("[GoAhead] Import:", err);
      G.showStatus("Der Import hat nicht geklappt.", 8000);
    });
  }

  function run(parsed, mode, errors) {
    Promise.all([G.db.all("routes"), G.db.all("walks")]).then(function (res) {
      var known = { routes: {}, walks: {} };
      (res[0] || []).forEach(function (r) { if (r.importKey) known.routes[r.importKey] = true; });
      (res[1] || []).forEach(function (r) { if (r.importKey) known.walks[r.importKey] = true; });
      var out = { routes: [], walks: [] };
      var skipped = 0;
      parsed.forEach(function (g) {
        var target = mode === "auto" ? (g.recorded ? "walks" : "routes") : mode;
        if (known[target][g.key]) { skipped++; return; }
        known[target][g.key] = true;   // auch Dubletten innerhalb dieses Imports
        try { out[target].push(target === "walks" ? toWalk(g) : toRoute(g)); } catch (e) { console.warn("[GoAhead] Import:", e); errors.push(T("„{0}“ lässt sich nicht übernehmen.", g.fileName)); }
      });
      return G.db.putMany("routes", out.routes).then(function () {
        return G.db.putMany("walks", out.walks);
      }).then(function () {
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
        changed();
        var msg = T("Importiert: {0} geplant, {1} erwandert", out.routes.length, out.walks.length) +
          (skipped ? ", " + T("{0} schon vorhanden", skipped) : "") + "." +
          (errors.length ? " " + T("{0} Fehler:", errors.length) + " " + errors.slice(0, 2).join(" ") : "");
        G.showStatus(msg, errors.length ? 10000 : 6000);
        if (G.openTracksPage) G.openTracksPage(out.walks.length && !out.routes.length ? "walked" : "planned");
      });
    }).catch(function (err) {
      console.warn("[GoAhead] Import:", err);
      G.showStatus("Der Import hat nicht geklappt.", 8000);
    });
  }

  // Erwanderte Tour als geplante Route (z. B. falsch einsortierte komoot-Planung)
  function walkToRoute(w) {
    return toRoute({ name: w.name, lines: w.segments, length: w.distance, key: w.importKey || ("walk|" + w.id),
      fileName: w.importedFrom || "", metaTime: null, t0: Date.parse(w.startedAt) || null });
  }

  G.backup = { save: save, restore: restore, importFiles: importFiles, parse: parse, unzip: unzip, walkToRoute: walkToRoute };
})();
