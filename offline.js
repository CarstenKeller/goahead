/* GoAhead – Kartenkacheln entlang einer Route offline speichern.
 *
 * - Gespeichert werden die Kacheln aller gerade sichtbaren Kartenebenen (Hintergrund und
 *   Overlays; bei Mosaiken die Dienste, die entlang der Route gelten) in den Zoomstufen ZOOMS, in einem Korridor mit dem eingestellten Abstand
 *   (Einstellung „Karten offline um die Route“, km) um die Route.
 * - Die Kachel-Adressen erzeugt Leaflet selbst (layer.getTileUrl), damit sie exakt den
 *   Anfragen der Karte entsprechen. Der Service Worker (sw.js) liefert sie aus dem Cache
 *   TILE_CACHE, auch ohne Netz.
 * - Geladen wird mit CORS (fetch mode "cors"): Die NRW-Dienste erlauben das (per ?diagnose
 *   geprüft). Ebenen, die kein CORS erlauben, werden erkannt und übersprungen – sonst würden
 *   „undurchsichtige“ Antworten im Browser-Speicher stark überbewertet.
 * - Ohne Empfang wird alle RETRY_MS erneut versucht (und sofort, wenn das Netz zurückkommt),
 *   bis alles gespeichert ist oder die Tour endet.
 */
