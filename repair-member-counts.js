// ════════════════════════════════════════════════════════════════
// TEK SEFERLİK ONARIM: community_directory/{gid}/memberCount senkronu
// ════════════════════════════════════════════════════════════════
// Ne yapar: her topluluk için group_chats/{gid}/meta/members altındaki
// GERÇEK üye sayısını okur ve community_directory/{gid}/memberCount
// alanına yazar. Kod tarafındaki düzeltme sadece BUNDAN SONRAKİ
// ekleme/çıkarma/katılma işlemlerini doğru tutar -- geçmişte oluşmuş
// yanlış (stale) sayıları düzeltmez, bu script onu yapar.
//
// NASIL ÇALIŞTIRILIR:
// 1) Uygulamayı (playlegendshub.vercel.app) tarayıcıda AÇIK ve
//    GİRİŞ YAPMIŞ halde iken masaüstü Chrome DevTools > Console'u aç.
//    (Mobilde chrome://inspect ile masaüstünden bağlanabilirsin,
//    veya bir topluluk sahibi/admin hesabıyla masaüstünde giriş yap.)
// 2) Bu dosyanın TÜM içeriğini konsola yapıştırıp Enter'a bas.
// 3) Konsolda her topluluk için "✔ ... -> N üye" satırları görmelisin.
//
// GÜVENLİK: Bu script SADECE community_directory/{gid}/memberCount
// alanını yazar; başka hiçbir veriye dokunmaz. RTDB security rules
// bu yazmaya izin vermiyorsa (örn. sadece owner/admin yazabiliyorsa)
// hata verir -- o durumda bir topluluk sahibi hesabıyla çalıştır.

(async function repairMemberCounts() {
    if (typeof firebase === "undefined" || !firebase.database) {
        console.error("❌ Firebase bulunamadı. Bu script'i uygulama sayfası açıkken çalıştırdığından emin ol.");
        return;
    }
    const db = firebase.database();

    console.log("🔍 community_directory taranıyor...");
    const dirSnap = await db.ref("community_directory").once("value");
    const dir = dirSnap.val() || {};
    const groupIds = Object.keys(dir);

    if (!groupIds.length) {
        console.log("ℹ️ community_directory boş, yapılacak bir şey yok.");
        return;
    }

    let fixed = 0, skipped = 0, failed = 0;

    for (const gid of groupIds) {
        try {
            const membersSnap = await db.ref(`group_chats/${gid}/meta/members`).once("value");
            const members = membersSnap.val() || {};
            const realCount = Object.keys(members).length;
            const currentDirCount = dir[gid] && typeof dir[gid].memberCount === "number" ? dir[gid].memberCount : null;

            if (currentDirCount === realCount) {
                console.log(`⏭  ${dir[gid].name || gid}: zaten doğru (${realCount} üye), atlandı.`);
                skipped++;
                continue;
            }

            await db.ref(`community_directory/${gid}/memberCount`).set(realCount);
            console.log(`✔ ${dir[gid].name || gid}: ${currentDirCount} -> ${realCount} üye olarak düzeltildi.`);
            fixed++;
        } catch (err) {
            console.error(`❌ ${gid} düzeltilemedi:`, err && err.message ? err.message : err);
            failed++;
        }
    }

    console.log(`\n🏁 Bitti. Düzeltilen: ${fixed}, zaten doğru: ${skipped}, hatalı: ${failed} (toplam ${groupIds.length} topluluk).`);
})();
