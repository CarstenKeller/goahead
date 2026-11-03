/* GoAhead – Wanderkarte für Wegemarkierer
 * Schritt 1: Karte mit eigener Position, Zoomen/Verschieben per Gesten.
 */
(function () {
  "use strict";

  var cfg = window.GOAHEAD_CONFIG;
  var APP_VERSION = "22";
  var STORAGE_KEY = "goahead.view.v1";

  // ---------- kleine Helfer ----------

  function storageGet() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function storageSet(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch (e) {
      /* privater Modus o. ä. – dann eben ohne Speichern */
    }
  }

  var statusEl = document.getElementById("status");
  var statusTimer = null;

  function showStatus(text, durationMs) {
    statusEl.textContent = text;
    statusEl.hidden = false;
    clearTimeout(statusTimer);
    if (durationMs) {
      statusTimer = setTimeout(hideStatus, durationMs);
    }
  }

  function hideStatus() {
    statusEl.hidden = true;
  }

  // ---------- Karte ----------

  var saved = storageGet();
  var start = saved && saved.center ? saved : null;

  var map = L.map("map", {
    center: start ? start.center : [cfg.initialView.lat, cfg.initialView.lng],
    zoom: start ? start.zoom : cfg.initialView.zoom,
    zoomControl: false,          // per Einstellung ein-/ausblendbar (Standard: aus)
    // Gesten: Ziehen, Pinch-Zoom, Doppeltipp – in Leaflet standardmäßig aktiv,
    // hier zur Klarheit explizit gesetzt.
    dragging: true,
    touchZoom: true,
    doubleClickZoom: true,
    scrollWheelZoom: true,
    boxZoom: false,
    inertia: true,
    zoomSnap: 0.25,
    zoomDelta: 1,
    wheelPxPerZoomLevel: 120
  });

  L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(map);

  // ---------- Hintergrundkarten und Overlays ----------

  // WMS, dessen Inhalt (Linien, Symbole, Schrift) vergrößert dargestellt werden kann:
  // Für dieselbe Fläche wird ein kleineres Bild angefordert und gestreckt angezeigt.
  var ScalableWMS = L.TileLayer.WMS.extend({
    _symbolScale: 1,
    onAdd: function (map) {
      L.TileLayer.WMS.prototype.onAdd.call(this, map);
      this._applyScale();
    },
    _applyScale: function () {
      if (!this._map) return;
      var size = this.getTileSize().x;
      var px = Math.max(64, Math.round(size / this._symbolScale));
      this.wmsParams.width = px;
      this.wmsParams.height = px;
    },
    setSymbolScale: function (f) {
      if (f === this._symbolScale) return;
      this._symbolScale = f;
      if (this._map) {
        this._applyScale();
        this.redraw();
      }
    }
  });

  // Kachel-Layer (XYZ): Vergrößern nur in Zweierpotenzen möglich – Kacheln der
  // nächstgröberen Zoomstufe werden doppelt so groß angezeigt.
  function xyzScaleStep(f) {
    if (f < 1.4) return 1;
    if (f < 2.8) return 2;
    return 4;
  }

  function setXyzSymbolScale(layer, f) {
    var step = xyzScaleStep(f);
    if (layer._symbolStep === step) return;
    var def = layer._goaheadDef;
    var offset = -Math.round(Math.log(step) / Math.LN2);
    layer._symbolStep = step;
    layer.options.tileSize = 256 * step;
    layer.options.zoomOffset = offset;
    layer.options.maxNativeZoom = (def.maxNativeZoom || def.maxZoom) - offset;
    if (layer._map) {
      var m = layer._map;
      layer._rescaling = true;
      m.removeLayer(layer);
      layer.addTo(m);
      layer._rescaling = false;
    }
  }

  function makeLayer(def, isOverlay) {
    var layer;
    if (def.type === "wms") {
      layer = new ScalableWMS(def.url, {
        layers: def.layers || "",
        format: def.format,
        transparent: !!def.transparent,
        version: "1.3.0",
        maxZoom: def.maxZoom,
        attribution: def.attribution,
        // 512er-Kacheln halbieren die Zahl der Anfragen an den WMS
        tileSize: 512,
        detectRetina: false,
        zIndex: isOverlay ? 10 : 1
      });
    } else {
      layer = L.tileLayer(def.url, {
        maxZoom: def.maxZoom,
        maxNativeZoom: def.maxNativeZoom,
        attribution: def.attribution,
        zIndex: isOverlay ? 10 : 1
      });
    }
    layer._goaheadDef = def;
    watchTileErrors(layer, def);
    return layer;
  }

  var layerById = {};
  var baseEntries = {};
  var overlayEntries = {};
  var defaultId = null;

  cfg.baseLayers.forEach(function (def) {
    var layer = makeLayer(def, false);
    layerById[def.id] = layer;
    baseEntries[def.name] = layer;
    if (def.default && !defaultId) defaultId = def.id;
  });

  (cfg.overlays || []).forEach(function (def) {
    var layer = makeLayer(def, true);
    layerById[def.id] = layer;
    overlayEntries[def.name] = layer;
  });

  var activeId = (saved && layerById[saved.layer] && baseEntries[layerById[saved.layer]._goaheadDef.name])
    ? saved.layer : (defaultId || cfg.baseLayers[0].id);
  layerById[activeId].addTo(map);

  // Overlays: gespeicherter Zustand, sonst Voreinstellung aus config.js
  var activeOverlays = {};
  (cfg.overlays || []).forEach(function (def) {
    var on = saved && saved.overlays ? saved.overlays.indexOf(def.id) >= 0 : !!def.visible;
    // Ein WMS-Overlay ohne Layer-Namen wird erst nach der Capabilities-Abfrage eingeblendet
    if (on && (def.type !== "wms" || def.layers)) {
      layerById[def.id].addTo(map);
    }
    if (on) activeOverlays[def.id] = true;
  });

  // ---------- Hamburger-Menü: Leiste mit Funktionsknöpfen, fährt von rechts ein ----------

  var menuBtn = document.getElementById("menu-btn");
  var toolbar = document.getElementById("toolbar");
  var menuClosers = [];   // Funktionen, die beim Schließen offene Panels zuklappen

  function menuIsOpen() { return toolbar.classList.contains("open"); }
  function openMenu() {
    toolbar.classList.add("open");
    toolbar.setAttribute("aria-hidden", "false");
    menuBtn.setAttribute("aria-expanded", "true");
  }
  function closeMenu() {
    toolbar.classList.remove("open");
    toolbar.setAttribute("aria-hidden", "true");
    menuBtn.setAttribute("aria-expanded", "false");
    menuClosers.forEach(function (fn) { fn(); });
  }
  menuBtn.addEventListener("click", function () {
    if (menuIsOpen()) closeMenu(); else openMenu();
  });
  L.DomEvent.disableClickPropagation(toolbar);
  L.DomEvent.disableScrollPropagation(toolbar);

  // Steuerelement zur Karte hinzufügen und in die Menüleiste verschieben
  function addToToolbar(control, onClose) {
    control.addTo(map);
    toolbar.appendChild(control.getContainer());
    if (onClose) menuClosers.push(onClose);
    return control;
  }

  var layersControl = L.control.layers(baseEntries, overlayEntries, { collapsed: true });
  addToToolbar(layersControl, function () { layersControl.collapse(); });

  // ---------- Größe der Wegemarkierungen ----------

  var SCALE_KEY = "goahead.symbolScale.v1";
  var symbolScale = 1;
  try {
    var storedScale = parseFloat(window.localStorage.getItem(SCALE_KEY));
    if (storedScale >= 1 && storedScale <= 3) symbolScale = storedScale;
  } catch (e) { /* ohne Speicher */ }

  function applySymbolScale(f) {
    symbolScale = f;
    (cfg.overlays || []).forEach(function (def) {
      var layer = layerById[def.id];
      if (def.type === "wms") layer.setSymbolScale(f);
      else setXyzSymbolScale(layer, f);
    });
  }

  var SizeControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      var box = L.DomUtil.create("div", "leaflet-bar size-control");
      var btn = L.DomUtil.create("a", "size-toggle", box);
      btn.href = "#";
      btn.setAttribute("role", "button");
      btn.title = "Größe der Wegemarkierungen";
      btn.setAttribute("aria-label", "Größe der Wegemarkierungen");
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
        '<rect x="3" y="7" width="18" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M7 12h10" stroke="#c0282d" stroke-width="3" stroke-linecap="round"/></svg>';

      var panel = L.DomUtil.create("div", "size-panel", box);
      panel.hidden = true;
      var label = L.DomUtil.create("label", "", panel);
      label.textContent = "Wegemarkierungen";
      var row = L.DomUtil.create("div", "size-row", panel);
      var input = L.DomUtil.create("input", "", row);
      input.type = "range";
      input.min = "1";
      input.max = "3";
      input.step = "0.25";
      input.value = String(symbolScale);
      input.setAttribute("aria-label", "Größe der Wegemarkierungen");
      var out = L.DomUtil.create("output", "", row);
      var note = L.DomUtil.create("div", "size-note", panel);

      function render() {
        var f = parseFloat(input.value);
        out.textContent = Math.round(f * 100) + " %";
        note.textContent = "OSM-Ebene: " + (xyzScaleStep(f) * 100) + " % (nur 100/200/400 % möglich)";
      }
      render();

      var timer = null;
      input.addEventListener("input", function () {
        render();
        clearTimeout(timer);
        timer = setTimeout(function () {
          var f = parseFloat(input.value);
          applySymbolScale(f);
          try { window.localStorage.setItem(SCALE_KEY, String(f)); } catch (e) { /* egal */ }
        }, 250);
      });

      L.DomEvent.on(btn, "click", function (e) {
        L.DomEvent.preventDefault(e);
        panel.hidden = !panel.hidden;
      });
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      // Panel schließen, wenn auf die Karte getippt wird
      map.on("click", function () { panel.hidden = true; });
      return box;
    }
  });
  var sizeControl = addToToolbar(new SizeControl(), function () {
    var pnl = sizeControl.getContainer().querySelector(".size-panel");
    if (pnl) pnl.hidden = true;
  });

  // ---------- Einstellungen ----------

  var SETTINGS_KEY = "goahead.settings.v1";
  // Gehgeschwindigkeiten für die Dauer-Prognose: Startwerte sind Annahmen, in den Einstellungen anpassbar
  var SETTING_DEFAULTS = {
    zoomButtons: false,
    speedFlat: 4.5,      // km/h in der Ebene
    speedUp: 3.0,        // km/h bei Steigung
    speedDown: 4.0,      // km/h bei Gefälle
    slopePercent: 5      // ab dieser Neigung (%) gilt ein Abschnitt als Steigung bzw. Gefälle
  };
  var settings = JSON.parse(JSON.stringify(SETTING_DEFAULTS));
  try {
    var storedSettings = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}");
    Object.keys(SETTING_DEFAULTS).forEach(function (k) {
      if (typeof storedSettings[k] === typeof SETTING_DEFAULTS[k]) settings[k] = storedSettings[k];
    });
  } catch (e) { /* Standardwerte */ }
  var settingsListeners = [];

  function saveSettings() {
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* egal */ }
  }

  var zoomControl = L.control.zoom({ position: "topleft", zoomInTitle: "Vergrößern", zoomOutTitle: "Verkleinern" });
  function applyZoomButtons() {
    if (settings.zoomButtons) zoomControl.addTo(map); else zoomControl.remove();
  }
  applyZoomButtons();

  var SettingsControl = L.Control.extend({
    onAdd: function () {
      var box = L.DomUtil.create("div", "leaflet-bar settings-control");
      var btn = L.DomUtil.create("a", "settings-toggle", box);
      btn.href = "#";
      btn.setAttribute("role", "button");
      btn.title = "Einstellungen";
      btn.setAttribute("aria-label", "Einstellungen");
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
        '<path fill="#444" d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>';
      var panel = L.DomUtil.create("div", "settings-panel", box);
      panel.hidden = true;
      function numRow(key, label, unit, min, max, step) {
        return '<label class="settings-num"><span>' + label + '</span><input type="number" inputmode="decimal" data-num="' + key +
          '" min="' + min + '" max="' + max + '" step="' + step + '"><span class="settings-unit">' + unit + "</span></label>";
      }
      panel.innerHTML = '<div class="settings-title">Einstellungen</div>' +
        '<label class="settings-row"><input type="checkbox" data-setting="zoomButtons"> Zoom-Knöpfe (+/−) anzeigen</label>' +
        '<div class="settings-sub">Gehgeschwindigkeit (für die Dauer)</div>' +
        numRow("speedFlat", "Ebene", "km/h", 0.5, 10, 0.1) +
        numRow("speedUp", "Steigung", "km/h", 0.5, 10, 0.1) +
        numRow("speedDown", "Gefälle", "km/h", 0.5, 10, 0.1) +
        numRow("slopePercent", "Steigung/Gefälle ab", "%", 1, 30, 1) +
        '<p class="settings-note">App-Version ' + APP_VERSION + ' · <a href="?diagnose">Diagnose</a></p>';
      panel.querySelectorAll("[data-num]").forEach(function (inp) {
        var key = inp.getAttribute("data-num");
        inp.value = String(settings[key]);
        inp.addEventListener("change", function () {
          var v = parseFloat(String(inp.value).replace(",", "."));
          var min = parseFloat(inp.min);
          var max = parseFloat(inp.max);
          if (isNaN(v)) v = SETTING_DEFAULTS[key];
          v = Math.min(max, Math.max(min, v));
          inp.value = String(v);
          settings[key] = v;
          saveSettings();
          settingsListeners.forEach(function (fn) { try { fn(settings); } catch (e) { console.warn(e); } });
        });
      });
      var cb = panel.querySelector('[data-setting="zoomButtons"]');
      cb.checked = settings.zoomButtons;
      cb.addEventListener("change", function () {
        settings.zoomButtons = cb.checked;
        saveSettings();
        applyZoomButtons();
      });
      L.DomEvent.on(btn, "click", function (e) {
        L.DomEvent.preventDefault(e);
        panel.hidden = !panel.hidden;
      });
      this._panel = panel;
      return box;
    }
  });
  var settingsControl = addToToolbar(new SettingsControl(), function () {
    if (settingsControl._panel) settingsControl._panel.hidden = true;
  });
  applySymbolScale(symbolScale);

  map.on("baselayerchange", function (e) {
    activeId = e.layer._goaheadDef.id;
    saveView();
  });
  map.on("overlayadd", function (e) {
    if (e.layer._rescaling) return;
    var def = e.layer._goaheadDef;
    activeOverlays[def.id] = true;
    if (def.type === "wms" && !def.layers) {
      showStatus("„" + def.name + "“: Kartenebenen des Dienstes noch unbekannt. " +
        "Details: Adresse mit ?diagnose öffnen.", 8000);
    }
    saveView();
  });
  map.on("overlayremove", function (e) {
    if (e.layer._rescaling) return;
    delete activeOverlays[e.layer._goaheadDef.id];
    saveView();
  });

  // Meldet, wenn ein Kartendienst gar keine Kacheln liefert
  function watchTileErrors(layer, def) {
    var ok = 0;
    var failed = 0;
    var warned = false;
    layer.on("tileload", function () { ok++; });
    layer.on("tileerror", function () {
      failed++;
      if (!warned && ok === 0 && failed >= 4) {
        warned = true;
        showStatus("Kartendienst „" + def.name + "“ liefert keine Kacheln. Netz prüfen oder andere Karte wählen.", 8000);
      }
    });
  }

  // ---------- WMS-Capabilities: Layer-Namen prüfen bzw. ermitteln ----------

  var diagnostics = {};

  function parseCapabilities(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, "text/xml");
    var result = [];
    var crs = {};
    var layers = doc.getElementsByTagName("Layer");
    for (var i = 0; i < layers.length; i++) {
      var entry = { name: null, title: null, leaf: true, queryable: layers[i].getAttribute("queryable") === "1" };
      var children = layers[i].children;
      for (var j = 0; j < children.length; j++) {
        var tag = children[j].localName;
        var text = children[j].textContent.trim();
        if (tag === "Name") entry.name = text;
        else if (tag === "Title") entry.title = text;
        else if (tag === "Layer") entry.leaf = false;
        else if (tag === "CRS" || tag === "SRS") crs[text] = true;
      }
      result.push(entry);
    }
    var gfi = [];
    var gfiEl = doc.getElementsByTagName("GetFeatureInfo")[0];
    if (gfiEl) {
      for (var g = 0; g < gfiEl.children.length; g++) {
        if (gfiEl.children[g].localName === "Format") gfi.push(gfiEl.children[g].textContent.trim());
      }
    }
    return { layers: result, crs: Object.keys(crs), featureInfoFormats: gfi };
  }

  function chooseLayers(def, caps) {
    var named = caps.layers.filter(function (l) { return l.name; });
    if (!named.length) return null;

    // Basiskarte: eingetragener Name vorhanden -> behalten
    if (def.layers) {
      var wanted = def.layers.split(",");
      var allThere = wanted.every(function (n) {
        return named.some(function (l) { return l.name === n; });
      });
      if (allThere) return def.layers;
    }

    // Overlay: alle Blatt-Layer, deren Name oder Titel passt (z. B. /wander/i)
    if (def.layerMatch) {
      var hits = named.filter(function (l) {
        return l.leaf && (def.layerMatch.test(l.name) || def.layerMatch.test(l.title || ""));
      });
      if (hits.length) return hits.map(function (l) { return l.name; }).join(",");
    }

    if (def.preferLayerMatch) {
      for (var k = 0; k < named.length; k++) {
        if (def.preferLayerMatch.test(named[k].name)) return named[k].name;
      }
    }
    // Rückfall: oberster benannter Layer (zeigt i. d. R. alle Unterebenen)
    return named[0].name;
  }

  function checkWmsCapabilities(def, layer) {
    var diag = diagnostics[def.id] = { name: def.name, url: def.url, configured: def.layers || "(keiner)", state: "läuft" };
    if (!window.fetch || !window.DOMParser) {
      diag.state = "Browser ohne fetch/DOMParser";
      return Promise.resolve();
    }
    var url = def.url + (def.url.indexOf("?") >= 0 ? "&" : "?") + "SERVICE=WMS&REQUEST=GetCapabilities";
    return fetch(url, { mode: "cors" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (xmlText) {
        var caps = parseCapabilities(xmlText);
        diag.state = "ok";
        diag.layers = caps.layers;
        diag.has3857 = caps.crs.indexOf("EPSG:3857") >= 0;
        diag.featureInfoFormats = caps.featureInfoFormats;

        var pick = chooseLayers(def, caps);
        diag.used = pick || "(keiner gefunden)";
        if (pick && pick !== def.layers) {
          console.warn("[GoAhead] " + def.name + ": verwende Layer „" + pick + "“ statt „" + (def.layers || "") + "“.");
          def.layers = pick;
          layer.setParams({ layers: pick });
          if (activeOverlays[def.id] && !map.hasLayer(layer)) layer.addTo(map);
        }
      })
      .catch(function (err) {
        // Häufigster Grund: Dienst sendet keine CORS-Header. Die Kacheln
        // selbst funktionieren trotzdem (Bilder brauchen kein CORS).
        diag.state = "nicht lesbar: " + err.message;
        diag.used = def.layers || "(keiner)";
      });
  }

  var capsChecks = cfg.baseLayers.concat(cfg.overlays || [])
    .filter(function (def) { return def.type === "wms"; })
    .map(function (def) { return checkWmsCapabilities(def, layerById[def.id]); });

  // Diagnose-Anzeige: Seite mit ?diagnose aufrufen
  var wfsDiagnostics = [];
  if (/[?&]diagnose\b/.test(window.location.search)) {
    var wfsChecks = (cfg.diagnoseWfs || []).map(probeWfs);
    Promise.all(capsChecks.concat(wfsChecks)).then(showDiagnostics);
  }

  function probeWfs(url) {
    var d = { url: url, state: "läuft" };
    wfsDiagnostics.push(d);
    return fetch(url + "?SERVICE=WFS&REQUEST=GetCapabilities", { mode: "cors" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (xmlText) {
        var doc = new DOMParser().parseFromString(xmlText, "text/xml");
        var types = doc.getElementsByTagName("FeatureType");
        d.types = [];
        for (var i = 0; i < types.length; i++) {
          var t = { name: "", title: "" };
          for (var j = 0; j < types[i].children.length; j++) {
            var c = types[i].children[j];
            if (c.localName === "Name") t.name = c.textContent.trim();
            if (c.localName === "Title") t.title = c.textContent.trim();
          }
          d.types.push(t);
        }
        var root = doc.documentElement;
        d.state = "ok (" + (root ? root.localName + " " + (root.getAttribute("version") || "") : "?") + ")";
      })
      .catch(function (err) {
        d.state = "nicht lesbar: " + err.message;
      });
  }

  function showDiagnostics() {
    var lines = ["App-Version " + APP_VERSION, ""];
    Object.keys(diagnostics).forEach(function (id) {
      var d = diagnostics[id];
      lines.push("■ " + d.name);
      lines.push("  Dienst: " + d.url);
      lines.push("  Capabilities: " + d.state);
      lines.push("  eingetragen: " + d.configured + "  →  verwendet: " + d.used);
      if (d.layers) {
        lines.push("  EPSG:3857: " + (d.has3857 ? "ja" : "NEIN"));
        lines.push("  GetFeatureInfo-Formate: " + ((d.featureInfoFormats || []).join(", ") || "keine"));
        lines.push("  Layer (Name – Titel):");
        d.layers.forEach(function (l) {
          lines.push("    " + (l.name || "–") + " – " + (l.title || "") + (l.queryable ? "  [abfragbar]" : ""));
        });
      }
      lines.push("");
    });

    wfsDiagnostics.forEach(function (d) {
      lines.push("■ WFS-Test");
      lines.push("  Dienst: " + d.url);
      lines.push("  Capabilities: " + d.state);
      if (d.types) {
        lines.push("  Objektarten (Name – Titel):");
        d.types.forEach(function (t) { lines.push("    " + t.name + " – " + t.title); });
      }
      lines.push("");
    });

    var box = document.createElement("div");
    box.id = "diagnose";
    var pre = document.createElement("pre");
    pre.textContent = lines.join("\n");
    var close = document.createElement("button");
    close.type = "button";
    close.textContent = "Schließen";
    close.addEventListener("click", function () { box.remove(); });
    var copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Kopieren";
    copy.addEventListener("click", function () {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(pre.textContent).then(function () { copy.textContent = "Kopiert"; });
      }
    });
    box.appendChild(copy);
    box.appendChild(close);
    box.appendChild(pre);
    document.body.appendChild(box);
  }

  // fetch mit Zeitlimit (sonst hängt eine Abfrage bei schlechtem Netz beliebig lange)
  function fetchWithTimeout(url, options, ms) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var opts = L.extend({}, options || {}, ctrl ? { signal: ctrl.signal } : {});
    var timer = null;
    return Promise.race([
      fetch(url, opts),
      new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
          // erst eigene Meldung, dann abbrechen (sonst gewinnt die AbortError-Meldung)
          reject(new Error("keine Antwort nach " + Math.round(ms / 1000) + " s"));
          if (ctrl) ctrl.abort();
        }, ms);
      })
    ]).then(function (r) { clearTimeout(timer); return r; },
            function (e) { clearTimeout(timer); throw e; });
  }

  // ---------- Antippen: Informationen zu Wegen (WMS GetFeatureInfo) ----------

  var infoDefs = (cfg.overlays || []).filter(function (d) { return d.type === "wms" && d.featureInfo; });
  var GML_NS = /opengis\.net\/gml/;

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // windowPx: Größe des abgefragten Bereichs auf dem Bildschirm (CSS-Pixel)
  // imgPx:    Bildgröße, die dem Server genannt wird. Ein kleines Bild für einen großen
  //           Bereich vergrößert die Fangtoleranz des Servers (ein Fingertipp ist ungenau).
  function featureInfoUrl(def, latlng, windowPx, imgPx, infoFormat) {
    var zoom = map.getZoom();
    var p = map.project(latlng, zoom);
    var half = windowPx / 2;
    var a = L.CRS.EPSG3857.project(map.unproject(p.add([-half, half]), zoom));
    var b = L.CRS.EPSG3857.project(map.unproject(p.add([half, -half]), zoom));
    var center = Math.floor(imgPx / 2);
    var params = {
      SERVICE: "WMS",
      VERSION: "1.3.0",
      REQUEST: "GetFeatureInfo",
      LAYERS: def.layers,
      QUERY_LAYERS: def.layers,
      STYLES: "",
      CRS: "EPSG:3857",
      BBOX: [a.x, a.y, b.x, b.y].join(","),
      WIDTH: imgPx,
      HEIGHT: imgPx,
      I: center,
      J: center,
      FORMAT: "image/png",
      INFO_FORMAT: infoFormat,
      FEATURE_COUNT: 20
    };
    return def.url + L.Util.getParamString(params, def.url, true);
  }

  // Liest Objekte und ihre Sacheigenschaften aus einer GML-Antwort (Geometrien werden ignoriert)
  function parseGmlFeatures(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("Antwort ist kein gültiges XML");
    var root = doc.documentElement;
    if (root && /ExceptionReport|ServiceExceptionReport/.test(root.localName)) {
      throw new Error("Server meldet: " + root.textContent.trim().slice(0, 200));
    }

    var features = [];
    var all = doc.getElementsByTagName("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (/^(member|featureMember|featureMembers)$/.test(el.localName)) {
        for (var j = 0; j < el.children.length; j++) features.push(el.children[j]);
      }
    }
    if (!features.length) {
      // Rückfall: Elemente mit gml:id gelten als Objekte (nur die äußersten)
      for (var k = 0; k < all.length; k++) {
        var cand = all[k];
        if (cand === root || GML_NS.test(cand.namespaceURI || "")) continue;
        if (cand.getAttributeNS && (cand.getAttributeNS("http://www.opengis.net/gml/3.2", "id") || cand.getAttribute("gml:id"))) {
          var nested = features.some(function (f) { return f.contains(cand); });
          if (!nested) features.push(cand);
        }
      }
    }

    return features.map(function (f) {
      var props = [];
      (function walk(node) {
        for (var c = 0; c < node.children.length; c++) {
          var child = node.children[c];
          if (GML_NS.test(child.namespaceURI || "")) continue;   // Geometrie, gml:name usw.
          if (child.children.length) {
            var isGeom = false;
            for (var g = 0; g < child.children.length; g++) {
              if (GML_NS.test(child.children[g].namespaceURI || "")) isGeom = true;
            }
            if (!isGeom) walk(child);
          } else {
            var v = child.textContent.trim();
            if (v) props.push([child.localName, v]);
          }
        }
      })(f);
      // Enthält ein Feld eine Bild-Adresse, wird sie als Wegzeichen angezeigt
      var symbol = null;
      for (var q = 0; q < props.length && !symbol; q++) {
        if (/^https?:\/\/\S+\.(png|svg|gif|jpe?g|webp)(\?\S*)?$/i.test(props[q][1])) symbol = props[q][1];
      }
      return { type: f.localName, props: props, symbol: symbol };
    });
  }

  // ---------- TFIS: Felder verständlich darstellen ----------

  var TFIS_LABELS = {
    schluessel: "Schlüssel",
    verein: "Verein",
    wegverlauf: "Verlauf",
    kategorie: "Kategorie",
    streckenvariante: "Streckenvariante",
    offizielleLaenge: "Länge",
    signaturnummer: "Signaturnummer"
  };
  var TFIS_ORDER = ["kategorie", "verein", "wegverlauf", "offizielleLaenge", "streckenvariante", "signaturnummer", "schluessel"];

  function prettyLabel(key) {
    if (TFIS_LABELS[key]) return TFIS_LABELS[key];
    var t = key.replace(/([a-zäöü])([A-ZÄÖÜ])/g, "$1 $2").replace(/_/g, " ");
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // Wegzeichen: SVG aus dem offiziellen TFIS-Paket von Geobasis NRW, beim Veröffentlichen
  // nach symbols/tfis/<Signaturnummer>.svg kopiert (siehe .github/workflows/pages.yml)
  function tfisSymbolUrl(signaturnummer) {
    var n = String(signaturnummer).trim();
    return /^\d+$/.test(n) ? "symbols/tfis/" + n + ".svg" : null;
  }

  function prettifyTfisFeature(def, f) {
    var byKey = {};
    f.props.forEach(function (kv) { byKey[kv[0]] = kv[1]; });
    var props = [];
    TFIS_ORDER.forEach(function (k) { if (byKey[k] != null) props.push([k, byKey[k]]); });
    f.props.forEach(function (kv) {
      if (kv[0] !== "name" && TFIS_ORDER.indexOf(kv[0]) < 0) props.push(kv);
    });
    var out = props.map(function (kv) {
      var v = kv[1];
      if (kv[0] === "offizielleLaenge" && /^\d+([.,]\d+)?$/.test(v)) v = String(v).replace(".", ",") + " km";
      return [prettyLabel(kv[0]), v];
    });
    var symbol = f.symbol;
    if (!symbol && byKey.signaturnummer) symbol = tfisSymbolUrl(byKey.signaturnummer);
    return {
      type: byKey.name || f.type,
      props: out,
      symbol: symbol
    };
  }

  // log: Liste, in die Anfrage und Antwort für die technischen Details geschrieben werden
  function fetchFeatures(def, latlng, windowPx, imgPx, log) {
    var url = featureInfoUrl(def, latlng, windowPx, imgPx, "text/xml;subtype=gml/3.2.1");
    var entry = { url: url, status: "läuft" };
    log.push(entry);
    var t0 = Date.now();
    return fetchWithTimeout(url, { mode: "cors" }, 12000)
      .then(function (r) {
        entry.status = "HTTP " + r.status + " (" + (r.headers.get("content-type") || "?") + ")";
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (text) {
        entry.ms = Date.now() - t0;
        entry.bytes = text.length;
        entry.snippet = text.slice(0, 1500);
        var features = parseGmlFeatures(text);
        entry.features = features.length;
        return features;
      })
      .catch(function (err) {
        entry.error = err.message;
        throw err;
      });
  }

  // ---------- OSM-Wanderrouten über die Overpass-API ----------

  var OSM_NETWORK = { iwn: "international", nwn: "national", rwn: "regional", lwn: "lokal" };
  var OSM_NETWORK_RANK = { iwn: 0, nwn: 1, rwn: 2, lwn: 3 };
  // Reihenfolge und deutsche Bezeichnungen der wichtigsten OSM-Tags
  var OSM_FIELDS = [
    ["ref", "Kürzel"],
    ["osmc:symbol", "Wegzeichen (osmc:symbol)"],
    ["symbol", "Wegzeichen (Beschreibung)"],
    ["operator", "Betreuer"],
    ["network", "Netz"],
    ["from", "von"],
    ["to", "nach"],
    ["distance", "Länge"],
    ["description", "Beschreibung"],
    ["website", "Webseite"],
    ["note", "Notiz"]
  ];

  // ---------- OSM-Wanderrouten über die API von Waymarked Trails ----------
  // Endpunkte laut Quelltext von github.com/waymarkedtrails/waymarkedtrails-api:
  //   /list/by_area?bbox=minx,miny,maxx,maxy (EPSG:3857), /details/relation/{id},
  //   /symbols/id/{symbol_id}.svg

  function wmtGroupLabel(g) {
    var v = String(g || "").toLowerCase();
    if (/^int|iwn/.test(v)) return "international";
    if (/^nat|nwn/.test(v)) return "national";
    if (/^reg|rwn/.test(v)) return "regional";
    if (/^loc|lwn/.test(v)) return "lokal";
    return g || "";
  }

  function fetchJson(url, log, ms) {
    var entry = { url: url, status: "läuft" };
    log.push(entry);
    var t0 = Date.now();
    return fetchWithTimeout(url, { mode: "cors" }, ms)
      .then(function (r) {
        entry.status = "HTTP " + r.status + " (" + (r.headers.get("content-type") || "?") + ")";
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (text) {
        entry.ms = Date.now() - t0;
        entry.bytes = text.length;
        entry.snippet = text.slice(0, 800);
        return JSON.parse(text);
      })
      .catch(function (err) {
        entry.ms = Date.now() - t0;
        entry.error = err.message;
        throw err;
      });
  }

  function fetchWmtRoutes(def, latlng, log) {
    var zoom = map.getZoom();
    var p = map.project(latlng, zoom);
    var a = L.CRS.EPSG3857.project(map.unproject(p.add([-24, 24]), zoom));
    var b = L.CRS.EPSG3857.project(map.unproject(p.add([24, -24]), zoom));
    var bbox = [a.x, a.y, b.x, b.y].map(function (v) { return v.toFixed(1); }).join(",");
    var base = def.wmtApi;

    return fetchJson(base + "/list/by_area?bbox=" + bbox + "&limit=20", log, 10000)
      .then(function (data) {
        var routes = data.results || [];
        log[log.length - 1].features = routes.length;
        // Details (Betreuer, Länge, alle OSM-Angaben) je Route; Fehler dort sind nicht schlimm
        return Promise.all(routes.slice(0, 12).map(function (rt) {
          return fetchJson(base + "/details/relation/" + rt.id, log, 10000)
            .catch(function () { return null; })
            .then(function (det) { return { rt: rt, det: det }; });
        }));
      })
      .then(function (items) {
        return items.map(function (it) {
          var rt = it.rt;
          var det = it.det || {};
          var props = [];
          if (rt.ref) props.push(["Kürzel", rt.ref]);
          if (rt.symbol_description) props.push(["Wegzeichen", rt.symbol_description]);
          if (det.operator) props.push(["Betreuer", det.operator]);
          if (rt.group) props.push(["Netz", wmtGroupLabel(rt.group)]);
          if (det.official_length) props.push(["Länge", (det.official_length / 1000).toFixed(1).replace(".", ",") + " km"]);
          if (rt.itinerary && rt.itinerary.length) props.push(["Verlauf", [].concat(rt.itinerary).join(" – ")]);
          if (det.description) props.push(["Beschreibung", det.description]);
          if (det.note) props.push(["Notiz", det.note]);
          if (det.url) props.push(["Webseite", det.url]);
          var extra = [];
          var tags = det.tags || {};
          Object.keys(tags).sort().forEach(function (k) { extra.push([k, tags[k]]); });
          return {
            type: rt.name || rt.ref || ("Route " + rt.id),
            symbol: rt.symbol_id ? base + "/symbols/id/" + encodeURIComponent(rt.symbol_id) + ".svg" : null,
            props: props,
            extra: extra,
            link: { href: "https://www.openstreetmap.org/relation/" + rt.id, text: "In OpenStreetMap ansehen" }
          };
        });
      });
  }

  function fetchOsmRoutes(def, latlng, log) {
    // Suchradius: etwa 24 Bildschirmpixel, mindestens 8 m, höchstens 250 m
    var zoom = map.getZoom();
    var p = map.project(latlng, zoom);
    var meters = map.distance(latlng, map.unproject(p.add([24, 0]), zoom));
    var radius = Math.round(Math.min(250, Math.max(8, meters)));
    var query = "[out:json][timeout:20];" +
      "way(around:" + radius + "," + latlng.lat.toFixed(6) + "," + latlng.lng.toFixed(6) + ")->.w;" +
      'rel(bw.w)[type=route][route~"^(hiking|foot)$"];' +
      "out tags;";
    var servers = [].concat(def.osmInfo);

    function attempt(i) {
      var entry = { url: servers[i] + "  (Radius " + radius + " m)\n" + query, status: "läuft" };
      log.push(entry);
      var t0 = Date.now();
      // POST als Formular: einfache Anfrage ohne CORS-Vorabprüfung
      return fetchWithTimeout(servers[i], {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query)
      }, 12000)
        .then(function (r) {
          entry.status = "HTTP " + r.status + " (" + (r.headers.get("content-type") || "?") + ")";
          if (r.status === 429) throw new Error("Server ausgelastet (429)");
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.text();
        })
        .then(function (text) {
          entry.ms = Date.now() - t0;
          entry.bytes = text.length;
          entry.snippet = text.slice(0, 1500);
          return { text: text, entry: entry };
        })
        .catch(function (err) {
          entry.ms = Date.now() - t0;
          entry.error = err.message;
          if (i + 1 < servers.length) return attempt(i + 1);
          throw err;
        });
    }

    return attempt(0)
      .then(function (res) {
        var text = res.text;
        var entry = res.entry;
        var data = JSON.parse(text);
        var rels = (data.elements || []).filter(function (el) { return el.type === "relation"; });
        rels.sort(function (a, b) {
          var ra = OSM_NETWORK_RANK[a.tags.network]; var rb = OSM_NETWORK_RANK[b.tags.network];
          ra = ra == null ? 9 : ra; rb = rb == null ? 9 : rb;
          if (ra !== rb) return ra - rb;
          return String(a.tags.ref || a.tags.name || "").localeCompare(String(b.tags.ref || b.tags.name || ""), "de");
        });
        entry.features = rels.length;
        return rels.map(function (rel) {
          var t = rel.tags || {};
          var props = [];
          OSM_FIELDS.forEach(function (f) {
            var v = t[f[0]];
            if (!v) return;
            if (f[0] === "network" && OSM_NETWORK[v]) v = OSM_NETWORK[v] + " (" + v + ")";
            if (f[0] === "distance" && /^[\d.,]+$/.test(v)) v = v + " km";
            props.push([f[1], v]);
          });
          var shown = {};
          OSM_FIELDS.forEach(function (f) { shown[f[0]] = true; });
          shown.name = shown.type = shown.route = true;
          var extra = Object.keys(t).filter(function (k) { return !shown[k]; }).sort()
            .map(function (k) { return [k, t[k]]; });
          return {
            type: t.name || t.ref || ("Route " + rel.id),
            props: props,
            extra: extra,
            link: { href: "https://www.openstreetmap.org/relation/" + rel.id, text: "In OpenStreetMap ansehen" }
          };
        });
      })
      .catch(function (err) {
        var last = log[log.length - 1];
        if (last && !last.error) last.error = err.message;
        throw err;
      });
  }

  // Baut den Inhalt des Infofensters. Quellen ohne Treffer und ohne Fehler werden weggelassen.
  function renderFeatures(results) {
    var html = "";
    function table(rows) {
      var t = "<table>";
      rows.forEach(function (kv) {
        var v = String(kv[1]);
        var cell = /^https?:\/\/\S+$/i.test(v)
          ? '<a href="' + escapeHtml(v) + '" target="_blank" rel="noopener">' + escapeHtml(v) + "</a>"
          : escapeHtml(v);
        t += "<tr><th>" + escapeHtml(kv[0]) + "</th><td>" + cell + "</td></tr>";
      });
      return t + "</table>";
    }
    var shown = results.filter(function (res) { return res.error || (res.features || []).length; });
    shown.forEach(function (res) {
      html += '<div class="fi-source">' + escapeHtml(res.def.name) + "</div>";
      if (res.error) {
        html += '<p class="fi-error">Abfrage fehlgeschlagen (' + escapeHtml(res.error) + ")</p>";
      }
      (res.features || []).forEach(function (f) {
        html += '<div class="fi-feature"><div class="fi-type">' +
          (f.symbol ? '<img class="fi-symbol" alt="" src="' + escapeHtml(f.symbol) + '" onerror="this.remove()">' : "") +
          "<span>" + escapeHtml(f.type) + "</span></div>";
        if (f.props.length) {
          html += table(f.props);
        } else if (!f.extra || !f.extra.length) {
          html += "<p>(keine Sachdaten)</p>";
        }
        if (f.extra && f.extra.length) {
          html += '<details class="fi-extra"><summary>Alle Angaben</summary>' + table(f.extra) + "</details>";
        }
        if (f.link) {
          html += '<p class="fi-raw"><a href="' + escapeHtml(f.link.href) + '" target="_blank" rel="noopener">' + escapeHtml(f.link.text) + "</a></p>";
        }
        html += "</div>";
      });
      if (res.htmlUrl) {
        html += '<p class="fi-raw"><a href="' + escapeHtml(res.htmlUrl) + '" target="_blank" rel="noopener">Original-Antwort des Servers öffnen</a></p>';
      }
    });
    var details = "";
    results.forEach(function (res) {
      (res.log || []).forEach(function (e, i) {
        details += res.def.name + " – Anfrage " + (i + 1) + ": " + e.status +
          (e.ms != null ? ", " + e.ms + " ms" : "") + (e.bytes != null ? ", " + e.bytes + " Zeichen" : "") +
          (e.features != null ? ", " + e.features + " Objekte erkannt" : "") +
          (e.error ? ", Fehler: " + e.error : "") + "\n" + e.url + "\n" +
          (e.snippet ? "Antwort (Anfang):\n" + e.snippet + "\n" : "") + "\n";
      });
    });
    if (details) {
      details = "App-Version " + APP_VERSION + "\n\n" + details;
      html += '<details class="fi-details"><summary>Technische Details</summary><pre>' + escapeHtml(details) + "</pre></details>";
    }
    return '<div class="fi">' + html + "</div>";
  }

  // ---------- Infofenster unten (volle Breite, unteres Drittel) ----------

  var infoPanel = document.getElementById("info-panel");
  var infoBody = document.getElementById("info-body");
  var tapMarker = null;

  function setTapMarker(latlng, searching) {
    if (!tapMarker) {
      tapMarker = L.marker(latlng, {
        icon: L.divIcon({ className: "", html: '<div class="tap-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 900
      });
    }
    tapMarker.setLatLng(latlng).addTo(map);
    var el = tapMarker.getElement();
    if (el) el.firstChild.classList.toggle("searching", !!searching);
  }

  function clearTapMarker() {
    if (tapMarker) map.removeLayer(tapMarker);
  }

  function openInfoPanel(html) {
    infoBody.innerHTML = html;
    infoBody.scrollTop = 0;
    infoPanel.hidden = false;
    document.body.classList.add("info-open");
  }

  function closeInfoPanel() {
    infoPanel.hidden = true;
    document.body.classList.remove("info-open");
    clearTapMarker();
  }

  document.getElementById("info-close").addEventListener("click", function () {
    infoRequest++;               // laufende Abfrage verwerfen
    closeInfoPanel();
  });
  // Höhe des Infofensters durch Ziehen am Kopf ändern; ganz nach unten gezogen schließt es
  var INFO_H_KEY = "goahead.infoHeight.v1";
  function setInfoHeight(px) {
    document.documentElement.style.setProperty("--info-height", Math.round(px) + "px");
  }
  try {
    var storedH = parseFloat(window.localStorage.getItem(INFO_H_KEY));
    if (storedH > 0.1 && storedH < 0.95) setInfoHeight(storedH * window.innerHeight);
  } catch (e) { /* egal */ }

  (function () {
    var head = infoPanel.querySelector(".info-head");
    var dragging = false;
    var startY = 0;
    var startH = 0;
    var curH = 0;
    head.addEventListener("pointerdown", function (e) {
      if (e.target.closest("#info-close")) return;
      dragging = true;
      startY = e.clientY;
      startH = curH = infoPanel.getBoundingClientRect().height;
      head.setPointerCapture(e.pointerId);
      infoPanel.classList.add("dragging");
      e.preventDefault();
    });
    head.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var maxH = window.innerHeight * 0.9;
      curH = Math.max(60, Math.min(maxH, startH + (startY - e.clientY)));
      setInfoHeight(curH);
    });
    function end() {
      if (!dragging) return;
      dragging = false;
      infoPanel.classList.remove("dragging");
      var minH = window.innerHeight * 0.15;
      if (curH < minH) {
        // nach unten weggezogen: schließen, letzte sinnvolle Höhe behalten
        setInfoHeight(Math.max(startH, minH));
        infoRequest++;
        closeInfoPanel();
        return;
      }
      try { window.localStorage.setItem(INFO_H_KEY, String(curH / window.innerHeight)); } catch (err) { /* egal */ }
    }
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  })();

  // Gesten im Infofenster nicht an die Karte weitergeben
  L.DomEvent.disableClickPropagation(infoPanel);
  L.DomEvent.disableScrollPropagation(infoPanel);

  var infoRequest = 0;

  function queryFeatureInfo(latlng) {
    var active = infoDefs.filter(function (d) { return d.layers && map.hasLayer(layerById[d.id]); })
      .concat((cfg.overlays || []).filter(function (d) { return (d.wmtApi || d.osmInfo) && map.hasLayer(layerById[d.id]); }));
    if (!active.length) {
      closeInfoPanel();
      return;
    }

    var requestId = ++infoRequest;
    setTapMarker(latlng, true);

    Promise.all(active.map(function (def) {
      var log = [];
      if (def.wmtApi || def.osmInfo) {
        var first = def.wmtApi
          ? fetchWmtRoutes(def, latlng, log).catch(function (err) {
              if (!def.osmInfo) throw err;
              return fetchOsmRoutes(def, latlng, log);     // Rückfall: Overpass
            })
          : fetchOsmRoutes(def, latlng, log);
        return first
          .then(function (features) { return { def: def, features: features, log: log }; })
          .catch(function (err) { return { def: def, error: err.message, log: log }; });
      }
      var htmlUrl = featureInfoUrl(def, latlng, 48, 13, "text/html");
      // erst mit großzügiger Fangtoleranz, bei leerem Ergebnis noch einmal genau
      return fetchFeatures(def, latlng, 48, 13, log)
        .then(function (features) {
          return features.length ? features : fetchFeatures(def, latlng, 101, 101, log);
        })
        .then(function (features) {
          return {
            def: def,
            features: features.map(function (f) { return prettifyTfisFeature(def, f); }),
            htmlUrl: htmlUrl,
            log: log
          };
        })
        .catch(function (err) {
          return { def: def, error: err.message, htmlUrl: htmlUrl, log: log };
        });
    })).then(function (results) {
      if (requestId !== infoRequest) return;      // inzwischen neu getippt
      var found = results.some(function (r) { return r.error || (r.features || []).length; });
      if (!found) {
        // Nichts gefunden: still bleiben, ein offenes Infofenster schließen
        closeInfoPanel();
        return;
      }
      setTapMarker(latlng, false);
      openInfoPanel(renderFeatures(results));
    });
  }

  var mapClickHandler = null;
  function setMapClickHandler(fn) {
    mapClickHandler = fn || null;
    if (fn) closeInfoPanel();
  }

  // Einzelnes Antippen abfragen, Doppeltipp (Zoom) dagegen nicht
  var clickTimer = null;
  map.on("click", function (e) {
    clearTimeout(clickTimer);
    if (menuIsOpen()) {        // erster Tipp schließt nur das Menü
      closeMenu();
      return;
    }
    clickTimer = setTimeout(function () {
      // Ein Modul (z. B. die Routenplanung) kann Kartentipps übernehmen
      if (mapClickHandler) mapClickHandler(e);
      else queryFeatureInfo(e.latlng);
    }, 300);
  });
  map.on("dblclick zoomstart", function () { clearTimeout(clickTimer); });

  // ---------- Ansicht merken ----------

  var saveTimer = null;
  function saveView() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var c = map.getCenter();
      storageSet({ center: [c.lat, c.lng], zoom: map.getZoom(), layer: activeId, overlays: Object.keys(activeOverlays) });
    }, 300);
  }
  map.on("moveend", saveView);

  // ---------- Eigene Position ----------

  var locateBtn = document.getElementById("locate-btn");
  var posMarker = null;
  var accCircle = null;
  var lastPos = null;
  var following = false;
  var hadFix = false;

  var userMoved = false;   // hat die Karte vor dem ersten GPS-Fix selbst bewegt/gezoomt

  function setFollowing(on) {
    following = on;
    locateBtn.classList.toggle("following", on);
    // Im Folgemodus um die Bildmitte (= eigene Position) zoomen, sonst um Finger/Mausposition.
    // So springt die Karte nach dem Zoomen nicht zur Position zurück.
    var mode = on ? "center" : true;
    map.options.touchZoom = mode;
    map.options.doubleClickZoom = mode;
    map.options.scrollWheelZoom = mode;
  }

  function stopFollowing() {
    userMoved = true;
    setFollowing(false);
  }

  // Wer die Karte selbst verschiebt, will nicht zurückgezogen werden
  map.on("dragstart", stopFollowing);

  var positionListeners = [];

  function onPosition(pos) {
    positionListeners.forEach(function (fn) {
      try { fn(pos); } catch (e) { console.warn("[GoAhead] Positions-Empfänger:", e); }
    });
    var latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);
    var acc = pos.coords.accuracy;
    lastPos = latlng;
    locateBtn.classList.remove("waiting");

    if (!posMarker) {
      posMarker = L.marker(latlng, {
        icon: L.divIcon({ className: "", html: '<div class="pos-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000
      }).addTo(map);
      accCircle = L.circle(latlng, {
        radius: acc,
        interactive: false,
        color: "#1f5fbf",
        weight: 1,
        fillColor: "#1f5fbf",
        fillOpacity: 0.12
      }).addTo(map);
    } else {
      posMarker.setLatLng(latlng);
      accCircle.setLatLng(latlng).setRadius(acc);
    }

    if (!hadFix) {
      hadFix = true;
      hideStatus();
      // Hat man die Karte schon selbst bewegt (z. B. auf einen Track gezoomt), nicht wegspringen
      if (!userMoved) {
        setFollowing(true);
        map.setView(latlng, Math.max(map.getZoom(), cfg.locateZoom), { animate: false });
      }
    } else if (following) {
      map.panTo(latlng, { animate: true });
    }
  }

  function onPositionError(err) {
    locateBtn.classList.remove("waiting");
    if (err.code === 1) {
      showStatus("Standortzugriff verweigert. Bitte in den Browser-/Systemeinstellungen erlauben.");
    } else if (err.code === 2) {
      showStatus("Position derzeit nicht verfügbar (kein GPS-Empfang?).", 6000);
    } else if (err.code === 3 && !hadFix) {
      showStatus("Suche GPS-Position …");
    }
  }

  var watchId = null;
  function startWatching() {
    if (!("geolocation" in navigator)) {
      showStatus("Dieses Gerät/dieser Browser unterstützt keine Standortbestimmung.");
      return;
    }
    if (!window.isSecureContext) {
      showStatus("Standort nur über HTTPS verfügbar.");
      return;
    }
    if (watchId !== null) return;
    locateBtn.classList.add("waiting");
    if (!hadFix) showStatus("Suche GPS-Position …");
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 30000
    });
  }

  function stopWatching() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  locateBtn.addEventListener("click", function () {
    if (lastPos) {
      setFollowing(true);
      map.setView(lastPos, Math.max(map.getZoom(), cfg.locateZoom));
    } else {
      // Nach einer Ablehnung neu anfragen (z. B. nachdem die Erlaubnis erteilt wurde)
      stopWatching();
      startWatching();
    }
  });

  // GPS pausieren, wenn die App im Hintergrund ist (spart Akku)
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopWatching();
    } else {
      startWatching();
    }
  });

  startWatching();

  // ---------- Dialoge (statt window.prompt, das manche Browser unterdrücken) ----------

  function openDialog(buildBody) {
    var back = document.createElement("div");
    back.className = "dlg-back";
    var box = document.createElement("div");
    box.className = "dlg";
    box.setAttribute("role", "dialog");
    back.appendChild(box);
    document.body.appendChild(back);
    function close() { back.remove(); }
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    buildBody(box, close);
    return close;
  }

  // Texteingabe; ruft onOk(text) auf, bei Abbruch nichts
  function askText(title, value, onOk, okLabel) {
    openDialog(function (box, close) {
      box.innerHTML = '<div class="dlg-title"></div><input class="dlg-input" type="text">' +
        '<div class="dlg-buttons"><button type="button" class="dlg-cancel">Abbrechen</button>' +
        '<button type="button" class="dlg-ok"></button></div>';
      box.querySelector(".dlg-title").textContent = title;
      box.querySelector(".dlg-ok").textContent = okLabel || "OK";
      var input = box.querySelector(".dlg-input");
      input.value = value || "";
      box.querySelector(".dlg-cancel").addEventListener("click", close);
      function ok() { var v = input.value; close(); onOk(v); }
      box.querySelector(".dlg-ok").addEventListener("click", ok);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") ok(); });
      setTimeout(function () { input.focus(); input.select(); }, 50);
    });
  }

  // Auswahl: actions = [{label, onClick, danger, primary}]
  function actionSheet(title, subtitle, actions) {
    openDialog(function (box, close) {
      box.classList.add("dlg-sheet");
      var t = document.createElement("div");
      t.className = "dlg-title";
      t.textContent = title;
      box.appendChild(t);
      if (subtitle) {
        var st = document.createElement("div");
        st.className = "dlg-sub";
        st.textContent = subtitle;
        box.appendChild(st);
      }
      actions.concat([{ label: "Abbrechen" }]).forEach(function (a) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "dlg-action" + (a.danger ? " danger" : "") + (a.primary ? " primary" : "");
        b.textContent = a.label;
        b.addEventListener("click", function () { close(); if (a.onClick) a.onClick(); });
        box.appendChild(b);
      });
    });
  }

  // Untere Leiste in der Höhe ziehbar machen (Griff = handle; Knöpfe darin bleiben bedienbar).
  // Die Höhe wird als Anteil der Bildschirmhöhe gespeichert. onResize(px) nach jeder Änderung.
  function makeResizable(panel, handle, storageKey, onResize) {
    var minH = 64;
    function apply(px) {
      var h = Math.round(Math.max(minH, Math.min(window.innerHeight * 0.88, px)));
      panel.style.height = h + "px";
      panel.style.maxHeight = "none";
      if (onResize) onResize(h);
    }
    try {
      var f = parseFloat(window.localStorage.getItem(storageKey));
      if (f > 0 && f < 1) apply(f * window.innerHeight);
    } catch (e) { /* Standardhöhe */ }

    var dragging = false;
    var startY = 0;
    var startH = 0;
    handle.addEventListener("pointerdown", function (e) {
      if (e.target.closest("button, input, select, a")) return;
      dragging = true;
      startY = e.clientY;
      startH = panel.getBoundingClientRect().height;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener("pointermove", function (e) {
      if (dragging) apply(startH + (startY - e.clientY));
    });
    function end() {
      if (!dragging) return;
      dragging = false;
      var h = panel.getBoundingClientRect().height;
      try { window.localStorage.setItem(storageKey, String(h / window.innerHeight)); } catch (err) { /* egal */ }
    }
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  // ---------- Symbole für Knöpfe (einheitlicher Strich-Stil) ----------
  var ICONS = {
    save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    roundtrip: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
    hiking: '<path d="M3 20l6-10 4 6 2-3 6 7z"/>',
    road: '<path d="M8 3L5 21M16 3l3 18M12 4v3M12 11v3M12 18v2"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
    locate: '<circle cx="12" cy="12" r="3.5" fill="currentColor"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chart: '<path d="M3 20h18"/><path d="M4 16l5-6 4 3 7-8"/>',
    share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>'
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
  }

  // ---------- Tooltips per langem Druck (Touch zeigt title-Texte sonst nicht an) ----------
  (function () {
    var tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    document.body.appendChild(tip);
    var timer = null;
    var shown = false;
    var startX = 0;
    var startY = 0;
    function hide() {
      clearTimeout(timer);
      tip.hidden = true;
    }
    document.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "touch") return;
      var el = e.target.closest("button[title], a[title]");
      if (!el) return;
      shown = false;
      startX = e.clientX;
      startY = e.clientY;
      clearTimeout(timer);
      timer = setTimeout(function () {
        tip.textContent = el.getAttribute("title");
        tip.hidden = false;
        var r = el.getBoundingClientRect();
        var w = tip.offsetWidth;
        var x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
        var y = r.top - tip.offsetHeight - 8;
        if (y < 8) y = r.bottom + 8;
        tip.style.left = x + "px";
        tip.style.top = y + "px";
        shown = true;
        setTimeout(hide, 1800);
      }, 450);
    }, true);
    document.addEventListener("pointermove", function (e) {
      if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) clearTimeout(timer);
    }, true);
    document.addEventListener("pointerup", function () { clearTimeout(timer); }, true);
    document.addEventListener("pointercancel", hide, true);
    // nach angezeigtem Tooltip den Knopf nicht auslösen
    document.addEventListener("click", function (e) {
      if (shown) {
        shown = false;
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
    document.addEventListener("contextmenu", function (e) {
      if (e.target.closest("button[title], a[title]")) e.preventDefault();
    });
  })();

  // GPX mit Begleittext teilen (z. B. an WhatsApp über das Teilen-Menü des Systems).
  // Chrome lässt beim Teilen nur bestimmte Dateitypen zu – .gpx gehört nicht dazu
  // (geprüft im Chromium-Quelltext chrome/browser/webshare/share_service_impl.cc: Endung UND
  // MIME-Typ müssen auf der Liste stehen; .txt/text/plain ja, .gpx nein). Dann Ausweichwege anbieten.
  function shareGpx(fileName, gpxText, title, detailText) {
    function tryShare(file) {
      var data = { title: title, text: detailText };
      if (file) data.files = [file];
      return navigator.share(data).catch(function (err) {
        if (err && err.name === "AbortError") return;   // vom Nutzer abgebrochen
        showStatus("Teilen fehlgeschlagen: " + (err && err.message || err), 6000);
      });
    }
    if (!navigator.share) {
      downloadFile(fileName, gpxText, "application/gpx+xml");
      showStatus("Teilen wird von diesem Browser nicht unterstützt – GPX wurde heruntergeladen.", 6000);
      return;
    }
    var gpxFile = null;
    try { gpxFile = new File([gpxText], fileName, { type: "application/gpx+xml" }); } catch (e) { /* alte Browser */ }
    if (gpxFile && navigator.canShare && navigator.canShare({ files: [gpxFile] })) {
      tryShare(gpxFile);
      return;
    }
    var txtFile = null;
    try { txtFile = new File([gpxText], fileName + ".txt", { type: "text/plain" }); } catch (e) { /* alte Browser */ }
    var canTxt = txtFile && navigator.canShare && navigator.canShare({ files: [txtFile] });
    var actions = [];
    if (canTxt) {
      actions.push({ label: "Als „" + fileName + ".txt“ teilen", primary: true, onClick: function () { tryShare(txtFile); } });
    }
    actions.push({ label: "GPX herunterladen und Text teilen", onClick: function () {
      downloadFile(fileName, gpxText, "application/gpx+xml");
      tryShare(null);
    } });
    actionSheet("GPX-Datei teilen", "Dieser Browser erlaubt keine .gpx-Dateien beim Teilen." +
      (canTxt ? " Als .txt kommt sie an – zum Öffnen „.txt“ entfernen (GoAhead liest sie auch so)." : ""), actions);
  }

  function downloadFile(fileName, text, mime) {
    var blob = new Blob([text], { type: mime || "application/octet-stream" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- Schnittstelle für weitere Module (z. B. tracks.js) ----------

  window.GOAHEAD = {
    map: map,
    showStatus: showStatus,
    escapeHtml: escapeHtml,
    stopFollowing: stopFollowing,
    addToToolbar: addToToolbar,
    closeMenu: closeMenu,
    openMenu: openMenu,
    setMapClickHandler: setMapClickHandler,
    closeInfoPanel: function () { infoRequest++; closeInfoPanel(); },
    getPosition: function () { return lastPos; },
    onPosition: function (fn) { positionListeners.push(fn); },
    // Folgemodus einschalten und auf die eigene Position zentrieren
    follow: function () {
      setFollowing(true);
      if (lastPos) map.setView(lastPos, Math.max(map.getZoom(), cfg.locateZoom));
      startWatching();
    },
    askText: askText,
    actionSheet: actionSheet,
    downloadFile: downloadFile,
    makeResizable: makeResizable,
    getSettings: function () { return settings; },
    onSettingsChange: function (fn) { settingsListeners.push(fn); },
    shareGpx: shareGpx,
    icon: icon
  };

  // ---------- Service Worker (App-Hülle offline verfügbar) ----------

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function (e) {
        console.info("[GoAhead] Service Worker nicht registriert:", e.message);
      });
    });
  }
})();
