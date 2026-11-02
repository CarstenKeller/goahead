/* GoAhead – Wanderkarte für Wegemarkierer
 * Schritt 1: Karte mit eigener Position, Zoomen/Verschieben per Gesten.
 */
(function () {
  "use strict";

  var cfg = window.GOAHEAD_CONFIG;
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
    zoomControl: true,
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

  L.control.layers(baseEntries, overlayEntries, { position: "topright", collapsed: true }).addTo(map);

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
  new SizeControl().addTo(map);
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
      var entry = { name: null, title: null, leaf: true };
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
    return { layers: result, crs: Object.keys(crs) };
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
  if (/[?&]diagnose\b/.test(window.location.search)) {
    Promise.all(capsChecks).then(showDiagnostics);
  }

  function showDiagnostics() {
    var lines = [];
    Object.keys(diagnostics).forEach(function (id) {
      var d = diagnostics[id];
      lines.push("■ " + d.name);
      lines.push("  Dienst: " + d.url);
      lines.push("  Capabilities: " + d.state);
      lines.push("  eingetragen: " + d.configured + "  →  verwendet: " + d.used);
      if (d.layers) {
        lines.push("  EPSG:3857: " + (d.has3857 ? "ja" : "NEIN"));
        lines.push("  Layer (Name – Titel):");
        d.layers.forEach(function (l) {
          lines.push("    " + (l.name || "–") + " – " + (l.title || ""));
        });
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

  function setFollowing(on) {
    following = on;
    locateBtn.classList.toggle("following", on);
  }

  // Wer die Karte selbst verschiebt, will nicht zurückgezogen werden
  map.on("dragstart", function () { setFollowing(false); });

  function onPosition(pos) {
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
      setFollowing(true);
      map.setView(latlng, Math.max(map.getZoom(), cfg.locateZoom), { animate: false });
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

  // ---------- Service Worker (App-Hülle offline verfügbar) ----------

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function (e) {
        console.info("[GoAhead] Service Worker nicht registriert:", e.message);
      });
    });
  }
})();
