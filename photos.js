/* GoAhead – Fotos unterwegs.
 *
 * - Aufnahme während einer Tour (Kamera-Knopf auf der Karte, nur im Unterwegs-Modus).
 * - Android-App (window.GoAheadNative.takePhoto): Die Kamera-App speichert das Bild in voller Größe in der
 *   Galerie, Album „GoAhead“ (MediaStore, Ordner Pictures/GoAhead). Die App gibt eine verkleinerte Kopie
 *   (max. 1600 px, JPEG) an diese Seite zurück (window.GOAHEAD_PHOTO_RESULT).
 * - Browser: Kamera bzw. Dateiauswahl über <input type="file" capture>. In die Galerie kann eine Web-App
 *   nicht speichern – das Bild liegt dann nur in GoAhead.
 * - Gespeichert wird in IndexedDB (Speicher "photos"): {id, walkId, lat, lng, time, blob, name, galleryUri}
 *   – walkId ist die Kennung der Tour (dieselbe wie später unter „Erwandert“).
 * - Auf der Karte: Kamera-Marker an der Aufnahmestelle; Antippen zeigt das Bild.
 */
(function () {
  "use strict";

  var G = window.GOAHEAD;

  var T = window.GOAHEAD_I18N.t;
  if (!G || !G.map) return;
  var map = G.map;
  var MAX_PX = 1600;
  var PENDING_KEY = "goahead.photoPending.v1";

  var urls = {};   // id -> Objekt-URL des Blobs
  function url(ph) {
    if (!ph) return "";
    if (!urls[ph.id] && ph.blob) urls[ph.id] = URL.createObjectURL(ph.blob);
    return urls[ph.id] || ph.dataUrl || "";
  }

  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ---------- Speicher ----------

  function all() { return G.db ? G.db.all("photos") : Promise.resolve([]); }
  function forWalk(walkId) {
    return all().then(function (list) {
      return (list || []).filter(function (p) { return p.walkId === walkId; }).sort(function (a, b) { return a.time - b.time; });
    });
  }
  function save(rec) { return G.db.put("photos", rec).then(function () { return rec; }); }
  function remove(ph) {
    if (urls[ph.id]) { URL.revokeObjectURL(urls[ph.id]); delete urls[ph.id]; }
    return G.db.del("photos", ph.id);
  }

  // ---------- Bild verkleinern (Browser) ----------

  function shrink(file) {
    var load = window.createImageBitmap
      ? createImageBitmap(file, { imageOrientation: "from-image" })
      : new Promise(function (resolve, reject) {
        var im = new Image();
        im.onload = function () { resolve(im); };
        im.onerror = reject;
        im.src = URL.createObjectURL(file);
      });
    return load.then(function (bmp) {
      var w = bmp.width, h = bmp.height;
      var f = Math.min(1, MAX_PX / Math.max(w, h));
      var c = document.createElement("canvas");
      c.width = Math.round(w * f);
      c.height = Math.round(h * f);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (resolve) { c.toBlob(resolve, "image/jpeg", 0.82); });
    });
  }

  function dataUrlToBlob(u) { return fetch(u).then(function (r) { return r.blob(); }); }

  // ---------- Aufnahme ----------

  var input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.setAttribute("capture", "environment");
  input.hidden = true;
  document.body.appendChild(input);

  var pending = null;   // {walkId, lat, lng, time, onDone}
  var listeners = [];   // fn(photo) nach jeder neuen Aufnahme

  function take(walkId) {
    var pos = G.getPosition && G.getPosition();
    if (!pos) { G.showStatus("Noch keine GPS-Position – Foto wird ohne Ort nicht zugeordnet.", 5000); return; }
    pending = { walkId: walkId, lat: pos.lat, lng: pos.lng, time: Date.now() };
    try { window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch (e) { /* egal */ }
    if (G.native && G.native.call("hasCamera") === true) {
      if (!G.native.call("takePhoto")) G.showStatus("Kamera konnte nicht geöffnet werden.", 5000);
      return;
    }
    input.value = "";
    input.click();
  }

  input.addEventListener("change", function () {
    var f = input.files && input.files[0];
    if (!f || !pending) return;
    var p = pending;
    shrink(f).then(function (blob) {
      return finish(p, blob, { name: f.name });
    }).catch(function (err) { console.warn("[GoAhead] Foto:", err); G.showStatus("Das Foto konnte nicht geöffnet werden.", 6000); });
  });

  // Rückmeldung der Android-App: {ok, dataUrl, name, uri, error}
  window.GOAHEAD_PHOTO_RESULT = function (res) {
    var p = pending;
    if (!p) {
      try { p = JSON.parse(window.localStorage.getItem(PENDING_KEY) || "null"); } catch (e) { p = null; }
    }
    if (!res || !res.ok) {
      if (res && res.error) { console.warn("[GoAhead] Foto:", res.error); G.showStatus("Das Foto konnte nicht übernommen werden.", 6000); }
      clearPending();
      return;
    }
    if (!p) { G.showStatus("Foto in der Galerie gespeichert (ohne Tour-Zuordnung).", 5000); return; }
    dataUrlToBlob(res.dataUrl).then(function (blob) {
      return finish(p, blob, { name: res.name, galleryUri: res.uri });
    }).catch(function (err) { console.warn("[GoAhead] Foto:", err); G.showStatus("Das Foto konnte nicht übernommen werden.", 6000); });
  };

  function clearPending() {
    pending = null;
    try { window.localStorage.removeItem(PENDING_KEY); } catch (e) { /* egal */ }
  }

  function finish(p, blob, extra) {
    clearPending();
    var rec = { id: newId(), walkId: p.walkId, lat: p.lat, lng: p.lng, time: p.time, blob: blob,
      name: extra.name || "", galleryUri: extra.galleryUri || "" };
    return save(rec).then(function () {
      G.showStatus(G.native && extra.galleryUri ? "Foto gespeichert (Galerie: Album „GoAhead“)." : "Foto gespeichert.", 3000);
      listeners.forEach(function (fn) { try { fn(rec); } catch (e) { console.warn(e); } });
      return rec;
    }).catch(function (err) { console.warn("[GoAhead] Foto:", err); G.showStatus("Das Foto konnte nicht gespeichert werden.", 6000); });
  }

  // ---------- Karte: Marker ----------

  function markerFor(ph) {
    var m = L.marker([ph.lat, ph.lng], {
      icon: L.divIcon({ className: "", html: '<div class="photo-pin">' + G.icon("camera") + "</div>", iconSize: [32, 32], iconAnchor: [16, 16] }),
      keyboard: false,
      zIndexOffset: 500
    });
    m.on("click", function (e) { L.DomEvent.stopPropagation(e); open(ph); });
    return m;
  }

  // Ebene mit den Fotos einer Tour: {layer, add(ph), list}
  function layerFor(walkId) {
    var g = L.layerGroup();
    var obj = { layer: g, list: [], add: function (ph) { obj.list.push(ph); markerFor(ph).addTo(g); } };
    forWalk(walkId).then(function (list) { list.forEach(obj.add); if (obj.onLoad) obj.onLoad(obj.list); });
    return obj;
  }

  // ---------- Anzeige ----------

  var view = document.createElement("div");
  view.className = "photo-view";
  view.hidden = true;
  view.innerHTML = '<img alt="Foto">' +
    '<div class="photo-view-bar">' +
      '<span class="photo-view-info"></span>' +
      '<button type="button" class="icon-btn photo-del" title="Foto aus GoAhead löschen" aria-label="Foto aus GoAhead löschen">' + G.icon("trash") + "</button>" +
      '<button type="button" class="icon-btn photo-close" title="Schließen" aria-label="Schließen">' + G.icon("close") + "</button>" +
    "</div>";
  document.body.appendChild(view);
  var shown = null;
  view.addEventListener("click", function (e) {
    if (e.target.closest(".photo-close") || e.target === view) { view.hidden = true; shown = null; return; }
    if (e.target.closest(".photo-del") && shown) {
      var ph = shown;
      G.actionSheet("Foto löschen?", T(ph.galleryUri ? "Es wird aus GoAhead entfernt; in der Galerie bleibt es erhalten." : "Es wird aus GoAhead entfernt."), [
        { label: "Löschen", danger: true, onClick: function () {
          remove(ph).then(function () {
            view.hidden = true;
            shown = null;
            deleteListeners.forEach(function (fn) { try { fn(ph); } catch (e) { console.warn(e); } });
          });
        } }
      ]);
    }
  });
  var deleteListeners = [];

  function open(ph) {
    shown = ph;
    view.querySelector("img").src = url(ph);
    view.querySelector(".photo-view-info").textContent = new Date(ph.time).toLocaleString(G.i18n.locale);
    view.hidden = false;
  }

  G.photos = {
    take: take,
    forWalk: forWalk,
    layerFor: layerFor,
    open: open,
    url: url,
    onAdded: function (fn) { listeners.push(fn); },
    onDeleted: function (fn) { deleteListeners.push(fn); }
  };
})();
