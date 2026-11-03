/* GoAhead – Kartenmosaik: eine Hintergrundkarte aus mehreren Diensten, je nach Gebiet.
 *
 * Jede Kachel wird auf einer Leinwand (canvas) aus den Quellen zusammengesetzt, die an dieser
 * Stelle gelten: von der allgemeinsten (z. B. OpenTopoMap weltweit) bis zur genauesten (z. B.
 * DTK NRW nur in NRW). Quellen mit Gebiet (region) werden an dessen Grenze zugeschnitten
 * (Grenzen aus regions.js). Liegt eine Kachel ganz in einem Gebiet, wird darunter nichts geladen.
 *
 * Bilder werden ohne CORS-Anforderung geladen (die Leinwand wird nur angezeigt, nie ausgelesen) –
 * so funktioniert die Anzeige auch bei Diensten ohne CORS. Offline-Kacheln liefert der Service Worker.
 *
 * Quelle (config.js): { id, name, kind: "xyz"|"wms", url, layers, version, format,
 *   region: ["NW", …] (fehlt = überall), minZoom, maxNativeZoom, attribution, pad2 }
 *   xyz: Vorlage mit {z} {x} {y} (pad2: Zoomstufe zweistellig, z. B. "05" – TopPlusOpen/basemap.de)
 */
