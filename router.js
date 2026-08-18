/* ================================================================
 * router.js — Legends Hub SPA Dynamic Router
 * ================================================================
 * Bu dosya index.html'deki ana modülün DIŞINDA, ayrı bir <script>
 * olarak yüklenir (bkz. index.html sonu: <script src="router.js">).
 * İçindeki fonksiyonlara window.HubRouterBridge, window.CommunityAuth,
 * window.CommunityRBAC ve window.MessagingSystem üzerinden erişir —
 * bu yüzden index.html'deki ana IIFE'den SONRA yüklenmesi zorunludur.
 *
 * Desteklenen URL şeması:
 *   /forum                                   -> Forum ana sekmesi
 *   /forum/:categoryId                       -> Forum kategorisi
 *   /forum/:categoryId/:threadSlug           -> Konu detayı
 *   /communities/:code                       -> Topluluk (üye ise kanal,
 *                                                değilse katılım popup'ı)
 *   /groups/:code                            -> Aynı mantık, "groups" yolu
 *   /admin-panel  veya  /console              -> Yetki korumalı (Helper+)
 *   /chat  /messages  /marketplace  /studio
 *   /profile /players /inbox                  -> Doğrudan sekme eşlemesi
 *
 * Tüm gezinmeler window.history.pushState ile yapılır; sayfa hiç
 * yeniden yüklenmez. Geri/İleri tuşları popstate ile dinlenir.
 * ================================================================ */

