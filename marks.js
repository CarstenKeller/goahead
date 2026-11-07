/* GoAhead – eigene Markierungsebenen für Wegemarkierer.
 *
 * Eine Ebene hält den Markierungszustand eines Gebiets (z. B. der eigenen Wabe) fest:
 *  - Wegzeichen der Ebene: amtliche TFIS-Wegzeichen (Signaturnummer → symbols/tfis/<Nr>.svg, siehe app.js
 *    tfisSymbolUrl und .github/workflows/pages.yml) oder eigene Bilder (verkleinert als data:-URL gespeichert).
 *  - Positionen: Ort + Liste von Wegzeichen (Reihenfolge änderbar), je Wegzeichen ein Zustand
 *    (gut / erneuern / fehlt) und ggf. das Foto der tatsächlichen Markierung.
 *
 * Gespeichert in IndexedDB, Speicher "marklayers" (über G.db aus tracks.js):
 *   {id, name, created, visible,
 *    symbols: [{id, name, tfis|null (Signaturnummer), key|null (eigene Wegenummer des Vereins), img|null}],
 *    points:  [{id, lat, lng, time, photos: [fotoId], signs: [{id, sym, state: "ok"|"renew"|"missing", photos: [fotoId]}]}]}
 *    (je Wegzeichen höchstens ein Eintrag pro Position; Positionen ohne Wegzeichen nur, solange ausgewählt)
 * Fotos liegen im Speicher "photos" (photos.js) mit walkId "mark:<ebenenId>:<positionsId|>" – so findet die
 * Rückmeldung der Kamera-App die Ebene auch dann, wenn die Seite zwischendurch neu geladen wurde.
 *
 * Bedienung: Seite „Ebenen“ (Liste, neue Ebene) → Ebene öffnen = Leiste über der Karte mit Kamera (Kopfzeile),
 * Wegzeichen ohne Foto, Filter nach Wegzeichen/Zustand mit Anzahl. Marker antippen = Position auswählen
 * (verschiebbar, Wegzeichen ordnen, Zustand ändern). Die Ebenen stehen auch in der Kartenwahl.
 *
 * Schritt 2 (noch offen): automatische Erkennung des Wegzeichens im Foto (Vorschlag, Bestätigung per Tipp).
 */
