/* GoAhead – Tour und Stand mit der Begleitung teilen (ohne Server).
 *
 * Geteilt wird ein Text mit einem Link: https://…/goahead/#g=<Daten>. Die Daten sind JSON, mit deflate gepackt
 * (CompressionStream „deflate-raw“, Chrome ab 80, Safari ab 16.4) und base64url-kodiert. Linien werden vorher
 * vereinfacht (Douglas-Peucker, 5 m) und als Polyline-Zeichenkette (Verfahren wie Google Encoded Polyline,
 * hier mit Höhe als drittem Wert) abgelegt.
 *
 * Empfang:
 *  - Link antippen → GoAhead öffnet und übernimmt (Seite mit #g=…).
 *  - Auf dem iPhone landet ein Link aus WhatsApp in Safari, nicht in der Web-App auf dem Home-Bildschirm
 *    (eigener Speicher – nach Kenntnisstand, ungeprüft). Deshalb: Nachricht kopieren und in GoAhead
 *    „Einfügen“ (Menü bzw. Knopf beim Begleiten) – liest die Zwischenablage, sonst Eingabefeld.
 *
 * Arten: "tour" (geplante Route) und "stand" (laufende Aufzeichnung: Route, Start, km, Zeit, gelaufene Spur).
 */
(function () {
  "use strict";

  var G = window.GOAHEAD;
  if (!G || !G.map) return;

  var BASE = location.origin + location.pathname.replace(/index\.html$/, "");
  var SIMPLIFY_M = 5;

  // ---------- Polyline mit Höhe ----------

  function encNum(v, out) {
    v = v < 0 ? ~(v << 1) : (v << 1);
    while (v >= 0x20) { out.push(String.fromCharCode((0x20 | (v & 0x1f)) + 63)); v >>= 5; }
    out.push(String.fromCharCode(v + 63));
  }
  // pts: [[lat, lng, ele|null, …]] → Text; Höhe in ganzen Metern (fehlende Höhe = -9999)
  function encode(pts) {
    var out = [];
    var pl = 0, pg = 0, pe = 0;
    pts.forEach(function (p) {
      var la = Math.round(p[0] * 1e5), lg = Math.round(p[1] * 1e5);
      var e = p[2] == null ? -9999 : Math.round(p[2]);
      encNum(la - pl, out); encNum(lg - pg, out); encNum(e - pe, out);
      pl = la; pg = lg; pe = e;
    });
    return out.join("");
  }
  function decode(str) {
    var pts = [];
    var i = 0, vals = [0, 0, 0];
    while (i < str.length) {
      for (var k = 0; k < 3; k++) {
        var shift = 0, res = 0, b;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length + 1);
        vals[k] += (res & 1) ? ~(res >> 1) : (res >> 1);
      }
      pts.push([vals[0] / 1e5, vals[1] / 1e5, vals[2] === -9999 ? null : vals[2]]);
    }
    return pts;
  }

  // ---------- Vereinfachen (Douglas-Peucker, Meter über einfache Projektion) ----------

  function simplify(pts, tol) {
    if (pts.length < 3) return pts.slice();
    var lat0 = pts[0][0] * Math.PI / 180;
    var kx = 111320 * Math.cos(lat0), ky = 110540;
    var xy = pts.map(function (p) { return [p[1] * kx, p[0] * ky]; });
    var keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var r = stack.pop(), a = r[0], b = r[1];
      var ax = xy[a][0], ay = xy[a][1], dx = xy[b][0] - ax, dy = xy[b][1] - ay;
      var len2 = dx * dx + dy * dy, best = -1, bd = tol;
      for (var i = a + 1; i < b; i++) {
        var t = len2 ? ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        var ex = xy[i][0] - (ax + t * dx), ey = xy[i][1] - (ay + t * dy);
        var d = Math.sqrt(ex * ex + ey * ey);
        if (d > bd) { bd = d; best = i; }
      }
      if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    return pts.filter(function (p, i) { return keep[i]; });
  }

  // ---------- Packen ----------

  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64url(str) {
    var s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
  function pipe(bytes, stream) {
    return new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  // Ergebnis: "1" + gepackt bzw. "0" + ungepackt (Browser ohne CompressionStream)
  function pack(obj) {
    var raw = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream === "undefined") return Promise.resolve("0" + b64url(raw));
    return pipe(raw, new CompressionStream("deflate-raw")).then(function (b) { return "1" + b64url(b); });
  }
  function unpack(str) {
    var kind = str.charAt(0);
    var bytes = unb64url(str.slice(1));
    var p = kind === "1"
      ? (typeof DecompressionStream === "undefined"
        ? Promise.reject(new Error("Dieser Browser kann den Stand nicht entpacken (zu alt)."))
        : pipe(bytes, new DecompressionStream("deflate-raw")))
      : Promise.resolve(bytes);
    return p.then(function (b) { return JSON.parse(new TextDecoder().decode(b)); });
  }

  // Route (planner-Format) → kompakt und zurück
  function packRoute(r) {
    function seg(s) { return s ? { l: encode(simplify(s.latlngs, SIMPLIFY_M)), m: s.mode || "route", d: Math.round(s.distance || 0) } : null; }
    return {
      p: encode((r.points || []).map(function (q) { return [q.lat, q.lng, null]; })),
      s: (r.segments || []).map(seg),
      c: r.roundtrip && r.closing ? seg(r.closing) : null,
      rt: !!r.roundtrip
    };
  }
  function unpackRoute(o) {
    function seg(s) {
      if (!s) return null;
      var ll = decode(s.l).map(function (p) { return p[2] == null ? [p[0], p[1]] : p; });
      return { latlngs: ll, mode: s.m, distance: s.d, source: s.m === "line" ? "direkt" : "geteilt" };
    }
    return {
      points: decode(o.p).map(function (p) { return { lat: p[0], lng: p[1] }; }),
      segments: (o.s || []).map(seg),
      closing: o.rt && o.c ? seg(o.c) : null,
      roundtrip: !!o.rt
    };
  }

  // ---------- Teilen ----------

  function shareText(title, text) {
    if (G.native && G.native.call("shareText", title, text) === true) return;
    if (!G.native && navigator.share) {
      navigator.share({ title: title, text: text }).catch(function (err) {
        if (!err || err.name !== "AbortError") copy(text);
      });
      return;
    }
    copy(text);
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        G.showStatus("In die Zwischenablage kopiert – in WhatsApp einfügen und senden.", 6000);
      }, function () { G.askText("Text zum Teilen (kopieren)", text, function () {}, "Fertig"); });
    } else {
      G.askText("Text zum Teilen (kopieren)", text, function () {}, "Fertig");
    }
  }

  function km(m) { return (m / 1000).toFixed(1).replace(".", ","); }

  // geplante Tour teilen
  function tour(rec) {
    pack({ v: 1, t: "tour", id: rec.id, n: rec.name, r: packRoute(rec), len: rec.stats && rec.stats.length }).then(function (data) {
      shareText("GoAhead: " + rec.name, "GoAhead-Tour „" + rec.name + "“ (" + km((rec.stats && rec.stats.length) || 0) + " km)\n" + BASE + "#g=" + data);
    }).catch(function (err) { G.showStatus("Teilen fehlgeschlagen: " + (err.message || err), 6000); });
  }

  // Stand einer laufenden Aufzeichnung teilen
  function stand(st) {
    if (!st.route) { G.showStatus("Stand teilen geht nur bei Touren mit geplanter Route.", 5000); return; }
    var track = (st.track || []).map(function (sg) { return encode(simplify(sg, SIMPLIFY_M)); });
    pack({ v: 1, t: "stand", id: st.routeId, n: st.name, r: packRoute(st.route), rev: st.reversed,
      s0: st.startedAt, at: st.at, km: Math.round(st.dist), mv: st.moving, dr: st.dRoute == null ? null : Math.round(st.dRoute), tr: track
    }).then(function (data) {
      var d = new Date(st.at);
      shareText("GoAhead: Stand " + st.name, "GoAhead-Stand „" + st.name + "“ " + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes() +
        " Uhr – " + km(st.dist) + " km gewandert\n" + BASE + "#g=" + data);
    }).catch(function (err) { G.showStatus("Teilen fehlgeschlagen: " + (err.message || err), 6000); });
  }

  // ---------- Empfangen ----------

  function extract(text) {
    var m = /#g=([0-9A-Za-z_-]+)/.exec(String(text || ""));
    return m ? m[1] : null;
  }

  // Route unter „Geplant“ ablegen bzw. aktualisieren (Kennung „geteilt:<id>“)
  function storeRoute(o) {
    var r = unpackRoute(o.r);
    var id = "shared-" + o.id;
    var now = new Date().toISOString();
    var rec = { id: id, name: o.n, createdAt: now, updatedAt: now, points: r.points, segments: r.segments,
      roundtrip: r.roundtrip, closing: r.closing, profile: "hiking", sharedFrom: o.id };
    var t = G.planner && G.planner.routeStats ? G.planner.routeStats(rec) : null;
    rec.stats = { length: t ? t.dist : (o.len || 0), ascent: t ? t.up : null, descent: t ? t.down : null, hours: t ? t.hours : null, points: r.points.length, lines: 0 };
    return G.db.put("routes", rec).then(function () {
      window.dispatchEvent(new Event("goahead:data"));
      return rec;
    });
  }

  function receive(data) {
    return unpack(data).then(function (o) {
      if (!o || (o.t !== "tour" && o.t !== "stand")) throw new Error("unbekannte Daten");
      return storeRoute(o).then(function (rec) {
        if (o.t === "tour") {
          G.actionSheet("Tour „" + rec.name + "“ übernommen", km(rec.stats.length) + " km · unter „Geplant“ gespeichert", [
            { label: "👥 Begleiten", primary: true, onClick: function () { G.nav.startCompanion(rec); } },
            { label: "👁 Ansehen", onClick: function () { G.openTracksPage("planned"); } }
          ]);
          return;
        }
        var route = unpackRoute(o.r);
        G.nav.applyStand({
          route: route, reversed: o.rev, startedAt: o.s0, at: o.at, dist: o.km, moving: o.mv, dRoute: o.dr,
          track: (o.tr || []).map(decode).map(function (sg) { return sg.map(function (p) { return [p[0], p[1], p[2], null]; }); })
        }, rec);
      });
    }).catch(function (err) {
      G.showStatus("Geteilte Daten nicht lesbar: " + (err.message || err), 8000);
    });
  }

  // Einfügen: Zwischenablage lesen (iPhone fragt kurz nach), sonst Eingabefeld
  function paste() {
    function fromText(t) {
      var d = extract(t);
      if (!d) { G.showStatus("Kein GoAhead-Link gefunden. Bitte die ganze Nachricht kopieren.", 6000); return; }
      receive(d);
    }
    function ask() { G.askText("Nachricht einfügen", "", fromText, "Übernehmen"); }
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) { if (extract(t)) fromText(t); else ask(); }, ask);
    } else {
      ask();
    }
  }

  // Seite mit #g=… geöffnet
  function fromHash() {
    var d = extract(location.hash);
    if (!d) return;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* egal */ }
    setTimeout(function () { receive(d); }, 800);
  }
  window.addEventListener("hashchange", fromHash);
  fromHash();

  // Menü: „Einfügen“
  var PasteControl = L.Control.extend({
    onAdd: function () {
      var box = L.DomUtil.create("div", "leaflet-bar paste-control");
      var btn = L.DomUtil.create("a", "paste-toggle", box);
      btn.href = "#";
      btn.setAttribute("role", "button");
      btn.title = "Geteilte Tour oder Stand einfügen";
      btn.setAttribute("aria-label", btn.title);
      btn.innerHTML = G.icon("paste");
      L.DomEvent.on(btn, "click", function (e) { L.DomEvent.preventDefault(e); if (G.closeMenu) G.closeMenu(); paste(); });
      L.DomEvent.disableClickPropagation(box);
      return box;
    }
  });
  if (G.addToToolbar) G.addToToolbar(new PasteControl());

  G.share = { tour: tour, stand: stand, paste: paste, receive: receive, _encode: encode, _decode: decode, _pack: pack, _unpack: unpack };
})();
