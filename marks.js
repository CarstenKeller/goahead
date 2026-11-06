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
 *    symbols: [{id, name, tfis|null (Signaturnummer), key|null (Wegenummer), img|null}],
 *    points:  [{id, lat, lng, time, photos: [fotoId], signs: [{id, sym, state: "ok"|"renew"|"missing", photo|null}]}]}
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

  function normalize(l) {
    l.symbols = l.symbols || [];
    l.points = l.points || [];
    l.points.forEach(function (p) { p.signs = p.signs || []; p.photos = p.photos || []; });
    return l;
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
  function countText(nPos, nSigns) {
    return T(nPos === 1 ? "1 Position" : "{0} Positionen", nPos) + " · " + T(nSigns === 1 ? "1 Wegzeichen" : "{0} Wegzeichen", nSigns);
  }
  function summary(layer, useFilter) {
    var pos = 0, signs = 0;
    layer.points.forEach(function (p) {
      var n = 0;
      p.signs.forEach(function (s) { if (!useFilter || signMatches(s)) n++; });
      if (!useFilter || !filterActive()) { pos++; signs += p.signs.length; }
      else if (n) { pos++; signs += n; }
    });
    return countText(pos, signs);
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
    var parts = [];
    if (c.ok) parts.push(T("{0} gut", c.ok));
    if (c.renew) parts.push(T("{0} erneuern", c.renew));
    if (c.missing) parts.push(T("{0} fehlt", c.missing));
    return parts.join(" · ");
  }

  // ---------- Karte ----------

  var current = null;        // geöffnete Ebene
  var selId = null;          // ausgewählte Position
  var pick = null;           // {photoId|null}: Wegzeichen für die ausgewählte Position wählen

  function markerIcon(layer, p) {
    var sel = current === layer && p.id === selId;
    if (map.getZoom() < DETAIL_ZOOM && !sel) {
      var worst = "ok";
      p.signs.forEach(function (s) { if (s.state === "missing") worst = "missing"; else if (s.state === "renew" && worst !== "missing") worst = "renew"; });
      if (!p.signs.length) worst = "none";
      return L.divIcon({ className: "", html: '<div class="mk-dot mk-' + worst + '"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
    }
    var list = p.signs.length ? p.signs : [null];
    var html = '<div class="mk-pin' + (sel ? " sel" : "") + '"><div class="mk-stack">' + list.map(function (s) {
      if (!s) return '<span class="mk-sign mk-none">?</span>';
      var dim = current === layer && filterActive() && !signMatches(s) ? " mk-dim" : "";
      return '<span class="mk-sign mk-' + s.state + dim + '"><img alt="" src="' + esc(symUrl(symOf(layer, s.sym))) + '"></span>';
    }).join("") + '</div><span class="mk-tail"></span></div>';
    var h = list.length * 30 + 6 + 8;
    return L.divIcon({ className: "", html: html, iconSize: [36, h], iconAnchor: [18, h] });
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
          p.signs.forEach(function (s) { if (s.photo === ph.id) { s.photo = null; changed = true; } });
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
        '<button type="button" class="icon-btn mk-nophoto" title="Wegzeichen ohne Foto erfassen" aria-label="Wegzeichen ohne Foto erfassen">' + G.icon("plus") + "</button>" +
        '<button type="button" class="icon-btn mk-close" title="Schließen" aria-label="Schließen">' + G.icon("close") + "</button>" +
      "</span>" +
    "</div>" +
    '<div class="sheet-body">' +
      '<div class="mk-point" hidden></div>' +
      '<div class="list-head mk-filter"></div>' +
      '<div class="mk-syms"></div>' +
    "</div>";
  document.body.appendChild(panel);
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);
  G.makeResizable(panel, panel.querySelector(".mk-head"), "goahead.marksHeight.v1");

  var pointEl = panel.querySelector(".mk-point");
  var filterEl = panel.querySelector(".mk-filter");
  var symsEl = panel.querySelector(".mk-syms");

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
          '<span class="trk-info mk-st-' + s.state + '">' + esc(stateLabel(s.state) + (s.photo ? " · " + T("mit Foto") : "")) + "</span></span>" +
        "</span>" +
        '<button type="button" class="icon-btn" data-act="up" title="Nach oben" aria-label="Nach oben"' + (i === 0 ? " disabled" : "") + ">" + G.icon("up") + "</button>" +
        '<button type="button" class="icon-btn" data-act="down" title="Nach unten" aria-label="Nach unten"' + (i === p.signs.length - 1 ? " disabled" : "") + ">" + G.icon("down") + "</button>" +
        "</div>";
    }).join("");
    if (pick) {
      html += '<div class="mk-pick">' + (layer.symbols.length ? layer.symbols.map(function (sym) {
        return '<button type="button" class="mk-pick-btn" data-pick="' + esc(sym.id) + '" title="' + esc(sym.name) + '" aria-label="' + esc(sym.name) + '" data-noi18n>' +
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

  function renderSyms() {
    var layer = current;
    var html = '<div class="list-head list-head-one"><span class="list-sum">' +
      esc(T(layer.symbols.length === 1 ? "1 Wegzeichen hinterlegt" : "{0} Wegzeichen hinterlegt", layer.symbols.length)) + "</span>" +
      '<button type="button" class="icon-btn mk-add-tfis" title="TFIS-Wegzeichen (Wegenummer) hinzufügen" aria-label="TFIS-Wegzeichen (Wegenummer) hinzufügen"><span class="icon-letter">Nr</span></button>' +
      '<button type="button" class="icon-btn mk-add-img" title="Eigenes Wegzeichen-Bild hinzufügen" aria-label="Eigenes Wegzeichen-Bild hinzufügen">' + G.icon("image") + "</button></div>";
    html += layer.symbols.map(function (sym) {
      var c = symCounts(layer, sym.id);
      return '<div class="trk-item mk-sym' + (filter.sym === sym.id ? " on" : "") + '" data-sym="' + esc(sym.id) + '">' +
        '<span class="trk-main" data-act="filter">' + '<span class="mk-sym-box"><img alt="" src="' + esc(symUrl(sym)) + '"></span>' +
          '<span class="trk-text"><span class="trk-name" data-noi18n>' + esc(sym.name) + "</span>" +
          '<span class="trk-info">' + esc((sym.tfis ? "TFIS " + (sym.key || sym.tfis) + " · " : "") + symCountText(c)) + "</span></span></span>" +
        '<span class="trk-actions"><button type="button" class="icon-btn" data-act="more" title="Weitere Aktionen" aria-label="Weitere Aktionen">' + G.icon("more") + "</button></span>" +
        "</div>";
    }).join("");
    symsEl.innerHTML = html;
  }

  function renderSheet() {
    var layer = current;
    if (!layer) return;
    panel.querySelector(".mk-title").textContent = layer.name;
    panel.querySelector(".mk-sub").textContent = summary(layer, false);
    renderPoint();
    renderFilter();
    renderSyms();
    renderMarkers(layer);
  }

  function openLayer(id, opts) {
    var layer = byId(id);
    if (!layer) return;
    opts = opts || {};
    if (current !== layer) { filter = { sym: "", state: "" }; selId = null; pick = null; }
    var prev = current;
    current = layer;
    if (prev && prev !== layer) renderMarkers(prev);
    if (opts.select !== undefined) {
      if (selId !== opts.select) pick = null;
      selId = opts.select;
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
    current = null;
    selId = null;
    pick = null;
    filter = { sym: "", state: "" };
    panel.hidden = true;
    document.body.classList.remove("mode-marks");
    if (layer) renderMarkers(layer);
  }

  function select(pointId) {
    if (selId !== pointId) pick = null;
    selId = pointId;
    renderSheet();
  }

  panel.querySelector(".mk-close").addEventListener("click", closeLayer);

  panel.querySelector(".mk-photo").addEventListener("click", function () {
    if (!current || !G.photos) return;
    if (!current.symbols.length) { G.showStatus("Zuerst Wegzeichen für diese Ebene hinterlegen.", 5000); return; }
    // ausgewählte Position: Foto ergänzt sie (nächstes Wegzeichen an derselben Stelle), sonst neue Position
    G.photos.take("mark:" + current.id + ":" + (selId || ""));
  });

  panel.querySelector(".mk-nophoto").addEventListener("click", function () {
    var layer = current;
    if (!layer) return;
    if (!layer.symbols.length) { G.showStatus("Zuerst Wegzeichen für diese Ebene hinterlegen.", 5000); return; }
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
      p.signs.push({ id: newId(), sym: pb.getAttribute("data-pick"), state: "ok", photo: pick.photoId || null });
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
      if (s.photo && photoCache[s.photo]) acts.push({ label: "Foto anzeigen", onClick: function () { G.photos.open(photoCache[s.photo]); } });
      acts.push({ label: "Entfernen", danger: true, onClick: function () {
        p.signs.splice(p.signs.indexOf(s), 1);
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

  symsEl.addEventListener("click", function (e) {
    var layer = current;
    if (!layer) return;
    if (e.target.closest(".mk-add-tfis")) { askTfis(layer); return; }
    if (e.target.closest(".mk-add-img")) { imgTarget = layer; imgInput.value = ""; imgInput.click(); return; }
    var item = e.target.closest("[data-sym]");
    var actEl = e.target.closest("[data-act]");
    if (!item || !actEl) return;
    var sym = symOf(layer, item.getAttribute("data-sym"));
    if (!sym) return;
    if (actEl.getAttribute("data-act") === "filter") {
      filter.sym = filter.sym === sym.id ? "" : sym.id;
      renderSheet();
    } else {
      var used = symCounts(layer, sym.id).all;
      G.actionSheet(sym.name, sym.tfis ? "TFIS " + sym.tfis : "", [
        { label: "Umbenennen", onClick: function () {
          G.askText("Name des Wegzeichens", sym.name, function (v) {
            v = (v || "").trim();
            if (!v) return;
            sym.name = v;
            save(layer);
            renderSheet();
          });
        } },
        { label: "Entfernen", danger: true, onClick: function () {
          function doRemove() {
            layer.symbols = layer.symbols.filter(function (x) { return x !== sym; });
            layer.points.forEach(function (p) { p.signs = p.signs.filter(function (s) { return s.sym !== sym.id; }); });
            if (filter.sym === sym.id) filter.sym = "";
            save(layer);
            renderSheet();
          }
          if (!used) { doRemove(); return; }
          G.actionSheet(T("„{0}“ entfernen?", sym.name),
            T(used === 1 ? "Es ist an 1 Stelle zugeordnet; dort wird es ebenfalls entfernt." : "Es ist an {0} Stellen zugeordnet; dort wird es ebenfalls entfernt.", used),
            [{ label: "Entfernen", danger: true, onClick: doRemove }]);
        } }
      ]);
    }
  });

  // ---------- Wegzeichen hinterlegen ----------

  function addSymbol(layer, sym) {
    sym.id = newId();
    layer.symbols.push(sym);
    save(layer);
    if (layer === current) renderSheet();
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
  // Verzeichnis Wegenummer (TFIS „schluessel“, z. B. „01-0A0-00“) → {k: Schreibweise, s: [Signaturnummern], n: Name};
  // erzeugt im Pages-Workflow aus dem TFIS-GeoPackage (.github/scripts/tfis_index.py)
  var keyIndex = null;
  function loadKeyIndex() {
    if (keyIndex) return keyIndex;
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 10000);
    keyIndex = fetch("symbols/tfis/index.json", ctl ? { signal: ctl.signal } : {}).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
    keyIndex.catch(function (err) { console.warn("[GoAhead] Wegenummern:", err); keyIndex = null; });
    return keyIndex;
  }

  // Eingabe: Wegenummer oder Signaturnummer, optional mit Namen dahinter („01-0A0-00 Eggeweg“)
  function askTfis(layer) {
    G.askText("Wegenummer oder Signaturnummer (TFIS)", "", function (v) {
      var m = /^\s*(\S+)\s*(.*)$/.exec(String(v || ""));
      if (!m) return;
      var code = m[1], rest = m[2].trim();
      if (/^\d+$/.test(code)) { addTfisTo(layer, code, rest); return; }
      var key = code.toUpperCase();
      loadKeyIndex().then(function (idx) {
        // Verzeichnis ist ohne Bindestriche/Leerzeichen geschlüsselt (tfis_index.py, norm)
        var e = idx && idx[key.replace(/[^0-9A-Z]/g, "")];
        if (!e || !e.s || !e.s.length) { G.showStatus(T("Zur Wegenummer {0} ist kein Wegzeichen bekannt.", key), 6000); return; }
        var name = rest || e.n || "";
        if (e.s.length === 1) { addTfisTo(layer, e.s[0], name, key); return; }
        G.actionSheet(T("Wegenummer {0}", key), name, e.s.map(function (nr) {
          return { label: T("Signaturnummer {0}", nr), onClick: function () { addTfisTo(layer, nr, name, key); } };
        }));
      }).catch(function () {
        G.showStatus("Die Wegenummern lassen sich gerade nicht laden. Bitte mit Internetverbindung noch einmal versuchen.", 7000);
      });
    }, "Weiter");
  }
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
  function addTfis(nr, name, key) {
    nr = String(nr || "").trim();
    key = key ? String(key).trim().toUpperCase() : null;
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
      var k = Math.min(1, SYM_PX / Math.max(bmp.width, bmp.height));
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * k));
      c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      var data = c.toDataURL("image/png");
      G.askText("Name des Wegzeichens", "", function (v) {
        v = (v || "").trim();
        if (!v) { G.showStatus("Ohne Namen wurde das Wegzeichen nicht übernommen.", 5000); return; }
        addSymbol(layer, { name: v, tfis: null, img: data });
      }, "Übernehmen");
    }).catch(function (err) {
      console.warn("[GoAhead] Wegzeichen-Bild:", err);
      G.showStatus("Das Bild konnte nicht geöffnet werden.", 6000);
    });
  });

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
      return '<div class="trk-item" data-id="' + esc(l.id) + '">' +
        '<input type="checkbox" class="mk-vis" data-act="toggle" aria-label="Auf der Karte zeigen" title="Auf der Karte zeigen"' + (l.visible ? " checked" : "") + ">" +
        '<span class="trk-main trk-tap" data-act="open"><span class="trk-text"><span class="trk-name" data-noi18n>' + esc(l.name) + "</span>" +
          '<span class="trk-info">' + esc(summary(l, false)) + "</span></span></span>" +
        '<span class="trk-actions"><button type="button" class="icon-btn" data-act="more" title="Weitere Aktionen" aria-label="Weitere Aktionen">' + G.icon("more") + "</button></span>" +
        "</div>";
    }).join("");
  }

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
    else if (act === "more") {
      G.actionSheet(layer.name, summary(layer, false), [
        { label: "Umbenennen", onClick: function () {
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
        } },
        { label: "Löschen", danger: true, onClick: function () {
          G.actionSheet(T("Ebene „{0}“ löschen?", layer.name), summary(layer, false), [
            { label: "Löschen", danger: true, onClick: function () { removeLayer(layer); } }
          ]);
        } }
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