(function () {
    "use strict";

    // ------------------------------------------------------------
    // Sabitler / eşlemeler
    // ------------------------------------------------------------

    // URL path segment'i -> gerçek data-view adı.
    // "chat" kullanıcı isteğinde geçen dostane bir alias; gerçek
    // view adı hep "messages" olarak kalıyor (index.html ile birebir).
    const VIEW_ALIASES = {
        chat: "messages",
        message: "messages",
        messages: "messages",
        marketplace: "marketplace",
        studio: "studio",
        groups: "groups",
        communities: "communities",
        inbox: "inbox",
        players: "players",
        profile: "profile"
    };

    // Basit (parametresiz) view'lar için path -> view eşlemesi.
    const SIMPLE_VIEW_ROUTES = {
        "/chat": "messages",
        "/messages": "messages",
        "/marketplace": "marketplace",
        "/studio": "studio",
        "/inbox": "inbox",
        "/players": "players"
    };

    // Yetki korumalı yollar -> hangi iç view'a karşılık geldiği.
    const PROTECTED_ROUTES = {
        "/admin-panel": "admin",
        "/console": "console"
    };

    const MIN_ROLE_FOR_PROTECTED = "helper";
    const UNAUTHORIZED_REDIRECT_PATH = "/forum/live";

    // Kullanıcının gördüğü "canlı sohbet" kategorisi index.html içinde
    // "general-chat" id'siyle tanımlı, ama görev tanımında istenen dostane
    // URL "/forum/live" olduğu için burada bir alias tutuyoruz. Böylece
    // hem "/forum/live" hem de gerçek id olan "/forum/general-chat" çalışır.
    const CATEGORY_URL_ALIASES = {
        live: "general-chat",
        "general-chat": "general-chat",
        announcements: "announcements",
        updates: "announcements",
        "general-discussion": "general-discussion",
        support: "support",
        suggestions: "suggestions"
    };

    // Ters yönde (gerçek categoryId -> URL'de gösterilecek dostane segment).
    const CATEGORY_TO_URL_SEGMENT = {
        "general-chat": "live",
        announcements: "updates",
        "general-discussion": "general-discussion",
        support: "support",
        suggestions: "suggestions"
    };

    let isApplyingRouteFromPop = false;
    let deepLinkResolveAttempts = 0;
    const MAX_DEEP_LINK_ATTEMPTS = 40; // ~40 * 150ms = 6sn'ye kadar bekler

    // ------------------------------------------------------------
    // Yardımcılar
    // ------------------------------------------------------------

    function bridge() {
        return window.HubRouterBridge || null;
    }

    function isAuthReady() {
        return !!(window.CommunityAuth && window.CommunityAuth.ready && window.CommunityAuth.isAuthorized);
    }

    function currentProfile() {
        return window.CommunityAuth ? window.CommunityAuth.profile : null;
    }

    function hasMinimumTier(minTier) {
        if (!window.CommunityRBAC || typeof window.CommunityRBAC.hasMinimumTier !== "function") return false;
        return window.CommunityRBAC.hasMinimumTier(currentProfile(), minTier);
    }

    function toast(msg) {
        const b = bridge();
        if (b && typeof b.showToastGlobal === "function") {
            b.showToastGlobal(msg);
        }
    }

    // Konu başlığından URL-dostu bir slug üretir (Türkçe karakterler dahil).
    function slugify(title) {
        if (!title) return "konu";
        const trMap = { ç: "c", Ç: "c", ğ: "g", Ğ: "g", ı: "i", İ: "i", ö: "o", Ö: "o", ş: "s", Ş: "s", ü: "u", Ü: "u" };
        let s = String(title).replace(/[çÇğĞıİöÖşŞüÜ]/g, (ch) => trMap[ch] || ch);
        s = s
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "");
        return s || "konu";
    }

    // Aktif kategori önbelleğinde, verilen slug'a uyan thread'i bulur.
    function findThreadBySlug(categoryId, slugOrId) {
        const b = bridge();
        if (!b) return null;
        const cache = b.forumThreadsCache || {};
        // Önce doğrudan gerçek threadId eşleşmesi dene (paylaşılan eski linkler için).
        if (cache[slugOrId]) return { id: slugOrId, thread: cache[slugOrId] };
        // Sonra slug eşleşmesi ara.
        for (const id in cache) {
            if (!Object.prototype.hasOwnProperty.call(cache, id)) continue;
            const t = cache[id];
            if (t && t.categoryId === categoryId && slugify(t.title) === slugOrId) {
                return { id, thread: t };
            }
        }
        return null;
    }

    function pathSegments(pathname) {
        return pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    }

    // ------------------------------------------------------------
    // URL <-> View senkronizasyonu (dışarıdan tetiklenen, örn. nav
    // tıklaması ile view değiştiğinde URL'i de güncel tutmak için)
    // ------------------------------------------------------------

    function pathForView(view) {
        switch (view) {
            case "forum": return "/forum";
            case "messages": return "/chat";
            case "marketplace": return "/marketplace";
            case "studio": return "/studio";
            case "groups": return "/groups";
            case "communities": return "/communities";
            case "inbox": return "/inbox";
            case "players": return "/players";
            case "profile": return "/profile/Me";
            case "admin": return "/admin-panel";
            case "console": return "/console";
            default: return "/" + view;
        }
    }

    function navigateToView(view, opts) {
        const path = pathForView(view);
        navigateTo(path, opts);
    }

    function navigateToThread(categoryId, threadTitle) {
        const b = bridge();
        const seg = (b && typeof b.categoryIdToUrlSegment === "function")
            ? b.categoryIdToUrlSegment(categoryId)
            : (CATEGORY_TO_URL_SEGMENT[categoryId] || categoryId);
        const slug = slugify(threadTitle);
        navigateTo("/forum/" + seg + "/" + slug);
    }

    // Verilen uid kendi hesabımızsa /profile/Me, değilse mention cache'inden
    // bulunan kullanıcı adıyla /profile/:KullaniciAdi olarak URL'i günceller.
    // Kullanıcı adı henüz cache'te yoksa (mention cache dolmamış) sessizce
    // hiçbir şey yapmaz -- URL eski hâlinde kalır, işlevi bozmaz.
    function navigateToProfile(uid) {
        const myUid = window.CommunityAuth && window.CommunityAuth.user && window.CommunityAuth.user.uid;
        if (uid && myUid && uid === myUid) {
            navigateTo("/profile/Me");
            return;
        }
        if (window.CommunityMentions && typeof window.CommunityMentions.getByUid === "function") {
            const candidate = window.CommunityMentions.getByUid(uid);
            if (candidate && candidate.username) {
                navigateTo("/profile/" + encodeURIComponent(candidate.username));
                return;
            }
        }
        // Kullanıcı adı bulunamadıysa en azından genel /profile'a düş.
        navigateTo("/profile/Me");
    }

    // Programatik geçiş: hem tarayıcı URL'ini günceller hem de ilgili
    // view'ı gerçekten uygular. replace=true ise geçmişe yeni girdi
    // eklemek yerine mevcut girdiyi değiştirir (örn. yetkisiz erişim
    // yönlendirmesinde geri tuşunun engellenen sayfaya dönmemesi için).
    function navigateTo(path, opts) {
        opts = opts || {};
        const current = window.location.pathname;

        // 🐛 KALICI DÖNGÜ KORUMASI: path zaten mevcut URL ile AYNIYSA,
        // applyRoute'u tekrar çağırmıyoruz. Aksi halde "normalize edip
        // kendi path'ine geri navigateTo çağıran" herhangi bir route
        // handler'ı (ör. /profile/KendiKullaniciAdım -> /profile/Me,
        // ya da forum kategori senkronu gibi) SONSUZ SENKRON DÖNGÜYE
        // (navigateTo -> applyRoute -> handler -> navigateTo -> ...)
        // girip sekmeyi tamamen kilitleyebiliyordu (stack overflow /
        // tarayıcı donması). Bu koruma, "zaten oradaysak tekrar işleme"
        // kuralını TEK bir merkezi yerden garanti eder.
        if (current === path && !opts.force) {
            return;
        }

        if (!opts.replace) {
            window.history.pushState({ hubPath: path }, "", path);
        } else {
            window.history.replaceState({ hubPath: path }, "", path);
        }
        applyRoute(path, { fromNavigate: true });
    }

    // ------------------------------------------------------------
    // Route uygulama (asıl yönlendirme mantığı)
    // ------------------------------------------------------------

    function applyRoute(pathname, opts) {
        opts = opts || {};
        const b = bridge();
        if (!b) return;

        const segs = pathSegments(pathname);
        if (segs.length === 0) {
            // Kök path -> varsayılan olarak Forum'a düş.
            b.switchView("forum");
            if (!opts.fromNavigate) window.history.replaceState({ hubPath: "/forum" }, "", "/forum");
            return;
        }

        const root = segs[0].toLowerCase();

        // ---- 1) Yetki korumalı yollar (RBAC) ----
        const fullPath = "/" + segs.join("/");
        if (PROTECTED_ROUTES[fullPath] || (segs.length === 1 && PROTECTED_ROUTES["/" + root])) {
            const targetView = PROTECTED_ROUTES[fullPath] || PROTECTED_ROUTES["/" + root];
            handleProtectedRoute(targetView);
            return;
        }

        // ---- 2) /forum, /forum/:category, /forum/:category/:threadSlug ----
        if (root === "forum") {
            handleForumRoute(segs);
            return;
        }

        // ---- 3) /communities/:code ----
        if (root === "communities") {
            if (segs.length >= 2) {
                handleCommunityOrGroupRoute(segs[1], "communities");
            } else {
                b.switchView("communities");
            }
            return;
        }

        // ---- 4) /groups/:code ----
        if (root === "groups") {
            if (segs.length >= 2) {
                handleCommunityOrGroupRoute(segs[1], "groups");
            } else {
                b.switchView("groups");
            }
            return;
        }

        // ---- 4b) /profile, /profile/Me, /profile/:KullaniciAdi ----
        if (root === "profile") {
            handleProfileRoute(segs);
            return;
        }

        // ---- 5) Basit sekmeler (chat, messages, marketplace, studio, ...) ----
        if (SIMPLE_VIEW_ROUTES[fullPath]) {
            b.switchView(SIMPLE_VIEW_ROUTES[fullPath]);
            return;
        }
        if (VIEW_ALIASES[root]) {
            b.switchView(VIEW_ALIASES[root]);
            return;
        }

        // ---- 6) Bilinmeyen yol -> Forum'a yönlendir (yumuşak 404) ----
        b.switchView("forum");
        window.history.replaceState({ hubPath: "/forum" }, "", "/forum");
    }

    // ------------------------------------------------------------
    // Forum route mantığı
    // ------------------------------------------------------------

    function handleForumRoute(segs) {
        const b = bridge();
        if (!b) return;

        b.switchView("forum");

        if (segs.length < 2) return; // sadece /forum

        const categorySeg = segs[1].toLowerCase();
        const categoryId = CATEGORY_URL_ALIASES[categorySeg] || categorySeg;

        const category = b.getCategoryById(categoryId);
        if (!category) {
            // Bilinmeyen kategori -> forum ana sekmesinde kal, sessizce yut.
            return;
        }

        b.switchForumCategory(categoryId);

        if (segs.length < 3) return; // /forum/:category, konu yok

        const threadSlug = segs[2];
        resolveAndOpenThread(categoryId, threadSlug);
    }

    // Thread cache'i Firebase'den asenkron dolduğu için (auth-ready sonrası
    // canlı dinleyici), sayfa doğrudan bir konu linkiyle açıldıysa kısa bir
    // süre boyunca polling yaparak cache dolana kadar bekleriz.
    function resolveAndOpenThread(categoryId, threadSlug, attempt) {
        attempt = attempt || 0;
        const b = bridge();
        if (!b) return;

        const found = findThreadBySlug(categoryId, threadSlug);
        if (found) {
            b.openThreadDetail(found.id);
            return;
        }

        if (attempt >= MAX_DEEP_LINK_ATTEMPTS) {
            toast("Bu konu bulunamadı veya kaldırılmış olabilir.");
            return;
        }
        setTimeout(() => resolveAndOpenThread(categoryId, threadSlug, attempt + 1), 150);
    }

    // ------------------------------------------------------------
    // Profil route mantığı: /profile, /profile/Me, /profile/:KullaniciAdi
    // ------------------------------------------------------------

    function handleProfileRoute(segs, attempt) {
        attempt = attempt || 0;
        const b = bridge();
        if (!b) return;

        b.switchView("profile", { skipDefaultProfileRender: segs.length >= 2 });

        const myUid = window.CommunityAuth && window.CommunityAuth.user && window.CommunityAuth.user.uid;

        // Sadece /profile veya /profile/Me -> kendi profilimiz.
        if (segs.length < 2 || segs[1].toLowerCase() === "me") {
            if (!myUid) return; // auth henüz hazır değil, switchView zaten "profile" sekmesini açık bırakır.
            if (typeof b.openUserProfile === "function") b.openUserProfile(myUid, { skipUrlSync: true });
            // URL'i her zaman dostane "Me" biçiminde tut.
            navigateTo("/profile/Me", { replace: true });
            return;
        }

        const requestedName = decodeURIComponent(segs[1]);

        // Kendi kullanıcı adımızı yazdıysa /profile/Me'ye normalize et.
        const myCandidate = (window.CommunityMentions && myUid) ? window.CommunityMentions.getByUid(myUid) : null;
        if (myCandidate && myCandidate.username && myCandidate.username.toLowerCase() === requestedName.toLowerCase()) {
            if (typeof b.openUserProfile === "function") b.openUserProfile(myUid, { skipUrlSync: true });
            navigateTo("/profile/Me", { replace: true });
            return;
        }

        // Mention/kullanıcı cache'i henüz hazır olmayabilir (sayfa bu linkle
        // doğrudan açıldıysa) -- window.CommunityMentions.onReady ile bekle.
        const tryResolve = () => {
            const candidate = window.CommunityMentions && typeof window.CommunityMentions.getByUsername === "function"
                ? window.CommunityMentions.getByUsername(requestedName)
                : null;
            if (candidate && candidate.uid) {
                if (typeof b.openUserProfile === "function") b.openUserProfile(candidate.uid, { skipUrlSync: true });
                return true;
            }
            return false;
        };

        if (tryResolve()) return;

        if (window.CommunityMentions && typeof window.CommunityMentions.onReady === "function") {
            window.CommunityMentions.onReady(() => {
                if (!tryResolve()) {
                    toast("Kullanıcı bulunamadı: @" + requestedName);
                }
            });
            return;
        }

        // onReady yoksa (beklenmedik durum) kısa polling'e düş.
        if (attempt < MAX_DEEP_LINK_ATTEMPTS) {
            setTimeout(() => handleProfileRoute(segs, attempt + 1), 150);
        } else {
            toast("Kullanıcı bulunamadı: @" + requestedName);
        }
    }

    function handleCommunityOrGroupRoute(code, sourceSegment, attempt) {
        attempt = attempt || 0;
        const b = bridge();
        if (!b) return;

        // Hem CommunityDirectoryCache (tüm topluluklar) hem de
        // MessagingSystem._userGroupsCache (kullanıcının zaten üye
        // olduğu gruplar) canlı Firebase dinleyicileriyle dolar; sayfa
        // doğrudan bu linkle açıldıysa henüz dolmamış olabilirler.
        const directory = window.CommunityDirectoryCache;
        const userGroups = window.MessagingSystem ? window.MessagingSystem._userGroupsCache : null;

        const directoryReady = directory && typeof directory === "object";
        const userGroupsReady = userGroups && typeof userGroups === "object";

        if (!directoryReady || !userGroupsReady) {
            if (attempt >= MAX_DEEP_LINK_ATTEMPTS) {
                toast("Topluluk bilgisi yüklenemedi. Lütfen tekrar deneyin.");
                b.switchView(sourceSegment === "groups" ? "groups" : "communities");
                return;
            }
            setTimeout(() => handleCommunityOrGroupRoute(code, sourceSegment, attempt + 1), 150);
            return;
        }

        // 🔗 Önce kodu doğrudan groupId (Firebase key) olarak dene -- eski
        // davranışla birebir uyumlu. Eşleşmezse, bu bir ÖZEL BAĞLANTI KODU
        // (vanity code) olabilir: community_directory içindeki gruplardan
        // vanityCode alanı bu koda eşit olanı ara (aynı cache, ek Firebase
        // sorgusu gerekmez). Böylece hem /communities/RealCode123 (ham
        // groupId) hem de /communities/legends-tr (özel kod) çalışır.
        let communityMeta = directory[code];
        let resolvedGroupId = code;
        if (!communityMeta) {
            const lowerCode = code.toLowerCase();
            for (const gid in directory) {
                if (!Object.prototype.hasOwnProperty.call(directory, gid)) continue;
                const entry = directory[gid];
                if (entry && entry.vanityCode && entry.vanityCode.toLowerCase() === lowerCode) {
                    communityMeta = entry;
                    resolvedGroupId = gid;
                    break;
                }
            }
        }

        if (!communityMeta) {
            toast("Bu topluluk/grup kodu geçersiz veya bulunamadı.");
            b.switchView(sourceSegment === "groups" ? "groups" : "communities");
            return;
        }

        const alreadyMember = !!userGroups[resolvedGroupId];

        if (alreadyMember) {
            // Zaten üye -> direkt kanala/gruba gir.
            b.switchView("groups");
            b.openGroupConversation(resolvedGroupId);
            return;
        }

        // Üye değil -> katılım/davet popup'ını göster (mevcut önizleme
        // modalı zaten "Katıl" butonuyla bu akışı sağlıyor).
        if (typeof window.openCommunityPreviewModal === "function") {
            b.switchView(sourceSegment === "groups" ? "groups" : "communities");
            window.openCommunityPreviewModal(resolvedGroupId);
        } else {
            toast("Topluluğa katılma penceresi açılamadı.");
            b.switchView(sourceSegment === "groups" ? "groups" : "communities");
        }
    }

    // ------------------------------------------------------------
    // Yetki korumalı yollar (RBAC) mantığı
    // ------------------------------------------------------------

    function handleProtectedRoute(targetView, attempt) {
        attempt = attempt || 0;
        const b = bridge();
        if (!b) return;

        // Auth/profil henüz hazır değilse (sayfa direkt bu linkle
        // açıldıysa) kısa süre bekleyip tekrar dene.
        if (!isAuthReady()) {
            if (attempt >= MAX_DEEP_LINK_ATTEMPTS) {
                // Auth hiç hazır olmadıysa (örn. login ekranında) sessizce
                // bırak — login sonrası showHubShell zaten forum'u açar.
                return;
            }
            setTimeout(() => handleProtectedRoute(targetView, attempt + 1), 150);
            return;
        }

        if (hasMinimumTier(MIN_ROLE_FOR_PROTECTED)) {
            b.switchView(targetView);
            return;
        }

        // Yetkisiz erişim: uyarı bildirimi + otomatik yönlendirme.
        toast("⛔ Bu sayfaya erişim yetkiniz yok.");
        navigateTo(UNAUTHORIZED_REDIRECT_PATH, { replace: true });
    }

    // ------------------------------------------------------------
    // Tarayıcı geçmişi (History API) entegrasyonu
    // ------------------------------------------------------------

    window.addEventListener("popstate", () => {
        isApplyingRouteFromPop = true;
        applyRoute(window.location.pathname, { fromNavigate: true });
        isApplyingRouteFromPop = false;
    });

    // ------------------------------------------------------------
    // Başlangıç: sayfa ilk yüklendiğinde mevcut URL'i uygula.
    // Auth henüz hazır olmayabileceğinden, forum dışındaki (özellikle
    // veri gerektiren) route'lar kendi içlerinde bekleme/polling
    // mantığına sahip. Basit view route'ları (forum, profile vb.)
    // hemen switchView çağırır; switchView zaten showHubShell sonrası
    // güvenle çalışacak şekilde tasarlanmış (nav zaten görünür değilse
    // etkisi olmaz, showHubShell açıldığında forum varsayılan aktif).
    // ------------------------------------------------------------

    function boot() {
        const initialPath = window.location.pathname === "/" || window.location.pathname === ""
            ? "/forum"
            : window.location.pathname;

        if (window.location.pathname !== initialPath) {
            window.history.replaceState({ hubPath: initialPath }, "", initialPath + window.location.search);
        }

        // Auth hazır olana kadar bekleyip ardından route'u uygula ki
        // korumalı/veri-bağımlı route'lar (admin-panel, communities,
        // groups, forum thread) doğru çalışsın.
        if (isAuthReady()) {
            applyRoute(initialPath, { fromNavigate: false });
        } else {
            document.addEventListener("communitystudio:auth-ready", function onReady() {
                document.removeEventListener("communitystudio:auth-ready", onReady);
                // showHubShell senkron olarak forum'u varsayılan gösterir;
                // bir sonraki mikro-görevde gerçek route'u üstüne uygularız.
                setTimeout(() => applyRoute(initialPath, { fromNavigate: false }), 0);
            });
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }

    // ------------------------------------------------------------
    // Dışa açılan API
    // ------------------------------------------------------------

    window.HubRouter = {
        navigateTo: navigateTo,
        navigateToView: navigateToView,
        navigateToThread: navigateToThread,
        navigateToProfile: navigateToProfile,
        applyRoute: applyRoute
    };
})();
