/* Service Worker: hält die App-Hülle offline verfügbar.
 * Kartenkacheln werden bewusst (noch) NICHT gecacht – das ist ein eigener Schritt
 * (Offline-Karten), der Speicherplatz und Nutzungsbedingungen berücksichtigen muss.
 */
var CACHE = "goahead-shell-v6";
var SHELL = [
  "./",
  "index.html",
  "styles.css",
  "config.js",
  "app.js",
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
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Netz zuerst (damit Updates sofort ankommen), Cache als Rückfall offline
  event.respondWith(
    // "no-cache": beim Server nachfragen, ob es eine neue Version gibt (statt HTTP-Cache)
    fetch(event.request, { cache: "no-cache" }).then(function (resp) {
      var copy = resp.clone();
      caches.open(CACHE).then(function (c) { c.put(event.request, copy); });
      return resp;
    }).catch(function () {
      return caches.match(event.request);
    })
  );
});