(function () {
  "use strict";

  var REG = window.GOAHEAD_REGIONS || {};
  var TS = 256;

  // Gebiete vorbereiten: Ringe mit Umrissrechteck
  var regions = {};
  Object.keys(REG).forEach(function (code) {
    regions[code] = REG[code].map(function (ring) {
      var b = [Infinity, Infinity, -Infinity, -Infinity];
      ring.forEach(function (p) {
        if (p[0] < b[0]) b[0] = p[0];
        if (p[1] < b[1]) b[1] = p[1];
        if (p[0] > b[2]) b[2] = p[0];
        if (p[1] > b[3]) b[3] = p[1];
      });
      return { pts: ring, bbox: b };
    });
  });

  function inRing(lon, lat, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function overlaps(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }

  // Lage eines Rechtecks [w, s, e, n] zu Gebieten: 0 = außerhalb, 1 = teilweise, 2 = ganz innen
  function classify(codes, bb) {
    var rings = [];
    codes.forEach(function (c) { (regions[c] || []).forEach(function (r) { if (overlaps(r.bbox, bb)) rings.push(r); }); });
    if (!rings.length) return { cls: 0, rings: rings };
    var corners = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]];
    var inside = 0;
    corners.forEach(function (c) {
      for (var i = 0; i < rings.length; i++) if (inRing(c[0], c[1], rings[i].pts)) { inside++; return; }
    });
    // Grenzpunkt innerhalb des Rechtecks? Dann verläuft eine Grenze hindurch
    var vertexInside = rings.some(function (r) {
      return r.pts.some(function (p) { return p[0] > bb[0] && p[0] < bb[2] && p[1] > bb[1] && p[1] < bb[3]; });
    });
    if (inside === corners.length && !vertexInside) return { cls: 2, rings: rings };
    if (inside === 0 && !vertexInside) return { cls: 0, rings: rings };
    return { cls: 1, rings: rings };
  }

  function srcApplies(src, z) {
    return (src.minZoom == null || z >= src.minZoom) && (src.maxZoom == null || z <= src.maxZoom);
  }

  // Quellen, die für das Rechteck bb in Zoomstufe z gebraucht werden (unten → oben), mit Zuschnitt
  function needed(sources, bb, z) {
    var out = [];
    for (var i = sources.length - 1; i >= 0; i--) {
      var s = sources[i];
      if (!srcApplies(s, z)) continue;
      if (!s.region) { out.unshift({ src: s, clip: null }); break; }
      var c = classify(s.region, bb);
      if (c.cls === 0) continue;
      out.unshift({ src: s, clip: c.cls === 2 ? null : c.rings });
      if (c.cls === 2) break;
    }
    return out;
  }

  function pad(z, two) { return two && z < 10 ? "0" + z : String(z); }

  // Adresse der Quelle für Kachel x/y/z; bei Überzoom die Elternkachel und der Ausschnitt darin
  function sourceTile(src, x, y, z) {
    var sub = null;
    if (src.kind !== "wms" && src.maxNativeZoom != null && z > src.maxNativeZoom) {
      var d = z - src.maxNativeZoom;
      var f = Math.pow(2, d);
      sub = { sx: (x % f) * TS / f, sy: (y % f) * TS / f, sw: TS / f };
      x = Math.floor(x / f);
      y = Math.floor(y / f);
      z = src.maxNativeZoom;
    }
    var url;
    if (src.kind === "wms") {
      var r = 20037508.342789244;
      var s = 2 * r / Math.pow(2, z);
      var minx = -r + x * s, maxy = r - y * s;
      var v = src.version || "1.3.0";
      url = src.url + (src.url.indexOf("?") < 0 ? "?" : "&") +
        "SERVICE=WMS&VERSION=" + v + "&REQUEST=GetMap&LAYERS=" + encodeURIComponent(src.layers) +
        "&STYLES=&" + (v === "1.3.0" ? "CRS" : "SRS") + "=EPSG:3857&BBOX=" +
        [minx, maxy - s, minx + s, maxy].map(function (n) { return n.toFixed(2); }).join(",") +
        "&WIDTH=" + TS + "&HEIGHT=" + TS + "&FORMAT=" + encodeURIComponent(src.format || "image/jpeg");
    } else {
      var subs = src.subdomains || "abc";
      url = src.url.replace("{s}", subs[Math.abs(x + y) % subs.length])
        .replace("{z}", pad(z, src.pad2)).replace("{x}", x).replace("{y}", y);
    }
    return { url: url, sub: sub };
  }

  function tileBounds(x, y, z) {
    var n = Math.pow(2, z);
    function lon(px) { return px / n * 360 - 180; }
    function lat(py) { var t = Math.PI - 2 * Math.PI * py / n; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t))); }
    return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
  }

  var MosaicLayer = L.GridLayer.extend({
    options: { tileSize: TS, updateWhenIdle: false, keepBuffer: 2, className: "goahead-mosaic" },

    initialize: function (def, options) {
      this._def = def;
      L.GridLayer.prototype.initialize.call(this, L.extend({ maxZoom: def.maxZoom || 20 }, options));
      this._attr = "";
    },

    // Adressen aller Bilder einer Kachel (für offline.js): [{url, name}]
    urlsForTile: function (x, y, z) {
      var bb = tileBounds(x, y, z);
      return needed(this._def.sources, bb, z).map(function (n) {
        return { url: sourceTile(n.src, x, y, z).url, name: n.src.name };
      });
    },

    // Quellen im Kartenausschnitt (für Quellenangabe und Anzeige)
    sourcesIn: function (bounds, z) {
      var bb = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      var seen = {};
      var list = [];
      // grob: jede Quelle, deren Gebiet den Ausschnitt berührt; die unterste allgemeine nur, wenn nötig
      needed(this._def.sources, bb, Math.round(z)).forEach(function (n) {
        if (!seen[n.src.id]) { seen[n.src.id] = true; list.push(n.src); }
      });
      return list;
    },

    onAdd: function (map) {
      L.GridLayer.prototype.onAdd.call(this, map);
      map.on("moveend zoomend", this._updateAttribution, this);
      this._updateAttribution();
    },

    onRemove: function (map) {
      map.off("moveend zoomend", this._updateAttribution, this);
      if (map.attributionControl && this._attr) map.attributionControl.removeAttribution(this._attr);
      this._attr = "";
      L.GridLayer.prototype.onRemove.call(this, map);
    },

    // Quellenangabe verwaltet die Ebene selbst (je nach Ausschnitt), nicht über Leaflets layeradd
    getAttribution: function () { return null; },

    _updateAttribution: function () {
      var map = this._map;
      if (!map || !map.attributionControl) return;
      var txt = this.sourcesIn(map.getBounds(), map.getZoom())
        .map(function (s) { return s.attribution; }).filter(Boolean).join(" | ");
      if (txt === this._attr) return;
      if (this._attr) map.attributionControl.removeAttribution(this._attr);
      this._attr = txt;
      if (txt) map.attributionControl.addAttribution(txt);
    },

    createTile: function (coords, done) {
      var canvas = document.createElement("canvas");
      canvas.width = TS;
      canvas.height = TS;
      var x = coords.x, y = coords.y, z = coords.z;
      var n = Math.pow(2, z);
      x = ((x % n) + n) % n;   // über die Datumsgrenze
      if (y < 0 || y >= n) { setTimeout(function () { done(null, canvas); }, 0); return canvas; }
      var bb = tileBounds(x, y, z);
      var list = needed(this._def.sources, bb, z);
      if (!list.length) { setTimeout(function () { done(null, canvas); }, 0); return canvas; }
      var ctx = canvas.getContext("2d");
      var imgs = [];
      var left = list.length;
      var ok = 0;
      var finished = false;
      var timer = setTimeout(finish, 25000);
      function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // in Reihenfolge zeichnen (unten → oben), jede Quelle an ihrem Gebiet zugeschnitten
        list.forEach(function (item, i) {
          var im = imgs[i];
          if (!im || !im.ok) return;
          ctx.save();
          if (item.clip) {
            ctx.beginPath();
            item.clip.forEach(function (r) {
              r.pts.forEach(function (p, k) {
                var px = (p[0] + 180) / 360 * n * TS - x * TS;
                var s = Math.sin(p[1] * Math.PI / 180);
                var py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * TS - y * TS;
                if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
              });
              ctx.closePath();
            });
            ctx.clip();
          }
          var t = im.tile;
          if (t.sub) ctx.drawImage(im.el, t.sub.sx, t.sub.sy, t.sub.sw, t.sub.sw, 0, 0, TS, TS);
          else ctx.drawImage(im.el, 0, 0, TS, TS);
          ctx.restore();
        });
        done(ok ? null : new Error("Keine Quelle lieferte ein Bild"), canvas);
      }
      list.forEach(function (item, i) {
        var t = sourceTile(item.src, x, y, z);
        var el = new Image();
        var rec = { el: el, tile: t, ok: false };
        imgs[i] = rec;
        el.onload = function () { rec.ok = true; ok++; if (--left === 0) finish(); };
        el.onerror = function () { if (--left === 0) finish(); };
        el.src = t.url;
      });
      return canvas;
    }
  });

  window.GOAHEAD_MOSAIC = {
    Layer: MosaicLayer,
    classify: classify,
    needed: needed,
    sourceTile: sourceTile,
    tileBounds: tileBounds,
    // Umrissrechteck von Gebieten als L.LatLngBounds (z. B. für Overlays, die nur dort Inhalt haben)
    regionBounds: function (codes) {
      var b = null;
      codes.forEach(function (c) {
        (regions[c] || []).forEach(function (r) {
          var rb = L.latLngBounds([r.bbox[1], r.bbox[0]], [r.bbox[3], r.bbox[2]]);
          if (b) b.extend(rb); else b = rb;
        });
      });
      return b;
    },
    // Liegt ein Punkt in einem der Gebiete?
    inRegion: function (codes, lat, lon) {
      return codes.some(function (c) {
        return (regions[c] || []).some(function (r) {
          return lon >= r.bbox[0] && lon <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3] && inRing(lon, lat, r.pts);
        });
      });
    }
  };
})();
