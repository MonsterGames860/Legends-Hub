// ================================================================
// LEGENDS HUB — SERVICE WORKER
// Basit "cache-first, network'e düş" stratejisi.
// Cache adını her yayında (deploy) artırarak eski istemcilerdeki
// önbelleği geçersiz kılabilirsin (örn. legends-hub-cache-v2).
//
// NOT (Push Notification hakkında önemli):
// Bu dosyadaki "push" event dinleyicisi, sunucu tarafından GERÇEK bir
// Web Push mesajı gönderildiğinde tetiklenir. Bunun çalışabilmesi için
// bir push servisi (ör. Firebase Cloud Messaging) + backend (Cloud
// Functions ya da kendi sunucunuz) kurulu olması ve istemcinin
// PushManager.subscribe() ile bir push aboneliği oluşturmuş olması
// GEREKİR. Bu proje şu an için sadece istemci tarafı (frontend) barındırıyor
// ve böyle bir backend/FCM kurulumu henüz yapılmamış -- dolayısıyla
// "push" event'i bu haliyle hiç tetiklenmeyecektir. Sekme kapalıyken/
// telefon kilitliyken bile bildirim düşmesini istiyorsanız, ayrı bir
// adımda FCM + Cloud Functions (ya da başka bir push sağlayıcı)
// kurulması gerekir. "notificationclick" dinleyicisi ise (aşağıda)
// bugünden itibaren çalışır: uygulama SEKME OLARAK açıkken/arka plan
// sekmesindeyken gösterilen bildirimlere tıklanmasını yönetir.
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

// ================================================================
// PUSH: sunucudan (FCM/Web Push) bir push mesajı geldiğinde çalışır.
// Bkz. dosya başındaki NOT — bu event, backend/FCM kurulmadan tetiklenmez.
// Hazır bekletiliyor: FCM kurulduğunda ekstra kod yazmaya gerek kalmadan
// çalışmaya başlar (payload formatı standart Web Push / FCM formatındadır).
// ================================================================
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: "Legends Hub", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Legends Hub";
  const options = {
    body: data.body || "",
    icon: data.icon || "./icons/icon-192.png",
    badge: data.badge || "./icons/badge-72.png",
    tag: data.tag || "legends-hub-notif",
    // Aynı 'tag' ile art arda gelen bildirimler tek bildirim gibi
    // yeniden titremesin/yığılmasın diye renotify true; WhatsApp'taki
    // gibi her yeni mesaj tekrar dikkat çeksin.
    renotify: true,
    vibrate: [120, 60, 120],
    data: {
      url: data.url || "./",          // bildirime tıklanınca açılacak sayfa/route
      dmId: data.dmId || null,
      otherUid: data.otherUid || null,
      type: data.type || "mention"
    },
    icon: data.icon || "./icons/icon-192.png"
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ================================================================
// NOTIFICATIONCLICK: bildirime tıklanınca çalışır. Açık bir sekme
// varsa ona odaklanıp uygulamaya "şu sohbeti aç" mesajı postalar;
// açık sekme yoksa yeni bir sekme/pencere açar. WhatsApp'takine benzer
// şekilde, tıklanan bildirim ilgili DM/sohbet ekranına yönlendirir.
// ================================================================
self.addEventListener("notificationclick", (event) => {
  const notifData = (event.notification && event.notification.data) || {};
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Zaten açık bir sekme varsa: odaklan ve hangi sohbetin
      // açılacağını postMessage ile bildir (index.html tarafında
      // "message" event dinleyicisi bunu yakalayıp openDmConversation
      // çağırır -- bkz. index.html içindeki NotificationSystem entegrasyonu).
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({ type: "notif-click", payload: notifData });
          return client.focus();
        }
      }
      // Açık sekme yoksa yeni pencere aç.
      if (self.clients.openWindow) {
        return self.clients.openWindow(notifData.url || "./");
      }
    })
  );
});
