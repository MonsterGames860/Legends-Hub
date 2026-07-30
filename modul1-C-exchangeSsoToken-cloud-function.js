// ============================================================
// 🔥 MODÜL 1 - BÖLÜM C: SSO TOKEN EXCHANGE CLOUD FUNCTION (BACKEND)
// ============================================================
// KONUM: Firebase projenizin `functions/` klasörü (index.js veya
//        ayrı bir dosyada export edip index.js'te re-export edin).
//
// KURULUM ADIMLARI (bir kereye mahsus):
//   1) Firebase CLI kurulu değilse: npm install -g firebase-tools
//   2) Proje kökünde:  firebase init functions   (zaten yoksa)
//   3) functions/ klasöründe:  npm install firebase-admin firebase-functions
//   4) Bu dosyayı functions/exchangeSsoToken.js olarak kaydedin
//   5) functions/index.js içine ekleyin:
//        const { exchangeSsoToken } = require("./exchangeSsoToken");
//        exports.exchangeSsoToken = exchangeSsoToken;
//   6) Deploy:  firebase deploy --only functions:exchangeSsoToken
//   7) Deploy sonrası size verilen HTTPS URL'i alıp Bölüm B'deki
//      `EXCHANGE_ENDPOINT` değişkenine yapıştırın.
//
// GÜVENLİK MANTIĞI:
//   - Client'tan gelen idToken, Firebase Admin SDK ile SUNUCU
//     TARAFINDA doğrulanır (admin.auth().verifyIdToken). Bu adım
//     sahte/manipüle edilmiş token'ları eler.
//   - Token'ın "issued at" (iat) zamanı kontrol edilir — çok eski
//     bir token'ın tekrar tekrar kullanılmasını (replay attack)
//     zorlaştırmak için 5 dakikadan eski token'lar reddedilir.
//   - Token'daki `firebase.sign_in_provider` alanı "anonymous" ise
//     (yani guest ise) İSTEK DOĞRUDAN REDDEDİLİR. Bu, ana sitedeki
//     guestLogin() akışının Community Studio'ya asla sızamamasını
//     backend seviyesinde bir kez daha garanti eder (defense in depth).
//   - Sadece doğrulanmış, guest olmayan bir uid için customToken
//     üretilir ve client'a döner.
// ============================================================

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp();
}

// CORS: Sadece ana oyun sitenizden ve Community Studio'dan gelen
// isteklere izin veriyoruz. Kendi gerçek domainlerinizle güncelleyin.
const ALLOWED_ORIGINS = [
    "https://playlegends.vercel.app",
    "https://community.SIZIN-DOMAININIZ.com" // Community Hub'ın nihai adresi netleşince güncellenecek
];

const MAX_TOKEN_AGE_SECONDS = 5 * 60; // 5 dakika

const exchangeSsoToken = onRequest(
    { cors: ALLOWED_ORIGINS, region: "europe-west1" },
    async (req, res) => {
        if (req.method !== "POST") {
            res.status(405).json({ error: "Method not allowed" });
            return;
        }

        const { idToken } = req.body || {};

        if (!idToken || typeof idToken !== "string") {
            res.status(400).json({ error: "idToken zorunludur." });
            return;
        }

        try {
            // 1) ID Token'ı doğrula (imza, geçerlilik süresi, proje eşleşmesi).
            const decoded = await admin.auth().verifyIdToken(idToken, /* checkRevoked */ true);

            // 2) Guest / anonim kullanıcıları backend seviyesinde de reddet.
            const signInProvider = decoded.firebase && decoded.firebase.sign_in_provider;
            if (signInProvider === "anonymous") {
                console.warn(`[exchangeSsoToken] Reddedildi: anonim kullanıcı uid=${decoded.uid}`);
                res.status(403).json({ error: "Misafir hesaplar Community Studio'ya erişemez." });
                return;
            }

            // 3) Token yaşını kontrol et (replay attack riskini azalt).
            const nowSeconds = Math.floor(Date.now() / 1000);
            const tokenAge = nowSeconds - decoded.iat;
            if (tokenAge > MAX_TOKEN_AGE_SECONDS) {
                console.warn(`[exchangeSsoToken] Reddedildi: token çok eski (${tokenAge}s) uid=${decoded.uid}`);
                res.status(401).json({ error: "Token süresi dolmuş, lütfen ana siteden tekrar deneyin." });
                return;
            }

            // 4) Realtime Database'den profil kontrolü — banlı kullanıcılar
            //    için custom token bile üretmiyoruz.
            const db = admin.database();
            const profileSnap = await db.ref("users/" + decoded.uid).once("value");
            const profile = profileSnap.val();

            if (!profile) {
                console.warn(`[exchangeSsoToken] Reddedildi: profil bulunamadı uid=${decoded.uid}`);
                res.status(403).json({ error: "Kullanıcı profili bulunamadı." });
                return;
            }

            if (profile.banned === true) {
                console.warn(`[exchangeSsoToken] Reddedildi: banlı kullanıcı uid=${decoded.uid}`);
                res.status(403).json({ error: "Bu hesap yasaklanmış." });
                return;
            }

            // 5) Her şey temiz — custom token üret.
            const customToken = await admin.auth().createCustomToken(decoded.uid, {
                ssoSource: "main-site-handoff"
            });

            res.status(200).json({ customToken });

        } catch (err) {
            console.error("[exchangeSsoToken] Doğrulama hatası:", err.message);
            res.status(401).json({ error: "Geçersiz veya süresi dolmuş token." });
        }
    }
);

module.exports = { exchangeSsoToken };
