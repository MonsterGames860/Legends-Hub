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
    ).then(() => self.clients.claim())
      .then(() => {
        // 🔄 OTOMATİK GÜNCELLEME: yeni service worker devreye girdiğinde
        // (eski cache'ler temizlenip self.clients.claim() ile tüm açık
        // sekmelerin kontrolü alındıktan SONRA) her açık sekmeye "yeni
        // sürüm hazır" mesajı gönderilir. index.html tarafındaki dinleyici
        // (bkz. "message" event, type: "sw-updated") bunu yakalayıp sayfayı
        // otomatik yeniler -- artık kullanıcının elle hard-reset yapmasına
        // gerek kalmaz, normal sayfa yenilemesi (hatta hiç yenilememesi)
        // bile en güncel sürüme geçmeye yeter.
        return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
          clientList.forEach((client) => client.postMessage({ type: "sw-updated" }));
        });
      })
  );
});

// ---- FETCH: index.html/manifest.json için NETWORK-FIRST (her zaman en
// güncel sürümü getir), diğer tüm dosyalar için eskisi gibi CACHE-FIRST.
// ────────────────────────────────────────────────────────────────
// 🐛 BUGFIX (otomatik güncelleme): Eskiden TÜM istekler cache-first idi,
// yani index.html bir kere önbelleğe alındıktan sonra yeni bir deploy
// yapılsa bile service worker hep eski, önbellekteki index.html'i
// döndürüyordu -- kullanıcı sayfayı normal yenilediğinde hâlâ eski
// sürümü görüyor, ancak "hard reset" (önbelleği elle temizleme) ile
// güncelleme oluyordu. Çözüm: index.html ve manifest.json (uygulamanın
// "kabuğu"/giriş noktası) için ÖNCE AĞDAN dene, başarısız olursa
// (çevrimdışıysa) cache'e düş. Diğer statik dosyalar (resimler, ikonlar
// gibi büyük/az değişen dosyalar) performans için hâlâ cache-first kalır.
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Sadece GET isteklerini önbellekle (POST/Firebase call'larına dokunma).
  if (req.method !== "GET") return;

  // Firebase / Google API / cross-origin isteklerine karışma —
  // bunlar kendi cache/CORS mantığını yönetsin.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // "Kabuk" dosyaları: sayfa navigasyonu (adres çubuğuna yazma, sayfa
  // yenileme) İLE index.html/manifest.json isteği her zaman bu dala girer.
  const isShellRequest = req.mode === "navigate"
    || url.pathname.endsWith("/index.html")
    || url.pathname === "/" || url.pathname.endsWith("/")
    || url.pathname.endsWith("/manifest.json");

  if (isShellRequest) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          // Ağdan başarıyla geldi: önbelleği bu en güncel sürümle
          // güncelle (bir sonraki çevrimdışı kullanım için) ve onu döndür.
          if (networkRes && networkRes.status === 200) {
            const resClone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return networkRes;
        })
        .catch(() => {
          // Çevrimdışıysa (ağ isteği başarısızsa) önbellekteki en son
          // bilinen sürüme düş -- eski davranış burada korunuyor.
          return caches.match(req).then((cached) => cached || caches.match("./index.html"));
        })
    );
    return;
  }

  // ---- Diğer tüm dosyalar: eskisi gibi cache-first, yoksa network ----
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
