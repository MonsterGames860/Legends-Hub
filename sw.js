// ================================================================
// LEGENDS HUB — SERVICE WORKER
// Basit "cache-first, network'e düş" stratejisi.
// Cache adını her yayında (deploy) artırarak eski istemcilerdeki
// önbelleği geçersiz kılabilirsin (örn. legends-hub-cache-v2).
// ================================================================

const CACHE_NAME = "legends-hub-cache-v1";

// Uygulama kabuğu (app shell) — ilk yüklemede önbelleğe alınır.
// Sadece aynı origin'deki, kesin var olan dosyaları listele.
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json"
];

// ---- INSTALL: app shell'i önbelleğe al ----
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch((err) => {
        // Listedeki bir dosya bulunamazsa install'ı düşürme, sadece logla.
        console.warn("[SW] App shell cache hatası:", err);
      });
    })
  );
  self.skipWaiting();
});

// ---- ACTIVATE: eski cache sürümlerini temizle ----
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ---- FETCH: cache-first, yoksa network, o da yoksa index.html'e düş ----
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Sadece GET isteklerini önbellekle (POST/Firebase call'larına dokunma).
  if (req.method !== "GET") return;

  // Firebase / Google API / cross-origin isteklerine karışma —
  // bunlar kendi cache/CORS mantığını yönetsin.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req)
        .then((networkRes) => {
          // Başarılı yanıtı sessizce önbelleğe ekle (bir sonraki sefer için).
          if (networkRes && networkRes.status === 200) {
            const resClone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return networkRes;
        })
        .catch(() => {
          // Çevrimdışı ve cache'te yoksa: navigasyon isteğiyse index.html'e düş.
          if (req.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
    })
  );
});
