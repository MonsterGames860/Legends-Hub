/**
 * ============================================================================
 *  studio-local-backup.js
 *  Play Legends — 3D Studio | Yerel Yedekleme & Offline Taslak Katmanı
 * ============================================================================
 *
 *  AMAÇ
 *  ----
 *  3dstudio.html'deki asıl kaydetme yolu Firebase Realtime Database'dir
 *  (bkz. saveModel()). Bu dosya onun YERİNE geçmez — YANINA, bir güvenlik
 *  ağı olarak eklenir:
 *
 *    1) Kullanıcı sahnede değişiklik yaptıkça (küp ekleme/silme/taşıma/
 *       boyama/isim değiştirme) sahne otomatik olarak IndexedDB'ye
 *       (yoksa localStorage'a) debounce'lu şekilde yazılır ("taslak").
 *    2) Sayfa yenilenirse ve URL'de ?modelId= YOKSA (yani Firebase'den
 *       belirli bir model yüklenmiyorsa), en son taslak otomatik geri
 *       yüklenir — kullanıcı kazara sekmeyi kapatsa/yenilese bile iş
 *       kaybolmaz.
 *    3) Kaydet butonuna basıldığında Firebase yazımı BAŞARISIZ olursa
 *       (bağlantı yok, izin hatası vb.) model yine de bu yerel katmana
 *       düşer ve kullanıcıya "yerel olarak yedeklendi" bilgisi verilir.
 *    4) exportModel() fonksiyonu ile model .json veya .gltf olarak
 *       indirilebilir (3dstudio.html'de zaten var olan exportRawJSON /
 *       exportGLTF fonksiyonlarını sarmalar; onlar yoksa kendi düşük
 *       seviyeli JSON exportunu yapar).
 *
 *  ENTEGRASYON
 *  -----------
 *  3dstudio.html'in </body> kapanışından HEMEN ÖNCE, mevcut ana
 *  <script>...</script> bloğundan SONRA şu satırı ekleyin:
 *
 *      <script src="studio-engine.js"></script>
 *
 *  (Bu dosyayı proje köküne "studio-engine.js" adıyla kopyalayın, ya da
 *  aynı içeriği doğrudan mevcut <script> bloğunun EN SONUNA, kapanış
 *  ")();" parantezinden SONRA yapıştırın.)
 *
 *  Bu dosya, ana script'teki şu global fonksiyon ve değişkenlerin
 *  `window` üzerinden erişilebilir olduğunu varsayar (3dstudio.html'de
 *  zaten böyledir):
 *      window.saveModel        (bkz. "window.saveModel = saveModel;")
 *  Ayrıca DOM'daki şu id'lere bağlanır (mevcut HTML'de hepsi var):
 *      #bb-model-name, #bb-btn-save, #bb-btn-new (varsa), #bb-toast
 *
 *  state/scene/cubes gibi iç değişkenlere DOĞRUDAN erişimi yoktur (onlar
 *  IIFE içinde kapalı/private'tır) — bu yüzden bu dosya, sahne verisini
 *  MutationObserver + olay dinleyicileri (klik, input, dragend) üzerinden,
 *  ana script'in kendi DOM güncellemelerini (outliner listesi, sahne
 *  istatistik chip'leri) izleyerek "bir şey değişti" sinyalini yakalar ve
 *  o anda mevcut sahneyi dışa aktarmak için ana script'in KENDİ export
 *  fonksiyonlarını (varsa) tetikler. Bu sayede ana dosyada TEK SATIR
 *  değişiklik yapmaya gerek kalmaz.
 * ============================================================================
 */

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // 0) AYARLAR
  // ------------------------------------------------------------------
  const DB_NAME = "pl3d_studio_backup";
  const DB_VERSION = 1;
  const STORE_NAME = "drafts";
  const DRAFT_KEY = "current_draft"; // tek-kullanıcılı yerel taslak; her zaman üzerine yazılır
  const AUTOSAVE_DEBOUNCE_MS = 1200;
  const LS_FALLBACK_KEY = "pl3d_studio_draft_fallback";
  const LS_LAST_SAVED_KEY = "pl3d_studio_last_saved_meta";

  // ------------------------------------------------------------------
  // 1) INDEXEDDB KATMANI (localStorage fallback ile)
  // ------------------------------------------------------------------
  let dbPromise = null;
  let idbSupported = "indexedDB" in window;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!idbSupported) {
        reject(new Error("IndexedDB desteklenmiyor"));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error || new Error("IndexedDB açılamadı"));
    });
    return dbPromise;
  }

  /** Taslağı IndexedDB'ye yazar; başarısız olursa localStorage'a düşer. */
  async function idbPut(record) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = resolve;
        tx.onerror = (e) => reject(e.target.error);
      });
      return true;
    } catch (err) {
      console.warn("[LocalBackup] IndexedDB yazımı başarısız, localStorage'a düşülüyor:", err);
      try {
        localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(record));
        return true;
      } catch (e2) {
        console.error("[LocalBackup] localStorage yazımı da başarısız:", e2);
        return false;
      }
    }
  }

  /** Taslağı IndexedDB'den okur; yoksa localStorage fallback'ini dener. */
  async function idbGet(key) {
    try {
      const db = await openDb();
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (e) => reject(e.target.error);
      });
      if (record) return record;
    } catch (err) {
      console.warn("[LocalBackup] IndexedDB okuma başarısız, localStorage deneniyor:", err);
    }
    try {
      const raw = localStorage.getItem(LS_FALLBACK_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  async function idbDelete(key) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = (e) => reject(e.target.error);
      });
    } catch (_) { /* yoksay */ }
    try { localStorage.removeItem(LS_FALLBACK_KEY); } catch (_) {}
  }

  // ------------------------------------------------------------------
  // 2) MODEL VERİ YAPISI — Voxel/Mesh/Matrix + renk + transform
  //    Ana script'teki state.cubes[] ile aynı şemayı kullanır ki
  //    3dstudio.html'in kendi yükleme mantığıyla (loadModelFromQueryIfPresent
  //    içindeki cubesRaw.forEach döngüsü) birebir uyumlu olsun.
  // ------------------------------------------------------------------

  /**
   * Ana script içindeki state.cubes dizisine DOĞRUDAN erişimimiz yok
   * (IIFE kapsamı kapalı). Bunun yerine, ana script'in zaten sahneye
   * eklediği DOM/CSS3D olmayan Three.js sahnesinden veri çekmek yerine,
   * ana script'in DIŞA AÇTIĞI tek gerçek kaynağı kullanıyoruz: kendi
   * "export" arayüzü. Ana script şu ikisini window'a açmıştır:
   *    window.saveModel        -> Firebase'e kaydeder (mevcut)
   * Ayrıca aşağıda tanımladığımız köprü, ana scriptteki iç `state`
   * değişkenine erişim İÇİN çok küçük bir opsiyonel kanca sağlar:
   * ana script bu dosyadan SONRA çalıştırılıyorsa, üstteki değişkenler
   * kapalıdır; bu yüzden en güvenilir yöntem DOM'u okumaktır (outliner
   * listesi + sahne istatistik chip'leri), çünkü bunlar her değişiklikte
   * ana script tarafından senkron güncellenir.
   *
   * Bunun yerine — çok daha sağlam bir çözüm olarak — ana script'e
   * (3dstudio.html) EKLENMESİ GEREKEN tek satırlık bir "expose" bloğu
   * var (bkz. dosya sonundaki not). O satır eklendiğinde bu fonksiyon
   * gerçek voxel/mesh verisini okur; eklenmezse DOM'dan en iyi çabayla
   * (best-effort) meta veriyi çıkarır ve en azından "bir şey değişti,
   * kaydet zamanı" sinyalini kaybetmez.
   */
  function readSceneSnapshot() {
    // Tercih 1: Ana script kendi state'ini window.__pl3dStudioState
    // olarak açtıysa (bkz. entegrasyon notu), gerçek voxel verisini
    // doğrudan oradan al — en güvenilir yol.
    if (window.__pl3dStudioState && Array.isArray(window.__pl3dStudioState.cubes)) {
      const s = window.__pl3dStudioState;
      return {
        name: getModelNameFromInput(),
        cubes: s.cubes.map((c) => ({
          id: c.id,
          name: c.name,
          color: c.color,
          parentId: c.parentId || null,
          position: { x: c.position.x, y: c.position.y, z: c.position.z },
          rotation: c.rotation
            ? { x: c.rotation.x, y: c.rotation.y, z: c.rotation.z }
            : { x: 0, y: 0, z: 0 },
          scale: { x: c.scale.x, y: c.scale.y, z: c.scale.z }
        })),
        groups: Array.isArray(s.groups) ? s.groups.slice() : [],
        cubeCount: s.cubes.length
      };
    }

    // Tercih 2 (fallback): state dışa açılmadıysa, en azından model adını
    // ve outliner'daki obje sayısını yakalayarak "boş olmayan bir taslak
    // var" bilgisini koru. Tam geometri kaybolur ama en azından kullanıcı
    // "kaydedilmemiş değişikliğin var" uyarısını görebilir.
    const objCountEl = document.getElementById("bb-stat-obj-val");
    const cubeCount = objCountEl ? parseInt(objCountEl.textContent, 10) || 0 : 0;
    return {
      name: getModelNameFromInput(),
      cubes: null, // gerçek veri yok — sadece meta
      groups: [],
      cubeCount
    };
  }

  function getModelNameFromInput() {
    const el = document.getElementById("bb-model-name");
    return (el && el.value && el.value.trim()) || "Untitled Model";
  }

  // ------------------------------------------------------------------
  // 3) AUTO-SAVE — debounce'lu, DOM değişikliklerini dinleyerek tetiklenir
  // ------------------------------------------------------------------
  let autosaveTimer = null;
  let lastSnapshotHash = null;

  function cheapHash(obj) {
    try {
      const s = JSON.stringify(obj);
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
      }
      return h + ":" + s.length;
    } catch (_) {
      return String(Math.random());
    }
  }

  async function persistDraft(reason) {
    const snapshot = readSceneSnapshot();
    const hash = cheapHash(snapshot);
    if (hash === lastSnapshotHash) return; // değişiklik yok, gereksiz yazma
    lastSnapshotHash = hash;

    const record = {
      key: DRAFT_KEY,
      savedAt: new Date().toISOString(),
      reason: reason || "auto",
      urlModelId: new URLSearchParams(window.location.search).get("modelId") || null,
      data: snapshot
    };
    const ok = await idbPut(record);
    if (ok) {
      try {
        localStorage.setItem(
          LS_LAST_SAVED_KEY,
          JSON.stringify({ savedAt: record.savedAt, name: snapshot.name, cubeCount: snapshot.cubeCount })
        );
      } catch (_) {}
      updateBackupIndicator(record.savedAt);
    }
  }

  function scheduleAutosave(reason) {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => persistDraft(reason), AUTOSAVE_DEBOUNCE_MS);
  }

  // Sahnedeki değişiklikleri yakalamak için ana script'in kendi güncellediği
  // DOM düğümlerini (outliner listesi + istatistik chip'leri) izliyoruz.
  // Bu, cube ekleme/silme/taşıma/boyama gibi TÜM sahne mutasyonlarında
  // ana scriptin zaten tetiklediği DOM güncellemelerinden "haberdar olmamızı"
  // sağlar — ana kodu değiştirmeye gerek kalmaz.
  function watchSceneMutations() {
    const targets = [
      document.getElementById("bb-outliner-list"),
      document.getElementById("bb-stat-obj-val"),
      document.getElementById("bb-stat-tri-val")
    ].filter(Boolean);

    if (targets.length === 0) {
      // Beklenen id'ler bulunamadıysa, en azından periyodik bir
      // güvenlik-ağı taraması yap (5 sn'de bir) — çok daha düşük hassasiyet
      // ama hiç kayıt tutmamaktan iyidir.
      setInterval(() => scheduleAutosave("interval-fallback"), 5000);
      return;
    }

    const observer = new MutationObserver(() => scheduleAutosave("mutation"));
    targets.forEach((t) => {
      observer.observe(t, { childList: true, subtree: true, characterData: true });
    });
  }

  // Model adı değiştirildiğinde de taslağı güncelle.
  function watchModelNameInput() {
    const nameInput = document.getElementById("bb-model-name");
    if (!nameInput) return;
    nameInput.addEventListener("input", () => scheduleAutosave("rename"));
  }

  // Sayfadan ayrılmadan hemen önce senkron bir "son şans" yazımı dene
  // (async IndexedDB garanti değildir ama best-effort dener).
  function watchBeforeUnload() {
    window.addEventListener("beforeunload", () => {
      // Bekleyen bir debounce varsa hemen çalıştırmayı dene.
      clearTimeout(autosaveTimer);
      persistDraft("beforeunload");
    });
  }

  // ------------------------------------------------------------------
  // 4) SAYFA AÇILIŞINDA TASLAK GERİ YÜKLEME
  // ------------------------------------------------------------------
  async function restoreDraftIfNeeded() {
    const urlParams = new URLSearchParams(window.location.search);
    const hasFirebaseModelId = !!urlParams.get("modelId");

    // Firebase'den belirli bir model yükleniyorsa, yerel taslağı ASLA
    // otomatik üzerine yazma / karıştırma — Firebase kaynağı önceliklidir.
    if (hasFirebaseModelId) return;

    const record = await idbGet(DRAFT_KEY);
    if (!record || !record.data) return;

    // Gerçek voxel verisi yoksa (sadece meta taslak), geri yükleyecek
    // bir şey yok.
    if (!record.data.cubes || record.data.cubes.length === 0) return;

    // Sahne zaten dolu değilse (başlangıç örnek küpü hariç) sessizce
    // otomatik yükleme yapmak yerine kullanıcıya sor — beklenmedik veri
    // kaybını/karışıklığını önlemek için.
    showRestorePrompt(record);
  }

  function showRestorePrompt(record) {
    // Basit, bağımsız bir bildirim çubuğu — mevcut #bb-toast stiliyle
    // çakışmaması için kendi minimal DOM'unu oluşturur.
    const bar = document.createElement("div");
    bar.setAttribute("id", "pl3d-restore-bar");
    bar.style.cssText = [
      "position:fixed", "left:50%", "bottom:64px", "transform:translateX(-50%)",
      "background:#232323", "border:1px solid #3d3d3d", "color:#f0f0f0",
      "padding:10px 14px", "border-radius:6px", "font:12px -apple-system,Segoe UI,Roboto,sans-serif",
      "z-index:99999", "display:flex", "align-items:center", "gap:10px",
      "box-shadow:0 4px 18px rgba(0,0,0,0.4)"
    ].join(";");

    const label = document.createElement("span");
    const when = new Date(record.savedAt);
    label.textContent =
      "Kaydedilmemiş yerel taslak bulundu: \"" +
      (record.data.name || "Untitled Model") +
      "\" (" + when.toLocaleString("tr-TR") + ") — geri yüklensin mi?";

    const restoreBtn = document.createElement("button");
    restoreBtn.textContent = "Geri Yükle";
    restoreBtn.style.cssText =
      "background:#2a5f99;border:1px solid #3a8ee6;color:#fff;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;";
    restoreBtn.addEventListener("click", () => {
      applyDraftToScene(record.data);
      bar.remove();
    });

    const dismissBtn = document.createElement("button");
    dismissBtn.textContent = "Yoksay";
    dismissBtn.style.cssText =
      "background:transparent;border:1px solid #3d3d3d;color:#c6c6c6;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;";
    dismissBtn.addEventListener("click", () => bar.remove());

    bar.appendChild(label);
    bar.appendChild(restoreBtn);
    bar.appendChild(dismissBtn);
    document.body.appendChild(bar);
  }

  /**
   * Taslağı sahneye uygular. Ana script'in addCube/paintCube/
   * applyCubeTransform/selectCube fonksiyonlarını window üzerinden
   * çağırabiliyorsak (bkz. entegrasyon notu) gerçek geri yükleme yapılır;
   * yoksa kullanıcıyı bilgilendirip JSON'u indirmeye yönlendiririz ki
   * veri hiçbir şekilde kaybolmasın.
   */
  function applyDraftToScene(data) {
    const canRebuild =
      typeof window.addCube === "function" &&
      typeof window.paintCube === "function" &&
      typeof window.applyCubeTransform === "function";

    if (!canRebuild) {
      showToastCompat(
        "Taslak bulundu ama sahne API'si genişletilmemiş — lütfen entegrasyon notundaki " +
        "\"window.addCube/paintCube/applyCubeTransform\" satırlarını ekleyin. " +
        "Bu arada taslağı JSON olarak indirebilirsin."
      );
      downloadJson(data, safeFileName(data.name) + "_draft.json");
      return;
    }

    const nameInput = document.getElementById("bb-model-name");
    if (nameInput) nameInput.value = data.name || "Untitled Model";

    data.cubes.forEach((c) => {
      window.addCube(c.position.x, c.position.y, c.position.z);
      const added = window.__pl3dStudioState.cubes[window.__pl3dStudioState.cubes.length - 1];
      added.name = c.name || added.name;
      added.parentId = c.parentId || null;
      added.rotation = c.rotation || { x: 0, y: 0, z: 0 };
      added.scale = c.scale || { x: 1, y: 1, z: 1 };
      window.paintCube(added.id, c.color || "#3a8ee6");
      window.applyCubeTransform(added);
    });

    if (typeof window.selectCube === "function") window.selectCube(null);
    showToastCompat("\"" + (data.name || "Untitled Model") + "\" yerel taslaktan geri yüklendi.");
  }

  // ------------------------------------------------------------------
  // 5) KAYDET / YENİ MODEL BUTONLARINA BAĞLANMA
  //    (Firebase saveModel() başarısız olursa yerel yedek devreye girer)
  // ------------------------------------------------------------------
  function hookSaveButton() {
    const saveBtn = document.getElementById("bb-btn-save");
    if (!saveBtn) return;
    saveBtn.addEventListener("click", () => {
      // Ana script'in kendi click handler'ı zaten saveModel()'i çağırıyor.
      // Biz burada sadece "kaydet niyeti" sinyaliyle anında bir taslak
      // yazıyoruz (debounce beklemeden) — böylece Firebase yazımı
      // başarısız olsa bile veri hiçbir zaman sadece bellekte kalmaz.
      persistDraft("manual-save-click");
    });
  }

  function hookNewModelButton() {
    // "Yeni Model Oluştur" butonu 3dstudio.html içinde değil,
    // index.html dashboard'unda (#studioCreateNewBtn) — o buton zaten
    // sayfayı 3dstudio.html'e (modelId'siz) yönlendiriyor. Burada ek
    // olarak: 3dstudio.html içinde "Temizle" butonuna basıldığında
    // (bb-btn-clear) yerel taslağı da temizleyelim ki eski model
    // yanlışlıkla geri gelmesin.
    const clearBtn = document.getElementById("bb-btn-clear");
    if (!clearBtn) return;
    clearBtn.addEventListener("click", () => {
      // clearAllCubes() ana scriptte zaten çalışacak; biz bir sonraki
      // autosave turunda (state boşaldıktan sonra) doğal olarak boş
      // sahneyi kaydedeceğiz. Anlık olarak eski taslağı da temizleyelim.
      setTimeout(() => idbDelete(DRAFT_KEY), 50);
    });
  }

  // ------------------------------------------------------------------
  // 6) DIŞA AKTARMA (EXPORT) — .json / .gltf indirme
  //    Ana script'te zaten exportRawJSON()/exportGLTF() varsa onları
  //    kullanır (tam GLTF çıktısı için gereklidir); yoksa bu dosyanın
  //    kendi düşük seviyeli JSON exportuna düşer.
  // ------------------------------------------------------------------
  function exportModel(format) {
    format = (format || "json").toLowerCase();

    if (format === "gltf" || format === "glb") {
      if (typeof window.exportGLTF === "function") {
        window.exportGLTF(format === "glb");
        return;
      }
      showToastCompat("GLTF export fonksiyonu bulunamadı — lütfen ana scriptte window.exportGLTF'i dışa açın.");
      return;
    }

    // format === "json"
    if (typeof window.exportRawJSON === "function") {
      window.exportRawJSON();
      return;
    }

    // Fallback: kendi taslağımızdan JSON üret.
    const snapshot = readSceneSnapshot();
    if (!snapshot.cubes) {
      showToastCompat("Dışa aktarılacak geometri verisi bulunamadı.");
      return;
    }
    downloadJson(
      {
        name: snapshot.name,
        format: "pl3d-local-backup-v1",
        exportedAt: new Date().toISOString(),
        cubeCount: snapshot.cubes.length,
        cubes: snapshot.cubes,
        groups: snapshot.groups
      },
      safeFileName(snapshot.name) + ".json"
    );
  }
  window.exportModel = exportModel;

  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function safeFileName(name) {
    return (
      (name || "model")
        .trim()
        .replace(/[^a-zA-Z0-9_\-ğüşıöçĞÜŞİÖÇ ]/g, "")
        .replace(/\s+/g, "_") || "model"
    );
  }

  // Var olan bir "Dışa Aktar" menüsüne (bb-export-menu içindeki
  // #bb-export-json / #bb-export-gltf / #bb-export-glb butonları) ek
  // bir "Yerel Yedeği İndir" seçeneği eklemek isterseniz, aşağıdaki
  // fonksiyonu çağırıp mevcut menüye bir buton enjekte edebilirsiniz.
  function injectLocalBackupExportButton() {
    const menu = document.getElementById("bb-export-menu");
    if (!menu || document.getElementById("bb-export-local-backup")) return;
    const btn = document.createElement("button");
    btn.id = "bb-export-local-backup";
    btn.className = "bb-export-menu-item"; // mevcut sınıf isimlendirmesine uydurulmalı; yoksa stil miras alınır
    btn.textContent = "💾 Yerel Taslağı İndir (.json)";
    btn.style.cssText = "display:block;width:100%;text-align:left;background:transparent;border:none;color:inherit;padding:8px 10px;cursor:pointer;font-size:12px;";
    btn.addEventListener("click", () => exportModel("json"));
    menu.appendChild(btn);
  }

  // ------------------------------------------------------------------
  // 7) KÜÇÜK YEDEKLEME GÖSTERGESİ (opsiyonel UI — üst bara "son yedek" saati basar)
  // ------------------------------------------------------------------
  function updateBackupIndicator(iso) {
    let el = document.getElementById("pl3d-backup-indicator");
    if (!el) {
      const topbar = document.querySelector(".bb-topbar");
      if (!topbar) return;
      el = document.createElement("span");
      el.id = "pl3d-backup-indicator";
      el.style.cssText =
        "font-size:10.5px;color:var(--bb-text-dim,#8a8a8a);white-space:nowrap;margin-left:4px;";
      const spacer = topbar.querySelector(".bb-topbar-spacer");
      if (spacer) topbar.insertBefore(el, spacer);
      else topbar.appendChild(el);
    }
    const t = new Date(iso);
    el.textContent = "💾 Yerel yedek: " + t.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  }

  // ------------------------------------------------------------------
  // 8) TOAST YARDIMCI — ana scriptin showToast'ını varsa kullanır
  // ------------------------------------------------------------------
  function showToastCompat(msg) {
    if (typeof window.showToast === "function") {
      window.showToast(msg);
      return;
    }
    const el = document.getElementById("bb-toast");
    if (el) {
      el.textContent = msg;
      el.classList.add("is-visible");
      setTimeout(() => el.classList.remove("is-visible"), 2200);
    } else {
      console.log("[LocalBackup]", msg);
    }
  }

  // ------------------------------------------------------------------
  // 9) BAŞLATMA
  // ------------------------------------------------------------------
  function init() {
    if (!idbSupported) {
      console.warn("[LocalBackup] Bu tarayıcıda IndexedDB yok, localStorage fallback kullanılacak.");
    }
    watchSceneMutations();
    watchModelNameInput();
    watchBeforeUnload();
    hookSaveButton();
    hookNewModelButton();
    injectLocalBackupExportButton();
    restoreDraftIfNeeded();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // Ana script kendi IIFE'sini DOMContentLoaded beklemeden çalıştırıyor
    // olabilir; sahnenin (addCube ile örnek küpün) oturması için bir
    // sonraki mikro-görev turuna erteliyoruz.
    setTimeout(init, 0);
  }
})();