(function () {
  "use strict";

  var G = window.GOAHEAD;
  if (!G || !G.map) return;
  var map = G.map;

  var TILE_CACHE = "goahead-tiles-v1";   // gleicher Name wie in sw.js
  var ZOOMS = [12, 13, 14, 15, 16, 17];
  var RETRY_MS = 30000;
  var PARALLEL = 4;

  // Kachel-Adresse für Kachel x/y in Raster-Zoomstufe z, wie Leaflet sie anfordern würde
  function tileUrl(layer, x, y, z) {
    var coords = L.point(x, y);
    coords.z = z;
    var saved = layer._tileZoom;
    layer._tileZoom = z;   // XYZ-Ebenen nehmen die Zoomstufe der URL aus _tileZoom
    try {
      return layer.getTileUrl(coords);
    } finally {
      layer._tileZoom = saved;
    }
  }

  function metersPerPixel(lat, z) {
    return 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, z));
  }

  // alle Kachel-Adressen einer Ebene im Korridor um die Linie
  function corridorUrls(layer, latlngs, bufferM) {
    var urls = {};
    var ts = layer.getTileSize().x;
    ZOOMS.forEach(function (zoom) {
      var z = layer._clampZoom ? layer._clampZoom(zoom) : zoom;
      if (layer.options.minZoom != null && zoom < layer.options.minZoom) return;
      if (layer.options.maxZoom != null && zoom > layer.options.maxZoom) return;
      var seen = {};
      // Linie so dicht abtasten, dass keine Kachel übersprungen wird
      var stepM = Math.max(10, Math.min(bufferM, metersPerPixel(latlngs[0][0], z) * ts / 2));
      for (var i = 0; i < latlngs.length; i++) {
        var a = L.latLng(latlngs[i][0], latlngs[i][1]);
        var b = i + 1 < latlngs.length ? L.latLng(latlngs[i + 1][0], latlngs[i + 1][1]) : a;
        var n = Math.max(1, Math.ceil(a.distanceTo(b) / stepM));
        for (var k = 0; k < n; k++) {
          var t = k / n;
          var p = L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t);
          var px = map.project(p, z);
          var r = bufferM / metersPerPixel(p.lat, z);
          var x0 = Math.floor((px.x - r) / ts);
          var x1 = Math.floor((px.x + r) / ts);
          var y0 = Math.floor((px.y - r) / ts);
          var y1 = Math.floor((px.y + r) / ts);
          for (var x = x0; x <= x1; x++) {
            for (var y = y0; y <= y1; y++) {
              var key = x + "/" + y;
              if (seen[key]) continue;
              seen[key] = true;
              var reg = layer._goaheadDef.region;
              if (reg && window.GOAHEAD_MOSAIC) {
                // Ebene mit Inhalt nur in einem Gebiet (z. B. TFIS NRW): Kacheln außerhalb überspringen
                var M = window.GOAHEAD_MOSAIC;
                var f = ts / 256;
                var tb = M.tileBounds(x * f, y * f, z);
                var te = M.tileBounds(x * f + f - 1, y * f + f - 1, z);
                if (M.classify(reg, [tb[0], te[1], te[2], tb[3]]).cls === 0) continue;
              }
              if (layer.urlsForTile) {
                // Mosaik: alle Quellen, die an dieser Kachel gebraucht werden (je nach Gebiet)
                layer.urlsForTile(x, y, z).forEach(function (u) { urls[u.url] = u.name; });
              } else {
                urls[tileUrl(layer, x, y, z)] = layer._goaheadDef.name;
              }
            }
          }
        }
      }
    });
    return Object.keys(urls).map(function (u) { return { url: u, name: urls[u] }; });
  }

  function visibleTileLayers() {
    var list = [];
    map.eachLayer(function (l) {
      if ((l instanceof L.TileLayer || l.urlsForTile) && l._goaheadDef) list.push(l);
    });
    return list;
  }

  /* Startet das Speichern. onUpdate(status) wird bei jedem Fortschritt aufgerufen:
   * { state: "loading"|"retry"|"done", done, total, skipped: [Ebenen-Namen] }
   * Rückgabe: { stop() } */
  function saveCorridor(latlngs, bufferKm, onUpdate) {
    var stopped = false;
    var timer = null;
    var status = { state: "loading", done: 0, total: 0, skipped: [] };
    var jobs = [];   // {url, layer}
    if (!window.caches || !latlngs || latlngs.length < 2) {
      status.state = "unsupported";
      onUpdate(status);
      return { stop: function () {} };
    }
    var bufferM = Math.max(100, bufferKm * 1000);
    visibleTileLayers().forEach(function (layer) {
      corridorUrls(layer, latlngs, bufferM).forEach(function (j) { jobs.push(j); });
    });
    status.total = jobs.length;

    function emit() { if (!stopped) onUpdate(status); }

    function fetchOne(cache, job) {
      return cache.match(job.url).then(function (hit) {
        if (hit) return true;
        return fetch(job.url, { mode: "cors" }).then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return cache.put(job.url, r).then(function () { return true; });
        });
      }).catch(function () { return false; });
    }

    function run() {
      if (stopped) return;
      status.state = "loading";
      emit();
      caches.open(TILE_CACHE).then(function (cache) {
        var pending = jobs.slice();
        var failedByLayer = {};
        var okByLayer = {};
        var done = 0;
        function worker() {
          if (stopped || !pending.length) return Promise.resolve();
          var job = pending.shift();
          return fetchOne(cache, job).then(function (ok) {
            var name = job.name;
            if (ok) { done++; okByLayer[name] = true; } else { failedByLayer[name] = (failedByLayer[name] || 0) + 1; }
            status.done = done;
            if (done % 10 === 0) emit();
            return worker();
          });
        }
        var workers = [];
        for (var i = 0; i < PARALLEL; i++) workers.push(worker());
        return Promise.all(workers).then(function () {
          if (stopped) return;
          var anyOk = Object.keys(okByLayer).length > 0;
          // Ebene ohne einzigen Erfolg, während andere klappen: vermutlich kein CORS → überspringen
          Object.keys(failedByLayer).forEach(function (name) {
            if (anyOk && !okByLayer[name] && status.skipped.indexOf(name) < 0) {
              status.skipped.push(name);
              jobs = jobs.filter(function (j) { return j.name !== name; });
            }
          });
          status.total = jobs.length;
          status.done = Math.min(done, status.total);
          if (status.done >= status.total) {
            status.state = "done";
            emit();
          } else {
            status.state = "retry";
            emit();
            timer = setTimeout(run, RETRY_MS);
          }
        });
      }).catch(function () {
        status.state = "retry";
        emit();
        timer = setTimeout(run, RETRY_MS);
      });
    }

    function onOnline() {
      if (status.state === "retry") { clearTimeout(timer); run(); }
    }
    window.addEventListener("online", onOnline);
    run();

    return {
      stop: function () {
        stopped = true;
        clearTimeout(timer);
        window.removeEventListener("online", onOnline);
      },
      status: status
    };
  }

  // gespeicherte Kacheln wieder freigeben (nach Ende der Tour)
  function clear() {
    if (window.caches) return caches.delete(TILE_CACHE);
    return Promise.resolve();
  }

  G.offline = { saveCorridor: saveCorridor, clear: clear, ZOOMS: ZOOMS };
})();