(function () {
  "use strict";

  var G = window.GOAHEAD;
  var T = window.GOAHEAD_I18N.t;
  if (!G || !G.map || !G.db) return;
  var map = G.map;
  var esc = G.escapeHtml;

  var STORE = "marklayers";
  var STATES = [["ok", "gut"], ["renew", "erneuern"], ["missing", "fehlt"]];
  var DETAIL_ZOOM = 14;      // darunter nur Punkte statt Wegzeichen
  var SYM_PX = 160;          // eigene Wegzeichen-Bilder: längste Seite

  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function stateLabel(st) {
    for (var i = 0; i < STATES.length; i++) if (STATES[i][0] === st) return T(STATES[i][1]);
    return "";
  }

  // ---------- Daten ----------

  var layers = [];           // alle Ebenen
  var groups = {};           // id -> L.layerGroup
  var photoCache = {};       // Foto-id -> Foto-Datensatz (für Vorschaubilder)

  function byId(id) {
    for (var i = 0; i < layers.length; i++) if (layers[i].id === id) return layers[i];
    return null;
  }
  function symOf(layer, symId) {
    for (var i = 0; i < layer.symbols.length; i++) if (layer.symbols[i].id === symId) return layer.symbols[i];
    return null;
  }
  function pointOf(layer, pointId) {
    for (var i = 0; i < layer.points.length; i++) if (layer.points[i].id === pointId) return layer.points[i];
    return null;
  }
  // Wegzeichen-Bild: TFIS-SVG aus dem Veröffentlichungslauf oder eigenes Bild
  function symUrl(sym) {
    if (!sym) return "";
    if (sym.tfis) return "symbols/tfis/" + encodeURIComponent(sym.tfis) + ".svg";
    return sym.img || "";
  }

  function save(layer) {
    return G.db.put(STORE, layer).catch(function (err) {
      console.warn("[GoAhead] Ebene speichern:", err);
      G.showStatus("Die Ebene konnte nicht gespeichert werden.", 6000);
    });
  }

  // Aufbereiten beim Laden: je Wegzeichen an einer Position nur ein Eintrag (mehrere Fotos möglich, z. B. für
  // beide Richtungen an Vorder- und Rückseite eines Baums); ältere Einträge mit einem Foto (photo) → photos.
  function normalize(l) {
    l.symbols = l.symbols || [];
    l.points = l.points || [];
    l.points.forEach(function (p) {
      p.photos = p.photos || [];
      var bySym = {};
      p.signs = (p.signs || []).filter(function (s) {
        s.photos = s.photos || (s.photo ? [s.photo] : []);
        delete s.photo;
        var first = bySym[s.sym];
        if (!first) { bySym[s.sym] = s; return true; }
        s.photos.forEach(function (id) { if (first.photos.indexOf(id) < 0) first.photos.push(id); });
        return false;
      });
    });
    return l;
  }

  // Positionen ohne Wegzeichen bleiben nur, solange sie ausgewählt sind (gerade erfasst); sonst werden sie mit
  // ihren Fotos gelöscht. true, wenn etwas entfernt wurde.
  function pruneEmpty(layer, keepId) {
    var removed = [];
    layer.points = layer.points.filter(function (p) {
      if (p.signs.length || p.id === keepId) return true;
      removed.push(p);
      return false;
    });
    removed.forEach(function (p) { deletePhotos(p.photos); });
    return removed.length > 0;
  }
  function tidy(layer) {
    if (layer && pruneEmpty(layer, current === layer ? selId : null)) save(layer);
  }

  // ---------- Zählen und Filtern ----------

  var filter = { sym: "", state: "" };    // gilt für die geöffnete Ebene

  function signMatches(s) {
    return (!filter.sym || s.sym === filter.sym) && (!filter.state || s.state === filter.state);
  }
  function filterActive() { return !!(filter.sym || filter.state); }
  function pointMatches(p) {
    if (!filterActive()) return true;
    return p.signs.some(signMatches);
  }
  // „Wegzeichen“ = vorhandene (gut + erneuern); fehlende werden getrennt gezählt
  function countText(nPos, nSigns, nMissing) {
    var t = T(nPos === 1 ? "1 Position" : "{0} Positionen", nPos);
    if (nSigns || !nMissing) t += " · " + T(nSigns === 1 ? "1 Wegzeichen" : "{0} Wegzeichen", nSigns);
    if (nMissing) t += " · " + T(nMissing === 1 ? "1 fehlt" : "{0} fehlen", nMissing);
    return t;
  }
  function summary(layer, useFilter) {
    var pos = 0, signs = 0, missing = 0;
    var f = useFilter && filterActive();
    layer.points.forEach(function (p) {
      var n = 0;
      p.signs.forEach(function (s) {
        if (f && !signMatches(s)) return;
        n++;
        if (s.state === "missing") missing++; else signs++;
      });
      if (!f || n) pos++;
    });
    return countText(pos, signs, missing);
  }
  // Anzahl je Wegzeichen nach Zustand: {ok, renew, missing, all}
  function symCounts(layer, symId) {
    var c = { ok: 0, renew: 0, missing: 0, all: 0 };
    layer.points.forEach(function (p) {
      p.signs.forEach(function (s) { if (s.sym === symId) { c[s.state] = (c[s.state] || 0) + 1; c.all++; } });
    });
    return c;
  }
  function symCountText(c) {
    if (!c.all) return T("nicht zugeordnet");
    var parts = [T("{0} zugeordnet", c.all)];
    if (c.ok) parts.push(T("{0} gut", c.ok));
    if (c.renew) parts.push(T("{0} erneuern", c.renew));
    if (c.missing) parts.push(T(c.missing === 1 ? "1 fehlt" : "{0} fehlen", c.missing));
    return parts.join(" · ");
  }

  // ---------- Karte ----------

  var current = null;        // geöffnete Ebene
  var selId = null;          // ausgewählte Position
  var pick = null;           // {photoId|null}: Wegzeichen für die ausgewählte Position wählen

  function scale() { return (G.symbolScale && G.symbolScale()) || 1; }

  function markerIcon(layer, p) {
    var sel = current === layer && p.id === selId;
    if (map.getZoom() < DETAIL_ZOOM && !sel) {
      var worst = "ok";
      p.signs.forEach(function (s) { if (s.state === "missing") worst = "missing"; else if (s.state === "renew" && worst !== "missing") worst = "renew"; });
      if (!p.signs.length) worst = "none";
      var d = Math.round(14 * scale());
      return L.divIcon({ className: "", html: '<div class="mk-dot mk-' + worst + '" style="width:' + d + "px;height:" + d + 'px"></div>',
        iconSize: [d, d], iconAnchor: [d / 2, d / 2] });
    }
    // Beim Filtern nur die passenden Wegzeichen zeigen; die ausgewählte Position zeigt alle (zum Bearbeiten)
    var list = p.signs;
    if (current === layer && filterActive() && !sel) list = list.filter(signMatches);
    if (!list.length) list = [null];
    // Größe wie die Wegemarkierungen der Kartenebenen (Einstellungen → Karte → Wegemarkierungen)
    var sz = Math.round(28 * scale());
    var html = '<div class="mk-pin' + (sel ? " sel" : "") + '" style="--mk-s:' + sz + 'px"><div class="mk-stack">' + list.map(function (s) {
      if (!s) return '<span class="mk-sign mk-none">?</span>';
      return '<span class="mk-sign mk-' + s.state + '"><img alt="" src="' + esc(symUrl(symOf(layer, s.sym))) + '"></span>';
    }).join("") + '</div><span class="mk-tail"></span></div>';
    // Stapel: Wegzeichen mit 2 px Abstand, 2 px Rand, darunter 8 px Spitze
    var w = sz + 4, h = list.length * (sz + 2) - 2 + 4 + 8;
    return L.divIcon({ className: "", html: html, iconSize: [w, h], iconAnchor: [w / 2, h] });
  }

  function renderMarkers(layer) {
    var g = groups[layer.id];
    if (!g) return;
    g.clearLayers();
    layer.points.forEach(function (p) {
      if (current === layer && !pointMatches(p) && p.id !== selId) return;
      var sel = current === layer && p.id === selId;
      var m = L.marker([p.lat, p.lng], { icon: markerIcon(layer, p), keyboard: false, draggable: sel, zIndexOffset: sel ? 900 : 400 });
      m.on("click", function (e) {
        L.DomEvent.stopPropagation(e);
        openLayer(layer.id, { select: p.id });
      });
      if (sel) {
        m.on("dragend", function () {
          var ll = m.getLatLng();
          p.lat = ll.lat;
          p.lng = ll.lng;
          save(layer);
        });
      }
      m.addTo(g);
    });
  }

  function ensureGroup(layer) {
    if (groups[layer.id]) return groups[layer.id];
    var g = L.layerGroup();
    g._goaheadMark = layer.id;
    groups[layer.id] = g;
    if (G.addOverlay) G.addOverlay(g, layer.name);
    return g;
  }
  function dropGroup(id) {
    var g = groups[id];
    if (!g) return;
    // erst aus der Kartenwahl nehmen: sonst meldet sie „ausgeblendet“ und die Ebene würde unsichtbar gespeichert
    if (G.removeOverlay) G.removeOverlay(g);
    map.removeLayer(g);
    delete groups[id];
  }
  function setVisible(layer, on) {
    var g = ensureGroup(layer);
    if (on && !map.hasLayer(g)) g.addTo(map);
    if (!on && map.hasLayer(g)) map.removeLayer(g);
  }

  // Sichtbarkeit aus der Kartenwahl übernehmen
  map.on("overlayadd overlayremove", function (e) {
    var id = e.layer && e.layer._goaheadMark;
    var layer = id && byId(id);
    if (!layer) return;
    var on = e.type === "overlayadd";
    if (on) renderMarkers(layer);
    if (layer.visible !== on) {
      layer.visible = on;
      save(layer);
      renderPage();
    }
  });
  if (G.onSymbolScale) G.onSymbolScale(function () {
    layers.forEach(function (l) { if (groups[l.id] && map.hasLayer(groups[l.id])) renderMarkers(l); });
  });
  map.on("zoomend", function () {
    layers.forEach(function (l) { if (groups[l.id] && map.hasLayer(groups[l.id])) renderMarkers(l); });
  });

  // ---------- Fotos ----------

  function loadPhotos(layer) {
    var prefix = "mark:" + layer.id + ":";
    return G.db.all("photos").then(function (list) {
      (list || []).forEach(function (ph) { if (String(ph.walkId).indexOf(prefix) === 0) photoCache[ph.id] = ph; });
    }).catch(function () { /* ohne Vorschaubilder */ });
  }
  function deletePhotos(ids) {
    ids.forEach(function (id) {
      delete photoCache[id];
      G.db.del("photos", id).catch(function () { /* egal */ });
    });
  }

  if (G.photos) {
    // Neues Foto aus dem Ebenen-Modus: Position anlegen bzw. ergänzen, dann Wegzeichen wählen
    G.photos.onAdded(function (ph) {
      var m = /^mark:([^:]+):(.*)$/.exec(String(ph.walkId || ""));
      if (!m) return;
      photoCache[ph.id] = ph;
      ready.then(function () {
        var layer = byId(m[1]);
        if (!layer) return;
        var p = m[2] && pointOf(layer, m[2]);
        if (!p) {
          p = { id: newId(), lat: ph.lat, lng: ph.lng, time: ph.time || Date.now(), photos: [], signs: [] };
          layer.points.push(p);
        }
        p.photos.push(ph.id);
        save(layer);
        openLayer(layer.id, { select: p.id, pick: { photoId: ph.id } });
      });
    });
    G.photos.onDeleted(function (ph) {
      delete photoCache[ph.id];
      layers.forEach(function (layer) {
        var changed = false;
        layer.points.forEach(function (p) {
          var i = p.photos.indexOf(ph.id);
          if (i >= 0) { p.photos.splice(i, 1); changed = true; }
          p.signs.forEach(function (s) {
            var j = s.photos.indexOf(ph.id);
            if (j >= 0) { s.photos.splice(j, 1); changed = true; }
          });
        });
        if (changed) { save(layer); if (layer === current) renderSheet(); }
      });
    });
  }

  // ---------- Leiste „Ebene“ ----------

  var panel = document.createElement("section");
  panel.id = "marks-panel";
  panel.className = "sheet";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Markierungsebene");
  panel.innerHTML =
    '<div class="mk-head sheet-handle">' +
      '<span class="sheet-grip" aria-hidden="true"></span>' +
      '<span class="sheet-titles"><span class="mk-title" data-noi18n></span><span class="mk-sub"></span></span>' +
      '<span class="sheet-head-btns">' +
        '<button type="button" class="icon-btn mk-photo" title="Markierung fotografieren" aria-label="Markierung fotografieren">' + G.icon("camera") + "</button>" +
        '<button type="button" class="icon-btn mk-pdf" title="PDF erstellen" aria-label="PDF erstellen">' + G.icon("pdf") + "</button>" +
        '<button type="button" class="icon-btn mk-nophoto" title="Wegzeichen ohne Foto erfassen" aria-label="Wegzeichen ohne Foto erfassen">' + G.icon("plus") + "</button>" +
        '<button type="button" class="icon-btn mk-close" title="Schließen" aria-label="Schließen">' + G.icon("close") + "</button>" +
      "</span>" +
    "</div>" +
    '<div class="sheet-body">' +
      '<div class="mk-point" hidden></div>' +
      '<div class="list-head mk-filter"></div>' +
    "</div>";
  document.body.appendChild(panel);
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);
  G.makeResizable(panel, panel.querySelector(".mk-head"), "goahead.marksHeight.v1");

  var pointEl = panel.querySelector(".mk-point");
  var filterEl = panel.querySelector(".mk-filter");

  function symImg(layer, symId, cls) {
    return '<img class="' + (cls || "mk-sym-img") + '" alt="" src="' + esc(symUrl(symOf(layer, symId))) + '">';
  }

  function renderPoint() {
    var layer = current;
    var p = layer && selId && pointOf(layer, selId);
    pointEl.hidden = !p;
    if (!p) { pointEl.innerHTML = ""; return; }
    var when = new Date(p.time).toLocaleString(G.i18n.locale, { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
    var html = '<div class="mk-point-head"><span class="mk-point-title">' + esc(when) + "</span>" +
      '<button type="button" class="icon-btn mk-del-point" title="Position löschen" aria-label="Position löschen">' + G.icon("trash") + "</button>" +
      '<button type="button" class="icon-btn mk-unsel" title="Auswahl aufheben" aria-label="Auswahl aufheben">' + G.icon("close") + "</button></div>";
    var photos = p.photos.filter(function (id) { return photoCache[id]; });
    if (photos.length) {
      html += '<div class="tour-photos mk-photos">' + photos.map(function (id) {
        return '<button type="button" class="tour-photo" data-photo="' + esc(id) + '" title="Foto anzeigen" aria-label="Foto anzeigen">' +
          '<img alt="" src="' + esc(G.photos.url(photoCache[id])) + '"></button>';
      }).join("") + "</div>";
    }
    html += p.signs.map(function (s, i) {
      var sym = symOf(layer, s.sym);
      return '<div class="mk-sign-row" data-sign="' + esc(s.id) + '">' +
        '<span class="mk-sign-main" data-act="sign">' +
          '<span class="mk-sign mk-' + s.state + '">' + symImg(layer, s.sym, "") + "</span>" +
          '<span class="trk-text"><span class="trk-name" data-noi18n>' + esc(sym ? sym.name : "?") + "</span>" +
          '<span class="trk-info mk-st-' + s.state + '">' + esc(stateLabel(s.state) + (s.photos.length > 1 ? " · " + T("{0} Fotos", s.photos.length) : s.photos.length ? " · " + T("mit Foto") : "")) + "</span></span>" +
        "</span>" +
        '<button type="button" class="icon-btn" data-act="up" title="Nach oben" aria-label="Nach oben"' + (i === 0 ? " disabled" : "") + ">" + G.icon("up") + "</button>" +
        '<button type="button" class="icon-btn" data-act="down" title="Nach unten" aria-label="Nach unten"' + (i === p.signs.length - 1 ? " disabled" : "") + ">" + G.icon("down") + "</button>" +
        "</div>";
    }).join("");
    if (pick) {
      html += '<div class="mk-pick">' + (layer.symbols.length ? layer.symbols.map(function (sym) {
        var here = p.signs.some(function (x) { return x.sym === sym.id; });
        return '<button type="button" class="mk-pick-btn' + (here ? " on" : "") + '" data-pick="' + esc(sym.id) + '" title="' + esc(sym.name) + '" aria-label="' + esc(sym.name) + '" data-noi18n>' +
          '<img alt="" src="' + esc(symUrl(sym)) + '"><span>' + esc(sym.name) + "</span></button>";
      }).join("") : '<p class="trk-empty">Noch keine Wegzeichen hinterlegt.</p>') +
        '<button type="button" class="icon-btn mk-pick-cancel" title="Nicht zuordnen" aria-label="Nicht zuordnen">' + G.icon("close") + "</button></div>";
    }
    pointEl.innerHTML = html;
  }

  function renderFilter() {
    var layer = current;
    var opts = '<option value="">Alle Wegzeichen</option>' + layer.symbols.map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (filter.sym === s.id ? " selected" : "") + " data-noi18n>" + esc(s.name) + "</option>";
    }).join("");
    var st = '<option value="">Alle Zustände</option>' + STATES.map(function (s) {
      return '<option value="' + s[0] + '"' + (filter.state === s[0] ? " selected" : "") + ">" + esc(T(s[1])) + "</option>";
    }).join("");
    // Anzahl nur bei aktivem Filter (ohne Filter steht sie schon in der Kopfzeile)
    filterEl.innerHTML =
      (filterActive() ? '<span class="list-sum">' + esc(summary(layer, true)) + "</span>" : "") +
      '<select class="list-kind mk-f-sym" aria-label="Wegzeichen" title="Wegzeichen">' + opts + "</select>" +
      '<select class="list-year mk-f-state" aria-label="Zustand" title="Zustand">' + st + "</select>";
  }

  function renderSheet() {
    var layer = current;
    if (!layer) return;
    panel.querySelector(".mk-title").textContent = layer.name;
    panel.querySelector(".mk-sub").textContent = summary(layer, false);
    renderPoint();
    renderFilter();
    renderMarkers(layer);
  }

  function openLayer(id, opts) {
    var layer = byId(id);
    if (!layer) return;
    opts = opts || {};
    if (current !== layer) {
      selId = null;
      pick = null;
      tidy(current);   // leere Position der vorher geöffneten Ebene aufräumen
      filter = { sym: "", state: "" };
    }
    if (opts.filterSym !== undefined) filter = { sym: opts.filterSym, state: "" };
    var prev = current;
    current = layer;
    if (prev && prev !== layer) renderMarkers(prev);
    if (opts.select !== undefined) {
      if (selId !== opts.select) pick = null;
      selId = opts.select;
      tidy(layer);
    }
    if (opts.pick) pick = opts.pick;
    if (!layer.visible) { layer.visible = true; save(layer); }
    setVisible(layer, true);
    closePage();
    if (G.closeMenu) G.closeMenu();
    if (G.closeInfoPanel) G.closeInfoPanel();
    document.body.classList.add("mode-marks");
    panel.hidden = false;
    renderSheet();
    if (opts.select) {
      var p = pointOf(layer, opts.select);
      if (p) keepVisible(p);
    }
    loadPhotos(layer).then(function () { if (current === layer) renderPoint(); });
  }

  // Ausgewählte Position oberhalb der Leiste halten (die Leiste liegt über der Karte)
  function keepVisible(p) {
    var pt = map.latLngToContainerPoint([p.lat, p.lng]);
    var size = map.getSize();
    var bottom = size.y - panel.offsetHeight - 24;
    var top = 120;               // Marker ragt nach oben (Wegzeichen über der Spitze)
    if (bottom < top + 40) return;   // Leiste fast ganz hochgezogen: nicht verschieben
    var dy = 0, dx = 0;
    if (pt.y > bottom) dy = pt.y - bottom;
    else if (pt.y < top) dy = pt.y - top;
    if (pt.x < 30) dx = pt.x - 30;
    else if (pt.x > size.x - 30) dx = pt.x - (size.x - 30);
    if (dx || dy) map.panBy([dx, dy]);
  }

  function closeLayer() {
    var layer = current;
    selId = null;
    pick = null;
    tidy(layer);
    current = null;
    filter = { sym: "", state: "" };
    panel.hidden = true;
    document.body.classList.remove("mode-marks");
    if (layer) renderMarkers(layer);
  }

  function select(pointId) {
    if (selId !== pointId) pick = null;
    selId = pointId;
    tidy(current);
    renderSheet();
  }

  panel.querySelector(".mk-close").addEventListener("click", closeLayer);
  panel.querySelector(".mk-pdf").addEventListener("click", function () { makePdf(); });

  panel.querySelector(".mk-photo").addEventListener("click", function () {
    if (!current || !G.photos) return;
    if (!current.symbols.length) { G.showStatus("Zuerst Wegzeichen hinterlegen: Seite „Ebenen“ → „…“ bei dieser Ebene.", 6000); return; }
    // ausgewählte Position: Foto ergänzt sie (nächstes Wegzeichen an derselben Stelle), sonst neue Position
    G.photos.take("mark:" + current.id + ":" + (selId || ""));
  });

  panel.querySelector(".mk-nophoto").addEventListener("click", function () {
    var layer = current;
    if (!layer) return;
    if (!layer.symbols.length) { G.showStatus("Zuerst Wegzeichen hinterlegen: Seite „Ebenen“ → „…“ bei dieser Ebene.", 6000); return; }
    var p = selId && pointOf(layer, selId);
    if (!p) {
      // Standort, ohne GPS die Kartenmitte (Position lässt sich danach verschieben)
      var pos = G.getPosition && G.getPosition();
      var ll = pos ? L.latLng(pos.lat, pos.lng) : map.getCenter();
      p = { id: newId(), lat: ll.lat, lng: ll.lng, time: Date.now(), photos: [], signs: [] };
      layer.points.push(p);
      save(layer);
      if (!pos) G.showStatus("Keine GPS-Position – Position in der Kartenmitte angelegt. Zum Verschieben ziehen.", 6000);
    }
    selId = p.id;
    pick = { photoId: null };
    renderSheet();
    keepVisible(p);
  });

  pointEl.addEventListener("click", function (e) {
    var layer = current;
    var p = layer && selId && pointOf(layer, selId);
    if (!p) return;
    if (e.target.closest(".mk-unsel")) { select(null); return; }
    if (e.target.closest(".mk-pick-cancel")) { pick = null; renderSheet(); return; }
    var ph = e.target.closest("[data-photo]");
    if (ph) { var rec = photoCache[ph.getAttribute("data-photo")]; if (rec) G.photos.open(rec); return; }
    if (e.target.closest(".mk-del-point")) {
      G.actionSheet("Position löschen?", T(p.signs.length === 1 ? "1 Wegzeichen und die Fotos dieser Stelle werden entfernt." : "{0} Wegzeichen und die Fotos dieser Stelle werden entfernt.", p.signs.length), [
        { label: "Löschen", danger: true, onClick: function () {
          layer.points = layer.points.filter(function (q) { return q !== p; });
          deletePhotos(p.photos);
          selId = null;
          pick = null;
          save(layer);
          renderSheet();
        } }
      ]);
      return;
    }
    var pb = e.target.closest("[data-pick]");
    if (pb && pick) {
      var symId = pb.getAttribute("data-pick");
      var have = null;
      p.signs.forEach(function (x) { if (x.sym === symId) have = x; });
      if (have) {
        // gleiches Wegzeichen an dieser Stelle: nur das Foto ergänzen (z. B. Markierung für die Gegenrichtung)
        if (pick.photoId && have.photos.indexOf(pick.photoId) < 0) have.photos.push(pick.photoId);
        else { var hs = symOf(layer, symId); G.showStatus(T("„{0}“ ist an dieser Stelle schon erfasst.", hs ? hs.name : "?"), 4000); }
      } else {
        p.signs.push({ id: newId(), sym: symId, state: "ok", photos: pick.photoId ? [pick.photoId] : [] });
      }
      pick = null;
      save(layer);
      renderSheet();
      return;
    }
    var row = e.target.closest("[data-sign]");
    var actEl = e.target.closest("[data-act]");
    if (!row || !actEl) return;
    var idx = -1;
    for (var i = 0; i < p.signs.length; i++) if (p.signs[i].id === row.getAttribute("data-sign")) idx = i;
    if (idx < 0) return;
    var s = p.signs[idx];
    var act = actEl.getAttribute("data-act");
    if (act === "up" || act === "down") {
      var j = act === "up" ? idx - 1 : idx + 1;
      if (j < 0 || j >= p.signs.length) return;
      p.signs[idx] = p.signs[j];
      p.signs[j] = s;
      save(layer);
      renderSheet();
    } else if (act === "sign") {
      var sym = symOf(layer, s.sym);
      var acts = STATES.filter(function (st) { return st[0] !== s.state; }).map(function (st) {
        return { label: T("Zustand: {0}", T(st[1])), onClick: function () { s.state = st[0]; save(layer); renderSheet(); } };
      });
      var shown = s.photos.filter(function (id) { return photoCache[id]; });
      if (shown.length) acts.push({ label: "Foto anzeigen", onClick: function () { G.photos.open(photoCache[shown[0]]); } });
      acts.push({ label: "Entfernen", danger: true, onClick: function () {
        // Wegzeichen mit seinen Fotos entfernen; ohne weitere Wegzeichen verschwindet die Position
        p.signs.splice(p.signs.indexOf(s), 1);
        p.photos = p.photos.filter(function (id) { return s.photos.indexOf(id) < 0; });
        deletePhotos(s.photos);
        if (!p.signs.length && !pick) {
          layer.points = layer.points.filter(function (q) { return q !== p; });
          deletePhotos(p.photos);
          selId = null;
        }
        save(layer);
        renderSheet();
      } });
      G.actionSheet(sym ? sym.name : "?", stateLabel(s.state), acts);
    }
  });

  filterEl.addEventListener("change", function (e) {
    if (!current) return;
    if (e.target.classList.contains("mk-f-sym")) filter.sym = e.target.value;
    if (e.target.classList.contains("mk-f-state")) filter.state = e.target.value;
    renderSheet();
  });

  // Nach Änderungen an Wegzeichen: Leiste (falls offen) und Seite „Ebenen“ neu zeichnen
  function refreshLayer(layer) {
    if (layer === current) renderSheet();
    renderPage();
    if (!pickEl.hidden && picker.layer === layer) renderPickGrid();
  }

  // Menü eines hinterlegten Wegzeichens (Seite „Ebenen“, aufgeklappte Ebene): Umbenennen, Entfernen
  function symbolMenu(layer, sym) {
    G.actionSheet(sym.name, sym.key || (sym.tfis ? "TFIS " + sym.tfis : ""), [
      { label: "Umbenennen", onClick: function () {
        G.askText("Name des Wegzeichens", sym.name, function (v) {
          v = (v || "").trim();
          if (!v) return;
          sym.name = v;
          save(layer);
          refreshLayer(layer);
        });
      } },
      { label: "Entfernen", danger: true, onClick: function () { removeSymbol(layer, sym); } }
    ]);
  }

  // Wegzeichen aus der Ebene entfernen; ist es zugeordnet, vorher nachfragen (es verschwindet dann auch dort)
  function removeSymbol(layer, sym, ask) {
    var used = symCounts(layer, sym.id).all;
    function doRemove() {
      layer.symbols = layer.symbols.filter(function (x) { return x !== sym; });
      layer.points.forEach(function (p) {
        p.signs = p.signs.filter(function (s) {
          if (s.sym !== sym.id) return true;
          p.photos = p.photos.filter(function (id) { return s.photos.indexOf(id) < 0; });
          deletePhotos(s.photos);
          return false;
        });
      });
      pruneEmpty(layer, current === layer ? selId : null);
      if (current === layer && filter.sym === sym.id) filter.sym = "";
      save(layer);
      refreshLayer(layer);
    }
    if (!used && !ask) { doRemove(); return; }
    G.actionSheet(T("„{0}“ entfernen?", sym.name),
      used ? T(used === 1 ? "Es ist an 1 Stelle zugeordnet; dort wird es ebenfalls entfernt." : "Es ist an {0} Stellen zugeordnet; dort wird es ebenfalls entfernt.", used) : "",
      [{ label: "Entfernen", danger: true, onClick: doRemove }]);
  }

  // ---------- PDF der Ebene (A4): gefilterte Positionen auf der Karte, Kopf und Legende ----------
  // GoAhead setzt die Seite selbst zusammen (Leinwand → JPEG → PDF mit einer Seite) und öffnet die Datei;
  // drucken lässt sie sich dann aus dem PDF-Viewer. Ausschnitt: äußerste gefilterte Positionen + Rand
  // (Einstellung „PDF: Rand um die Positionen“, Standard 100 m), Querformat, wenn breiter als hoch.
  // Kartenkacheln werden mit CORS geladen (sonst dürfte die Leinwand nicht ausgelesen werden); Ebenen ohne
  // CORS-Freigabe fehlen im PDF und werden gemeldet. Laut offline.js erlauben die NRW-Dienste CORS (?diagnose).
  var PDF_DPI = 150;
  var PX_MM = PDF_DPI / 25.4;
  var pdfBusy = false;

  function printBounds(layer) {
    var pts = layer.points.filter(pointMatches);
    if (!pts.length) return null;
    var s = 90, n = -90, w = 180, e = -180;
    pts.forEach(function (p) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); });
    var m = (G.getSettings && G.getSettings().printMarginM) || 0;
    var dLat = m / 111320, dLng = m / (111320 * Math.cos((s + n) / 2 * Math.PI / 180));
    return L.latLngBounds([s - dLat, w - dLng], [n + dLat, e + dLng]);
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function loadImg(src, cors, ms) {
    return new Promise(function (resolve) {
      var im = new Image();
      if (cors) im.crossOrigin = "anonymous";
      var t = setTimeout(function () { resolve(null); }, ms || 15000);
      im.onload = function () { clearTimeout(t); resolve(im); };
      im.onerror = function () { clearTimeout(t); resolve(null); };
      im.src = src;
    });
  }

  // Kachel-Adresse wie Leaflet sie anfordern würde (wie offline.js)
  function tileUrlOf(layer, x, y, z) {
    var c = L.point(x, y);
    c.z = z;
    var saved = layer._tileZoom;
    layer._tileZoom = z;
    try { return layer.getTileUrl(c); } finally { layer._tileZoom = saved; }
  }

  // nacheinander mit höchstens n gleichzeitig
  function runLimited(jobs, n, onProgress) {
    var i = 0, done = 0;
    return new Promise(function (resolve) {
      if (!jobs.length) { resolve(); return; }
      function next() {
        if (i >= jobs.length) return;
        var job = jobs[i++];
        job().then(function () {
          done++;
          if (onProgress) onProgress(done, jobs.length);
          if (done === jobs.length) resolve(); else next();
        });
      }
      for (var k = 0; k < Math.min(n, jobs.length); k++) next();
    });
  }

  // Kartenbild der sichtbaren Ebenen für den Ausschnitt: origin/size in Pixeln der Zoomstufe z
  function renderMapCanvas(origin, size, z, onProgress) {
    var cv = document.createElement("canvas");
    cv.width = size.x;
    cv.height = size.y;
    var ctx = cv.getContext("2d");
    ctx.fillStyle = cssVar("--c-print-paper", "#ffffff");
    ctx.fillRect(0, 0, size.x, size.y);
    var tileLayers = [];
    map.eachLayer(function (l) {
      if ((l instanceof L.TileLayer || l.renderTile) && l._goaheadDef) tileLayers.push(l);
    });
    tileLayers.sort(function (a, b) { return (a.options.zIndex || 0) - (b.options.zIndex || 0); });
    var missing = [];
    // je Ebene eine Leinwand, am Ende in Reihenfolge übereinander
    var parts = tileLayers.map(function (layer) {
      var lc = document.createElement("canvas");
      lc.width = size.x;
      lc.height = size.y;
      return { layer: layer, ctx: lc.getContext("2d"), canvas: lc, ok: 0, total: 0 };
    });
    var jobs = [];
    parts.forEach(function (part) {
      var layer = part.layer;
      var ts = layer.getTileSize().x;
      var x0 = Math.floor(origin.x / ts), x1 = Math.floor((origin.x + size.x - 1) / ts);
      var y0 = Math.floor(origin.y / ts), y1 = Math.floor((origin.y + size.y - 1) / ts);
      var bounds = layer.options.bounds ? L.latLngBounds(layer.options.bounds) : null;
      for (var x = x0; x <= x1; x++) {
        for (var y = y0; y <= y1; y++) {
          (function (x, y) {
            var dx = x * ts - origin.x, dy = y * ts - origin.y;
            if (bounds) {
              var tb = L.latLngBounds(map.unproject([x * ts, (y + 1) * ts], z), map.unproject([(x + 1) * ts, y * ts], z));
              if (!bounds.intersects(tb)) return;
            }
            part.total++;
            jobs.push(function () {
              if (layer.renderTile) {
                return layer.renderTile(x, y, z).then(function (r) {
                  if (r.ok) { part.ok++; part.ctx.drawImage(r.canvas, dx, dy, ts, ts); }
                  else if (!r.total) part.total--;   // Kachel ohne Quelle (z. B. außerhalb aller Gebiete)
                });
              }
              return loadImg(tileUrlOf(layer, x, y, z), true).then(function (im) {
                if (im) { part.ok++; part.ctx.drawImage(im, dx, dy, ts, ts); }
              });
            });
          })(x, y);
        }
      }
    });
    return runLimited(jobs, 6, onProgress).then(function () {
      parts.forEach(function (part) {
        if (part.total && !part.ok) missing.push(part.layer._goaheadDef.name);
        if (part.ok) ctx.drawImage(part.canvas, 0, 0);
      });
      return { canvas: cv, missing: missing };
    });
  }

  // Bild in ein Kästchen einpassen (Seitenverhältnis behalten)
  function drawContain(ctx, im, x, y, w, h) {
    var iw = im.naturalWidth || im.width || 1, ih = im.naturalHeight || im.height || 1;
    var k = Math.min(w / iw, h / ih);
    ctx.drawImage(im, x + (w - iw * k) / 2, y + (h - ih * k) / 2, iw * k, ih * k);
  }

  function stateColor(st) {
    return st === "missing" ? cssVar("--c-mk-missing", "#c62828") : st === "renew" ? cssVar("--c-mk-renew", "#f08c00") : cssVar("--c-mk-ok", "#2f9e44");
  }

  function signBox(ctx, im, st, x, y, s) {
    ctx.fillStyle = cssVar("--c-mk-plate", "#ffffff");
    ctx.fillRect(x, y, s, s);
    if (im) {
      if (st === "missing") ctx.globalAlpha = 0.4;
      drawContain(ctx, im, x + 3, y + 3, s - 6, s - 6);
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = stateColor(st);
    if (st === "missing") ctx.setLineDash([6, 4]);
    ctx.strokeRect(x + 1.5, y + 1.5, s - 3, s - 3);
    ctx.setLineDash([]);
  }

  // Text umbrechen; gibt die Höhe zurück
  function wrapText(ctx, text, x, y, maxW, lh) {
    var words = String(text).split(" "), line = "", yy = y;
    words.forEach(function (w) {
      var test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, yy); yy += lh; line = w; }
      else line = test;
    });
    if (line) { ctx.fillText(line, x, yy); yy += lh; }
    return yy - y;
  }

  function niceScale(maxM) {
    var p = Math.pow(10, Math.floor(Math.log(maxM) / Math.LN10));
    var r = maxM / p;
    return (r >= 5 ? 5 : r >= 2 ? 2 : 1) * p;
  }

  function buildPage(layer, b, landscape, onProgress) {
    var pw = Math.round((landscape ? 297 : 210) * PX_MM), ph = Math.round((landscape ? 210 : 297) * PX_MM);
    var margin = Math.round(8 * PX_MM), head = Math.round(16 * PX_MM), foot = Math.round(22 * PX_MM);
    var mw = pw - 2 * margin, mh = ph - 2 * margin - head - foot;
    // Zoomstufe, bei der der Ausschnitt genau in die Kartenfläche passt; Kacheln eine Stufe feiner (schärfer)
    var p0nw = map.project(b.getNorthWest(), 0), p0se = map.project(b.getSouthEast(), 0);
    var zFit = Math.min(Math.log(mw / Math.max(1e-9, p0se.x - p0nw.x)), Math.log(mh / Math.max(1e-9, p0se.y - p0nw.y))) / Math.LN2;
    var zt = Math.max(1, Math.min(18, Math.ceil(zFit)));
    var k = Math.pow(2, zt - zFit);                 // Kachel-Pixel je Seiten-Pixel
    var c = map.project(b.getCenter(), zt);
    var size = L.point(Math.ceil(mw * k), Math.ceil(mh * k));
    var origin = L.point(Math.round(c.x - size.x / 2), Math.round(c.y - size.y / 2));
    var used = {};
    layer.points.forEach(function (p) { p.signs.forEach(function (s) { if (signMatches(s)) used[s.sym] = (used[s.sym] || 0) + 1; }); });
    var syms = layer.symbols.filter(function (sym) { return used[sym.id]; });
    var symImgs = {};
    return Promise.all(layer.symbols.map(function (sym) {
      return loadImg(symUrl(sym), false, 10000).then(function (im) { symImgs[sym.id] = im; });
    })).then(function () {
      return renderMapCanvas(origin, size, zt, onProgress);
    }).then(function (res) {
      var page = document.createElement("canvas");
      page.width = pw;
      page.height = ph;
      var ctx = page.getContext("2d");
      var ink = cssVar("--c-print-ink", "#1d2125");
      ctx.fillStyle = cssVar("--c-print-paper", "#ffffff");
      ctx.fillRect(0, 0, pw, ph);
      // Kopf
      ctx.fillStyle = ink;
      ctx.textBaseline = "top";
      ctx.font = "bold " + Math.round(6 * PX_MM) + "px sans-serif";
      ctx.fillText(layer.name, margin, margin);
      var sym = filter.sym && symOf(layer, filter.sym);
      var what = [sym ? sym.name : T("Alle Wegzeichen"), filter.state ? stateLabel(filter.state) : T("Alle Zustände")].join(" · ");
      ctx.font = Math.round(3.2 * PX_MM) + "px sans-serif";
      ctx.fillText(what + " · " + summary(layer, true) + " · " + new Date().toLocaleDateString(G.i18n.locale), margin, margin + Math.round(8.5 * PX_MM));
      // Karte
      var mx = margin, my = margin + head;
      ctx.drawImage(res.canvas, mx, my, mw, mh);
      ctx.lineWidth = 1;
      ctx.strokeStyle = ink;
      ctx.strokeRect(mx + 0.5, my + 0.5, mw - 1, mh - 1);
      // Positionen: passende Wegzeichen untereinander, Spitze am Ort
      var s = Math.round(5.5 * PX_MM * Math.min(2, scale())), gap = 3, pad = 3;   // wie auf der Karte vergrößert (höchstens doppelt)
      ctx.save();
      ctx.beginPath();
      ctx.rect(mx, my, mw, mh);
      ctx.clip();
      layer.points.forEach(function (p) {
        var list = p.signs.filter(signMatches);
        if (!list.length) return;
        var pt = map.project([p.lat, p.lng], zt);
        var px = mx + (pt.x - origin.x) / k, py = my + (pt.y - origin.y) / k;
        var bh = list.length * (s + gap) - gap + 2 * pad, bw = s + 2 * pad, tail = 10;
        var bx = px - bw / 2, by = py - tail - bh;
        ctx.fillStyle = cssVar("--c-mk-plate", "#ffffff");
        ctx.shadowColor = "rgba(0,0,0,0.35)";
        ctx.shadowBlur = 6;
        ctx.fillRect(bx, by, bw, bh);
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.moveTo(px - 8, by + bh);
        ctx.lineTo(px + 8, by + bh);
        ctx.lineTo(px, py);
        ctx.closePath();
        ctx.fill();
        list.forEach(function (sg, i) { signBox(ctx, symImgs[sg.sym], sg.state, bx + pad, by + pad + i * (s + gap), s); });
      });
      ctx.restore();
      // Maßstab unten links in der Karte
      var lat = b.getCenter().lat;
      var mPerPx = 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, zt)) * k;
      var len = niceScale(mw * 0.2 * mPerPx), lpx = len / mPerPx;
      var sx = mx + 16, sy = my + mh - 22;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(sx - 6, sy - 26, lpx + 12, 34);
      ctx.fillStyle = ink;
      ctx.fillRect(sx, sy, lpx, 4);
      ctx.fillRect(sx, sy - 8, 2, 12);
      ctx.fillRect(sx + lpx - 2, sy - 8, 2, 12);
      ctx.font = Math.round(2.6 * PX_MM) + "px sans-serif";
      ctx.textBaseline = "bottom";
      ctx.fillText(len >= 1000 ? G.i18n.dec(len / 1000) + " km" : len + " m", sx, sy - 4);
      // Fuß: Legende und Quellenangabe
      ctx.textBaseline = "middle";
      var fy = my + mh + Math.round(3 * PX_MM), fx = margin, ls = Math.round(4.5 * PX_MM);
      ctx.font = Math.round(3 * PX_MM) + "px sans-serif";
      function legend(im, st, label) {
        var w = ls + 8 + ctx.measureText(label).width + 28;
        if (fx + w > pw - margin) { fx = margin; fy += ls + 8; }
        signBox(ctx, im, st, fx, fy, ls);
        ctx.fillStyle = ink;
        ctx.fillText(label, fx + ls + 8, fy + ls / 2);
        fx += w;
      }
      syms.forEach(function (sy2) { legend(symImgs[sy2.id], "ok", sy2.name + " (" + used[sy2.id] + ")"); });
      STATES.forEach(function (st) { legend(null, st[0], T(st[1])); });
      var attr = map.attributionControl ? map.attributionControl.getContainer().textContent.replace(/^\s*Leaflet\s*\|?\s*/, "") : "";
      ctx.font = Math.round(2.3 * PX_MM) + "px sans-serif";
      ctx.textBaseline = "top";
      ctx.fillStyle = cssVar("--c-muted", "#5f6b75");
      wrapText(ctx, T("Karte: {0}", attr) + " · GoAhead", margin, ph - margin - Math.round(5 * PX_MM), pw - 2 * margin, Math.round(2.8 * PX_MM));
      return { page: page, missing: res.missing, landscape: landscape };
    });
  }

  // Minimales PDF mit einer Seite: JPEG als Bild über die ganze Seite (A4 in pt)
  function pdfFromJpeg(jpeg, w, h, landscape) {
    var W = landscape ? 841.89 : 595.28, H = landscape ? 595.28 : 841.89;
    var enc = new TextEncoder();
    var chunks = [], offsets = [], pos = 0;
    function add(x) { var b = typeof x === "string" ? enc.encode(x) : x; chunks.push(b); pos += b.length; }
    function obj(n, body) { offsets[n] = pos; add(n + " 0 obj\n" + body + "\nendobj\n"); }
    add("%PDF-1.4\n%âãÏÓ\n");
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + W + " " + H + "] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>");
    offsets[4] = pos;
    add("4 0 obj\n<< /Type /XObject /Subtype /Image /Width " + w + " /Height " + h +
      " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpeg.length + " >>\nstream\n");
    add(jpeg);
    add("\nendstream\nendobj\n");
    var content = "q " + W + " 0 0 " + H + " 0 0 cm /Im0 Do Q";
    obj(5, "<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream");
    var xref = pos;
    var x = "xref\n0 6\n0000000000 65535 f \n";
    for (var i = 1; i <= 5; i++) x += ("000000000" + offsets[i]).slice(-10) + " 00000 n \n";
    add(x + "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
    var out = new Uint8Array(pos), o = 0;
    chunks.forEach(function (c) { out.set(c, o); o += c.length; });
    return out;
  }

  function toBase64(bytes) {
    var s = "", CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }

  function pdfName(layer) {
    var d = new Date();
    var ymd = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
    return ("GoAhead " + layer.name + " " + ymd).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_") + ".pdf";
  }

  function deliverPdf(bytes, name) {
    if (G.native) {
      var r = G.native.call("openFile", name, "application/pdf", toBase64(bytes));
      if (r == null) { G.showStatus("Für das PDF bitte die neue Version der Android-App installieren.", 8000); return; }
      if (r === "opened") G.showStatus(T("PDF gespeichert unter „Downloads“: {0}", name), 5000);
      else if (r === "saved") G.showStatus(T("PDF gespeichert unter „Downloads“: {0}. Zum Öffnen fehlt ein PDF-Programm.", name), 8000);
      else G.showStatus("Das PDF konnte nicht gespeichert werden.", 6000);
      return;
    }
    var url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 60000);
    G.showStatus(T("PDF erstellt: {0}", name), 5000);
  }

  function makePdf() {
    var layer = current;
    if (!layer || pdfBusy) return;
    var b = printBounds(layer);
    if (!b) { G.showStatus("Keine Positionen für das PDF.", 5000); return; }
    var c = b.getCenter();
    var landscape = map.distance([c.lat, b.getWest()], [c.lat, b.getEast()]) > map.distance([b.getSouth(), c.lng], [b.getNorth(), c.lng]);
    pdfBusy = true;
    G.showStatus(T("PDF wird erstellt … {0} %", 0));
    buildPage(layer, b, landscape, function (d, n) {
      G.showStatus(T("PDF wird erstellt … {0} %", Math.round(d / n * 100)));
    }).then(function (res) {
      return new Promise(function (resolve, reject) {
        res.page.toBlob(function (blob) { blob ? resolve({ blob: blob, res: res }) : reject(new Error("JPEG")); }, "image/jpeg", 0.88);
      });
    }).then(function (x) {
      return x.blob.arrayBuffer().then(function (buf) {
        var bytes = pdfFromJpeg(new Uint8Array(buf), x.res.page.width, x.res.page.height, x.res.landscape);
        G.hideStatus();
        deliverPdf(bytes, pdfName(layer));
        if (x.res.missing.length) {
          setTimeout(function () {
            G.showStatus(T("Im PDF fehlt die Karte „{0}“. Bitte später noch einmal versuchen oder eine andere Karte wählen.", x.res.missing.join(", ")), 8000);
          }, 5200);
        }
      });
    }).catch(function (err) {
      console.warn("[GoAhead] PDF:", err);
      G.showStatus("Das PDF konnte nicht erstellt werden.", 6000);
    }).then(function () { pdfBusy = false; });
  }

  // ---------- Wegzeichen hinterlegen ----------

  function addSymbol(layer, sym) {
    sym.id = newId();
    layer.symbols.push(sym);
    save(layer);
    if (layer === current) renderSheet();
    if (!pickEl.hidden && picker.layer === layer) renderPickGrid();
    renderPage();
  }

  // TFIS-Wegzeichen über die Signaturnummer: prüfen, ob das Bild vorhanden ist (Zeitlimit 8 s)
  function checkImage(url) {
    return new Promise(function (resolve) {
      var im = new Image();
      var t = setTimeout(function () { resolve(false); }, 8000);
      im.onload = function () { clearTimeout(t); resolve(true); };
      im.onerror = function () { clearTimeout(t); resolve(false); };
      im.src = url;
    });
  }
  // Verzeichnis der TFIS-Wanderwege: [[Signaturnummer, Name, Bezeichnung, Verein, Kategorie], …];
  // erzeugt im Pages-Workflow aus dem TFIS-GeoPackage (.github/scripts/tfis_index.py, Aufbau dort belegt).
  // Eigene Wegenummern der Vereine (z. B. „01-0A0-00“) stehen nicht in TFIS – gesucht wird nach Name/Bezeichnung.
  var wayIndex = null;
  function loadWayIndex() {
    if (wayIndex) return wayIndex;
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 10000);
    wayIndex = fetch("symbols/tfis/index.json", ctl ? { signal: ctl.signal } : {}).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (list) {
      if (!Array.isArray(list)) throw new Error("altes Format");
      return list;
    });
    wayIndex.catch(function (err) { console.warn("[GoAhead] Wegeverzeichnis:", err); wayIndex = null; });
    return wayIndex;
  }

  // Bei gleich guten Treffern: überregionale Wege zuerst (Kategorien laut TFIS-Protokoll, z. B. „Fernwanderweg“)
  function katRank(kat) {
    kat = (kat || "").toLowerCase();
    if (kat.indexOf("fern") >= 0) return 0;
    if (kat.indexOf("haupt") >= 0) return 1;
    if (kat.indexOf("örtlich") >= 0) return 3;
    return 2;
  }

  function wayName(w) {
    if (w.nam && w.bez && w.nam.indexOf(w.bez) < 0) return w.bez + " " + w.nam;
    return w.nam || w.bez || ("TFIS " + w.nr);
  }

  // ---------- Seite „Wegzeichen wählen“: alle TFIS-Wegzeichen als Bilder ----------
  // Filter nach Verein und Kategorie (Werte aus TFIS), Lupe blendet die Namenssuche ein (wie bei „Tracks“).
  // Eine davor geschriebene eigene Wegenummer („01-0A0-00 Eggeweg“ – steht nicht in TFIS) wird beim Übernehmen
  // mit dem Wegzeichen gespeichert. Ziffern allein finden die Signaturnummer.
  var OWN_KEY = /^([0-9A-Z]{2}-[0-9A-Z]{3}-[0-9A-Z]{2})\s*(.*)$/i;
  var signGroups = null;   // je Signaturnummer: {nr, nam, bez, vereine{}, kats{}, rank, text}
  var picker = { layer: null, lastLayer: null, verein: "", kat: "", q: "", search: false };

  function buildGroups(list) {
    var by = {};
    list.forEach(function (r) {
      var g = by[r[0]];
      if (!g) g = by[r[0]] = { nr: r[0], nam: "", bez: "", vereine: {}, kats: {}, rank: 9, text: "" };
      if (!g.nam && r[1]) g.nam = r[1];
      if (!g.bez && r[2]) g.bez = r[2];
      if (r[3]) g.vereine[r[3]] = true;
      if (r[4]) { g.kats[r[4]] = true; g.rank = Math.min(g.rank, katRank(r[4])); }
      g.text += " " + (r[1] || "") + " " + (r[2] || "") + " " + r[0];
    });
    return Object.keys(by).map(function (k) { var g = by[k]; g.text = g.text.toLowerCase(); return g; })
      .sort(function (a, b) {
        return a.rank - b.rank || (a.bez || a.nam || a.nr).localeCompare(b.bez || b.nam || b.nr, "de", { numeric: true });
      });
  }

  var pickEl = document.createElement("section");
  pickEl.id = "marks-pick-page";
  pickEl.className = "page";
  pickEl.hidden = true;
  pickEl.setAttribute("aria-label", "Wegzeichen wählen");
  pickEl.innerHTML =
    '<header class="page-head">' +
      '<button type="button" class="page-back" aria-label="Zurück">' +
        '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      "</button>" +
      "<h1>Wegzeichen wählen</h1>" +
    "</header>" +
    '<div class="page-body"><div class="mk-pick-head"></div><div class="mk-grid"></div></div>';
  document.body.appendChild(pickEl);
  var pickHead = pickEl.querySelector(".mk-pick-head");
  var pickGrid = pickEl.querySelector(".mk-grid");
  pickEl.querySelector(".page-back").addEventListener("click", function () { pickEl.hidden = true; });

  // Voreinstellung Verein: der Verein, zu dem die meisten schon hinterlegten TFIS-Wegzeichen der Ebene gehören
  function guessVerein(layer) {
    var count = {}, best = "", n = 0, byNr = {};
    signGroups.forEach(function (g) { byNr[g.nr] = g; });
    layer.symbols.forEach(function (s) {
      var g = s.tfis && byNr[s.tfis];
      if (!g) return;
      Object.keys(g.vereine).forEach(function (v) {
        count[v] = (count[v] || 0) + 1;
        if (count[v] > n) { n = count[v]; best = v; }
      });
    });
    return best;
  }

  function pickQuery() {
    var m = OWN_KEY.exec(picker.q.trim());
    return { own: m ? m[1].toUpperCase() : null, q: (m ? m[2] : picker.q).trim().toLowerCase() };
  }

  function renderPickHead() {
    var vereine = {}, kats = {};
    signGroups.forEach(function (g) {
      Object.keys(g.vereine).forEach(function (v) { vereine[v] = true; });
      Object.keys(g.kats).forEach(function (k) { kats[k] = true; });
    });
    var vOpts = '<option value="">Alle Vereine</option>' + Object.keys(vereine).sort(function (a, b) { return a.localeCompare(b, "de"); }).map(function (v) {
      return '<option value="' + esc(v) + '"' + (picker.verein === v ? " selected" : "") + " data-noi18n>" + esc(v) + "</option>";
    }).join("");
    var kOpts = '<option value="">Alle Kategorien</option>' + Object.keys(kats).sort(function (a, b) { return katRank(a) - katRank(b) || a.localeCompare(b, "de"); }).map(function (k) {
      return '<option value="' + esc(k) + '"' + (picker.kat === k ? " selected" : "") + " data-noi18n>" + esc(k) + "</option>";
    }).join("");
    var on = picker.search || picker.q;
    pickHead.innerHTML = '<div class="list-head"><span class="list-sum mk-pick-sum"></span>' +
      '<select class="list-kind mk-pv" aria-label="Verein" title="Verein">' + vOpts + "</select>" +
      '<select class="list-year mk-pk" aria-label="Kategorie" title="Kategorie">' + kOpts + "</select>" +
      '<button type="button" class="icon-btn list-find' + (on ? " on" : "") + '" title="Nach Namen suchen" aria-label="Nach Namen suchen">' + G.icon("search") + "</button></div>" +
      (on ? '<input type="search" class="list-q mk-pq" placeholder="Name …" value="' + esc(picker.q) + '">' : "");
  }

  // Wegzeichen ohne Bild (fehlt im TFIS-Paket) ausblenden und nicht mitzählen
  var pickCount = 0;
  function showPickCount() {
    var el = pickEl.querySelector(".mk-pick-sum");
    if (el) el.textContent = T(pickCount === 1 ? "1 Wegzeichen" : "{0} Wegzeichen", pickCount);
  }
  pickGrid.addEventListener("error", function (e) {
    var b = e.target && e.target.closest && e.target.closest(".mk-pick-btn");
    if (!b || b.hidden) return;
    b.hidden = true;
    pickCount--;
    showPickCount();
  }, true);

  function renderPickGrid() {
    var layer = picker.layer;
    var have = {};
    layer.symbols.forEach(function (s) { if (s.tfis) have[s.tfis] = true; });
    var pq = pickQuery();
    var shown = signGroups.filter(function (g) {
      return (!picker.verein || g.vereine[picker.verein]) && (!picker.kat || g.kats[picker.kat]) && (!pq.q || g.text.indexOf(pq.q) >= 0);
    });
    pickCount = shown.length;
    showPickCount();
    pickGrid.innerHTML = shown.length ? shown.map(function (g) {
      var title = wayName(g) + " · " + Object.keys(g.vereine).join(", ");
      return '<button type="button" class="mk-pick-btn' + (have[g.nr] ? " on" : "") + '" data-nr="' + esc(g.nr) + '" title="' + esc(title) +
        '" aria-label="' + esc(title) + '" data-noi18n>' +
        '<img alt="" loading="lazy" src="' + esc(symUrl({ tfis: g.nr })) + '">' +
        "<span>" + esc(g.bez || g.nam || g.nr) + "</span></button>";
    }).join("") : '<p class="trk-empty">Keine passenden Wegzeichen.</p>';
  }

  function openPicker(layer) {
    picker.layer = layer;
    document.body.appendChild(pickEl);   // über der Seite „Ebenen“
    pickEl.hidden = false;
    pickHead.innerHTML = "";
    pickGrid.innerHTML = "";
    loadWayIndex().then(function (list) {
      if (!signGroups) signGroups = buildGroups(list);
      if (picker.lastLayer !== layer.id) { picker.verein = guessVerein(layer); picker.lastLayer = layer.id; }
      renderPickHead();
      renderPickGrid();
    }).catch(function () {
      pickGrid.innerHTML = '<p class="trk-empty">Das Wegeverzeichnis lässt sich gerade nicht laden. Bitte mit Internetverbindung noch einmal versuchen.</p>';
    });
  }

  pickHead.addEventListener("change", function (e) {
    if (e.target.classList.contains("mk-pv")) picker.verein = e.target.value;
    else if (e.target.classList.contains("mk-pk")) picker.kat = e.target.value;
    else return;
    renderPickGrid();
  });
  pickHead.addEventListener("input", function (e) {
    if (!e.target.classList.contains("mk-pq")) return;
    picker.q = e.target.value;
    renderPickGrid();
  });
  pickHead.addEventListener("click", function (e) {
    if (!e.target.closest(".list-find")) return;
    if (picker.search || picker.q) { picker.search = false; picker.q = ""; } else picker.search = true;
    renderPickHead();
    renderPickGrid();
    var inp = pickHead.querySelector(".mk-pq");
    if (inp) inp.focus();
  });
  pickGrid.addEventListener("click", function (e) {
    var b = e.target.closest("[data-nr]");
    if (!b || !picker.layer) return;
    var nr = b.getAttribute("data-nr"), g = null;
    if (b.classList.contains("on")) {
      // schon übernommen: erneut antippen = aus der Ebene entfernen (mit Rückfrage)
      var have = null;
      picker.layer.symbols.forEach(function (x) { if (x.tfis === nr) have = x; });
      if (have) removeSymbol(picker.layer, have, true);
      return;
    }
    signGroups.forEach(function (x) { if (x.nr === nr) g = x; });
    addTfisTo(picker.layer, nr, g ? wayName(g) : "", pickQuery().own);
  });

  function addTfisTo(layer, nr, name, key) {
    for (var i = 0; i < layer.symbols.length; i++) {
      if (layer.symbols[i].tfis === nr) { G.showStatus(T("Dieses Wegzeichen ist schon in „{0}“.", layer.name), 5000); return; }
    }
    checkImage(symUrl({ tfis: nr })).then(function (ok) {
      if (!ok) { G.showStatus("Zu dieser Signaturnummer gibt es kein Wegzeichen-Bild.", 6000); return; }
      G.askText("Name des Wegzeichens", name || ("TFIS " + nr), function (v) {
        addSymbol(layer, { name: (v || "").trim() || "TFIS " + nr, tfis: nr, key: key || null, img: null });
        G.showStatus(T("Wegzeichen in „{0}“ übernommen.", layer.name), 4000);
      }, "Übernehmen");
    });
  }

  // Aus dem Infofenster (Weg antippen): in die geöffnete Ebene, sonst Ebene wählen bzw. anlegen
  function addTfis(nr, name) {
    var key = null;   // eigene Wegenummer gibt es nur bei der Eingabe von Hand
    nr = String(nr || "").trim();
    if (!nr) return;
    if (current) { addTfisTo(current, nr, name, key); return; }
    if (!layers.length) {
      createLayer(function (layer) { addTfisTo(layer, nr, name, key); });
      return;
    }
    if (layers.length === 1) { addTfisTo(layers[0], nr, name, key); return; }
    G.actionSheet("In welche Ebene?", "", layers.map(function (l) {
      return { label: l.name, onClick: function () { addTfisTo(l, nr, name, key); } };
    }));
  }

  // Eigenes Bild (Datei oder Kamera), verkleinert als PNG
  var imgInput = document.createElement("input");
  imgInput.type = "file";
  imgInput.accept = "image/*";
  imgInput.hidden = true;
  document.body.appendChild(imgInput);
  var imgTarget = null;
  imgInput.addEventListener("change", function () {
    var f = imgInput.files && imgInput.files[0];
    var layer = imgTarget;
    if (!f || !layer) return;
    var load = window.createImageBitmap ? createImageBitmap(f, { imageOrientation: "from-image" }) : new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = reject;
      im.src = URL.createObjectURL(f);
    });
    load.then(function (bmp) {
      cropImage(bmp, function (r) {
        var k = Math.min(1, SYM_PX / Math.max(r.w, r.h));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(r.w * k));
        c.height = Math.max(1, Math.round(r.h * k));
        c.getContext("2d").drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
        var data = c.toDataURL("image/png");
        G.askText("Name des Wegzeichens", "", function (v) {
          v = (v || "").trim();
          if (!v) { G.showStatus("Ohne Namen wurde das Wegzeichen nicht übernommen.", 5000); return; }
          addSymbol(layer, { name: v, tfis: null, img: data });
        }, "Übernehmen");
      });
    }).catch(function (err) {
      console.warn("[GoAhead] Wegzeichen-Bild:", err);
      G.showStatus("Das Bild konnte nicht geöffnet werden.", 6000);
    });
  });

  // Ausschnitt wählen: Rahmen mit dem Finger aufziehen; im Rahmen beginnen = Rahmen verschieben.
  // onOk({x, y, w, h}) in Bildpunkten des Originals.
  function cropImage(bmp, onOk) {
    var back = document.createElement("div");
    back.className = "dlg-back";
    back.innerHTML = '<div class="dlg mk-crop" role="dialog"><div class="dlg-title">Ausschnitt wählen</div>' +
      '<div class="mk-crop-box"><canvas></canvas><div class="mk-crop-sel"></div></div>' +
      '<div class="dlg-buttons"><button type="button" class="dlg-cancel">Abbrechen</button><button type="button" class="dlg-ok">Weiter</button></div></div>';
    document.body.appendChild(back);
    var box = back.querySelector(".mk-crop-box");
    var cv = back.querySelector("canvas");
    var sel = back.querySelector(".mk-crop-sel");
    var maxW = box.clientWidth || 300;
    var maxH = Math.round(window.innerHeight * 0.55);
    var f = Math.min(maxW / bmp.width, maxH / bmp.height, 1);
    var W = Math.max(1, Math.round(bmp.width * f)), H = Math.max(1, Math.round(bmp.height * f));
    cv.width = W; cv.height = H;
    cv.style.width = W + "px"; cv.style.height = H + "px";
    box.style.width = W + "px"; box.style.height = H + "px";
    cv.getContext("2d").drawImage(bmp, 0, 0, W, H);
    // Vorgabe: mittiges Quadrat über 60 % der kürzeren Seite
    var s0 = Math.round(Math.min(W, H) * 0.6);
    var r = { x: Math.round((W - s0) / 2), y: Math.round((H - s0) / 2), w: s0, h: s0 };
    function draw() {
      sel.style.left = r.x + "px"; sel.style.top = r.y + "px";
      sel.style.width = r.w + "px"; sel.style.height = r.h + "px";
    }
    draw();
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function pos(e) {
      var b = box.getBoundingClientRect();
      return { x: clamp(e.clientX - b.left, 0, W), y: clamp(e.clientY - b.top, 0, H) };
    }
    // Erster Zug zieht immer einen neuen Rahmen auf (die Vorgabe liegt mittig, man beginnt fast immer darin).
    // Danach: an einer Ecke = Größe ändern (gegenüberliegende Ecke bleibt), im Rahmen = verschieben, sonst neu.
    var drag = null, fresh = true, CORNER = 28;
    box.addEventListener("pointerdown", function (e) {
      var p = pos(e), mode = "new", anchor = p;
      if (!fresh) {
        var cs = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
        for (var i = 0; i < 4; i++) {
          if (Math.abs(p.x - cs[i][0]) < CORNER && Math.abs(p.y - cs[i][1]) < CORNER) {
            mode = "new";
            anchor = { x: cs[3 - i][0], y: cs[3 - i][1] };   // gegenüberliegende Ecke
            break;
          }
        }
        if (anchor === p && p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) mode = "move";
      }
      drag = { start: p, anchor: anchor, mode: mode, orig: { x: r.x, y: r.y, w: r.w, h: r.h } };
      try { box.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
      e.preventDefault();
    });
    box.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var p = pos(e);
      if (drag.mode === "move") {
        r.x = clamp(drag.orig.x + p.x - drag.start.x, 0, W - r.w);
        r.y = clamp(drag.orig.y + p.y - drag.start.y, 0, H - r.h);
      } else {
        var a = drag.anchor;
        var w = Math.abs(p.x - a.x), h = Math.abs(p.y - a.y);
        if (w < 12 && h < 12) return;   // zu klein: alter Rahmen bleibt
        r = { x: Math.min(p.x, a.x), y: Math.min(p.y, a.y), w: w, h: h };
        fresh = false;
      }
      draw();
    });
    function end() { drag = null; }
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", end);
    function close() { back.remove(); }
    back.querySelector(".dlg-cancel").addEventListener("click", close);
    back.querySelector(".dlg-ok").addEventListener("click", function () {
      close();
      onOk({ x: r.x / f, y: r.y / f, w: Math.max(1, r.w / f), h: Math.max(1, r.h / f) });
    });
  }

  // ---------- Seite „Ebenen“ ----------

  var pageEl = document.createElement("section");
  pageEl.id = "marks-page";
  pageEl.className = "page";
  pageEl.hidden = true;
  pageEl.setAttribute("aria-label", "Ebenen");
  pageEl.innerHTML =
    '<header class="page-head">' +
      '<button type="button" class="page-back" aria-label="Zurück zur Karte">' +
        '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      "</button>" +
      "<h1>Ebenen</h1>" +
    "</header>" +
    '<div class="page-body mk-list"></div>';
  document.body.appendChild(pageEl);
  var listEl = pageEl.querySelector(".mk-list");
  pageEl.querySelector(".page-back").addEventListener("click", closePage);

  function renderPage() {
    var head = '<div class="list-head list-head-one"><span class="list-sum">' +
      (layers.length ? esc(T(layers.length === 1 ? "1 Ebene" : "{0} Ebenen", layers.length)) : "") + "</span>" +
      '<button type="button" class="icon-btn mk-new" title="Neue Ebene" aria-label="Neue Ebene">' + G.icon("plus") + "</button></div>";
    if (!layers.length) {
      listEl.innerHTML = head + '<p class="trk-empty">Noch keine eigenen Ebenen.</p>';
      return;
    }
    var sorted = layers.slice().sort(function (a, b) { return a.name.localeCompare(b.name, G.i18n.locale); });
    listEl.innerHTML = head + sorted.map(function (l) {
      var open = !!expanded[l.id];
      var details = "";
      if (open) {
        details = '<div class="mk-details">' +
          '<div class="icon-row mk-detail-btns">' +
            '<button type="button" class="icon-btn" data-act="addtfis" title="TFIS-Wegzeichen hinzufügen" aria-label="TFIS-Wegzeichen hinzufügen">' + G.icon("search") + "</button>" +
            '<button type="button" class="icon-btn" data-act="addimg" title="Eigenes Wegzeichen-Bild hinzufügen" aria-label="Eigenes Wegzeichen-Bild hinzufügen">' + G.icon("image") + "</button>" +
            '<span class="mk-detail-gap"></span>' +
            '<button type="button" class="icon-btn" data-act="rename" title="Umbenennen" aria-label="Umbenennen">' + G.icon("edit") + "</button>" +
            '<button type="button" class="icon-btn trk-del" data-act="delete" title="Löschen" aria-label="Löschen">' + G.icon("trash") + "</button>" +
          "</div>" +
          (l.symbols.length ? l.symbols.map(function (sym) {
          return '<div class="mk-detail" data-sym="' + esc(sym.id) + '">' +
            '<span class="mk-detail-main" data-act="sym"><span class="mk-sym-box"><img alt="" src="' + esc(symUrl(sym)) + '"></span>' +
            '<span class="trk-text"><span class="trk-name" data-noi18n>' + esc(sym.name) + "</span>" +
            '<span class="trk-info">' + esc((sym.key ? sym.key + " · " : sym.tfis ? "TFIS " + sym.tfis + " · " : "") + symCountText(symCounts(l, sym.id))) + "</span></span></span>" +
            '<button type="button" class="icon-btn" data-act="symmore" title="Weitere Aktionen" aria-label="Weitere Aktionen">' + G.icon("more") + "</button></div>";
        }).join("") : '<p class="trk-empty">Noch keine Wegzeichen hinterlegt.</p>') +
          "</div>";
      }
      return '<div class="trk-item mk-layer-item" data-id="' + esc(l.id) + '">' +
        '<input type="checkbox" class="mk-vis" data-act="toggle" aria-label="Auf der Karte zeigen" title="Auf der Karte zeigen"' + (l.visible ? " checked" : "") + ">" +
        '<span class="trk-main trk-tap" data-act="open"><span class="trk-text"><span class="trk-name" data-noi18n>' + esc(l.name) + "</span>" +
          '<span class="trk-info">' + esc(summary(l, false)) + "</span></span></span>" +
        '<span class="trk-actions"><button type="button" class="icon-btn' + (open ? " on" : "") + '" data-act="more" title="Weitere Aktionen" aria-label="Weitere Aktionen">' + G.icon("more") + "</button></span>" +
        details + "</div>";
    }).join("");
  }
  var expanded = {};   // Ebenen-id -> Wegzeichen aufgeklappt

  function createLayer(then) {
    G.askText("Name der Ebene", "", function (v) {
      v = (v || "").trim();
      if (!v) return;
      var layer = normalize({ id: newId(), name: v, created: Date.now(), visible: true });
      layers.push(layer);
      ensureGroup(layer);
      save(layer).then(function () {
        renderPage();
        if (then) then(layer); else openLayer(layer.id);
      });
    }, "Anlegen");
  }

  listEl.addEventListener("click", function (e) {
    if (e.target.closest(".mk-new")) { createLayer(); return; }
    var item = e.target.closest("[data-id]");
    var actEl = e.target.closest("[data-act]");
    if (!item || !actEl) return;
    var layer = byId(item.getAttribute("data-id"));
    if (!layer) return;
    var act = actEl.getAttribute("data-act");
    if (act === "open") openLayer(layer.id);
    else if (act === "more") { expanded[layer.id] = !expanded[layer.id]; renderPage(); }
    else if (act === "sym") openLayer(layer.id, { filterSym: actEl.closest("[data-sym]").getAttribute("data-sym") });
    else if (act === "symmore") {
      var sym = symOf(layer, actEl.closest("[data-sym]").getAttribute("data-sym"));
      if (sym) symbolMenu(layer, sym);
    }
    else if (act === "addtfis") openPicker(layer);
    else if (act === "addimg") { imgTarget = layer; imgInput.value = ""; imgInput.click(); }
    else if (act === "rename") {
          G.askText("Name der Ebene", layer.name, function (v) {
            v = (v || "").trim();
            if (!v) return;
            layer.name = v;
            // Name in der Kartenwahl: Ebene neu eintragen
            var vis = layer.visible;
            dropGroup(layer.id);
            ensureGroup(layer);
            setVisible(layer, vis);
            renderMarkers(layer);
            save(layer);
            renderPage();
          });
    } else if (act === "delete") {
      G.actionSheet(T("Ebene „{0}“ löschen?", layer.name), summary(layer, false), [
        { label: "Löschen", danger: true, onClick: function () { removeLayer(layer); } }
      ]);
    }
  });
  listEl.addEventListener("change", function (e) {
    if (!e.target.classList.contains("mk-vis")) return;
    var layer = byId(e.target.closest("[data-id]").getAttribute("data-id"));
    if (!layer) return;
    layer.visible = e.target.checked;
    setVisible(layer, layer.visible);
    save(layer);
  });

  function removeLayer(layer) {
    if (current === layer) closeLayer();
    var prefix = "mark:" + layer.id + ":";
    G.db.del(STORE, layer.id).then(function () {
      dropGroup(layer.id);
      layers = layers.filter(function (l) { return l !== layer; });
      renderPage();
      return G.db.all("photos").then(function (list) {
        deletePhotos((list || []).filter(function (ph) { return String(ph.walkId).indexOf(prefix) === 0; }).map(function (ph) { return ph.id; }));
      });
    }).catch(function (err) {
      console.warn("[GoAhead] Ebene löschen:", err);
      G.showStatus("Die Ebene konnte nicht gelöscht werden.", 6000);
    });
  }

  function openPage() {
    if (G.closeMenu) G.closeMenu();
    renderPage();
    pageEl.hidden = false;
  }
  function closePage() { pageEl.hidden = true; }

  var MarksControl = L.Control.extend({
    onAdd: function () {
      var box = L.DomUtil.create("div", "leaflet-bar mk-control");
      var btn = L.DomUtil.create("a", "mk-toggle", box);
      btn.tabIndex = 0;   // ohne href: langer Druck zeigt sonst die Link-Adresse an
      btn.setAttribute("role", "button");
      btn.title = "Ebenen";
      btn.setAttribute("aria-label", "Ebenen");
      btn.innerHTML = G.icon("marks");
      L.DomEvent.on(btn, "click", function (e) { L.DomEvent.preventDefault(e); openPage(); });
      L.DomEvent.disableClickPropagation(box);
      return box;
    }
  });
  G.addToToolbar(new MarksControl());

  // ---------- Laden ----------

  function loadAll() {
    return G.db.all(STORE).then(function (all) {
      Object.keys(groups).forEach(dropGroup);
      layers = (all || []).map(normalize);
      layers.forEach(function (l) {
        if (pruneEmpty(l, current && current.id === l.id ? selId : null)) save(l);
        ensureGroup(l);
        if (l.visible) setVisible(l, true);
        renderMarkers(l);
      });
      if (current) {
        var again = byId(current.id);
        if (again) { current = again; renderSheet(); } else closeLayer();
      }
      renderPage();
    }).catch(function (err) {
      console.warn("[GoAhead] Ebenen konnten nicht geladen werden:", err);
      listEl.innerHTML = '<p class="trk-empty">Die gespeicherten Daten lassen sich gerade nicht öffnen. Bitte die App neu starten.</p>';
    });
  }
  var ready = loadAll();
  window.addEventListener("goahead:data", loadAll);

  G.marks = { open: openLayer, openPage: openPage, addTfis: addTfis, close: closeLayer,
    list: function () { return layers; } };
})();
