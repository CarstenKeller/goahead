/* Service Worker
 * - App-Hülle: Netz zuerst (Updates kommen sofort an), Cache als Rückfall ohne Netz.
 * - Kartenkacheln: Liegen sie im Offline-Speicher TILE_CACHE (von offline.js beim Start einer
 *   Tour entlang der Route gefüllt), werden sie von dort geliefert – sonst ganz normal aus dem Netz.
 */
var CACHE = "goahead-shell-v27";
var TILE_CACHE = "goahead-tiles-v1";   // gleicher Name wie in offline.js; bei Updates NICHT löschen
var SHELL = [
  "./",
  "index.html",
  "styles.css",
  "config.js",
  "regions.js",
  "mosaic.js",
  "app.js",
  "tracks.js",
  "planner.js",
  "tourview.js",
  "offline.js",
  "photos.js",
  "nav.js",
  "backup.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/leaflet.css",
  "vendor/leaflet/images/layers.png",
  "vendor/leaflet/images/layers-2x.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== TILE_CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    // nur Bilder (Kartenkacheln) – erst Offline-Speicher, dann Netz
    if (req.destination !== "image") return;
    event.respondWith(
      caches.open(TILE_CACHE).then(function (c) { return c.match(req.url); }).then(function (hit) {
        return hit || fetch(req);
      })
    );
    return;
  }

  // App-Hülle: Netz zuerst, "no-cache" fragt beim Server nach einer neuen Version
  event.respondWith(
    fetch(req, { cache: "no-cache" }).then(function (resp) {
      var copy = resp.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return resp;
    }).catch(function () {
      return caches.match(req);
    })
  );
});
