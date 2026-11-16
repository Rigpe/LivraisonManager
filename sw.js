/* sw.js - Service worker de LivraisonManager : met en cache les fichiers de l'application pour
   qu'elle s'ouvre même sans connexion. Stratégie « réseau d'abord, cache en secours » : quand le
   site est en ligne, la dernière version déployée est toujours servie (et mise en cache) ;
   hors ligne, la dernière version vue est utilisée. Les données de l'utilisateur ne passent
   jamais par ici (elles sont dans le navigateur). Changer CACHE_VERSION force le renouvellement. */
var CACHE_VERSION = "lm-cache-v1";
var CORE_FILES = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json", "./icon.svg", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      // addAll échoue si un fichier manque : on les ajoute un par un pour ne rien bloquer.
      return Promise.all(CORE_FILES.map(function (url) { return cache.add(url).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) { return hit || caches.match("./index.html"); });
    })
  );
});