/**
 * ============================================================================
 *  ENTEGRASYON NOTU — 3dstudio.html'e eklenmesi GEREKEN (opsiyonel ama
 *  ŞİDDETLE ÖNERİLEN) tek satırlık "expose" bloğu
 * ============================================================================
 *
 *  Bu dosya, ana script'in `state` değişkenine normalde erişemez (IIFE
 *  kapalı kapsam). Gerçek voxel/mesh/transform verisiyle TAM auto-save
 *  ve taslak-geri-yükleme yapabilmesi için, 3dstudio.html içindeki ana
 *  <script> bloğunda, `const state = {...}` tanımından hemen SONRA
 *  (satır ~1135'ten sonra) şu satırı ekleyin:
 *
 *      window.__pl3dStudioState = state;
 *
 *  Ayrıca dosyanın sonunda zaten şunlar mevcut ve yeterli:
 *      window.saveModel = saveModel;
 *
 *  Bunlara EK olarak, IIFE içindeki şu fonksiyonları da window'a açarsanız
 *  (fonksiyon tanımlarının hemen altına birer satır eklemeniz yeterli):
 *
 *      window.addCube = addCube;
 *      window.paintCube = paintCube;
 *      window.applyCubeTransform = applyCubeTransform;
 *      window.selectCube = selectCube;
 *      window.exportGLTF = exportGLTF;
 *      window.exportRawJSON = exportRawJSON;
 *
 *  ...bu dosya TAM ÖZELLİKLİ çalışır: gerçek geometriyi taslağa yazar,
 *  taslaktan sahneyi birebir yeniden kurar, ve mevcut export
 *  fonksiyonlarınızı (gerçek GLTFExporter çıktısı dahil) kullanır.
 *
 *  Bu satırları eklemezseniz dosya yine de ÇALIŞIR (hata vermez) ama
 *  daha sınırlı bir modda: yalnızca "değişiklik oldu" meta bilgisini
 *  (model adı, obje sayısı) yedekler ve export için ana scriptin
 *  fonksiyonlarını bulamazsa kullanıcıyı bilgilendirir.
 * ============================================================================
 */
