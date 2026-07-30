// ============================================================
// 🔗 MODÜL 1 - BÖLÜM A: COMMUNITY STUDIO SSO TOKEN HANDOFF
// index.html'e eklenecek kod.
// KONUM: Mevcut `auth.onAuthStateChanged((user) => { ... });` bloğundan
//        HEMEN SONRA eklenmelidir (yaklaşık satır ~2825 civarı,
//        `function closeGame()` tanımından hemen önce).
// AMAÇ: Kullanıcı "Community Studio'ya Git" linkine bastığında,
//       eğer gerçek (guest olmayan) bir oturum varsa kısa ömürlü
//       bir Firebase ID Token üretip yeni sekmede Community Studio'yu
//       bu token ile açar. Guest kullanıcılar veya oturumu olmayanlar
//       için işlem tamamen engellenir.
// ============================================================

// Bu kod, https://playlegends.vercel.app (index.html) sitesine eklenecektir.
// Community Studio / Hub'ın gerçek adresini burada tanımlıyoruz.
// Hub'ı nereye deploy ederseniz (Vercel/Firebase Hosting/başka), o URL'i buraya yazın.
const COMMUNITY_STUDIO_URL = "https://community.SIZIN-DOMAININIZ.com";

/**
 * Community Studio'yu açar. Guest kullanıcılar ve oturumu olmayanlar
 * için işlem tamamen reddedilir, hiçbir token üretilmez.
 */
async function openCommunityStudio() {
    // 1) Guest kontrolü — guest ise token asla üretilmez.
    if (isGuest || !auth || !auth.currentUser) {
        const msg = (typeof lang !== 'undefined' && lang === 'tr')
            ? "Community Studio'ya erişmek için gerçek bir hesapla giriş yapmalısınız. Misafir hesaplar erişemez."
            : "You must be logged in with a real account to access Community Studio. Guest accounts cannot access it.";
        alert(msg);
        return;
    }

    try {
        // 2) Kısa ömürlü ID Token al (Firebase varsayılan ~1 saat geçerli,
        //    ancak Community Studio tarafında ekstra olarak "issued at"
        //    zaman damgası da doğrulanacak — bkz. Bölüm B).
        //    force-refresh = true: en güncel custom claims/rol bilgisiyle gelsin diye.
        const idToken = await auth.currentUser.getIdToken(/* forceRefresh */ true);

        // 3) Token'ı URL fragment (#) ile taşıyoruz, query string (?) ile DEĞİL.
        //    Sebep: URL fragment'lar sunucuya (access loglarına, CDN loglarına,
        //    Referer header'ına) hiç gitmez, sadece tarayıcı tarafında JS ile
        //    okunabilir. Bu, token'ın sızma riskini query string'e göre azaltır.
        const targetUrl = `${COMMUNITY_STUDIO_URL}/#authToken=${encodeURIComponent(idToken)}`;

        // 4) Yeni sekmede aç. noopener: yeni sekmenin window.opener üzerinden
        //    bu sayfaya erişip zararlı bir şey yapmasını engeller.
        window.open(targetUrl, "_blank", "noopener,noreferrer");

    } catch (err) {
        console.error("Community Studio token üretilemedi:", err);
        const msg = (typeof lang !== 'undefined' && lang === 'tr')
            ? "Community Studio'ya bağlanırken bir hata oluştu. Lütfen tekrar deneyin."
            : "An error occurred while connecting to Community Studio. Please try again.";
        alert(msg);
    }
}

// Bu fonksiyonu, sitenizdeki "Community Studio" butonunun
// onclick="openCommunityStudio()" attribute'una bağlayabilirsiniz. Örnek:
// <button onclick="openCommunityStudio()">🎨 Community Studio</button>
