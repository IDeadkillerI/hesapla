'use strict';
const $ = id => document.getElementById(id);

/* =========================================================
 * BULUT MİMARİSİ
 * Tüm kalıcı veriler Firebase Realtime Database üzerinde tutulur.
 * Yerel dosya veya tarayıcı hafızası kullanılmaz.
 * Veri yolu: printcost/{params|filamentStock|filamentPurchases|products|sales|costHistory}
 * ========================================================= */
const CLOUD_ROOT = 'printcost';

// Sol menüdeki her seçenek ayrı bir sayfa görünümü açar.
function showPage(pageId) {
  document.querySelectorAll('.page-section').forEach(section => {
    section.classList.toggle('active', section.id === pageId);
  });
  document.querySelectorAll('.sidebar nav a[data-page]').forEach(link => {
    const active = link.dataset.page === pageId;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const target = document.getElementById(pageId);
  if (target) target.scrollIntoView({behavior:'smooth', block:'start'});
  // Sayfaya her girişte grafikler sıfırdan dolar.
  if (pageId === 'analysis' && typeof playCostChart === 'function') playCostChart(true);
  requestAnimationFrame(syncSlidingPills);
  if (pageId === 'inventory' && typeof playPriceBars === 'function') playPriceBars(true);
  if (pageId === 'sales' && typeof playSalesChart === 'function') playSalesChart(true);
}
document.querySelectorAll('.sidebar nav a[data-page]').forEach(link => {
  link.addEventListener('click', event => {
    event.preventDefault();
    showPage(link.dataset.page);
    history.replaceState(null, '', `#${link.dataset.page}`);
  });
});

const inputIds = ['filamentPrice','standGrams','lighterCost','targetUnits','wasteRate','printerPower','energyPrice','printerPrice','printerLifeHours','wearCost'];
const stockInputIds = ['minStockKg'];
const defaults = {
  filamentPrice:700, standGrams:210, lighterCost:400, targetUnits:48,
  wasteRate:8, printerPower:120, energyPrice:2.6, printerPrice:18000, printerLifeHours:5000, wearCost:1.5,
  filamentStockKg:0, minStockKg:2
};
const clone = value => JSON.parse(JSON.stringify(value));
let state = {...clone(defaults), products: []};
let sales = [];
let costHistory = [];
// Üretim kayıtları (printcost/productionLogs). Satıştan bağımsız üretim hareketleri.
let productionLogs = [];
// Renk adı → depodaki kilogram. Ayrı bir bulut düğümünde (printcost/filamentStock) tutulur.
let filamentStock = {};
let filamentStockLoaded = false;
let legacyStockChecked = false;
let detailProductId = null;
let lastCommittedParams = clone(defaults);
const dirtyParamKeys = new Set();
let cloudReady = false;
let firebaseConnected = false;
let paramsInitialized = false;
let db = null;
let rootRef = null;
let paramsRef = null;
let productsRef = null;
let salesRef = null;
let historyRef = null;
let filamentStockRef = null;
let maintenanceFundRef = null;
let maintenanceLogsRef = null;
let productionLogsRef = null;
let filamentPurchasesRef = null;
// Filament alımları (printcost/filamentPurchases): her alım bir gider kaydıdır.
let filamentPurchases = [];
let presenceRef = null;
// Bakım & gider fonu (printcost/maintenanceFund) ve gerçek masraf kayıtları.
let maintenanceFund = {balance:0, totalAccrued:0, totalSpent:0, updatedAt:0};
let maintenanceLogs = [];
// Filament stok girişleri: renk → {kg, totalWeightGrams, weightedAveragePricePerKg}.
// Eski kayıtlarda değer düz bir sayı (kg) olabilir; normalizeStockEntry geriye dönük uyumluluk sağlar.
const selectedProducts = new Set(), selectedSales = new Set();
const pendingDeletes = new Map();
let hiddenSince = 0;

/* ---------- Firebase başlatma ve canlı dinleyiciler ---------- */
function setCloudStatus(mode, text, sub) {
  const note = $('cloudNote');
  if (note) note.dataset.status = mode;
  const textEl = $('cloudStatusText');
  if (textEl) textEl.textContent = text;
  const subEl = $('cloudStatusSub');
  if (subEl && sub) subEl.textContent = sub;
}
function cloudError(error, action) {
  console.error(action, error);
  toast(`Bulut işlemi başarısız: ${action}`);
}
function initFirebase() {
  const cfg = window.FIREBASE_CONFIG;
  const missing = !cfg || !cfg.apiKey || !cfg.databaseURL
    || String(cfg.apiKey).includes('YOUR_') || String(cfg.databaseURL).includes('YOUR_');
  if (missing) {
    setCloudStatus('error', 'Firebase yapılandırması bekleniyor', 'firebase-config.js dosyasına proje bilgilerini gir.');
    const banner = $('cloudBanner');
    if (banner) banner.hidden = false;
    authUnavailable('Firebase yapılandırması eksik. firebase-config.js dosyasını doldur.');
    return;
  }
  if (typeof firebase === 'undefined') {
    setCloudStatus('error', 'Firebase SDK yüklenemedi', 'İnternet bağlantısını kontrol edip sayfayı yenile.');
    toast('Firebase SDK yüklenemedi. İnternet bağlantısını kontrol et.');
    authUnavailable('Firebase SDK yüklenemedi. İnternet bağlantını kontrol edip sayfayı yenile.');
    return;
  }
  try {
    firebase.initializeApp(cfg);
    db = firebase.database();
    // Firebase Realtime Database Web SDK, sekme açıkken yerel write-queue ve otomatik retry sağlar.
    // Android/iOS'a özgü setPersistenceEnabled() Web SDK'da bulunmadığından çağrılmaz.
    rootRef = db.ref(CLOUD_ROOT);
    paramsRef = rootRef.child('params');
    productsRef = rootRef.child('products');
    salesRef = rootRef.child('sales');
    historyRef = rootRef.child('costHistory');
    filamentStockRef = rootRef.child('filamentStock');
    maintenanceFundRef = rootRef.child('maintenanceFund');
    maintenanceLogsRef = rootRef.child('maintenanceLogs');
    productionLogsRef = rootRef.child('productionLogs');
    filamentPurchasesRef = rootRef.child('filamentPurchases');
    presenceRef = rootRef.child('system/presence');
    cloudReady = true;
    const banner = $('cloudBanner');
    if (banner) banner.hidden = true;
    initAuth();   // dinleyiciler yalnızca başarılı girişten sonra bağlanır
  } catch (error) {
    cloudReady = false;
    authUnavailable('Firebase başlatılamadı. Yapılandırma değerlerini kontrol et.');
    setCloudStatus('error', 'Firebase başlatılamadı', 'Yapılandırma değerlerini kontrol et.');
    cloudError(error, 'Firebase başlatma');
  }
}
function attachCloudListeners() {
  db.ref('.info/connected').on('value', snap => {
    const connected = snap.val() === true;
    firebaseConnected = connected;
    setCloudStatus(
      connected ? 'online' : 'offline',
      connected ? 'Bulut bağlı · veriler Firebase’de' : 'Bağlantı kuruluyor…',
      connected ? 'Bulut bağlı; bekleyen sekme içi yazmalar eşitleniyor.' : 'Bağlantı yok; sekme açık kaldığı sürece yazmalar kuyruklanır.'
    );
  }, error => cloudError(error, 'bağlantı durumu'));

  // Maliyet parametreleri: her değişiklik anında buluta yazılır, onValue ile geri okunur.
  paramsRef.on('value', snap => {
    if (!snap.exists()) {
      paramsRef.set(clone(defaults)).catch(error => cloudError(error, 'varsayılan parametreler'));
      return;
    }
    const remote = snap.val() || {};
    [...inputIds, ...stockInputIds, 'filamentStockKg'].forEach(key => {
      const value = Number(remote[key]);
      const safe = Number.isFinite(value) ? value : defaults[key];
      const el = $(key);
      // Kullanıcının henüz buluta yazmadığı yerel değer, gelen yankıyla ezilmez.
      if (dirtyParamKeys.has(key)) {
        state[key] = num(key);
        return;
      }
      state[key] = safe;
      if (el && document.activeElement !== el && String(el.value) !== String(safe)) el.value = safe;
    });
    if (!paramsInitialized) {
      lastCommittedParams = clone(params());
      paramsInitialized = true;
      if ($('stockAddPrice')) $('stockAddPrice').value = state.filamentPrice;
    } else {
      // Uzak cihazdan gelen ve yerelde düzenlenmeyen değerleri referans kabul et.
      inputIds.forEach(key => {
        if (!dirtyParamKeys.has(key)) lastCommittedParams[key] = state[key];
      });
    }
    maybeMigrateLegacyStock();
    renderProducts();
    renderSales();
    renderInventory();
  }, error => {
    setCloudStatus('error', 'Bulut okunamadı', 'Realtime Database kurallarını kontrol et.');
    cloudError(error, 'parametreleri okuma');
  });

  // Ürünler: push anahtarı ürün kimliği olarak kullanılır.
  productsRef.on('value', snap => {
    const value = snap.val() || {};
    state.products = Object.entries(value)
      .filter(([id]) => !pendingDeletes.has(`product:${id}`))
      // ÖNEMLİ: id en son yazılır. Eski yedeklerden gelen kayıtlarda kaydın içinde
      // bulunan "id" alanı Firebase anahtarını ezerse üretim/satış işlemleri yanlış
      // anahtarla arama yapar. Böylece yerel id her zaman gerçek bulut anahtarıdır.
      .map(([id, product]) => ({...product, id}))
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    renderProducts();
    renderSales();
  }, error => cloudError(error, 'ürünleri okuma'));

  // Satışlar
  salesRef.on('value', snap => {
    const value = snap.val() || {};
    sales = Object.entries(value).filter(([id]) => !pendingDeletes.has(`sale:${id}`)).map(([id, record]) => ({id, ...record}));
    renderSales();
  }, error => cloudError(error, 'satışları okuma'));

  // Maliyet / fiyat geçmişi
  historyRef.on('value', snap => {
    const value = snap.val() || {};
    costHistory = Object.entries(value).map(([id, entry]) => ({id, ...entry}));
    renderCostHistory();
    renderInventory();
  }, error => cloudError(error, 'fiyat geçmişini okuma'));

  // Renk bazlı filament stoğu: her renk ayrı anahtar olarak tutulur (kg).
  filamentStockRef.on('value', snap => {
    filamentStock = snap.val() || {};
    filamentStockLoaded = true;
    maybeMigrateLegacyStock();
    renderProducts();
    renderInventory();
  }, error => cloudError(error, 'filament stoğunu okuma'));

  // Bakım fonu havuzu: satışlardan biriken teorik pay.
  maintenanceFundRef.on('value', snap => {
    const value = snap.val() || {};
    maintenanceFund = {
      balance: Number(value.balance) || 0,
      totalAccrued: Number(value.totalAccrued) || 0,
      totalSpent: Number(value.totalSpent) || 0,
      updatedAt: Number(value.updatedAt) || 0
    };
    renderMaintenance();
  }, error => cloudError(error, 'bakım fonunu okuma'));

  // Gerçek bakım masrafları.
  maintenanceLogsRef.on('value', snap => {
    const value = snap.val() || {};
    maintenanceLogs = Object.entries(value)
      .map(([id, log]) => ({id, ...log}))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    renderMaintenance();
  }, error => cloudError(error, 'bakım masraflarını okuma'));

  // Üretim kayıtları: hangi üründen kaç adet üretildiği ve tüketilen renk gramları.
  if (productionLogsRef) productionLogsRef.on('value', snap => {
    const value = snap.val() || {};
    productionLogs = Object.entries(value)
      .map(([id, log]) => ({id, ...log}))
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    if ($('productDetailModal') && !$('productDetailModal').hidden) renderProductDetail();
  }, error => cloudError(error, 'üretim kayıtlarını okuma'));

  // Filament alım giderleri.
  filamentPurchasesRef.on('value', snap => {
    const value = snap.val() || {};
    filamentPurchases = Object.entries(value)
      .map(([id, p]) => ({id, ...p}))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    renderPurchases();
    renderSales();
  }, error => cloudError(error, 'filament alımlarını okuma'));

  // onDisconnect: sekme kapanınca/bağlantı kopunca oturum "offline" işaretlenir.
  // Bu düğüm yalnızca bağlantı sağlığı göstergesidir; stok/satış verisini etkilemez.
  if (presenceRef) {
    const sessionId = Math.random().toString(36).slice(2, 10);
    const onlinePayload = {state:'online', sessionId, at: Date.now()};
    presenceRef.child(sessionId).onDisconnect().remove();
    presenceRef.child(sessionId).set(onlinePayload).catch(() => {});
    window.addEventListener('beforeunload', () => { presenceRef.child(sessionId).remove().catch(() => {}); });
  }

  // navigator.onLine tabanlı çevrimdışı uyarısı (Firebase .info/connected tamamlayıcısı).
  window.addEventListener('offline', () => {
    setCloudStatus('offline', 'İnternet bağlantısı yok', 'Stoklu satışlar bağlantı gelene kadar güvenlik için engellenir.');
    toast('İnternet bağlantısı kesildi. Stoklu satışlar bağlantı gelene kadar bekletilecek.', 'warning');
  });
  window.addEventListener('online', () => {
    setCloudStatus('connecting', 'Bağlantı yeniden kuruluyor…', 'Bekleyen yazmalar eşitleniyor.');
    toast('İnternet bağlantısı geri geldi; bulut yeniden eşitleniyor.', 'info');
  });
  if (navigator.onLine === false) {
    setCloudStatus('offline', 'İnternet bağlantısı yok', 'Stoklu satışlar bağlantı gelene kadar engellenir.');
  }
}

/* ---------- Ağırlıklı ortalama maliyet (WACC) yardımcıları ----------
   Yeni stok kayıtları {kg, totalWeightGrams, weightedAveragePricePerKg} nesnesidir.
   Eski kayıtlar düz sayı (kg) olduğundan okurken normalize edilir; böylece veri
   yapısı değişse bile mevcut Firebase verisi bozulmadan çalışmaya devam eder. */
function normalizeStockEntry(raw) {
  if (raw && typeof raw === 'object') {
    const legacyKg = Math.max(0, Number(raw.kg) || 0);
    const grams = Math.max(0, Number(raw.totalWeightGrams) || legacyKg * 1000);
    const price = Number(raw.weightedAveragePricePerKg);
    return {
      kg: grams / 1000,
      totalWeightGrams: grams,
      weightedAveragePricePerKg: Number.isFinite(price) && price > 0 ? price : null
    };
  }
  const kg = Math.max(0, Number(raw) || 0);
  return {kg, totalWeightGrams:kg * 1000, weightedAveragePricePerKg:null};
}
function stockKgOf(color) { return normalizeStockEntry(filamentStock[color]).kg; }
// Bir rengin ağırlıklı ortalama fiyatı; kayıt yoksa genel filament fiyatına düşer.
function colorAveragePrice(color, fallback) {
  const entry = normalizeStockEntry(filamentStock[color]);
  return entry.weightedAveragePricePerKg ?? (Number(fallback) || 0);
}
const round3 = value => Math.round((Number(value) || 0) * 1000) / 1000;
const round2 = value => Math.round((Number(value) || 0) * 100) / 100;
const round4 = value => Math.round((Number(value) || 0) * 10000) / 10000;

// Eski tek değerli filamentStockKg kaydı varsa "Genel" rengine taşınır.
function maybeMigrateLegacyStock() {
  if (legacyStockChecked || !filamentStockLoaded || !paramsInitialized) return;
  legacyStockChecked = true;
  const legacyKg = Math.max(0, Number(state.filamentStockKg) || 0);
  if (!Object.keys(filamentStock).length && legacyKg > 0 && cloudReady) {
    filamentStockRef.child('Genel').set(legacyKg)
      .then(() => toast('Eski tek renk stok kaydı "Genel" rengine taşındı.'))
      .catch(error => cloudError(error, 'eski stok taşıma'));
  }
}

/* ---------- Yazma yardımcıları ---------- */
const pendingParamWrites = {};
let paramWriteTimer = null;
function pendingWriteCount() { return Object.keys(pendingParamWrites).length; }
function queueParamWrite(key, value) {
  if (!cloudReady) return;
  pendingParamWrites[key] = value;
  clearTimeout(paramWriteTimer);
  paramWriteTimer = setTimeout(flushParamWrites, 350);
}
function flushParamWrites() {
  clearTimeout(paramWriteTimer);
  const payload = {...pendingParamWrites};
  Object.keys(pendingParamWrites).forEach(key => delete pendingParamWrites[key]);
  if (!cloudReady || !Object.keys(payload).length) return;
  paramsRef.update(payload).catch(error => cloudError(error, 'parametreleri kaydetme'));
}
function writeProductItem(id, fields) {
  if (!cloudReady || !id) return;
  return productsRef.child(id).update(fields).catch(error => cloudError(error, 'ürünü güncelleme'));
}
function writeColorStock(color, kg) {
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan stok kaydedilemez.'); return Promise.reject(new Error('offline')); }
  const safe = Math.max(0, Number(kg) || 0);
  const existing = normalizeStockEntry(filamentStock[color]);
  // Miktar elle düzenlense de ağırlıklı ortalama fiyat korunur; eski düz sayı
  // kayıtlarında fiyat bilinmediği için güncel parametre fiyatı baz alınır.
  const payload = {
    kg: round3(safe),
    totalWeightGrams: Math.round(safe * 1000),
    weightedAveragePricePerKg: existing.weightedAveragePricePerKg ?? params().filamentPrice,
    updatedAt: Date.now()
  };
  return filamentStockRef.child(color).set(payload)
    .catch(error => { cloudError(error, 'renk stoğu'); throw error; });
}
function deleteColorStock(color) {
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan stok silinemez.'); return; }
  filamentStockRef.child(color).remove().catch(error => cloudError(error, 'renk stoğu silme'));
}

/* ---------- Kurumsal veri doğrulama, stok kilidi ve geri alma ---------- */
function parseStrictNumber(value, {min=0, max=Number.MAX_SAFE_INTEGER, integer=false}={}) {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!raw) return {ok:false, reason:'Boş değer'};
  // Yalnızca ondalık / bilimsel gösterim kabul edilir; "12abc" gibi değerler sessizce sayıya çevrilmez.
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return {ok:false, reason:'Geçersiz sayısal biçim'};
  const number = Number(raw);
  if (!Number.isFinite(number)) return {ok:false, reason:'Geçersiz sayısal değer'};
  if (number < min) return {ok:false, reason:`Değer en az ${min} olmalı`};
  if (number > max) return {ok:false, reason:`Değer en fazla ${max} olabilir`};
  if (integer && !Number.isInteger(number)) return {ok:false, reason:'Tam sayı girilmeli'};
  return {ok:true, value:number};
}
function numericFieldLabel(el) {
  return el.getAttribute('aria-label')
    || el.closest('label')?.querySelector('span')?.textContent?.trim()
    || el.closest('label')?.innerText?.trim()
    || el.id
    || 'Sayısal alan';
}
function validateNumericElement(el, {silent=false}={}) {
  if (!el || el.type !== 'number') return true;
  const min = el.min === '' ? 0 : Number(el.min);
  const max = el.max === '' ? Number.MAX_SAFE_INTEGER : Number(el.max);
  const integer = el.step === '1';
  const parsed = parseStrictNumber(el.value, {min:Number.isFinite(min)?min:0,max:Number.isFinite(max)?max:Number.MAX_SAFE_INTEGER,integer});
  if (!parsed.ok) {
    el.setCustomValidity(parsed.reason);
    el.setAttribute('aria-invalid','true');
    el.classList.add('is-invalid');
    if (!silent) toast(`${numericFieldLabel(el)}: ${parsed.reason}.`, 'warning');
    return false;
  }
  el.setCustomValidity(''); el.removeAttribute('aria-invalid'); el.classList.remove('is-invalid');
  return true;
}
// Form gönderimi / hesaplama öncesi merkezi doğrulama.
// Görünür tüm sayısal alanları kontrol eder; hata varsa işlemi durdurur.
function validateFormInputs(scope=document) {
  const problems = [];
  scope.querySelectorAll('input[type="number"]').forEach(el => {
    if (el.disabled || el.readOnly || el.closest('[hidden]')) return;
    const min = el.min === '' ? 0 : Number(el.min);
    const max = el.max === '' ? Number.MAX_SAFE_INTEGER : Number(el.max);
    const integer = el.step === '1';
    const parsed = parseStrictNumber(el.value, {min:Number.isFinite(min)?min:0,max:Number.isFinite(max)?max:Number.MAX_SAFE_INTEGER,integer});
    if (!parsed.ok) {
      el.setCustomValidity(parsed.reason);
      el.setAttribute('aria-invalid','true');
      el.classList.add('is-invalid');
      problems.push({el, reason:parsed.reason});
    }
  });
  // Sıfıra bölme riski taşıyan kritik parametreler için ek güvence.
  [['printerLifeHours','Makine ömrü en az 1 saat olmalı'],['targetUnits','Hedef üretim adedi en az 1 olmalı']].forEach(([id, reason]) => {
    const el = $(id);
    if (!el || el.disabled || el.readOnly || el.closest('[hidden]')) return;
    if (!parseStrictNumber(el.value, {min:1}).ok) {
      el.setCustomValidity(reason);
      el.setAttribute('aria-invalid','true');
      el.classList.add('is-invalid');
      if (!problems.some(problem => problem.el === el)) problems.push({el, reason});
    }
  });
  if (!problems.length) return true;
  const first = problems[0];
  if (first.el.focus) first.el.focus();
  toast(`${numericFieldLabel(first.el)}: ${first.reason}. İşlem durduruldu.`, 'error');
  return false;
}
document.addEventListener('focusout', event => {
  if (event.target?.matches?.('input[type="number"]')) validateNumericElement(event.target);
});
document.addEventListener('input', event => {
  if (event.target?.matches?.('input[type="number"]')) validateNumericElement(event.target,{silent:true});
});
/* =========================================================
 * MAMUL STOK & ÜRETİM MİMARİSİ
 * - Satışlar yalnızca products/{id}/readyStock (hazır mamul adedi) düşer.
 * - Hammadde (renk bazlı filament) yalnızca "Üret" akışında tüketilir.
 * - Üretim: filament kontrolü → renk gramlarını düş → mamul stoğu artır → log yaz.
 * ========================================================= */
function readyStockOf(product) {
  return Math.max(0, Math.floor(Number(product?.readyStock) || 0));
}
function stockGuardMessage() { return 'Yetersiz mamul stok / önce üretim yap'; }
const TX_MAX_ATTEMPTS = 3;
function txRetryDelay(attempt) { return 400 * Math.pow(2, attempt) + Math.floor(Math.random() * 250); }
function txShouldRetry(error) { return !/PERMISSION_DENIED/i.test(String(error?.code || error?.message || '')); }

/**
 * Transaction süresince kök düğüm önbelleğini açık tutar.
 *
 * Firebase Web SDK'da transaction, yolun değeri yerel önbellekte yoksa update
 * fonksiyonunu `null` ile çağırır ve dönen değer `undefined` ise SUNUCUYA HİÇ
 * GİTMEDEN iptal eder (onComplete(null, false)). Uygulama `printcost` kökünü
 * doğrudan dinlemediği için (yalnızca products, sales vb. alt düğümler dinlenir)
 * kök önbelleği boştur; bu yüzden geçerli ürün "bulunamadı" sanılıyordu.
 *
 * Tek seferlik `once()` çözüm değildir: dinleyici kalkınca SDK önbellek düğümünü
 * de siler. Bu yüzden ilk değer gelene kadar bekleyen AKTİF bir dinleyici kurulur
 * ve transaction bitene kadar (release çağrılana kadar) kaldırılmaz.
 *
 * Kullanım: acquireRootCache().then(release => islem().finally(release));
 */
function acquireRootCache() {
  if (!rootRef) return Promise.resolve(() => {});
  return new Promise(resolve => {
    let settled = false, timer = null;
    let release = () => {};
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) { try { rootRef.off('value', handler); } catch (e) { /* yok say */ } }
      resolve(release);
    };
    const handler = () => finish(true);
    release = () => {
      try { rootRef.off('value', handler); } catch (e) { /* yok say */ }
    };
    try {
      rootRef.on('value', handler, error => {
        console.warn('Kök veri senkronizasyonu başarısız; transaction yine de denenecek.', error);
        finish(false);
      });
    } catch (error) {
      console.warn('Kök veri dinleyicisi kurulamadı; transaction yine de denenecek.', error);
      finish(false);
      return;
    }
    // Bağlantı hiç kurulamazsa sonsuza kadar beklememek için güvenlik zaman aşımı.
    timer = setTimeout(() => finish(false), 10000);
    // Transaction beklenmedik şekilde takılırsa dinleyici 30 sn sonra yine bırakılır.
    setTimeout(() => { if (settled) release(); }, 30000);
  });
}

/**
 * Satışı + mamul stok düşümünü + bakım fonu tahakkukunu tek atomik transaction'da birleştirir.
 * requirements: [{productId, name, qty}] — satılan mamul adetleri.
 * Hammadde filament stoğuna bu fonksiyon dokunmaz; o yalnızca handleProduction'da düşer.
 */
function commitSaleWithFinishedStock(record, requirements, maintenanceShare = 0) {
  if (!cloudReady || !rootRef) return Promise.reject(new Error('Bulut bağlantısı kurulmadan satış kaydedilemez.'));
  if (!firebaseConnected || navigator.onLine === false) {
    toast('Bağlantı yok. Mamul stok doğrulamalı satış, stok güvenliği için bağlantı gelene kadar engellendi.', 'warning');
    return Promise.reject(new Error('offline-stock-guard'));
  }
  const saleRef = salesRef.push();
  const share = Math.max(0, Number(maintenanceShare) || 0);
  let shortages = [];

  const runAttempt = attempt => new Promise((resolve, reject) => {
    let shortage = false, duplicate = false;
    shortages = [];
    rootRef.transaction(current => {
      shortage = false; duplicate = false; shortages = [];
      const root = current || {};
      // Ağ hatası sonrası yeniden denemede satış zaten yazıldıysa çift kayıt engellenir.
      if (root.sales && root.sales[saleRef.key]) { duplicate = true; return; }
      const products = {...(root.products || {})};
      for (const req of requirements) {
        // Üretimdekiyle aynı esnek kimlik çözümlemesi: anahtar / normalize anahtar /
        // kayıt içi id / benzersiz ad. Böylece satışta da stok bulunamama hatası oluşmaz.
        const productKey = matchProductKey(products, req.productId, req.name);
        const product = productKey ? products[productKey] : null;
        const available = readyStockOf(product);
        const wanted = Math.max(0, Math.floor(Number(req.qty) || 0));
        if (!productKey || !product || available < wanted) {
          shortage = true;
          shortages.push({ name: req.name || product?.name || 'Ürün', available, qty: wanted });
          return;
        }
        products[productKey] = {...product, readyStock: available - wanted};
      }
      root.products = products;
      root.sales = {...(root.sales || {}), [saleRef.key]: record};
      // Bakım fonu: satışın teorik bakım payı aynı atomik işlemde havuza eklenir.
      if (share > 0) {
        const fund = root.maintenanceFund && typeof root.maintenanceFund === 'object' ? root.maintenanceFund : {};
        root.maintenanceFund = {
          ...fund,
          balance: round2((Number(fund.balance) || 0) + share),
          totalAccrued: round2((Number(fund.totalAccrued) || 0) + share),
          updatedAt: Date.now()
        };
      }
      return root;
    }, (error, committed) => {
      if (error) {
        if (attempt < TX_MAX_ATTEMPTS - 1 && txShouldRetry(error)) {
          setTimeout(() => runAttempt(attempt + 1).then(resolve, reject), txRetryDelay(attempt));
          return;
        }
        cloudError(error, 'mamul stok kontrollü satış');
        toast('Mamul stok güncellenemedi, lütfen tekrar deneyin. Satış kaydedilmedi.', 'error', {title:'Stok senkronizasyonu başarısız'});
        reject(error); return;
      }
      if (!committed) {
        if (duplicate) { resolve(saleRef.key); return; }
        if (shortage) {
          const detail = shortages.map(s => `${s.name}: hazır ${fmt(s.available,0)}, istenen ${fmt(s.qty,0)}`).join(' · ');
          toast(`${stockGuardMessage()}. ${detail}. Satış kaydedilmedi.`, 'warning', {title:'Mamul stok yetersiz'});
          reject(new Error('insufficient-finished-stock')); return;
        }
        // Eşzamanlı çakışma / iptal: üstel geri çekilmeyle yeniden dene.
        if (attempt < TX_MAX_ATTEMPTS - 1) {
          setTimeout(() => runAttempt(attempt + 1).then(resolve, reject), txRetryDelay(attempt));
          return;
        }
        toast('Mamul stok güncellenemedi (eşzamanlı çakışma), lütfen tekrar deneyin.', 'error', {title:'Stok senkronizasyonu başarısız'});
        reject(new Error('transaction-aborted')); return;
      }
      resolve(saleRef.key);
    }, false);
  });
  return acquireRootCache().then(release => runAttempt(0).finally(release));
}

// Üretimde kullanılacak renk tüketimini [{name, grams}] biçimine getirir.
function normalizeColorUsage(colorUsageMap) {
  const list = Array.isArray(colorUsageMap)
    ? colorUsageMap
    : Object.entries(colorUsageMap || {}).map(([name, grams]) => ({name, grams}));
  return list
    .map(row => ({name: sanitizeColorName(row?.name), grams: Math.max(0, Number(row?.grams) || 0)}))
    .filter(row => row.name && row.grams > 0);
}

/**
 * Tek merkezli üretim akışı.
 * handleProduction(productId, quantity, colorUsageMap)
 * colorUsageMap: [{name:'Siyah', grams:1200}] — tüm üretim için toplam gram.
 *
 * Atomik olarak: her rengin filament stoğunu kontrol eder → yeterliyse gramları düşer
 * → ürünün readyStock (mamul) adedini artırır → productionLogs'a kayıt yazar.
 * Yetersiz hammadde varsa hiçbir alan yazılmaz ve işlem reddedilir.
 */
function handleProduction(productId, quantity, colorUsageMap, nameHint) {
  if (!cloudReady || !rootRef) return Promise.reject(new Error('Bulut bağlantısı kurulmadan üretim kaydedilemez.'));
  if (!firebaseConnected || navigator.onLine === false) {
    toast('Bağlantı yok. Hammadde stok kontrolü gerektiren üretim, bağlantı gelene kadar engellendi.', 'warning');
    return Promise.reject(new Error('offline-stock-guard'));
  }
  const qtyParsed = parseStrictNumber(quantity, {min:1, max:100000, integer:true});
  if (!qtyParsed.ok) {
    toast(`Üretim adedi geçersiz: ${qtyParsed.reason}.`, 'warning');
    return Promise.reject(new Error('invalid-quantity'));
  }
  const qty = qtyParsed.value;
  const usage = normalizeColorUsage(colorUsageMap);
  if (!usage.length) {
    toast('Üretim için en az bir renk ve tüketilecek gram gir.', 'warning');
    return Promise.reject(new Error('empty-usage'));
  }
  const logRef = productionLogsRef.push();
  const fallbackPrice = params().filamentPrice;
  // Eşleştirme için ürün adı ipucu: modal, yerel kayıt artık görünmüyorsa bile adı geçirir.
  let productNameHint = String(nameHint || productById(productId)?.name || '');
  // İlk denemede çözülen anahtar kullanılır; bulut anlık görüntüsü eskiyse taze okumayla güncellenir.
  let lookupId = productId;
  let freshLookupDone = false;
  let shortages = [];

  const runAttempt = attempt => new Promise((resolve, reject) => {
    let shortage = false, duplicate = false, missingProduct = false;
    shortages = [];
    rootRef.transaction(current => {
      shortage = false; duplicate = false; missingProduct = false; shortages = [];
      const root = current || {};
      if (root.productionLogs && root.productionLogs[logRef.key]) { duplicate = true; return; }
      const products = {...(root.products || {})};
      // ID'yi esnek çöz: birebir anahtar, normalize anahtar, kayıt içi id veya benzersiz ad.
      const productKey = matchProductKey(products, lookupId, productNameHint)
        || matchProductKey(products, productId, productNameHint);
      const product = productKey ? products[productKey] : null;
      if (!productKey || !product) { shortage = true; missingProduct = true; return; }
      const stock = {...(root.filamentStock || {})};
      for (const use of usage) {
        const raw = stock[use.name];
        const entry = normalizeStockEntry(raw);
        if (entry.totalWeightGrams + 1e-6 < use.grams) {
          shortage = true;
          shortages.push({ name: use.name, needed: use.grams, available: entry.totalWeightGrams });
          return;
        }
        const remainingGrams = Math.max(0, entry.totalWeightGrams - use.grams);
        stock[use.name] = {
          ...(raw && typeof raw === 'object' ? raw : {}),
          kg: round3(remainingGrams / 1000),
          totalWeightGrams: Math.round(remainingGrams),
          weightedAveragePricePerKg: entry.weightedAveragePricePerKg ?? fallbackPrice,
          updatedAt: Date.now()
        };
      }
      root.filamentStock = stock;
      const readyStock = readyStockOf(product) + qty;
      products[productKey] = {...product, readyStock};
      root.products = products;
      root.productionLogs = {
        ...(root.productionLogs || {}),
        [logRef.key]: {
          date: todayISO(),
          productId: productKey,
          productName: product.name || 'İsimsiz ürün',
          qty,
          colors: usage.map(use => ({name: use.name, grams: Math.round(use.grams * 100) / 100})),
          totalGrams: Math.round(usage.reduce((sum, use) => sum + use.grams, 0) * 100) / 100,
          readyStockAfter: readyStock,
          createdAt: Date.now()
        }
      };
      return root;
    }, (error, committed) => {
      if (error) {
        if (attempt < TX_MAX_ATTEMPTS - 1 && txShouldRetry(error)) {
          setTimeout(() => runAttempt(attempt + 1).then(resolve, reject), txRetryDelay(attempt));
          return;
        }
        cloudError(error, 'üretim kaydı');
        toast('Üretim kaydedilemedi, lütfen tekrar deneyin.', 'error', {title:'Stok senkronizasyonu başarısız'});
        reject(error); return;
      }
      if (!committed) {
        if (duplicate) { resolve(logRef.key); return; }
        if (shortage) {
          if (missingProduct) {
            // 1) Yerelde ürün varken bulut anlık görüntüsü henüz ürünleri içermiyorsa
            //    (ilk bağlantı / sekme uyanması) hemen hata vermek yerine kısa bir
            //    gecikmeyle tekrar denenir.
            if (productById(productId) && attempt < TX_MAX_ATTEMPTS - 1) {
              setTimeout(() => runAttempt(attempt + 1).then(resolve, reject), txRetryDelay(attempt));
              return;
            }
            // 2) Son çare: ürün anahtarını buluttan taze oku. Yerel liste eski kalmışsa
            //    (ör. başka cihazda yedek geri yükleme / anahtar yenilenmesi) doğru
            //    anahtar bulunup üretim onunla yeniden denenir.
            if (!freshLookupDone && productsRef) {
              freshLookupDone = true;
              console.warn('Üretim: bulut anlık görüntüsünde ürün yok, taze veriyle yeniden deneniyor.', { productId, productNameHint });
              productsRef.once('value').then(snap => {
                const freshProducts = snap.val() || {};
                const freshKey = matchProductKey(freshProducts, productId, productNameHint)
                  || matchProductKey(freshProducts, lookupId, productNameHint);
                if (freshKey) {
                  lookupId = freshKey;
                  if (freshProducts[freshKey]?.name) productNameHint = freshProducts[freshKey].name;
                  runAttempt(0).then(resolve, reject);
                } else {
                  console.warn('Üretim: ürün bulutta da bulunamadı.', { productId, lookups: Object.keys(freshProducts).slice(0, 20) });
                  toast('Ürün bulunamadı. Üretim kaydedilmedi.', 'error');
                  reject(new Error('missing-product'));
                }
              }).catch(error => {
                console.error('üretim ürünü doğrulama', error);
                toast('Ürün bulunamadı. Üretim kaydedilmedi.', 'error');
                reject(new Error('missing-product'));
              });
              return;
            }
            toast('Ürün bulunamadı. Üretim kaydedilmedi.', 'error');
            reject(new Error('missing-product')); return;
          }
          const detail = shortages.map(s => `${s.name}: stok ${fmt(s.available/1000,3)} kg, gereken ${fmt(s.needed/1000,3)} kg`).join(' · ');
          toast(`Yetersiz hammadde. ${detail}. Üretim kaydedilmedi.`, 'error', {title:'Filament stoğu yetersiz'});
          reject(new Error('insufficient-filament')); return;
        }
        if (attempt < TX_MAX_ATTEMPTS - 1) {
          setTimeout(() => runAttempt(attempt + 1).then(resolve, reject), txRetryDelay(attempt));
          return;
        }
        toast('Üretim kaydedilemedi (eşzamanlı çakışma), lütfen tekrar deneyin.', 'error', {title:'Stok senkronizasyonu başarısız'});
        reject(new Error('transaction-aborted')); return;
      }
      resolve(logRef.key);
    }, false);
  });
  return acquireRootCache().then(release => runAttempt(0).finally(release));
}

/**
 * Üretimi geri al.
 * Tek transaction'da: üretim kaydını siler → kaydın tükettiği renk gramlarını filament
 * stoğuna geri ekler (ağırlıklı ortalama fiyat korunur) → ürünün hazır mamul adedini
 * üretilen adet kadar düşer. Üretilen adetlerin bir kısmı satıldıysa (mamul stok < adet)
 * işlem reddedilir; çünkü stok negatife düşemez.
 */
function undoProduction(logId) {
  if (!cloudReady || !rootRef) { toast('Bulut bağlantısı kurulmadan üretim geri alınamaz.', 'warning'); return Promise.resolve(false); }
  if (!firebaseConnected || navigator.onLine === false) {
    toast('Bağlantı yok. Stok güvenliği için üretim geri alma bağlantı gelene kadar engellendi.', 'warning');
    return Promise.resolve(false);
  }
  const log = productionLogs.find(item => String(item.id) === String(logId));
  if (!log) { toast('Üretim kaydı bulunamadı.', 'error'); return Promise.resolve(false); }
  const logColors = (Array.isArray(log.colors) ? log.colors : Object.values(log.colors || {}));
  const summary = logColors.map(col => `${col.name} ${fmt(Number(col.grams) || 0, 1)} g`).join(', ');
  return confirmDialog({
    title: 'Üretimi geri al',
    message: `"${log.productName || 'Ürün'}" için ${fmt(Number(log.qty) || 0, 0)} adetlik üretim iptal edilecek. Tüketilen filament (${summary || 'renk kaydı yok'}) stoğa geri eklenir ve mamul stoktan ${fmt(Number(log.qty) || 0, 0)} adet düşülür.`,
    confirmText: 'Geri al', danger: true
  }).then(ok => {
    if (!ok) return false;
    let reason = '';
    const runAttempt = attempt => new Promise((resolve, reject) => {
      reason = '';
      rootRef.transaction(current => {
        reason = '';
        const root = current || {};
        const logs = {...(root.productionLogs || {})};
        const rec = logs[logId];
        if (!rec) { reason = 'missing-log'; return; }
        const qty = Math.max(0, Math.floor(Number(rec.qty) || 0));
        const products = {...(root.products || {})};
        const key = matchProductKey(products, rec.productId, rec.productName);
        if (key) {
          const available = readyStockOf(products[key]);
          if (available < qty) { reason = `sold:${available}:${qty}`; return; }
          products[key] = {...products[key], readyStock: available - qty};
          root.products = products;
        }
        const stock = {...(root.filamentStock || {})};
        const recColors = Array.isArray(rec.colors) ? rec.colors : Object.values(rec.colors || {});
        for (const col of recColors) {
          const name = sanitizeColorName(col?.name);
          const grams = Math.max(0, Number(col?.grams) || 0);
          if (!name || !grams) continue;
          const raw = stock[name];
          const entry = normalizeStockEntry(raw);
          const total = entry.totalWeightGrams + grams;
          stock[name] = {
            ...(raw && typeof raw === 'object' ? raw : {}),
            kg: round3(total / 1000),
            totalWeightGrams: Math.round(total),
            weightedAveragePricePerKg: entry.weightedAveragePricePerKg ?? params().filamentPrice,
            updatedAt: Date.now()
          };
        }
        root.filamentStock = stock;
        delete logs[logId];
        root.productionLogs = logs;
        return root;
      }, (error, committed) => {
        if (error) {
          if (attempt < TX_MAX_ATTEMPTS - 1 && txShouldRetry(error)) { setTimeout(() => runAttempt(attempt + 1).then(resolve, reject), txRetryDelay(attempt)); return; }
          reject(error); return;
        }
        if (!committed) {
          if (reason) { resolve(false); return; }
          if (attempt < TX_MAX_ATTEMPTS - 1) { setTimeout(() => runAttempt(attempt + 1).then(resolve, reject), txRetryDelay(attempt)); return; }
          reject(new Error('transaction-aborted')); return;
        }
        resolve(true);
      }, false);
    });
    return acquireRootCache().then(release => runAttempt(0).finally(release)).then(done => {
      if (done) {
        toast(`Üretim geri alındı. ${summary ? summary + ' filament stoğa iade edildi.' : ''} Mamul stoktan ${fmt(Number(log.qty) || 0, 0)} adet düşüldü.`, 'success');
        return true;
      }
      if (reason.startsWith('sold:')) {
        const [, available, qty] = reason.split(':');
        toast(`Geri alınamadı: bu üretimden ${qty} adet düşülmesi gerekiyor ama mamul stokta yalnızca ${available} adet var (bir kısmı satılmış olabilir).`, 'error', {title:'Mamul stok yetersiz'});
      } else if (reason === 'missing-log') {
        toast('Bu üretim kaydı zaten geri alınmış veya silinmiş.', 'warning');
      } else {
        toast('Üretim geri alınamadı, lütfen tekrar deneyin.', 'error');
      }
      return false;
    }).catch(error => { cloudError(error, 'üretimi geri alma'); return false; });
  });
}

/* ---------- Filament alım giderleri ---------- */
function purchasesInBounds(bounds) {
  return filamentPurchases.filter(p => {
    if (!bounds || !bounds.start) return true;
    const d = localDate(p.date);
    return d && d >= bounds.start && d < bounds.end;
  });
}
const purchaseTotalOf = p => Number(p.total) || round2((Number(p.kg) || 0) * (Number(p.pricePerKg) || 0));
function renderPurchases() {
  const rowsEl = $('purchaseRows');
  if (!rowsEl) return;
  const total = filamentPurchases.reduce((sum, p) => sum + purchaseTotalOf(p), 0);
  const kg = filamentPurchases.reduce((sum, p) => sum + (Number(p.kg) || 0), 0);
  if ($('purchaseTotalAll')) $('purchaseTotalAll').textContent = money(total);
  if ($('purchaseTotalKg')) $('purchaseTotalKg').textContent = `${fmt(kg, 2)} kg`;
  if ($('purchaseCount')) $('purchaseCount').textContent = `${filamentPurchases.length} alım kaydı`;
  rowsEl.innerHTML = filamentPurchases.map(p => `<tr>
    <td>${esc(p.date || '')}</td><td>${esc(p.color || '')}</td><td>${fmt(Number(p.kg) || 0, 2)} kg</td>
    <td>${money(p.pricePerKg)} / kg</td><td class="profit-negative">−${money(purchaseTotalOf(p))}</td>
    <td><button class="delete-btn" type="button" data-purchase-delete="${esc(p.id)}" title="Alımı geri al" aria-label="Alımı geri al">×</button></td>
  </tr>`).join('');
  if ($('purchaseEmpty')) $('purchaseEmpty').style.display = filamentPurchases.length ? 'none' : 'block';
  refreshTableLabels(rowsEl.closest('table'));
}
// Alımı geri al: kaydı siler, eklenen kiloyu stoktan düşer (gider de otomatik kalkar).
function deletePurchase(id) {
  const rec = filamentPurchases.find(p => String(p.id) === String(id));
  if (!rec || !cloudReady) return;
  confirmDialog({
    title: 'Filament alımını geri al',
    message: `${rec.color} · ${fmt(Number(rec.kg) || 0, 2)} kg alımı (${money(purchaseTotalOf(rec))}) silinecek; ${fmt(Number(rec.kg) || 0, 2)} kg stoktan düşülecek ve gider kaydı kaldırılacak.`,
    confirmText: 'Geri al', danger: true
  }).then(ok => {
    if (!ok) return;
    let insufficient = false, missing = false;
    acquireRootCache().then(release => new Promise((resolve, reject) => {
      rootRef.transaction(current => {
        insufficient = false; missing = false;
        const root = current || {};
        const list = {...(root.filamentPurchases || {})};
        const p = list[id];
        if (!p) { missing = true; return; }
        const stock = {...(root.filamentStock || {})};
        const raw = stock[p.color];
        const entry = normalizeStockEntry(raw);
        const grams = (Number(p.kg) || 0) * 1000;
        if (entry.totalWeightGrams + 1e-6 < grams) { insufficient = true; return; }
        const left = Math.max(0, entry.totalWeightGrams - grams);
        stock[p.color] = {...(raw && typeof raw === 'object' ? raw : {}), kg: round3(left / 1000), totalWeightGrams: Math.round(left),
          weightedAveragePricePerKg: entry.weightedAveragePricePerKg ?? params().filamentPrice, updatedAt: Date.now()};
        root.filamentStock = stock;
        delete list[id];
        root.filamentPurchases = list;
        return root;
      }, (error, committed) => error ? reject(error) : resolve(committed), false);
    }).finally(release)).then(committed => {
      if (committed) toast('Filament alımı geri alındı; stok ve gider güncellendi.', 'success');
      else if (insufficient) toast('Geri alınamadı: bu renkte, alınan miktar kadar stok kalmamış (üretimde kullanılmış).', 'error');
      else if (missing) toast('Alım kaydı zaten silinmiş.', 'warning');
      else toast('Alım geri alınamadı, tekrar deneyin.', 'error');
    }).catch(error => cloudError(error, 'alım geri alma'));
  });
}
function updateStockTotalPreview() {
  const el = $('stockAddTotal');
  if (!el) return;
  const kg = Number($('stockAddKg').value), price = Number($('stockAddPrice').value);
  el.innerHTML = kg > 0 && price > 0
    ? `Bu alım <strong>${money(kg * price)}</strong> gider olarak kaydedilecek (${fmt(kg, 2)} kg × ${money(price)}).`
    : 'Miktar ve fiyat girildiğinde toplam gider burada görünür.';
}
function undoableDelete(type, id, record, ref, label) {
  const key = `${type}:${id}`;
  if (pendingDeletes.has(key)) return;
  pendingDeletes.set(key,{record,ref,timer:null});
  if (type==='product') { state.products=state.products.filter(x=>String(x.id)!==String(id)); renderProducts(); renderSales(); }
  else { sales=sales.filter(x=>String(x.id)!==String(id)); renderSales(); }
  const stack=$('toastStack');
  const el=document.createElement('div'); el.className='toast toast-info undo-toast'; el.setAttribute('role','status');
  el.innerHTML=`<span class="toast-icon">↶</span><div class="toast-body"><strong>Silme beklemede</strong><p>${esc(label)} · 5 saniye içinde geri alabilirsin.</p></div><button type="button" class="undo-action">Geri Al</button><i class="toast-progress"></i>`;
  stack.appendChild(el);
  let remaining=5000,started=Date.now(),timer;
  const finish=async restore=>{
    clearTimeout(timer); const pending=pendingDeletes.get(key); if(!pending)return;
    pendingDeletes.delete(key); el.remove();
    if(restore){
      try { await ref.set(record); toast('Kayıt geri yüklendi.','success'); }
      catch(error){cloudError(error,'kaydı geri yükleme');}
    } else {
      try { await ref.remove(); toast('Kayıt silindi.','success'); }
      catch(error){pendingDeletes.set(key,pending); if(type==='product')state.products.push({...record,id});else sales.push({...record,id});renderProducts();renderSales();cloudError(error,'kayıt silme');}
    }
  };
  el.querySelector('.undo-action').addEventListener('click',()=>finish(true));
  el.addEventListener('mouseenter',()=>{clearTimeout(timer);remaining-=Date.now()-started;});
  el.addEventListener('mouseleave',()=>{started=Date.now();timer=setTimeout(()=>finish(false),remaining);});
  timer=setTimeout(()=>finish(false),remaining); pendingDeletes.get(key).timer=timer;
}
function syncBulkToolbars() {
  const pt=$('productBulkToolbar'), st=$('salesBulkToolbar');
  if(pt){pt.hidden=!selectedProducts.size;$('productBulkCount').textContent=`${selectedProducts.size} ürün seçildi`;}
  if(st){st.hidden=!selectedSales.size;$('salesBulkCount').textContent=`${selectedSales.size} satış seçildi`;}
}
function refreshTableLabels(table) {
  if(!table)return; const labels=[...table.querySelectorAll('thead th')].map(th=>th.textContent.trim());
  table.querySelectorAll('tbody tr').forEach(row=>[...row.children].forEach((cell,i)=>{if(labels[i])cell.dataset.label=labels[i];}));
}

/* ---------- Genel yardımcılar ---------- */
function num(id) {
  const el = $(id);
  if (!el) return 0;
  const value = Number(el.value);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
function money(value) {
  return new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'}).format(Number.isFinite(Number(value)) ? Number(value) : 0);
}
function fmt(value, digits=2) {
  return new Intl.NumberFormat('tr-TR',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(Number.isFinite(Number(value)) ? Number(value) : 0);
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function params() {
  return {
    filamentPrice:num('filamentPrice'), standGrams:num('standGrams'),
    lighterCost:num('lighterCost'), targetUnits:Math.max(1,num('targetUnits')),
    wasteRate:Math.min(90,num('wasteRate')), printerPower:num('printerPower'), energyPrice:num('energyPrice'),
    printerPrice:num('printerPrice'), printerLifeHours:num('printerLifeHours'), wearCost:num('wearCost')
  };
}
// Saatlik sabitler: enerji, amortisman ve aşınma maliyeti baskı süresiyle çarpılır.
function hourlyRates(x=params()) {
  return {
    energy: (x.printerPower/1000)*x.energyPrice,
    depreciation: x.printerLifeHours>0 ? x.printerPrice/x.printerLifeHours : 0,
    wear: x.wearCost,
    wasteShare: Math.min(90,Math.max(0,x.wasteRate))/100
  };
}
function calc(product, x=params()) {
  const qty = Math.max(0, Number(product.qty)||0);
  const grams = Math.max(0, Number(product.grams)||0);
  const hours = Math.max(0, Number(product.hours)||0);
  const gramPrice = x.filamentPrice/1000;
  const rates = hourlyRates(x);
  const wasteShare = rates.wasteShare;
  // Filament: üründe tanımlı renklerin adet başına gram toplamı (yoksa toplam gram ÷ adet).
  const perUnitGrams = unitGrams(product);
  // Renk tanımlı ürünlerde her rengin AĞIRLIKLI ORTALAMA alım fiyatı kullanılır.
  // Renk stoğunda fiyat kaydı yoksa genel filament fiyatına güvenli biçimde düşülür.
  const productColorList = productColors(product);
  const filament = productColorList.length
    ? productColorList.reduce((sum, color) => sum + color.grams * colorAveragePrice(color.name, x.filamentPrice) / 1000, 0)
    : perUnitGrams * gramPrice;
  const stand = qty > 0 ? (x.standGrams*gramPrice)/qty : 0;
  // Adet başına baskı süresi. Elektrik, amortisman ve aşınma bu süreyle çarpılır:
  // elektrik = (süre ÷ adet) × (yazıcı gücü ÷ 1000) × kWh fiyatı
  const unitHours = qty > 0 ? hours/qty : 0;
  const electric = unitHours*rates.energy;
  const machine = unitHours*rates.depreciation;
  const wear = unitHours*rates.wear;
  // Fire payı başarısız baskıların hammaddesini ve enerjisini kapsar.
  const fire = (filament + stand + electric) * wasteShare;
  const lighter = x.lighterCost/x.targetUnits; // Çakmak maliyeti hedef üretim adedine bölünür.
  const unit = filament+electric+stand+machine+wear+fire+lighter;
  const sale = Math.max(0,Number(product.sale)||0);
  const profit = sale-unit;
  return {gram:perUnitGrams,hours,filament,electric,stand,machine,wear,fire,lighter,unit,profit,total:unit*qty,totalProfit:profit*qty};
}
function syncInputs() {
  inputIds.forEach(id => { if ($(id)) $(id).value = state[id] ?? defaults[id]; });
  stockInputIds.forEach(id => { if ($(id)) $(id).value = state[id] ?? defaults[id]; });
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
/* ---------- Site içi bildirimler (toast) ve onay penceresi ----------
   Tarayıcı alert/confirm/Notification API'leri kullanılmaz. */
const TOAST_ICONS = {
  success:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  error:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16.2h.01"/></svg>',
  warning:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 21 19.5H3L12 4Z"/><path d="M12 10v4.2M12 17h.01"/></svg>',
  info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.9h.01"/></svg>'
};
const TOAST_TITLES = { success:'Tamamlandı', error:'İşlem başarısız', warning:'Dikkat', info:'Bilgi' };
function toastKind(text) {
  if (/başarısız|yüklenemedi|okunamadı/i.test(text)) return 'error';
  if (/kurulmadan|lütfen|önce |girmelisin|\bgir\.|\bseç\.|en fazla|çok büyük/i.test(text)) return 'warning';
  if (/kaydedildi|eklendi|silindi|güncellendi|kaldırıldı|taşındı|buluta|buluttan|Firebase’e/i.test(text)) return 'success';
  return 'info';
}
function dismissToast(el) {
  if (!el || el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 280);
}
function toast(message, kind, opts) {
  const stack = $('toastStack');
  if (!stack) return;
  const text = String(message ?? '');
  const type = TOAST_ICONS[kind] ? kind : toastKind(text);
  const duration = (opts && opts.duration) || (type === 'error' ? 5600 : 3600);
  // Aynı mesaj üst üste yığılmasın
  stack.querySelectorAll('.toast:not(.leaving)').forEach(item => { if (item.dataset.msg === text) dismissToast(item); });
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.dataset.msg = text;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.style.setProperty('--toast-dur', `${duration}ms`);
  el.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type]}</span>
    <div class="toast-body"><strong>${esc((opts && opts.title) || TOAST_TITLES[type])}</strong><p></p></div>
    <button class="toast-close" type="button" aria-label="Bildirimi kapat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>
    <i class="toast-progress"></i>`;
  el.querySelector('p').textContent = text;
  stack.appendChild(el);
  while (stack.querySelectorAll('.toast:not(.leaving)').length > 4) dismissToast(stack.querySelector('.toast:not(.leaving)'));
  let remaining = duration, started = 0, timer = 0;
  const arm = () => { started = Date.now(); timer = setTimeout(() => dismissToast(el), remaining); };
  el.addEventListener('mouseenter', () => { clearTimeout(timer); remaining -= Date.now() - started; el.classList.add('paused'); });
  el.addEventListener('mouseleave', () => { el.classList.remove('paused'); arm(); });
  el.querySelector('.toast-close').addEventListener('click', () => { clearTimeout(timer); dismissToast(el); });
  arm();
}
function confirmDialog(options) {
  const o = Object.assign({ title:'Emin misin?', message:'', confirmText:'Onayla', cancelText:'Vazgeç', danger:false }, options);
  return new Promise(resolve => {
    const modal = $('confirmModal'), ok = $('confirmOk'), cancel = $('confirmCancel');
    if (!modal) { resolve(false); return; }
    const previous = document.activeElement;
    $('confirmTitle').textContent = o.title;
    $('confirmMessage').textContent = o.message;
    ok.textContent = o.confirmText; cancel.textContent = o.cancelText;
    modal.classList.toggle('is-danger', !!o.danger);
    modal.hidden = false;
    (o.danger ? cancel : ok).focus();
    const finish = result => {
      modal.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      modal.removeEventListener('mousedown', onBackdrop);
      ok.onclick = cancel.onclick = null;
      if (previous && previous.focus) previous.focus();
      resolve(result);
    };
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
      else if (event.key === 'Tab') {
        event.preventDefault();
        (document.activeElement === ok ? cancel : ok).focus();
      }
    };
    const onBackdrop = event => { if (event.target === modal) finish(false); };
    document.addEventListener('keydown', onKey, true);
    modal.addEventListener('mousedown', onBackdrop);
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
  });
}
/* ---------- Grafik animasyonları ----------
   Maliyet donut'u saat yönünde dolar, çubuklar sıfırdan büyür. Animasyon, sayfa
   ilk açıldığında ve veri gerçekten değiştiğinde çalışır (aynı veri gelirse tekrarlanmaz). */
const chartSig = {};
const chartData = {};
let donutRaf = 0;
const prefersReducedMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const isPageActive = id => { const el = $(id); return !!el && el.classList.contains('active'); };
function growBars(root, selector, prop, animate) {
  if (!root) return;
  const els = [...root.querySelectorAll(selector)];
  const final = el => { el.style.transitionDelay = '0ms'; el.style[prop] = `${el.dataset.v}%`; };
  if (!animate || prefersReducedMotion()) {
    els.forEach(el => { el.style.transition = 'none'; final(el); });
    void root.offsetWidth;
    els.forEach(el => { el.style.transition = ''; });
    return;
  }
  els.forEach(el => { el.style.transition = 'none'; el.style.transitionDelay = '0ms'; el.style[prop] = '0%'; });
  void root.offsetWidth;                       // 0 durumunu kesinleştir
  requestAnimationFrame(() => els.forEach((el, i) => {
    el.style.transition = '';
    el.style.transitionDelay = `${i * 70}ms`;
    el.style[prop] = `${el.dataset.v}%`;
  }));
}
function paintDonut(segments, k, hasData) {
  const donut = $('costDonut');
  if (!donut) return;
  if (!hasData) { donut.style.background = 'var(--donut-track)'; return; }
  const limit = k * 100;
  const stops = segments.map(seg => `${seg.color} ${Math.min(seg.start, limit)}% ${Math.min(seg.end, limit)}%`);
  stops.push(`var(--donut-track) ${limit}% 100%`);
  donut.style.background = `conic-gradient(${stops.join(',')})`;
}
function playCostChart(animate) {
  const d = chartData.cost;
  if (!d) return;
  const segments = []; let acc = 0;
  d.costs.forEach(([, value], index) => {
    const pct = d.total > 0 ? value / d.total * 100 : 0;
    segments.push({ color: d.palette[index], start: acc, end: acc + pct }); acc += pct;
  });
  cancelAnimationFrame(donutRaf);
  growBars($('costBreakdown'), '.bar-fill', 'width', animate);
  const hasData = d.total > 0;
  if (!animate || prefersReducedMotion() || !hasData) {
    paintDonut(segments, 1, hasData); $('costGrandTotal').textContent = money(d.total); return;
  }
  paintDonut(segments, 0, true);
  $('costGrandTotal').textContent = money(0);
  const started = performance.now(), duration = 1150;
  const step = now => {
    const t = Math.min(1, (now - started) / duration), eased = 1 - Math.pow(1 - t, 3);
    paintDonut(segments, eased, true);
    $('costGrandTotal').textContent = money(d.total * eased);
    if (t < 1) donutRaf = requestAnimationFrame(step);
  };
  donutRaf = requestAnimationFrame(step);
}
function playPriceBars(animate) { growBars($('priceBars'), '.price-bar-fill', 'height', animate); }

/* ---------- Esnek ürün kimliği çözümleme ----------
 * Firebase anahtarı ile kayıttaki id alanı eski yedekler, içe aktarılan veriler veya
 * farklı cihazlardan gelen kayıtlar yüzünden birbirini tutmayabilir. Bu yardımcılar
 * anahtarı tam, normalize edilmiş (boşluk/büyük-küçük harf bağımsız) ve kayıt içindeki
 * alternatif id alanları üzerinden bulur. Böylece "Ürün bulunamadı" hatası oluşmaz.
 */
function normalizeIdValue(value) {
  // Kimlikler ASCII tabanlıdır; Türkçe yerel ayarı "I" harfini "ı" yapıp
  // "ID1" ile "id1" eşleşmesini bozacağı için yerel ayardan bağımsız küçültülür.
  return String(value ?? '').trim().toLowerCase();
}
function normalizeNameValue(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');
}
const ALT_ID_FIELDS = ['cloudKey', 'firebaseKey', 'key', 'productId'];
function matchProductKey(products, productId, productName) {
  if (!products || typeof products !== 'object') return null;
  const wanted = normalizeIdValue(productId);
  const keys = Object.keys(products);
  // 1) Firebase anahtarı birebir eşleşiyorsa (büyük/küçük harfe duyarlı) onu kullan.
  if (wanted && Object.prototype.hasOwnProperty.call(products, productId)) return productId;
  if (wanted) {
    // 2) Anahtarın normalize edilmiş hali: "  Abc123 " = "abc123".
    let key = keys.find(candidate => normalizeIdValue(candidate) === wanted);
    if (key) return key;
    // 3) Kaydın içindeki id / alternatif kimlik alanları.
    key = keys.find(candidate => {
      const record = products[candidate];
      if (normalizeIdValue(record?.id) === wanted) return true;
      return ALT_ID_FIELDS.some(field => normalizeIdValue(record?.[field]) === wanted);
    });
    if (key) return key;
  }
  // 4) Son çare: benzersiz ürün adı. Aynı ada sahip birden fazla ürün varsa
  //    yanlış kaydı güncellememek için eşleşme kabul edilmez.
  const wantedName = normalizeNameValue(productName);
  if (wantedName) {
    const matches = keys.filter(candidate => normalizeNameValue(products[candidate]?.name) === wantedName);
    if (matches.length === 1) return matches[0];
  }
  return null;
}
function productById(id) {
  const wanted = normalizeIdValue(id);
  if (!wanted) return undefined;
  return state.products.find(product => String(product.id) === String(id))
    || state.products.find(product => normalizeIdValue(product.id) === wanted)
    || state.products.find(product => ALT_ID_FIELDS.some(field => normalizeIdValue(product[field]) === wanted));
}
function sameProductId(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a) === String(b) || normalizeIdValue(a) === normalizeIdValue(b);
}
/* ---------- Renk yardımcıları ---------- */
// Firebase dizileri seyrek gelebilir; hem dizi hem nesne biçimini destekle.
function rawColors(product) {
  const value = product?.colors;
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}
// Ürünün renkleri, adet başına gram olarak.
function productColors(product) {
  return rawColors(product)
    .map(color => ({name: String(color?.name ?? '').trim(), grams: Math.max(0, Number(color?.grams) || 0)}))
    .filter(color => color.name || color.grams > 0);
}
function hasColors(product) {
  return productColors(product).length > 0;
}
function unitGrams(product) {
  const colors = productColors(product);
  if (colors.length) return colors.reduce((sum, color) => sum + color.grams, 0);
  const qty = Math.max(0, Number(product.qty) || 0);
  const grams = Math.max(0, Number(product.grams) || 0);
  return qty > 0 ? grams / qty : 0;
}
function sanitizeColorName(name) {
  return String(name ?? '').trim().replace(/[.#$\[\]\/]/g, '').replace(/\s+/g, ' ').slice(0, 24);
}
const COLOR_SWATCHES = {
  siyah:'#232936', beyaz:'#ffffff', gri:'#9aa2b1', gümüş:'#c6ccd6', altın:'#d4af37',
  kırmızı:'#d94b4b', mavi:'#3f7edb', yeşil:'#2fa56e', sarı:'#e8c537', turuncu:'#e8892f',
  mor:'#8b5cd6', pembe:'#e878a8', kahverengi:'#8a5a3b', bordo:'#7d2f3d',
  turkuaz:'#2fb6b0', lacivert:'#2c3e7d', bej:'#d8c3a5', şeffaf:'#e9edf4'
};
function colorSwatch(name) {
  const key = String(name || '').toLocaleLowerCase('tr-TR').trim();
  if (COLOR_SWATCHES[key]) return COLOR_SWATCHES[key];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 360;
  return `hsl(${hash} 62% 56%)`;
}
// Renk stoğu + ürün planlarını birleştirip renk bazlı özet üretir.
function stockCalc(x=params()) {
  const waste = 1 + Math.min(90,Math.max(0,x.wasteRate))/100;
  const stockByColor = {};
  const avgPriceByColor = {};
  const gramsByColor = {};
  Object.entries(filamentStock || {}).forEach(([name, raw]) => {
    const safeName = sanitizeColorName(name);
    if (!safeName) return;
    const entry = normalizeStockEntry(raw);
    stockByColor[safeName] = (stockByColor[safeName] || 0) + entry.kg;
    // Aynı renk adı farklı anahtarlarla gelirse gram ağırlıklı ortalama fiyat birleştirilir.
    const previousGrams = gramsByColor[safeName] || 0;
    const price = entry.weightedAveragePricePerKg ?? x.filamentPrice;
    const previousAvg = avgPriceByColor[safeName] ?? price;
    gramsByColor[safeName] = previousGrams + entry.totalWeightGrams;
    avgPriceByColor[safeName] = gramsByColor[safeName] > 0
      ? ((previousGrams * previousAvg) + (entry.totalWeightGrams * price)) / gramsByColor[safeName]
      : price;
  });
  const stockKg = Object.values(stockByColor).reduce((sum, kg) => sum + kg, 0);

  const items = state.products.map(p => {
    const qty = Math.max(0, Number(p.qty) || 0);
    const grams = Math.max(0, Number(p.grams) || 0);
    const colors = productColors(p);
    const gpu = unitGrams(p);
    const colored = colors.length > 0;
    // Renk tanımlıysa her renk için ayrı ihtiyaç ve kapasite hesaplanır.
    const colorUse = colors.map(color => {
      const stockOfColor = stockByColor[color.name] || 0;
      const perUnitKg = color.grams * waste / 1000;
      const producible = perUnitKg > 0 ? Math.floor(stockOfColor / perUnitKg + 1e-9) : 0;
      return {
        name: color.name || 'Renk adı yok', gramsPerUnit: color.grams,
        gramsTotal: color.grams * qty, stockKg: stockOfColor,
        plannedKg: color.grams * qty * waste / 1000, producible
      };
    });
    const effGpu = gpu * waste;
    let producible;
    if (colored) {
      const usable = colorUse.filter(color => color.gramsPerUnit > 0);
      producible = usable.length ? Math.min(...usable.map(color => color.producible)) : 0;
    } else {
      producible = effGpu > 0 ? Math.floor(stockKg / (effGpu / 1000) + 1e-9) : 0;
    }
    const plannedKg = colored
      ? colorUse.reduce((sum, color) => sum + color.plannedKg, 0)
      : grams * waste / 1000;
    return {p, qty, grams, gpu, colored, colorUse, effGpu, producible, plannedKg, shortfall: Math.max(0, qty - producible)};
  });

  // Renk bazlı stok tablosu: stokta olan ve ürünlerde kullanılan tüm renkler.
  const colorNames = new Set([...Object.keys(stockByColor), ...items.flatMap(item => item.colorUse.map(color => color.name))]);
  const colorRows = [...colorNames].map(name => {
    const neededKg = items.reduce((sum, item) => sum + item.colorUse.filter(color => color.name === name).reduce((s, color) => s + color.plannedKg, 0), 0);
    const stockOfColor = stockByColor[name] || 0;
    return {name, stockKg: stockOfColor, neededKg, remaining: stockOfColor - neededKg, avgPrice: avgPriceByColor[name] ?? x.filamentPrice};
  }).sort((a, b) => a.remaining - b.remaining || a.name.localeCompare(b.name, 'tr'));

  const neededKg = items.reduce((sum,item)=>sum+item.plannedKg,0);
  return {stockKg,neededKg,remaining:stockKg-neededKg,items,colorRows,minStockKg:Math.max(0,Number(state.minStockKg)||0),waste,wasteRate:x.wasteRate};
}
function renderProducts() {
  const x = params();
  const rates = hourlyRates(x);
  $('gramPrice').textContent = `${money(x.filamentPrice/1000)} / g`;
  $('standTotal').textContent = money(x.standGrams*x.filamentPrice/1000);
  $('lighterUnit').textContent = money(x.lighterCost/x.targetUnits);
  if ($('wasteFactor')) $('wasteFactor').textContent = `×${fmt(1+rates.wasteShare,2)}`;
  if ($('hourlyEnergy')) $('hourlyEnergy').textContent = `${money(rates.energy)} / saat`;
  if ($('hourlyDep')) $('hourlyDep').textContent = `${money(rates.depreciation)} / saat`;
  if ($('hourlyWear')) $('hourlyWear').textContent = `${money(rates.wear)} / saat`;
  const query = $('searchInput').value.trim().toLocaleLowerCase('tr-TR');
  const rows = $('productRows'); rows.innerHTML = '';
  state.products.forEach(p => {
    p.usesLighter = Boolean(p.usesLighter);
    if (!String(p.name ?? '').toLocaleLowerCase('tr-TR').includes(query)) return;
    const c = calc(p,x);
    const colors = productColors(p);
    // Ürün listesinde gösterilen stok mamul (hazır ürün) stoğudur; hammadde kapasitesi envanterde.
    const readyStock = readyStockOf(p);
    const stockBadge = readyStock <= 0
      ? '<span class="stock-badge out" title="Hazır mamul stok yok. Satış için önce Üret ile üretim kaydı ekle.">Mamul stok yok · 0 adet</span>'
      : `<span class="stock-badge ok" title="Satılabilir hazır mamul stoğu">Hazır stok · ${fmt(readyStock,0)} adet</span>`;
    const colorCell = colors.length
      ? `<div class="color-chip-list">${colors.map(color => `<span class="color-chip" title="${esc(color.name || 'Renk')} · adet başına ${fmt(color.grams,1)} g"><i style="background:${colorSwatch(color.name)}"></i>${esc(color.name || 'Renk')} <small>${fmt(color.grams,1)} g</small></span>`).join('')}</div>`
      : '<span class="muted-chip">Renk tanımlanmadı</span>';
    const tr = document.createElement('tr');
    tr.className = 'product-row';
    tr.dataset.productRow = p.id;
    tr.title = 'Ürün detayı için tıkla';
    tr.innerHTML = `
      <td data-label="Seç"><input type="checkbox" class="row-select" data-select-product="${esc(p.id)}" aria-label="${esc(p.name)} ürününü seç" ${selectedProducts.has(String(p.id))?'checked':''}></td><td class="photo-cell"><div class="product-photo-wrap">${p.photo ? `<button class="product-photo-btn" type="button" data-product-detail="${esc(p.id)}" aria-label="${esc(p.name)} detayını aç" title="Ürün detayını aç"><img class="product-photo" src="${p.photo}" alt="${esc(p.name)} fotoğrafı" loading="lazy"><span class="photo-zoom-hint" aria-hidden="true">⤢</span></button>` : '<div class="photo-placeholder">Fotoğraf<br>yok</div>'}<label class="photo-upload">Cihazdan Yükle<input type="file" accept="image/*" data-photo-id="${esc(p.id)}" aria-label="${esc(p.name)} cihazdan fotoğraf yükle"></label></div></td>
      <td><div class="product-name-cell"><input class="name-input" aria-label="Ürün adı" data-pid="${esc(p.id)}" data-k="name" value="${esc(p.name)}">${stockBadge}</div></td>
      <td><input type="number" min="0" max="100000" step="1" aria-label="Adet" data-pid="${esc(p.id)}" data-k="qty" value="${Number(p.qty)||0}"></td>
      <td><input type="number" min="0" max="10000000" step="0.1" aria-label="Toplam gram" data-pid="${esc(p.id)}" data-k="grams" value="${Number(p.grams)||0}"></td>
      <td><input type="number" min="0" max="100000" step="0.1" aria-label="Baskı süresi saat" data-pid="${esc(p.id)}" data-k="hours" value="${Number(p.hours)||0}" placeholder="Saat"></td>
      <td>${fmt(c.gram)} g</td><td>${colorCell}</td><td>${money(c.filament)}</td><td title="(Baskı süresi ÷ adet) × yazıcı gücü (kW) × kWh fiyatı">${money(c.electric)}</td><td>${money(c.stand)}</td><td title="(Baskı süresi ÷ adet) × (yazıcı bedeli ÷ ömür)">${money(c.machine)}</td><td title="(Baskı süresi ÷ adet) × saatlik bakım fonu (nozzle, PTFE, PEI, dişli, fan)">${money(c.wear)}</td><td title="Fire oranı: %${fmt(x.wasteRate,1)}">${money(c.fire)}</td><td>${money(c.lighter)}</td><td class="money">${money(c.unit)}</td>
      <td><input class="sale-input" type="number" min="0" max="10000000" step="0.01" aria-label="Satış fiyatı" data-pid="${esc(p.id)}" data-k="sale" value="${Number(p.sale)||0}"></td>
      <td class="${c.profit>=0?'profit-positive':'profit-negative'}">${money(c.profit)}</td>
      <td class="money">${money(c.total)}</td>
      <td><div class="row-actions"><button class="detail-btn" data-product-detail="${esc(p.id)}" type="button" title="Ürün detayını aç">Detay</button><button class="delete-btn" data-delete="${esc(p.id)}" title="Ürünü sil" aria-label="Ürünü sil">×</button></div></td>`;
    rows.appendChild(tr);
  });
  refreshTableLabels(rows.closest('table')); syncBulkToolbars();
  const all = state.products.map(p=>({p,c:calc(p,x)}));
  // "Toplam üretim" kartı satılabilir hazır mamul stoğunu gösterir.
  const units = state.products.reduce((sum,p)=>sum+readyStockOf(p),0);
  const total = all.reduce((sum,item)=>sum+item.c.total,0);
  $('statProducts').textContent = state.products.length;
  $('statUnits').textContent = fmt(units,0);
  $('statCost').textContent = money(total);
  $('totalFooter').textContent = `Toplam maliyet: ${money(total)}`;
  $('rowCount').textContent = `${state.products.length} ürün`;
  const costs = [
    ['Filament',all.reduce((s,a)=>s+a.c.filament*a.p.qty,0)],
    ['Elektrik',all.reduce((s,a)=>s+a.c.electric*a.p.qty,0)],
    ['Stand',all.reduce((s,a)=>s+a.c.stand*a.p.qty,0)],
    ['Makine amortismanı',all.reduce((s,a)=>s+a.c.machine*a.p.qty,0)],
    ['Aşınma & bakım',all.reduce((s,a)=>s+a.c.wear*a.p.qty,0)],
    ['Fire payı',all.reduce((s,a)=>s+a.c.fire*a.p.qty,0)],
    ['Çakmak',all.reduce((s,a)=>s+a.c.lighter*a.p.qty,0)]
  ];
  const totalCost = costs.reduce((sum,item)=>sum+item[1],0);
  const palette = ['#6657e8','#2996d6','#e89a42','#22a77a','#d65c78','#b05ce0','#3aa4a1'];
  let cumulative = 0;
  const gradient = costs.map(([name,value],index)=>{
    const pct = totalCost>0 ? value/totalCost*100 : 0;
    const start = cumulative; cumulative += pct;
    return `${palette[index]} ${start}% ${cumulative}%`;
  });
  chartData.cost = { costs, total: totalCost, palette };
  const costSig = JSON.stringify(costs.map(item => Math.round(item[1] * 100)));
  if (chartSig.cost !== costSig) {
    chartSig.cost = costSig;
    $('costBreakdown').innerHTML = costs.map(([name,value],index)=>{
      const pct = totalCost>0 ? value/totalCost*100 : 0;
      return `<div class="break-row"><span class="break-name"><i style="background:${palette[index]}"></i>${name}</span><div class="bar-track"><div class="bar-fill" data-v="${Math.max(0,pct).toFixed(2)}" style="width:0%;background:${palette[index]}"></div></div><span class="break-value">${money(value)} <small>%${fmt(pct,1)}</small></span></div>`;
    }).join('');
    playCostChart(isPageActive('analysis'));   // görünürse animasyonlu; değilse son hâliyle çiz
  }
  renderSaleProductOptions();
  renderInventory();
  if ($('productDetailModal') && !$('productDetailModal').hidden) renderProductDetail();
}
function renderSaleProductOptions() {
  if (typeof syncPackageProducts === 'function') syncPackageProducts();
  const select = $('saleProduct');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = state.products.map(p=>`<option value="${esc(p.id)}">${esc(p.name || 'İsimsiz ürün')} · hazır ${fmt(readyStockOf(p),0)} adet</option>`).join('');
  if (state.products.length && [...select.options].some(o=>o.value===previous)) select.value = previous;
  if (!state.products.length) select.innerHTML = '<option value="">Önce ürün ekle</option>';
}
// Filament fiyat kayıtları: maliyet geçmişindeki filament değişimleri + alım kayıtları.
function filamentPricePoints() {
  return costHistory
    .filter(h=>h.key==='filamentPrice' && Number.isFinite(Number(h.newValue)))
    .sort((a,b)=>String(a.date).localeCompare(String(b.date)));
}
function renderInventory() {
  if (!$('stockRows')) return;
  const x = params();
  const stock = stockCalc(x);
  // --- Stok kartları ---
  $('stockCurrent').textContent = `${fmt(stock.stockKg,2)} kg`;
  $('stockNeeded').textContent = `${fmt(stock.neededKg,2)} kg`;
  const remainingEl = $('stockRemaining');
  remainingEl.textContent = `${fmt(stock.remaining,2)} kg`;
  remainingEl.classList.toggle('is-bad', stock.remaining < 0);
  const bottleneck = [...stock.items].sort((a,b)=>b.shortfall-a.shortfall || a.producible-b.producible)[0];
  $('stockBottleneck').textContent = bottleneck ? (bottleneck.p.name || 'İsimsiz ürün') : '—';
  $('stockBottleneckNote').textContent = bottleneck
    ? (bottleneck.shortfall > 0 ? `${fmt(bottleneck.shortfall,0)} adet eksik` : `${fmt(bottleneck.producible,0)} adet basılabilir`)
    : 'Stok sınırı';
  const hasShortage = stock.colorRows.some(row => row.remaining < -0.0005) || stock.items.some(item => item.shortfall > 0);
  $('stockTag').textContent = stock.stockKg > 0 && !hasShortage ? 'Stok yeterli' : 'Stok uyarısı';

  // --- Renk bazlı stok tablosu ---
  if ($('colorStockTag')) $('colorStockTag').textContent = `${stock.colorRows.length} renk`;
  const colorRowsEl = $('colorStockRows');
  if (colorRowsEl) {
    colorRowsEl.innerHTML = stock.colorRows.map(row=>{
      const short = row.remaining < -0.0005;
      const low = row.stockKg > 0 && stock.minStockKg > 0 && row.stockKg < stock.minStockKg;
      const status = row.stockKg <= 0
        ? '<span class="status-pill neutral">Stok yok</span>'
        : short
          ? `<span class="status-pill danger">${fmt(-row.remaining,2)} kg eksik</span>`
          : low
            ? '<span class="status-pill warn">Kritik</span>'
            : '<span class="status-pill ok">Yeterli</span>';
      return `<tr>
        <td><span class="color-name"><i class="color-dot" style="background:${colorSwatch(row.name)}"></i>${esc(row.name)}</span></td>
        <td><div class="input-wrap mini-input"><input type="number" min="0" max="100000" step="0.001" data-color-stock="${esc(row.name)}" value="${Number(row.stockKg.toFixed(3))}" aria-label="${esc(row.name)} stoğu kg"><b>kg</b></div></td>
        <td title="Alım fiyatlarının gram ağırlıklı ortalaması">${money(row.avgPrice)} <small class="muted">/ kg</small></td>
        <td>${fmt(row.neededKg,2)} kg</td>
        <td class="${short?'is-bad':'is-good'}">${fmt(row.remaining,2)} kg</td>
        <td>${status}</td>
        <td><button class="delete-btn" type="button" data-color-remove="${esc(row.name)}" title="Bu rengi stoktan kaldır" aria-label="${esc(row.name)} rengini stoktan kaldır">×</button></td>
      </tr>`;
    }).join('');
  }
  if ($('colorStockEmpty')) $('colorStockEmpty').style.display = stock.colorRows.length ? 'none' : 'block';
  const colorList = $('stockColorList');
  if (colorList) colorList.innerHTML = stock.colorRows.map(row=>`<option value="${esc(row.name)}"></option>`).join('');

  // --- Uyarı listesi ---
  const alerts = [];
  if (stock.stockKg <= 0) alerts.push(['danger','Depoda filament görünmüyor. Aşağıdaki stok girişinden renk ve miktar ekle.']);
  else if (stock.minStockKg > 0 && stock.stockKg < stock.minStockKg) alerts.push(['danger',`Kritik stok: toplam ${fmt(stock.stockKg,2)} kg, belirlediğin ${fmt(stock.minStockKg,2)} kg eşiğinin altında.`]);
  if (stock.stockKg > 0 && stock.neededKg > stock.stockKg) alerts.push(['danger',`Planı tamamlamak için toplam ${fmt(stock.neededKg-stock.stockKg,2)} kg filament eksik.`]);
  stock.colorRows.filter(row=>row.stockKg<=0 && row.neededKg>0).forEach(row=>{
    alerts.push(['warn',`"${row.name}" rengi için stok yok; plan ${fmt(row.neededKg,2)} kg gerektiriyor.`]);
  });
  stock.colorRows.filter(row=>row.stockKg>0 && row.remaining<-0.0005).forEach(row=>{
    alerts.push(['danger',`"${row.name}" rengi plana ${fmt(-row.remaining,2)} kg yetmiyor.`]);
  });
  stock.items.filter(item=>item.shortfall>0 && item.gpu>0).forEach(item=>{
    const reason = item.colored ? 'renk stoğu' : 'stok';
    alerts.push(['warn',`"${item.p.name || 'İsimsiz ürün'}" için ${reason} ${fmt(item.producible,0)} adede yetiyor; plan ${fmt(item.qty,0)} adet.`]);
  });
  if (!alerts.length) alerts.push(['ok','Stok, mevcut üretim planını karşılamaya yeterli görünüyor.']);
  $('stockAlerts').innerHTML = alerts.map(([type,text])=>`<div class="alert-item ${type}"><span class="alert-dot"></span><p>${esc(text)}</p></div>`).join('');

  // --- Ürünlere göre stok tablosu ---
  $('stockRows').innerHTML = stock.items.map(item=>{
    const chips = item.colored
      ? `<div class="color-chip-list">${item.colorUse.map(color=>`<span class="color-chip"><i style="background:${colorSwatch(color.name)}"></i>${esc(color.name)} <small>${fmt(color.gramsPerUnit,1)} g</small></span>`).join('')}</div>`
      : '<span class="muted-chip">Genel stok</span>';
    return `<tr>
      <td>${esc(item.p.name || 'İsimsiz ürün')}</td>
      <td>${chips}</td>
      <td>${fmt(item.gpu)} g</td>
      <td>${fmt(item.effGpu)} g</td>
      <td>${fmt(item.qty,0)}</td>
      <td class="${item.shortfall>0?'stock-short':'stock-ok'}">${fmt(item.producible,0)} adet</td>
      <td>${fmt(item.plannedKg,2)} kg</td>
      <td>${!item.colored ? '<span class="status-pill neutral">Renk tanımlanmadı</span>' : item.gpu<=0 ? '<span class="status-pill neutral">Gram girilmedi</span>' : item.shortfall>0 ? `<span class="status-pill danger">${fmt(item.shortfall,0)} adet eksik</span>` : '<span class="status-pill ok">Yeterli</span>'}</td>
    </tr>`;
  }).join('');
  $('stockEmpty').style.display = stock.items.length ? 'none' : 'block';

  // --- Enflasyon özeti ---
  const points = filamentPricePoints();
  const current = x.filamentPrice;
  $('inflCurrent').textContent = money(current);
  let base = current, baseDate = null;
  if (points.length) {
    const first = points[0];
    base = Number(first.oldValue) > 0 ? Number(first.oldValue) : Number(first.newValue);
    baseDate = new Date(first.date);
  }
  $('inflFirst').textContent = points.length ? money(base) : '—';
  $('inflFirstDate').textContent = points.length && baseDate && !Number.isNaN(baseDate.getTime())
    ? `${baseDate.toLocaleDateString('tr-TR')} · ${points.length} kayıt` : 'Kayıt yok';
  const changePct = base > 0 ? (current-base)/base*100 : 0;
  const changeEl = $('inflChange');
  changeEl.textContent = points.length ? `${changePct>=0?'+':''}${fmt(changePct,1)}%` : '—';
  changeEl.classList.toggle('is-good', changePct < 0);
  changeEl.classList.toggle('is-bad', changePct > 0);
  $('inflChangeNote').textContent = points.length ? `${money(current-base)} fark / kg` : 'İlk kayda göre';
  const totalGrams = state.products.reduce((sum,p)=>sum+(Number(p.grams)||0),0);
  $('inflImpact').textContent = points.length ? money(totalGrams*(current-base)/1000) : '—';
  $('inflImpact').classList.toggle('is-bad', totalGrams*(current-base) > 0);
  $('inflImpact').classList.toggle('is-good', totalGrams*(current-base) < 0);

  // --- Fiyat bar grafiği (son 12 kayıt + güncel) ---
  const series = points.slice(-12).map(pt=>({label:new Date(pt.date).toLocaleDateString('tr-TR',{day:'2-digit',month:'2-digit'}),price:Number(pt.newValue)||0}));
  series.push({label:'Güncel',price:current,current:true});
  const maxPrice = Math.max(...series.map(s=>s.price),1);
  const barSig = JSON.stringify(series);
  if (chartSig.price !== barSig) {
    chartSig.price = barSig;
    $('priceBars').innerHTML = series.map(s=>`<div class="price-bar${s.current?' current':''}" title="${esc(s.label)}: ${money(s.price)}"><span class="price-bar-fill" data-v="${Math.max(6,(s.price/maxPrice)*100).toFixed(2)}" style="height:0%"></span><small>${esc(s.label)}</small></div>`).join('');
    playPriceBars(isPageActive('inventory'));
  }

  // --- Enflasyon tablosu ---
  const rows = [...points].reverse();
  $('inflationRows').innerHTML = rows.map(pt=>{
    const oldPrice = Number(pt.oldValue)||0, newPrice = Number(pt.newValue)||0;
    const pct = oldPrice>0 ? (newPrice-oldPrice)/oldPrice*100 : 0;
    const date = new Date(pt.date);
    const dateText = Number.isNaN(date.getTime()) ? esc(pt.date) : date.toLocaleDateString('tr-TR');
    return `<tr><td>${dateText}</td><td>${esc(pt.source || 'Sistem')}</td><td>${money(oldPrice)}</td><td><strong>${money(newPrice)}</strong></td><td class="${pct>=0?'profit-negative':'profit-positive'}">${pct>=0?'+':''}${fmt(pct,1)}%</td><td>${esc(pt.note || '')}</td></tr>`;
  }).join('');
  $('inflationEmpty').style.display = rows.length ? 'none' : 'block';
  refreshTableLabels($('colorStockRows')?.closest('table'));
  refreshTableLabels($('stockRows')?.closest('table'));
  refreshTableLabels($('inflationRows')?.closest('table'));
}
function saveStockEntry(event) {
  event.preventDefault();
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan stok kaydedilemez.'); return; }
  const color = sanitizeColorName($('stockAddColor').value);
  if (!color) { toast('Eklemek için bir renk adı gir.'); return; }
  if (!validateFormInputs($('stockForm'))) return;
  const kgParsed = parseStrictNumber($('stockAddKg').value,{min:0.01,max:100000});
  const priceParsed = parseStrictNumber($('stockAddPrice').value,{min:0.01,max:1000000});
  if (!kgParsed.ok || !priceParsed.ok) { toast('Stok miktarı ve alım fiyatı geçerli aralıkta olmalı.', 'error'); return; }
  const kg = kgParsed.value;
  const price = priceParsed.value;
  const dateValue = $('stockAddDate').value || todayISO();
  const previous = params().filamentPrice;
  const existing = normalizeStockEntry(filamentStock[color]);
  // Eski düz sayı kayıtlarında fiyat bilinmez; güncel filament fiyatı başlangıç ortalaması kabul edilir.
  const existingAvg = existing.weightedAveragePricePerKg ?? previous;
  const addedGrams = kg * 1000;
  const newGrams = existing.totalWeightGrams + addedGrams;
  // Ağırlıklı ortalama maliyet:
  // (mevcut gram × eski ortalama) + (eklenen gram × yeni alım fiyatı) ÷ toplam gram
  const newAvgPrice = newGrams > 0
    ? ((existing.totalWeightGrams * existingAvg) + (addedGrams * price)) / newGrams
    : price;
  const newStock = round3(newGrams / 1000);
  const priceChanged = price > 0 && Math.abs(price-previous) > 0.001;
  const updates = {};
  updates[`filamentStock/${color}`] = {
    kg: newStock,
    totalWeightGrams: Math.round(newGrams),
    weightedAveragePricePerKg: round4(newAvgPrice),
    lastPurchasePrice: price,
    updatedAt: Date.now()
  };
  // Alım bedeli gider olarak kaydedilir (alım silinirse gider de kalkar).
  const purchaseKey = filamentPurchasesRef.push().key;
  updates[`filamentPurchases/${purchaseKey}`] = {
    date: dateValue, color, kg: round3(kg), pricePerKg: round2(price),
    total: round2(kg * price), createdAt: Date.now()
  };
  if (priceChanged) updates['params/filamentPrice'] = price;
  let historyEntry = null;
  if (priceChanged) {
    const stamp = new Date(`${dateValue}T12:00:00`);
    const historyKey = historyRef.push().key;
    historyEntry = {
      id:historyKey, date:Number.isNaN(stamp.getTime())?new Date().toISOString():stamp.toISOString(),
      key:'filamentPrice', label:'Filament fiyatı (TL/kg)', oldValue:previous, newValue:price,
      source:'Alım kaydı', note:`${fmt(kg,2)} kg ${color} filament alımı`
    };
    updates[`costHistory/${historyKey}`] = historyEntry;
  }
  rootRef.update(updates)
    .then(() => {
      filamentStock[color] = updates[`filamentStock/${color}`];
      $('stockAddColor').value = color;
      if (priceChanged) {
        state.filamentPrice = price;
        $('filamentPrice').value = price;
        $('stockAddPrice').value = round2(newAvgPrice);
        lastCommittedParams = clone(params());
        if (historyEntry) { costHistory.unshift(historyEntry); renderCostHistory(); }
      }
      $('stockAddKg').value = 1;
      $('stockAddDate').value = todayISO();
      renderProducts(); renderSales(); renderInventory();
      toast(priceChanged
        ? `${color} stoğuna ${fmt(kg,2)} kg eklendi. Ağırlıklı ortalama fiyat ${money(newAvgPrice)} / kg; son alım ${money(price)} / kg.`
        : `${color} stoğuna ${fmt(kg,2)} kg filament eklendi. Ağırlıklı ortalama ${money(newAvgPrice)} / kg.`);
      toast(`${money(kg * price)} gider olarak kaydedildi.`, 'info');
      updateStockTotalPreview();
    })
    .catch(error => cloudError(error, 'stok girişi'));
}
function addProduct() {
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan ürün eklenemez.'); return; }
  const product = {name:'Yeni Ürün',qty:1,grams:0,hours:0,sale:0,usesLighter:true,photo:'',readyStock:0,createdAt:Date.now()};
  productsRef.push(product)
    .then(() => toast('Yeni ürün buluta eklendi.'))
    .catch(error => cloudError(error, 'ürün ekleme'));
}
function localDate(dateString) {
  const parts = String(dateString||'').split('-').map(Number);
  if (parts.length!==3 || parts.some(n=>!n)) return null;
  return new Date(parts[0],parts[1]-1,parts[2]);
}
function getPeriodBounds(period) {
  const now = new Date(); now.setHours(0,0,0,0);
  if (period==='all') return {start:null,end:null,label:'Tüm kayıtlar'};
  if (period==='week') {
    const start = new Date(now); const day = (start.getDay()+6)%7; start.setDate(start.getDate()-day);
    const end = new Date(start); end.setDate(end.getDate()+7);
    return {start,end,label:`${dateLabel(start)} – ${dateLabel(new Date(end.getTime()-86400000))}`};
  }
  const start = new Date(now.getFullYear(),now.getMonth(),1);
  const end = new Date(now.getFullYear(),now.getMonth()+1,1);
  return {start,end,label:start.toLocaleDateString('tr-TR',{month:'long',year:'numeric'})};
}
function dateLabel(date) { return date.toLocaleDateString('tr-TR',{day:'2-digit',month:'2-digit',year:'numeric'}); }
function filteredSales() {
  const period = $('salesPeriod').value;
  const bounds = getPeriodBounds(period);
  const records = sales.filter(s=>{
    if (!bounds.start) return true;
    const date = localDate(s.date);
    return date && date>=bounds.start && date<bounds.end;
  });
  return {records:records.sort((a,b)=>String(b.date).localeCompare(String(a.date)) || (b.createdAt||0)-(a.createdAt||0)),bounds};
}
function renderSales() {
  const {records,bounds} = filteredSales();
  $('salesRange').textContent = bounds.label;
  const qty = records.reduce((sum,s)=>sum+(Number(s.unitsTotal ?? s.qty)||0),0);   // paketlerde içerdeki ürün adetleri sayılır
  const revenue = records.reduce((sum,s)=>sum+(Number(s.revenue)||0),0);
  const cost = records.reduce((sum,s)=>sum+(Number(s.totalCost)||0),0);
  const profit = records.reduce((sum,s)=>sum+(Number(s.profit)||0),0);
  $('salesUnits').textContent = fmt(qty,0); $('salesRevenue').textContent = money(revenue);
  $('salesCost').textContent = money(cost); $('salesProfit').textContent = money(profit);
  // Seçili dönemdeki filament alım giderleri ve gider sonrası bakiye.
  const expense = purchasesInBounds(bounds).reduce((sum, p) => sum + purchaseTotalOf(p), 0);
  if ($('salesExpense')) $('salesExpense').textContent = money(expense);
  if ($('salesAfterExpense')) {
    const after = profit - expense;
    $('salesAfterExpense').textContent = money(after);
    $('salesAfterExpense').classList.toggle('profit-negative', after < 0);
    $('salesAfterExpense').classList.toggle('profit-positive', after >= 0);
  }
  // Ana sayfadaki kâr kartı, dönem filtresinden bağımsız olarak gerçek satış kayıtlarından gelir.
  const allProfit = sales.reduce((sum, s) => sum + (Number(s.profit) || 0), 0);
  $('statProfit').textContent = money(allProfit);
  $('statProfitCaption').textContent = sales.length ? `Yapılan ${sales.length} satış kaydından` : 'Henüz satış kaydı yok';
  $('salesEmpty').style.display = records.length ? 'none' : 'block';
  $('salesRows').innerHTML = records.map(s=>`<tr class="${s.type==='package'?'is-package':''}">
    <td><input type="checkbox" class="row-select" data-select-sale="${esc(s.id)}" aria-label="Satışı seç" ${selectedSales.has(String(s.id))?'checked':''}></td><td>${esc(s.date)}</td><td>${saleNameCell(s)}</td><td>${saleQtyCell(s)}</td><td>${money(s.unitPrice)}</td><td class="money">${money(s.revenue)}</td><td>${money(s.unitCost)}</td><td>${money(s.totalCost)}</td><td class="${s.profit>=0?'profit-positive':'profit-negative'}">${money(s.profit)}</td><td>${esc(s.note||'')}</td><td><button class="detail-btn" data-sale-detail="${esc(s.id)}" type="button">Fiyat detayı</button></td><td><button class="delete-btn" data-sale-delete="${esc(s.id)}" title="Satış kaydını sil" aria-label="Satış kaydını sil">×</button></td>
  </tr>`).join('');
  refreshTableLabels($('salesRows')?.closest('table')); syncBulkToolbars();
  renderCostHistory();
  renderSalesChart();
}
function snapshotForSale(product, x) {
  const c = calc(product, x);
  return {
    params: clone(x),
    // Base64 fotoğraf her satışta kopyalanıp veritabanını şişirmesin diye snapshot'a eklenmez.
    product: { id: product.id, name: product.name || 'İsimsiz ürün', qty: Number(product.qty)||0, grams: Number(product.grams)||0, hours: Number(product.hours)||0, usesLighter: Boolean(product.usesLighter), colors: productColors(product) },
    breakdown: { filament:c.filament, electric:c.electric, stand:c.stand, machine:c.machine, wear:c.wear, fire:c.fire, lighter:c.lighter, unit:c.unit },
    capturedAt: new Date().toISOString()
  };
}
// Bir satışın makine bakım fonuna aktarılacak teorik payı:
// satılan adet × (parti toplam süresi ÷ parti adedi) × saatlik bakım ücreti.
function maintenanceShareForProduct(product, qty, x = params()) {
  const batchQty = Math.max(0, Number(product?.qty) || 0);
  const batchHours = Math.max(0, Number(product?.hours) || 0);
  if (!batchQty || !batchHours) return 0;
  return round2((batchHours / batchQty) * Math.max(0, Number(qty) || 0) * Math.max(0, Number(x.wearCost) || 0));
}
function saveSale(event) {
  event.preventDefault();
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan satış kaydedilemez.'); return; }
  if (!validateFormInputs($('saleForm'))) return;
  const product = productById($('saleProduct').value);
  if (!product) { toast('Önce ürün maliyet tablosuna ürün ekle.'); return; }
  const qtyParsed = parseStrictNumber($('saleQty').value,{min:1,max:100000,integer:true});
  const priceParsed = parseStrictNumber($('salePrice').value,{min:0,max:10000000});
  if (!qtyParsed.ok || !priceParsed.ok) { toast('Adet ve fiyat geçerli aralıkta olmalı. Satış kaydedilmedi.', 'error'); return; }
  const qty = qtyParsed.value;
  const readyStock = readyStockOf(product);
  if (readyStock < qty) {
    toast(`${stockGuardMessage()}. "${product.name || 'İsimsiz ürün'}" için hazır ${fmt(readyStock,0)} adet var, ${fmt(qty,0)} adet satılamaz. Önce ürün detayından "Üret" ile üretim ekle.`, 'warning', {title:'Mamul stok yetersiz'});
    return;
  }
  const unitPrice = priceParsed.value;
  const x = params();
  const unitCost = calc(product, x).unit;
  const maintenanceShare = maintenanceShareForProduct(product, qty, x);
  const record = {
    date: $('saleDate').value || todayISO(), productId:product.id, productName:product.name || 'İsimsiz ürün',
    qty, unitPrice, unitCost, costSnapshot:snapshotForSale(product,x), maintenanceShare,
    revenue:qty*unitPrice, totalCost:qty*unitCost, profit:qty*(unitPrice-unitCost),
    note:$('saleNote').value.trim(), createdAt:Date.now()
  };
  commitSaleWithFinishedStock(record, [{productId:product.id, name:product.name || 'İsimsiz ürün', qty}], maintenanceShare)
    .then(() => {
      $('saleQty').value = 1; $('saleNote').value = '';
      toast(`Satış buluta kaydedildi. Net kâr: ${money(record.profit)}${maintenanceShare > 0 ? ` · Bakım fonuna ${money(maintenanceShare)} aktarıldı` : ''}`);
    })
    .catch(error => { if(!['insufficient-finished-stock','offline-stock-guard','transaction-aborted'].includes(error.message)) cloudError(error, 'satış kaydetme'); });
}

function recordParameterChanges() {
  flushParamWrites();
  const current = params();
  const labels = {
    filamentPrice:'Filament fiyatı (TL/kg)',standGrams:'Stand gramı (g)',
    lighterCost:'Çakmak toplu maliyeti (TL)',targetUnits:'Hedef adet',
    wasteRate:'Fire oranı (%)',printerPower:'Yazıcı gücü (W)',energyPrice:'Elektrik birim fiyatı (TL/kWh)',
    printerPrice:'Yazıcı bedeli (TL)',printerLifeHours:'Beklenen ömür (saat)',wearCost:'Bakım fonu (TL/saat)'
  };
  const changed = Object.keys(labels).filter(key => dirtyParamKeys.has(key) && Number(current[key])!==Number(lastCommittedParams[key]));
  const stamp = new Date().toISOString();
  changed.forEach(key=>{
    const entry = {date:stamp,key,label:labels[key],oldValue:Number(lastCommittedParams[key])||0,newValue:Number(current[key])||0,source:'Sistem'};
    if (cloudReady) {
      const ref = historyRef.push();
      entry.id = ref.key;
      ref.set(entry).catch(error => cloudError(error, 'fiyat geçmişi'));
      costHistory.unshift(entry);
    }
  });
  dirtyParamKeys.clear();
  lastCommittedParams = clone(current);
  renderCostHistory();
  if (changed.length && cloudReady) toast('Maliyet değişikliği buluta kaydedildi.');
}
function renderCostHistory() {
  const tbody = $('costHistoryRows');
  if (!tbody) return;
  const rows = [...costHistory].sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  tbody.innerHTML = rows.slice(0,100).map(item=>{
    const date = new Date(item.date);
    const dateText = Number.isNaN(date.getTime()) ? esc(item.date) : `${date.toLocaleDateString('tr-TR')} ${date.toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'})}`;
    const units = {filamentPrice:' TL',lighterCost:' TL',printerPrice:' TL',energyPrice:' TL/kWh',standGrams:' g',targetUnits:' adet',wasteRate:' %',printerPower:' W',printerLifeHours:' saat',wearCost:' TL/saat'};
    const unit = units[item.key] || '';
    return `<tr><td>${dateText}</td><td>${esc(item.label)}</td><td>${fmt(item.oldValue)}${unit}</td><td><strong>${fmt(item.newValue)}${unit}</strong></td><td><button class="delete-btn" type="button" data-history-delete="${esc(item.id)}" aria-label="Maliyet değişim kaydını sil" title="Kaydı sil">×</button></td></tr>`;
  }).join('');
  $('historyEmpty').style.display = rows.length ? 'none' : 'block';
  refreshTableLabels(tbody.closest('table'));
}
function showSaleDetails(id) {
  const sale = sales.find(item=>String(item.id)===String(id));
  if (!sale) return;
  if (sale.type === 'package') { showPackageDetails(sale); return; }
  const snap = sale.costSnapshot;
  const p = snap?.params || {};
  const b = snap?.breakdown || {};
  $('saleDetailTitle').textContent = `${sale.productName} — satış detayları`;
  $('saleDetailSubtitle').textContent = `Satış tarihi: ${sale.date} · Kayıt anındaki fiyatlar gösteriliyor; bugünkü maliyetlerle yeniden hesaplanmıyor.`;
  const paramItems = [
    ['Filament fiyatı',p.filamentPrice===undefined?'Bu eski kayıtta saklanmamış':money(p.filamentPrice)+' / kg'],
    ['Fire oranı',p.wasteRate===undefined?'Bu eski kayıtta saklanmamış':`%${fmt(p.wasteRate,1)}`],
    ['Yazıcı gücü',p.printerPower===undefined?'Bu eski kayıtta saklanmamış':`${fmt(p.printerPower,0)} W`],
    ['Elektrik birim fiyatı',p.energyPrice===undefined?'Bu eski kayıtta saklanmamış':money(p.energyPrice)+' / kWh'],
    ['Yazıcı bedeli',p.printerPrice===undefined?'Bu eski kayıtta saklanmamış':money(p.printerPrice)],
    ['Beklenen ömür',p.printerLifeHours===undefined?'Bu eski kayıtta saklanmamış':`${fmt(p.printerLifeHours,0)} saat`],
    ['Bakım fonu',p.wearCost===undefined?'Bu eski kayıtta saklanmamış':money(p.wearCost)+' / saat'],
    ['Çakmak toplu maliyeti',p.lighterCost===undefined?'Bu eski kayıtta saklanmamış':money(p.lighterCost)],
    ['Stand filament miktarı',p.standGrams===undefined?'Bu eski kayıtta saklanmamış':fmt(p.standGrams)+' g'],
    ['Hedef adet',p.targetUnits===undefined?'Bu eski kayıtta saklanmamış':fmt(p.targetUnits,0)+' adet']
  ];
  const breakdownItems = [
    ['Filament / ürün',b.filament],['Elektrik / ürün',b.electric],['Stand / ürün',b.stand],['Makine amortismanı / ürün',b.machine],['Aşınma & bakım / ürün',b.wear],['Fire payı / ürün',b.fire],['Çakmak / ürün',b.lighter]
  ];
  $('saleDetailContent').innerHTML = `
    <h3 class="detail-section-title">Satış anındaki değişken fiyatlar</h3>
    <div class="detail-grid">${paramItems.map(([label,value])=>`<div class="detail-item"><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>`).join('')}</div>
    <h3 class="detail-section-title">Ürün maliyetinin dökümü (birim başına)</h3>
    <div class="detail-meta"><span>Baskı süresi<strong>${fmt(snap?.product?.hours||0)} saat</strong></span></div>
    <div class="table-wrap"><table class="detail-table"><thead><tr><th>Gider kalemi</th><th>Birim maliyet</th></tr></thead><tbody>${breakdownItems.map(([label,value])=>`<tr><td>${esc(label)}</td><td>${value===undefined?'Eski kayıtta yok':money(value)}</td></tr>`).join('')}<tr><td><strong>Toplam birim maliyet</strong></td><td><strong>${money(sale.unitCost)}</strong></td></tr></tbody></table></div>
    <div class="detail-total"><span>Satış fiyatı / adet<strong>${money(sale.unitPrice)}</strong></span><span>Satılan adet<strong>${fmt(sale.qty,0)}</strong></span><span>Toplam ciro<strong>${money(sale.revenue)}</strong></span><span>Toplam maliyet<strong>${money(sale.totalCost)}</strong></span><span>Bu satışın net kârı<strong>${money(sale.profit)}</strong></span></div>
    ${!snap?'<p class="note">Bu satış, fiyat geçmişi özelliği eklenmeden önce kaydedilmiş. Eski maliyet bileşenleri bu kayıtta saklı olmadığı için sadece birim maliyet, toplam maliyet ve kâr gösterilebilir. Yeni satışlarda tüm fiyatlar ayrı ayrı kaydedilir.</p>':''}`;
  $('saleDetailModal').hidden = false;
}

/* ---------- Parametre ve ürün olayları ---------- */
inputIds.forEach(id=>{
  const el = $(id);
  if (!el) return;
  el.addEventListener('input',()=>{
    if(!validateNumericElement(el,{silent:true})) return;
    dirtyParamKeys.add(id);
    state[id]=num(id);
    renderProducts(); renderSales();
    queueParamWrite(id, state[id]);
  });
  el.addEventListener('change',()=>{ if(!validateNumericElement(el)){el.value=lastCommittedParams[id] ?? defaults[id];return;} state[id]=num(id); recordParameterChanges(); });
});
stockInputIds.forEach(id=>{
  const el = $(id); if (!el) return;
  el.addEventListener('input',()=>{ if(!validateNumericElement(el,{silent:true}))return; state[id]=num(id); renderProducts(); queueParamWrite(id, state[id]); });
  el.addEventListener('change',()=>{ if(!validateNumericElement(el)){el.value=state[id] ?? defaults[id];return;} state[id]=num(id); queueParamWrite(id, state[id]); renderInventory(); });
});
// Canvas içeriğini tarayıcının desteklediği en verimli formatta Base64 Data URL'e çevirir.
// WebP desteklenmiyorsa JPEG'e, o da yoksa tarayıcının varsayılan PNG çıktısına düşer.
function canvasToDataUrl(canvas, quality = 0.82) {
  const attempts = [
    ['image/webp', quality],
    ['image/webp', Math.max(0.55, quality - 0.18)],
    ['image/jpeg', quality],
    ['image/jpeg', Math.max(0.55, quality - 0.18)]
  ];
  let dataUrl = '';
  for (const [type, q] of attempts) {
    try { dataUrl = canvas.toDataURL(type, q); } catch (error) { continue; }
    if (dataUrl.startsWith(`data:${type}`)) break;
  }
  if (!dataUrl.startsWith('data:image/')) throw new Error('Görsel Base64 formatına dönüştürülemedi.');
  return dataUrl;
}
// Fotoğrafı en fazla 640 px olacak şekilde küçültür, düz arka planı temizler ve
// sonucu Realtime Database'de doğrudan saklanabilecek Base64 Data URL olarak döndürür.
function processPhotoFile(file, id) {
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan fotoğraf kaydedilemez.'); return; }
  const product = productById(id);
  if (!file || !product) return;
  if (!file.type.startsWith('image/')) { toast('Lütfen bir fotoğraf dosyası seç.'); return; }
  if (file.size > 12*1024*1024) { toast('Fotoğraf en fazla 12 MB olabilir.'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      try {
        const maxSide=640, scale=Math.min(1,maxSide/Math.max(img.width,img.height));
        const canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(img.width*scale)); canvas.height=Math.max(1,Math.round(img.height*scale));
        const ctx=canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img,0,0,canvas.width,canvas.height);
        const bgResult=removeBackground(canvas);
        const dataUrl=canvasToDataUrl(canvas,0.82);
        // Realtime Database yazma boyutunu güvenli sınırda tut.
        if (dataUrl.length > 2_000_000) {
          toast('Fotoğraf Base64 olarak çok büyük. Daha düşük çözünürlüklü bir görsel seç.', 'error');
          return;
        }
        productsRef.child(id).update({photo:dataUrl})
          .then(() => {
            product.photo=dataUrl;
            renderProducts();
            const kb = Math.max(1, Math.round(dataUrl.length/1024));
            toast(bgResult==='done'
              ? `Fotoğraf arka planı temizlenerek ${canvas.width}×${canvas.height} px boyutunda Base64 olarak kaydedildi (${kb} KB).`
              : `Fotoğraf ${canvas.width}×${canvas.height} px boyutunda Base64 olarak kaydedildi (${kb} KB).`,
              'success');
          })
          .catch(error => cloudError(error,'fotoğrafı Realtime Database’e kaydetme'));
      } catch(error) {
        console.error('fotoğraf dönüştürme', error);
        toast('Fotoğraf Base64 formatına dönüştürülemedi.', 'error');
      }
    };
    img.onerror=()=>toast('Fotoğraf okunamadı.'); img.src=reader.result;
  };
  reader.onerror=()=>toast('Fotoğraf yüklenemedi.'); reader.readAsDataURL(file);
}

$('productRows').addEventListener('change',event=>{
  const fileInput = event.target.closest('input[data-photo-id]');
  if (fileInput) {
    const file = fileInput.files && fileInput.files[0];
    if (file) processPhotoFile(file, fileInput.dataset.photoId);
    return;
  }
  const el=event.target; if (!el.dataset.pid || !el.dataset.k) return;
  const product=productById(el.dataset.pid); if(!product)return;
  if (el.type==='number' && !validateNumericElement(el)) { el.value=product[el.dataset.k] ?? 0; return; }
  const key=el.dataset.k;
  if (key === 'name') {
    product.name = el.value;
    writeProductItem(product.id, {name: product.name});
  } else if (key === 'qty') {
    const qty = parseStrictNumber(el.value,{min:0,integer:true}).value;
    product.qty=qty;
    const fields = {qty};
    const raw = rawColors(product);
    if (raw.length) {
      const unit = raw.reduce((sum, color) => sum + Math.max(0, Number(color?.grams) || 0), 0);
      product.grams = Math.round(unit * qty * 100) / 100;
      fields.grams = product.grams;
    }
    writeProductItem(product.id, fields);
  } else if (key === 'grams') {
    const grams = parseStrictNumber(el.value,{min:0}).value;
    product.grams=grams;
    const fields = {grams};
    const qty = Math.max(0, Number(product.qty) || 0);
    const raw = rawColors(product).map(color => ({
      name: String(color?.name ?? ''),
      grams: Math.max(0, Number(color?.grams) || 0)
    }));
    if (raw.length && qty > 0) {
      // Toplam gram elle değiştirildiğinde renk gramları oransal olarak ölçeklenir.
      const targetUnit = grams / qty;
      const sum = raw.reduce((total, color) => total + color.grams, 0);
      product.colors = raw.map(color => ({
        name: color.name,
        grams: Math.round((sum > 0 ? color.grams * targetUnit / sum : targetUnit / raw.length) * 100) / 100
      }));
      fields.colors = product.colors;
    }
    writeProductItem(product.id, fields);
  } else {
    product[key] = Math.max(0, Number(el.value) || 0);
    writeProductItem(product.id, {[key]: product[key]});
  }
  renderProducts(); renderSales();
});
$('productRows').addEventListener('click',event=>{
  const detailButton=event.target.closest('[data-product-detail]');
  if(detailButton){openProductDetail(detailButton.dataset.productDetail);return;}
  const button=event.target.closest('[data-delete]');
  if (button) {
    const product=productById(button.dataset.delete); if(!product)return;
    if (!cloudReady) { toast('Bulut bağlantısı kurulmadan ürün silinemez.'); return; }
    confirmDialog({ title:'Ürünü sil', message:`"${product.name||'Ürün'}" ürünü silinecek. Satış geçmişindeki kayıtlar korunur.`, confirmText:'Ürünü sil', danger:true }).then(ok=>{
      if(!ok) return;
      const copy={...product}; delete copy.id;
      undoableDelete('product',product.id,copy,productsRef.child(product.id),`“${product.name||'Ürün'}”`);
    });
    return;
  }
  // Düzenlenebilir alanlara tıklanmadıysa satırın tamamı ürün detayını açar.
  if (event.target.closest('input, select, textarea, label, button, a')) return;
  const row = event.target.closest('tr[data-product-row]');
  if (row) openProductDetail(row.dataset.productRow);
});
$('salesRows').addEventListener('click',event=>{
  const detailButton=event.target.closest('[data-sale-detail]');
  if(detailButton){showSaleDetails(detailButton.dataset.saleDetail);return;}
  const button=event.target.closest('[data-sale-delete]'); if(!button)return;
  const record=sales.find(s=>String(s.id)===button.dataset.saleDelete);
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan satış silinemez.'); return; }
  confirmDialog({ title:'Satış kaydını sil', message:`${record?.productName||'Bu'} satış kaydı silinecek.`, confirmText:'Kaydı sil', danger:true }).then(ok=>{
    if(!ok) return;
    if(!record)return;
    const copy={...record}; delete copy.id;
    undoableDelete('sale',record.id,copy,salesRef.child(record.id),`“${record.productName||'Satış'}”`);
  });
});
$('costHistoryRows').addEventListener('click',event=>{
  const button=event.target.closest('[data-history-delete]');
  if(!button) return;
  const id=button.dataset.historyDelete;
  const item=costHistory.find(entry=>String(entry.id)===String(id));
  if(!item) return;
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan kayıt silinemez.'); return; }
  confirmDialog({ title:'Değişim kaydını sil', message:`${item.label} değişim kaydı silinecek. Bu işlem geri alınamaz.`, confirmText:'Kaydı sil', danger:true }).then(ok=>{
    if(!ok) return;
    costHistory=costHistory.filter(entry=>String(entry.id)!==String(id));
    renderCostHistory(); renderInventory();
    historyRef.child(id).remove().catch(error=>cloudError(error,'fiyat geçmişi silme'));
    toast('Maliyet değişim kaydı buluttan silindi.');
  });
});
$('saleForm').addEventListener('submit',saveSale);

// Toplu seçim, yüzde zam ve geri alınabilir toplu silme.
$('productRows').addEventListener('change',event=>{
  const box=event.target.closest('[data-select-product]'); if(!box)return;
  const id=String(box.dataset.selectProduct); box.checked?selectedProducts.add(id):selectedProducts.delete(id); syncBulkToolbars();
});
$('salesRows').addEventListener('change',event=>{
  const box=event.target.closest('[data-select-sale]'); if(!box)return;
  const id=String(box.dataset.selectSale); box.checked?selectedSales.add(id):selectedSales.delete(id); syncBulkToolbars();
});
$('productSelectAll')?.addEventListener('change',event=>{state.products.forEach(p=>event.target.checked?selectedProducts.add(String(p.id)):selectedProducts.delete(String(p.id)));renderProducts();});
$('salesSelectAll')?.addEventListener('change',event=>{filteredSales().records.forEach(s=>event.target.checked?selectedSales.add(String(s.id)):selectedSales.delete(String(s.id)));renderSales();});
$('productBulkClear')?.addEventListener('click',()=>{selectedProducts.clear();renderProducts();});
$('salesBulkClear')?.addEventListener('click',()=>{selectedSales.clear();renderSales();});
$('productBulkRaise')?.addEventListener('click',async()=>{
  const parsed=parseStrictNumber($('productBulkPercent').value,{min:0,max:500}); if(!parsed.ok){toast('Zam oranı 0–500 arasında geçerli bir sayı olmalı.','warning');return;}
  const targets=state.products.filter(p=>selectedProducts.has(String(p.id))); if(!targets.length)return;
  const updates={}; targets.forEach(p=>{const sale=Math.round((Number(p.sale)||0)*(1+parsed.value/100)*100)/100;updates[`${p.id}/sale`]=sale;p.sale=sale;});
  try{await productsRef.update(updates);toast(`${targets.length} ürünün fiyatı %${fmt(parsed.value,1)} artırıldı.`,'success');renderProducts();}catch(error){cloudError(error,'toplu fiyat güncelleme');}
});
$('productBulkDelete')?.addEventListener('click',async()=>{
  const targets=state.products.filter(p=>selectedProducts.has(String(p.id))); if(!targets.length)return;
  if(!await confirmDialog({title:'Toplu ürün silme',message:`${targets.length} ürün 5 saniye boyunca geri alınabilir şekilde silinecek.`,confirmText:'Seçilenleri sil',danger:true}))return;
  selectedProducts.clear(); targets.forEach(p=>{const copy={...p};delete copy.id;undoableDelete('product',p.id,copy,productsRef.child(p.id),`“${p.name||'Ürün'}”`);});
});
$('salesBulkDelete')?.addEventListener('click',async()=>{
  const targets=sales.filter(s=>selectedSales.has(String(s.id))); if(!targets.length)return;
  if(!await confirmDialog({title:'Toplu satış silme',message:`${targets.length} satış kaydı 5 saniye boyunca geri alınabilir şekilde silinecek.`,confirmText:'Seçilenleri sil',danger:true}))return;
  selectedSales.clear(); targets.forEach(s=>{const copy={...s};delete copy.id;undoableDelete('sale',s.id,copy,salesRef.child(s.id),`“${s.productName||'Satış'}”`);});
});

$('stockForm').addEventListener('submit',saveStockEntry);
['stockAddKg','stockAddPrice'].forEach(id => $(id)?.addEventListener('input', updateStockTotalPreview));
updateStockTotalPreview();
$('purchaseRows')?.addEventListener('click', event => {
  const btn = event.target.closest('[data-purchase-delete]');
  if (btn) deletePurchase(btn.dataset.purchaseDelete);
});
$('saleProduct').addEventListener('change',()=>{const p=productById($('saleProduct').value); if(p && Number(p.sale)>0) $('salePrice').value=p.sale;});
$('salesPeriod').addEventListener('change',renderSales);
$('closeSaleDetail').addEventListener('click',()=>$('saleDetailModal').hidden=true);
$('saleDetailModal').addEventListener('click',event=>{if(event.target===$('saleDetailModal')) $('saleDetailModal').hidden=true;});
document.addEventListener('keydown',event=>{
  if (event.key !== 'Escape') return;
  if ($('photoLightbox') && !$('photoLightbox').hidden) return; // önce lightbox kapanır
  if ($('productionModal') && !$('productionModal').hidden) { closeProductionModal(); return; }
  $('saleDetailModal').hidden = true;
  if ($('productDetailModal') && !$('productDetailModal').hidden) closeProductDetail();
});
$('addProduct').addEventListener('click',addProduct); $('addProductTop').addEventListener('click',addProduct);
$('searchInput').addEventListener('input',renderProducts);
$('saleDate').value=todayISO();
if ($('stockAddDate')) $('stockAddDate').value=todayISO();
if ($('stockAddPrice')) $('stockAddPrice').value=state.filamentPrice ?? defaults.filamentPrice;
window.addEventListener('beforeunload',()=>{ if (pendingWriteCount()) flushParamWrites(); });

/* =========================================================
 * ÜRÜN DETAY MODALI
 * Fotoğrafa, ürün satırına veya "Detay" düğmesine tıklanınca açılır.
 * Kullanılan renkler, renk başına gram ve büyük fotoğraf gösterilir.
 * ========================================================= */
function openProductDetail(id) {
  detailProductId = String(id);
  const modal = $('productDetailModal');
  if (!modal) return;
  modal.hidden = false;
  renderProductDetail();
}
function closeProductDetail() {
  const modal = $('productDetailModal');
  if (modal) modal.hidden = true;
  detailProductId = null;
}
function detailColorList(product) {
  return rawColors(product)
    .map(color => ({name: String(color?.name ?? ''), grams: Math.max(0, Number(color?.grams) || 0)}))
    .filter(color => color.name || color.grams > 0);
}
function saveDetailColors(colors) {
  const product = productById(detailProductId);
  if (!product) return;
  const clean = colors
    .map(color => ({name: sanitizeColorName(color.name), grams: Math.max(0, Number(color.grams) || 0)}))
    .filter(color => color.name || color.grams > 0);
  const qty = Math.max(0, Number(product.qty) || 0);
  const unit = clean.reduce((sum, color) => sum + color.grams, 0);
  product.colors = clean;
  product.grams = Math.round(unit * qty * 100) / 100;
  writeProductItem(product.id, {colors: clean.length ? clean : null, grams: product.grams});
  renderProducts(); renderSales();
}
function renderProductDetail() {
  const modal = $('productDetailModal');
  if (!modal || modal.hidden) return;
  const product = productById(detailProductId);
  if (!product) { closeProductDetail(); return; }
  const x = params();
  const c = calc(product, x);
  const qty = Math.max(0, Number(product.qty) || 0);
  const readyStock = readyStockOf(product);
  const colors = detailColorList(product);
  const gramPrice = x.filamentPrice / 1000;
  const totalUnitGrams = unitGrams(product);
  $('productDetailTitle').textContent = product.name || 'İsimsiz ürün';
  $('productDetailSubtitle').textContent = `${fmt(qty,0)} adet · ${fmt(totalUnitGrams,1)} g/adet · toplam ${fmt(totalUnitGrams*qty,1)} g filament`;
  const colorOptions = [...new Set([
    ...Object.keys(filamentStock || {}),
    ...colors.map(color => color.name)
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
  const colorRowsHtml = colors.length ? colors.map((color, index) => {
    const stockKg = stockKgOf(color.name);
    const colorGramPrice = colorAveragePrice(color.name, x.filamentPrice) / 1000;
    return `<div class="color-edit-row">
      <span class="color-dot" style="background:${colorSwatch(color.name)}"></span>
      <input class="color-name-input" list="productColorOptions" data-color-index="${index}" data-color-field="name" value="${esc(color.name)}" placeholder="Renk adı" aria-label="Renk adı" maxlength="24">
      <div class="input-wrap mini-input"><input type="number" min="0" max="100000" step="0.1" data-color-index="${index}" data-color-field="grams" value="${Number(color.grams)}" aria-label="Adet başına gram"><b>g/adet</b></div>
      <div class="color-edit-meta">Toplam <strong>${fmt(color.grams*qty,1)} g</strong> · ${money(color.grams*qty*colorGramPrice)} · Stok: ${stockKg > 0 ? `${fmt(stockKg,2)} kg` : 'yok'}</div>
      <button class="delete-btn" type="button" data-color-delete="${index}" title="Rengi üründen kaldır" aria-label="Rengi üründen kaldır">×</button>
    </div>`;
  }).join('') : '<p class="empty-inline">Bu ürüne henüz renk tanımlanmadı. Aşağıdan renk adı ve gram ekleyebilirsin.</p>';
  const metaItems = [
    ['Parti adedi', fmt(qty,0)],
    ['Hazır mamul stok', `${fmt(readyStock,0)} adet`],
    ['Baskı süresi', `${fmt(Number(product.hours)||0,1)} sa`],
    ['Birim maliyet', money(c.unit)],
    ['Satış fiyatı', money(product.sale)],
    ['Birim kâr', money(c.profit)],
    ['Toplam maliyet', money(c.total)]
  ];
  const productLogs = productionLogs.filter(log => sameProductId(log.productId, product.id)).slice(0, 6);
  const productionLogHtml = productLogs.length ? `
    <h3 class="detail-section-title">Son üretim kayıtları</h3>
    <div class="production-log-list">${productLogs.map(log => {
      const colorText = (Array.isArray(log.colors) ? log.colors : Object.values(log.colors || {}))
        .map(color => `${esc(color.name || 'Renk')} ${fmt(Number(color.grams)||0,1)} g`).join(' · ');
      return `<div class="production-log-row">
        <span class="production-log-date">${esc(String(log.date || ''))}</span>
        <span class="production-log-qty">+${fmt(Number(log.qty)||0,0)} adet</span>
        <span class="production-log-colors">${colorText || 'Renk kaydı yok'}</span>
        <span class="production-log-total">${fmt(Number(log.totalGrams)||0,1)} g</span>
        <button class="btn btn-ghost production-undo-btn" type="button" data-production-undo="${esc(log.id)}" title="Üretimi iptal et, filamenti stoğa iade et">↶ Geri al</button>
      </div>`;
    }).join('')}</div>` : '<p class="empty-inline">Henüz üretim kaydı yok. Üret düğmesiyle ilk üretimini ekle.</p>';
  $('productDetailInfo').innerHTML = `
    <div class="detail-actions">
      <button class="btn btn-primary" type="button" data-production-open><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Üret</button>
      <span class="detail-actions-note">Mamul stoğa <strong>${fmt(readyStock,0)} adet</strong> hazır · Üretim hammadde stoğundan düşer.</span>
    </div>
    <div class="detail-grid product-detail-meta">${metaItems.map(([label,value])=>`<div class="detail-item"><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>`).join('')}</div>
    <h3 class="detail-section-title">Kullanılan renkler ve filament</h3>
    <div class="color-edit-list">${colorRowsHtml}</div>
    <div class="color-add-row">
      <input id="detailNewColor" list="productColorOptions" placeholder="Renk adı" maxlength="24" autocomplete="off" aria-label="Yeni renk adı">
      <div class="input-wrap mini-input"><input id="detailNewGrams" type="number" min="0" max="100000" step="0.1" placeholder="Gram" aria-label="Yeni rengin adet başına gramı"><b>g/adet</b></div>
      <button class="btn btn-primary" type="button" data-detail-add-color>＋ Renk ekle</button>
    </div>
    <datalist id="productColorOptions">${colorOptions.map(name=>`<option value="${esc(name)}"></option>`).join('')}</datalist>
    <div class="detail-total"><span>Toplam filament<strong>${fmt(totalUnitGrams*qty,1)} g</strong></span><span>Filament maliyeti<strong>${money(c.filament*qty)}</strong></span><span>Renk çeşidi<strong>${fmt(colors.length,0)}</strong></span></div>
    ${productionLogHtml}`;
  const photoEl = $('productDetailPhoto');
  photoEl.innerHTML = product.photo
    ? `<button class="detail-photo-btn" type="button" data-detail-photo-open aria-label="Fotoğrafı büyüt" title="Büyütmek için tıkla"><img src="${product.photo}" alt="${esc(product.name||'Ürün')} fotoğrafı"><span class="detail-photo-hint">Büyüt ⤢</span></button>`
    : '<div class="detail-photo-empty">Fotoğraf yok</div>';
  if (product.photo) photoEl.innerHTML += '<button class="photo-upload detail-photo-upload" type="button" data-detail-photo-transparent title="Düz renkli arka planı siler">Arka planı şeffaflaştır</button>';
  photoEl.innerHTML += '<label class="photo-upload detail-photo-upload">Cihazdan Yükle<input type="file" accept="image/*" data-detail-photo-upload aria-label="Cihazdan ürün fotoğrafı yükle"></label>';
}
function removeDetailColor(index) {
  const product = productById(detailProductId);
  if (!product) return;
  const colors = detailColorList(product);
  colors.splice(index, 1);
  saveDetailColors(colors);
}
function addDetailColor() {
  const product = productById(detailProductId);
  if (!product) return;
  const nameInput = $('detailNewColor');
  const gramsInput = $('detailNewGrams');
  const name = sanitizeColorName(nameInput?.value);
  if (gramsInput && !validateNumericElement(gramsInput)) return;
  const grams = gramsInput ? parseStrictNumber(gramsInput.value,{min:0}).value : 0;
  if (!name && !grams) { toast('Renk adı veya gram gir.'); return; }
  const colors = detailColorList(product);
  colors.push({name, grams});
  if (nameInput) nameInput.value = '';
  if (gramsInput) gramsInput.value = '';
  saveDetailColors(colors);
  toast('Renk ürüne eklendi.');
}
function updateDetailColor(index, field, value) {
  const product = productById(detailProductId);
  if (!product) return;
  const colors = detailColorList(product);
  if (!colors[index]) return;
  if (field === 'name') colors[index].name = sanitizeColorName(value);
  else { const parsed=parseStrictNumber(value,{min:0}); if(!parsed.ok){toast('Gram değeri boş veya geçersiz olamaz.','warning');renderProductDetail(product);return;} colors[index].grams=parsed.value; }
  saveDetailColors(colors);
}
if ($('productDetailModal')) {
  $('closeProductDetail').addEventListener('click', closeProductDetail);
  $('productDetailModal').addEventListener('click', event => {
    if (event.target === $('productDetailModal')) { closeProductDetail(); return; }
    const photoButton = event.target.closest('[data-detail-photo-open]');
    if (photoButton) {
      const product = productById(detailProductId);
      if (product?.photo) openLightbox(product.id, photoButton);
      return;
    }
    if (event.target.closest('[data-detail-photo-transparent]')) { makeProductPhotoTransparent(detailProductId); return; }
    if (event.target.closest('[data-production-open]')) { openProductionModal(detailProductId); return; }
    const undoBtn = event.target.closest('[data-production-undo]');
    if (undoBtn) { undoBtn.disabled = true; undoProduction(undoBtn.dataset.productionUndo).finally(() => { undoBtn.disabled = false; }); return; }
    const addButton = event.target.closest('[data-detail-add-color]');
    if (addButton) { addDetailColor(); return; }
    const deleteButton = event.target.closest('[data-color-delete]');
    if (deleteButton) { removeDetailColor(Number(deleteButton.dataset.colorDelete)); return; }
  });
  $('productDetailModal').addEventListener('change', event => {
    const fileInput = event.target.closest('input[data-detail-photo-upload]');
    if (fileInput) {
      const file = fileInput.files && fileInput.files[0];
      if (file) processPhotoFile(file, detailProductId);
      return;
    }
    const colorInput = event.target.closest('[data-color-index]');
    if (!colorInput) return;
    if(colorInput.type==='number' && !validateNumericElement(colorInput)) { renderProductDetail(productById(detailProductId)); return; }
    updateDetailColor(Number(colorInput.dataset.colorIndex), colorInput.dataset.colorField, colorInput.value);
  });
}

/* =========================================================
 * ÜRETİM MODALI — adet + renk başına toplam gram tüketimi
 * Üretim yalnızca burada hammadde stoğundan düşer ve ürünün
 * mamul stoğunu (readyStock) artırır.
 * ========================================================= */
const PROD = { productId:null, productName:'', qty:1, rows:[] };

function openProductionModal(productId) {
  const product = productById(productId);
  const modal = $('productionModal');
  if (!product) { toast('Ürün bulunamadı. Liste yenileniyor, lütfen tekrar dene.', 'error'); return; }
  if (!modal) return;
  // Yerel id artık her zaman gerçek bulut anahtarıdır; yine de boşsa güvenli tarafta kal.
  if (product.id === undefined || product.id === null || String(product.id) === '') {
    toast('Ürün kimliği okunamadı. Sayfayı yenileyip tekrar dene.', 'error'); return;
  }
  PROD.productId = String(product.id);
  PROD.productName = String(product.name || '');
  PROD.qty = 1;
  const colors = detailColorList(product).filter(color => color.name);
  PROD.rows = colors.length
    ? colors.map(color => ({name: color.name, base: color.grams, grams: color.grams, edited: false}))
    : [{name: '', base: 0, grams: 0, edited: true}];
  modal.hidden = false;
  renderProductionModal();
  setTimeout(() => $('productionQty')?.focus(), 60);
}
function closeProductionModal() {
  const modal = $('productionModal');
  if (modal) modal.hidden = true;
  PROD.productId = null;
  PROD.productName = '';
}
function productionRowMeta(row) {
  if (!row.name) return '<span class="muted">Renk seçilmedi</span>';
  const stockGrams = stockKgOf(row.name) * 1000;
  const remaining = stockGrams - Math.max(0, Number(row.grams) || 0);
  return `Stok: ${fmt(stockGrams / 1000, 2)} kg · <strong class="${remaining < -1e-6 ? 'is-bad' : 'is-good'}">${remaining < -1e-6 ? `${fmt(-remaining, 1)} g eksik` : `kalan ${fmt(remaining, 1)} g`}</strong>`;
}
function updateProductionSubtitle() {
  const product = productById(PROD.productId);
  const el = $('productionSubtitle');
  if (!product || !el) return;
  const ready = readyStockOf(product);
  el.textContent = `Hazır mamul stok: ${fmt(ready, 0)} adet · Üretim sonrası: ${fmt(ready + PROD.qty, 0)} adet`;
}
function updateProductionTotals() {
  const box = $('productionTotals');
  if (!box) return;
  const x = params();
  const totalGrams = PROD.rows.reduce((sum, row) => sum + Math.max(0, Number(row.grams) || 0), 0);
  const cost = PROD.rows.reduce((sum, row) => {
    const grams = Math.max(0, Number(row.grams) || 0);
    return sum + (row.name ? (grams / 1000) * colorAveragePrice(row.name, x.filamentPrice) : 0);
  }, 0);
  box.innerHTML = `<span>Toplam tüketim<strong>${fmt(totalGrams, 1)} g</strong></span><span>Tahmini filament maliyeti<strong>${money(cost)}</strong></span><span>Üretilecek<strong>${fmt(PROD.qty, 0)} adet</strong></span>`;
  document.querySelectorAll('[data-prod-meta]').forEach(el => {
    const row = PROD.rows[Number(el.dataset.prodMeta)];
    if (row) el.innerHTML = productionRowMeta(row);
  });
  updateProductionSubtitle();
}
function renderProductionModal() {
  const modal = $('productionModal');
  if (!modal || modal.hidden) return;
  const product = productById(PROD.productId);
  // Liste anlık olarak boşalsa bile modalı kapatma; anahtar modal açılırken saklandı.
  const productName = product?.name || PROD.productName || 'İsimsiz ürün';
  $('productionTitle').textContent = `${productName} — üretim`;
  const qtyInput = $('productionQty');
  if (qtyInput && document.activeElement !== qtyInput) qtyInput.value = PROD.qty;
  const colorOptions = [...new Set([
    ...Object.keys(filamentStock || {}),
    ...PROD.rows.map(row => row.name)
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
  $('productionColorOptions').innerHTML = colorOptions.map(name => `<option value="${esc(name)}"></option>`).join('');
  $('productionColorRows').innerHTML = PROD.rows.map((row, index) => `<div class="color-edit-row production-color-row" data-prod-row="${index}">
    <span class="color-dot" style="background:${colorSwatch(row.name)}"></span>
    <input class="color-name-input" list="productionColorOptions" data-prod-field="name" value="${esc(row.name)}" placeholder="Renk adı" maxlength="24" aria-label="Renk adı">
    <div class="input-wrap mini-input"><input type="number" min="0" max="1000000" step="0.1" data-prod-field="grams" value="${Number(row.grams) || 0}" aria-label="Toplam tüketim gramı"><b>g</b></div>
    <div class="color-edit-meta production-row-meta" data-prod-meta="${index}">${productionRowMeta(row)}</div>
    <button class="delete-btn" type="button" data-prod-remove="${index}" title="Tüketim satırını kaldır" aria-label="Tüketim satırını kaldır">×</button>
  </div>`).join('');
  updateProductionTotals();
}
function saveProduction(event) {
  event.preventDefault();
  const product = productById(PROD.productId);
  // Yerel kayıt anlık olarak görünmese bile modal açılırken saklanan gerçek anahtarla
  // devam edilir; handleProduction anahtarı bulutta taze veriyle doğrular. Böylece
  // liste senkronizasyonu geciktiğinde üretim boşuna reddedilmez.
  const productName = String(product?.name || PROD.productName || 'İsimsiz ürün');
  if (!PROD.productId || String(PROD.productId) === 'undefined') {
    toast('Ürün bulunamadı. Üretim kaydedilmedi.', 'error'); return;
  }
  if (!validateFormInputs($('productionForm'))) return;
  const qtyParsed = parseStrictNumber($('productionQty').value, {min:1, max:100000, integer:true});
  if (!qtyParsed.ok) { toast(`Üretim adedi: ${qtyParsed.reason}.`, 'warning'); return; }
  const rows = [...$('productionColorRows').querySelectorAll('[data-prod-row]')].map(rowEl => ({
    name: sanitizeColorName(rowEl.querySelector('[data-prod-field="name"]')?.value),
    grams: Number(rowEl.querySelector('[data-prod-field="grams"]')?.value)
  }));
  const usage = [];
  for (const row of rows) {
    if (!row.name && !(row.grams > 0)) continue;
    if (!row.name) { toast('Her tüketim satırı için bir renk adı gir.', 'warning'); return; }
    if (!(row.grams > 0)) { toast(`"${row.name}" için toplam tüketim gramı 0'dan büyük olmalı.`, 'warning'); return; }
    usage.push(row);
  }
  if (!usage.length) { toast('Üretim için en az bir renk ve tüketilecek gram gir.', 'warning'); return; }
  const submitBtn = $('productionSubmit');
  if (submitBtn) submitBtn.disabled = true;
  handleProduction(PROD.productId, qtyParsed.value, usage, productName)
    .then(() => {
      const produced = qtyParsed.value;
      closeProductionModal();
      toast(`"${productName}" için ${fmt(produced, 0)} adet üretim kaydedildi. Hammadde stoğu düşüldü, mamul stoğa eklendi.`, 'success');
    })
    .catch(() => {})   // handleProduction kullanıcıya ayrıntılı toast gösterir
    .finally(() => { if (submitBtn) submitBtn.disabled = false; });
}
if ($('productionModal')) {
  $('closeProduction').addEventListener('click', closeProductionModal);
  $('productionCancel').addEventListener('click', closeProductionModal);
  $('productionModal').addEventListener('click', event => {
    if (event.target === $('productionModal')) { closeProductionModal(); return; }
    if (event.target.closest('#productionAddColor')) {
      const name = sanitizeColorName($('productionNewColor').value);
      const gramsParsed = parseStrictNumber($('productionNewGrams').value, {min:0.001, max:1000000});
      if (!name) { toast('Eklemek için bir renk adı gir.', 'warning'); return; }
      if (!gramsParsed.ok) { toast(`Tüketim gramı: ${gramsParsed.reason}.`, 'warning'); return; }
      PROD.rows.push({name, base: 0, grams: gramsParsed.value, edited: true});
      $('productionNewColor').value = '';
      $('productionNewGrams').value = 0;
      renderProductionModal();
      return;
    }
    const removeButton = event.target.closest('[data-prod-remove]');
    if (removeButton) {
      PROD.rows.splice(Number(removeButton.dataset.prodRemove), 1);
      if (!PROD.rows.length) PROD.rows.push({name: '', base: 0, grams: 0, edited: true});
      renderProductionModal();
    }
  });
  $('productionQty').addEventListener('input', () => {
    const parsed = parseStrictNumber($('productionQty').value, {min:1, max:100000, integer:true});
    if (!parsed.ok) { validateNumericElement($('productionQty'), {silent:true}); return; }
    if (parsed.value === PROD.qty) return;
    PROD.rows.forEach(row => {
      if (!row.edited) row.grams = Math.round(row.base * parsed.value * 100) / 100;
    });
    PROD.qty = parsed.value;
    renderProductionModal();
  });
  $('productionColorRows').addEventListener('input', event => {
    const field = event.target.closest('[data-prod-field]');
    const rowEl = event.target.closest('[data-prod-row]');
    if (!field || !rowEl) return;
    const row = PROD.rows[Number(rowEl.dataset.prodRow)];
    if (!row) return;
    if (field.dataset.prodField === 'grams') {
      row.grams = Math.max(0, Number(field.value) || 0);
      row.edited = true;
      updateProductionTotals();
    }
  });
  $('productionColorRows').addEventListener('change', event => {
    const field = event.target.closest('[data-prod-field="name"]');
    if (!field) return;
    const rowEl = field.closest('[data-prod-row]');
    const row = rowEl ? PROD.rows[Number(rowEl.dataset.prodRow)] : null;
    if (!row) return;
    row.name = sanitizeColorName(field.value);
    renderProductionModal();
  });
  $('productionForm').addEventListener('submit', saveProduction);
}

/* ---------- Renk stoğu tablosu olayları ---------- */
if ($('colorStockRows')) {
  $('colorStockRows').addEventListener('change', event => {
    const input = event.target.closest('input[data-color-stock]');
    if (!input) return;
    const color = input.dataset.colorStock;
    if(!validateNumericElement(input)){input.value=stockKgOf(color);return;}
    const parsed = parseStrictNumber(input.value,{min:0,max:100000});
    if (!parsed.ok) { toast(`${color}: ${parsed.reason}.`, 'error'); input.value = stockKgOf(color); return; }
    const kg = parsed.value;
    const existing = normalizeStockEntry(filamentStock[color]);
    filamentStock[color] = {
      kg, totalWeightGrams: Math.round(kg * 1000),
      weightedAveragePricePerKg: existing.weightedAveragePricePerKg ?? params().filamentPrice,
      updatedAt: Date.now()
    };
    renderProducts(); renderSales(); renderInventory();
    writeColorStock(color, kg)
      .then(()=>toast(`${color} stoğu ${fmt(kg,2)} kg olarak güncellendi.`))
      .catch(()=>{});
  });
  $('colorStockRows').addEventListener('click', event => {
    const button = event.target.closest('[data-color-remove]');
    if (!button) return;
    const color = button.dataset.colorRemove;
    if (!cloudReady) { toast('Bulut bağlantısı kurulmadan stok silinemez.'); return; }
    confirmDialog({ title:'Rengi stoktan kaldır', message:`"${color}" rengi stoktan kaldırılacak.`, confirmText:'Kaldır', danger:true }).then(ok=>{
      if(!ok) return;
      delete filamentStock[color];
      deleteColorStock(color);
      renderProducts(); renderSales(); renderInventory();
      toast('Renk stoktan kaldırıldı.');
    });
  });
}

/* ---------- Fotoğraf büyütme (lightbox) ---------- */
const lb = { items:[], index:0, zoom:1, panX:0, panY:0, dragging:false, trigger:null, timer:null };
const LB_MIN_ZOOM = 1, LB_MAX_ZOOM = 4;

function lightboxItems() {
  return state.products
    .map((p, index) => ({ id:p.id, index, name: p.name || `Ürün ${index+1}`, photo: p.photo }))
    .filter(item => Boolean(item.photo));
}
function openLightbox(productId, trigger) {
  const items = lightboxItems();
  const start = items.findIndex(item => String(item.id) === String(productId));
  if (start < 0) return;
  lb.items = items; lb.index = start; lb.trigger = trigger || document.activeElement;
  const box = $('photoLightbox');
  clearTimeout(lb.timer);
  $('lightboxThumbs').innerHTML = items.map((item, i) => `<button type="button" class="lightbox-thumb${i===start?' active':''}" data-thumb="${i}" aria-label="${esc(item.name)} fotoğrafını göster"><img src="${item.photo}" alt=""></button>`).join('');
  box.hidden = false;
  document.body.classList.add('lightbox-open');
  renderLightbox();
  // hidden kaldırıldıktan sonra çift RAF ile geçiş animasyonu başlatılır.
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('open')));
  setTimeout(() => $('lightboxClose').focus({preventScroll:true}), 80);
}
function closeLightbox() {
  const box = $('photoLightbox');
  if (box.hidden) return;
  box.classList.remove('open');
  document.body.classList.remove('lightbox-open');
  clearTimeout(lb.timer);
  lb.timer = setTimeout(() => { box.hidden = true; }, 300);
  if (lb.trigger && lb.trigger.isConnected) lb.trigger.focus({preventScroll:true});
  lb.trigger = null;
}
function renderLightbox() {
  const item = lb.items[lb.index];
  if (!item) return;
  const img = $('lightboxImage');
  img.src = item.photo;
  img.alt = `${item.name} fotoğrafı`;
  $('lightboxTitle').textContent = item.name;
  $('lightboxCount').textContent = `${lb.index+1} / ${lb.items.length}`;
  const single = lb.items.length < 2;
  $('lightboxPrev').hidden = single;
  $('lightboxNext').hidden = single;
  $('lightboxCount').hidden = single;
  $('lightboxThumbs').classList.toggle('single', single);
  [...$('lightboxThumbs').children].forEach((el, i) => el.classList.toggle('active', i === lb.index));
  img.classList.remove('lb-pop'); void img.offsetWidth; img.classList.add('lb-pop');
  resetLightboxZoom();
}
function stepLightbox(delta) {
  if (lb.items.length < 2) return;
  lb.index = (lb.index + delta + lb.items.length) % lb.items.length;
  renderLightbox();
}
function applyLightboxTransform() {
  const img = $('lightboxImage'), canvas = $('lightboxCanvas');
  img.style.transform = `translate(${lb.panX}px, ${lb.panY}px) scale(${lb.zoom})`;
  $('lightboxZoomReset').textContent = `${Math.round(lb.zoom*100)}%`;
  canvas.classList.toggle('is-zoomed', lb.zoom > 1);
  $('lightboxHint').classList.toggle('is-hidden', lb.zoom > 1);
  $('lightboxZoomIn').disabled = lb.zoom >= LB_MAX_ZOOM;
  $('lightboxZoomOut').disabled = lb.zoom <= LB_MIN_ZOOM;
}
function clampLightboxPan() {
  if (lb.zoom <= 1) { lb.panX = 0; lb.panY = 0; return; }
  const canvas = $('lightboxCanvas'), img = $('lightboxImage');
  const rect = canvas.getBoundingClientRect();
  const maxX = Math.max(0, (img.offsetWidth * lb.zoom - rect.width) / 2);
  const maxY = Math.max(0, (img.offsetHeight * lb.zoom - rect.height) / 2);
  lb.panX = Math.min(maxX, Math.max(-maxX, lb.panX));
  lb.panY = Math.min(maxY, Math.max(-maxY, lb.panY));
}
function setLightboxZoom(next, clientX, clientY) {
  const old = lb.zoom;
  next = Math.min(LB_MAX_ZOOM, Math.max(LB_MIN_ZOOM, next));
  if (Math.abs(next - old) < 0.001) return;
  const ratio = next / old;
  if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
    const rect = $('lightboxCanvas').getBoundingClientRect();
    const px = clientX - (rect.left + rect.width / 2);
    const py = clientY - (rect.top + rect.height / 2);
    lb.panX = px - (px - lb.panX) * ratio;
    lb.panY = py - (py - lb.panY) * ratio;
  } else {
    lb.panX *= ratio; lb.panY *= ratio;
  }
  lb.zoom = next;
  if (next === 1) { lb.panX = 0; lb.panY = 0; }
  clampLightboxPan();
  applyLightboxTransform();
}
function resetLightboxZoom() {
  lb.zoom = 1; lb.panX = 0; lb.panY = 0;
  applyLightboxTransform();
}

$('lightboxClose').addEventListener('click', closeLightbox);
$('lightboxPrev').addEventListener('click', () => stepLightbox(-1));
$('lightboxNext').addEventListener('click', () => stepLightbox(1));
$('lightboxZoomIn').addEventListener('click', () => setLightboxZoom(lb.zoom + 0.5));
$('lightboxZoomOut').addEventListener('click', () => setLightboxZoom(lb.zoom - 0.5));
$('lightboxZoomReset').addEventListener('click', resetLightboxZoom);
$('photoLightbox').addEventListener('click', event => {
  if (event.target.closest('[data-lightbox-close]')) closeLightbox();
});
$('lightboxThumbs').addEventListener('click', event => {
  const thumb = event.target.closest('[data-thumb]');
  if (!thumb) return;
  lb.index = Number(thumb.dataset.thumb) || 0;
  renderLightbox();
});

const lbCanvas = $('lightboxCanvas');
let lbPointer = null;
lbCanvas.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  lbPointer = { x:event.clientX, y:event.clientY, panX:lb.panX, panY:lb.panY, moved:false };
  if (lb.zoom > 1) {
    lb.dragging = true;
    lbCanvas.classList.add('dragging');
    try { lbCanvas.setPointerCapture(event.pointerId); } catch (e) {}
  }
});
lbCanvas.addEventListener('pointermove', event => {
  if (!lbPointer) return;
  const dx = event.clientX - lbPointer.x, dy = event.clientY - lbPointer.y;
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) lbPointer.moved = true;
  if (lb.zoom > 1) {
    lb.panX = lbPointer.panX + dx; lb.panY = lbPointer.panY + dy;
    clampLightboxPan(); applyLightboxTransform();
  }
});
function endLightboxPointer(event) {
  const start = lbPointer;
  lbPointer = null; lb.dragging = false;
  lbCanvas.classList.remove('dragging');
  try { lbCanvas.releasePointerCapture(event.pointerId); } catch (e) {}
  if (!start || event.type === 'pointercancel') return;
  const dx = event.clientX - start.x, dy = event.clientY - start.y;
  // Zoom yokken yatay sürükleme fotoğraf değiştirir.
  if (lb.zoom <= 1 && Math.abs(dx) > 60 && Math.abs(dy) < 80) { stepLightbox(dx < 0 ? 1 : -1); return; }
  if (start.moved) return;
  if (lb.zoom > 1) resetLightboxZoom();
  else if (Number.isFinite(event.clientX)) setLightboxZoom(2.2, event.clientX, event.clientY);
}
lbCanvas.addEventListener('pointerup', endLightboxPointer);
lbCanvas.addEventListener('pointercancel', endLightboxPointer);
lbCanvas.addEventListener('wheel', event => {
  if ($('photoLightbox').hidden) return;
  event.preventDefault();
  setLightboxZoom(lb.zoom + (event.deltaY < 0 ? 0.3 : -0.3), event.clientX, event.clientY);
}, { passive:false });
document.addEventListener('keydown', event => {
  const box = $('photoLightbox');
  if (!box || box.hidden) return;
  if (event.key === 'Escape') closeLightbox();
  else if (event.key === 'ArrowLeft') stepLightbox(-1);
  else if (event.key === 'ArrowRight') stepLightbox(1);
  else if (event.key === '+' || event.key === '=') setLightboxZoom(lb.zoom + 0.5);
  else if (event.key === '-' || event.key === '_') setLightboxZoom(lb.zoom - 0.5);
  else if (event.key === '0') resetLightboxZoom();
  else if (event.key === 'Tab') {
    // Odak, modal içindeki öğeler arasında döner.
    const focusables = [...box.querySelectorAll('button:not([hidden]):not(:disabled)')];
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    return;
  } else return;
  event.preventDefault();
});

/* =========================================================
   Tema · Kenar çubuğu · Firebase destekli giriş
   Tercihler (tema, kenar çubuğu, oturum) tarayıcıda küçük anahtarlar olarak
   tutulur; iş verileri hâlâ yalnızca Firebase'dedir.
   ========================================================= */
const THEMES = { dark:'#09090b', light:'#f4f5f7', midnight:'#050b1a', glass:'#0b1030', olive:'#0b0e08', carbon:'#070707', indigo:'#0d0f18', 'modern-dark':'#08090d', 'clean-light':'#f7f8fa', forest:'#07130f', 'midnight-blue':'#050b1a', 'admin-v2':'#0b1329', 'dashboard-v26':'#f8fafc' };
function prefGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function prefSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* gizli mod vb. */ } }
function prefDel(key) { try { localStorage.removeItem(key); } catch (e) { /* yoksay */ } }

/* ---------- Tema ---------- */
function applyTheme(name, animate, originEvent) {
  const theme = THEMES[name] ? name : 'dark';
  const root = document.documentElement;
  const update = () => {
    root.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEMES[theme]);
    document.querySelectorAll('[data-theme-choice]').forEach(btn =>
      btn.setAttribute('aria-checked', String(btn.dataset.themeChoice === theme)));
    prefSet('pc_theme', theme);
  };
  if (!animate) { update(); return; }
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (originEvent && Number.isFinite(originEvent.clientX)) root.style.setProperty('--theme-origin-x', `${originEvent.clientX}px`);
    if (originEvent && Number.isFinite(originEvent.clientY)) root.style.setProperty('--theme-origin-y', `${originEvent.clientY}px`);
    document.startViewTransition(update);
  } else if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const x = originEvent && Number.isFinite(originEvent.clientX) ? originEvent.clientX : innerWidth - 36;
    const y = originEvent && Number.isFinite(originEvent.clientY) ? originEvent.clientY : 36;
    root.style.setProperty('--theme-origin-x', `${x}px`);
    root.style.setProperty('--theme-origin-y', `${y}px`);
    root.classList.remove('theme-reveal'); update(); void root.offsetWidth;
    root.classList.add('theme-reveal');
    setTimeout(() => root.classList.remove('theme-reveal'), 760);
  } else update();
}
function setThemeMenu(open) {
  const menu = $('themeMenu'), btn = $('themeToggle');
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button')).focus();
}
function initThemeBar() {
  applyTheme(prefGet('pc_theme') || 'dark', false);
  $('themeToggle').addEventListener('click', () => setThemeMenu($('themeMenu').hidden));
  document.querySelectorAll('[data-theme-choice]').forEach(btn =>
    btn.addEventListener('click', event => { applyTheme(btn.dataset.themeChoice, true, event); setThemeMenu(false); $('themeToggle').focus(); }));
  document.addEventListener('click', event => {
    if ($('themeMenu').hidden) return;
    if (!event.target.closest('#themeMenu') && !event.target.closest('#themeToggle')) setThemeMenu(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('themeMenu').hidden) { setThemeMenu(false); $('themeToggle').focus(); }
  });
}

function syncSlidingPills() {
  document.querySelectorAll('.seg, .sale-mode').forEach(group => {
    const buttons = [...group.querySelectorAll('.seg-btn, .sale-mode-btn, [data-sale-mode], [data-chart-type], [data-chart-range]')];
    const active = buttons.find(button => button.classList.contains('active'));
    if (!active) return;
    const g = group.getBoundingClientRect(), b = active.getBoundingClientRect();
    group.style.setProperty('--pill-x', `${b.left - g.left + group.scrollLeft}px`);
    group.style.setProperty('--pill-w', `${b.width}px`);
    group.classList.add('has-sliding-pill');
  });
}
window.addEventListener('resize', syncSlidingPills, {passive:true});

/* ---------- Açılır-kapanır kenar çubuğu ---------- */
function setSidebar(collapsed, persist) {
  document.body.classList.add('sb-ready');
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const btn = $('sidebarToggle');
  if (btn) {
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', collapsed ? 'Kenar çubuğunu göster' : 'Kenar çubuğunu gizle');
  }
  if (persist) prefSet('pc_sidebar', collapsed ? 'collapsed' : 'open');
}
function initSidebarToggle() {
  setSidebar(prefGet('pc_sidebar') === 'collapsed', false);
  $('sidebarToggle').addEventListener('click', () =>
    setSidebar(!document.body.classList.contains('sidebar-collapsed'), true));
}

/* ---------- SHA-256 (crypto.subtle yoksa yedek) ---------- */
function sha256Fallback(str) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const bytes = Array.from(new TextEncoder().encode(str));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 255);
  let h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < bytes.length; o += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++) w[i] = (bytes[o+i*4] << 24) | (bytes[o+i*4+1] << 16) | (bytes[o+i*4+2] << 8) | bytes[o+i*4+3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3);
      const s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e,6) ^ rotr(e,11) ^ rotr(e,25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a,2) ^ rotr(a,13) ^ rotr(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h = [h[0]+a|0,h[1]+b|0,h[2]+c|0,h[3]+d|0,h[4]+e|0,h[5]+f|0,h[6]+g|0,h[7]+hh|0];
  }
  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
async function sha256Hex(text) {
  if (window.crypto && crypto.subtle) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* güvenli olmayan bağlam: yedeğe düş */ }
  }
  return sha256Fallback(text);
}

/* ---------- Firebase destekli giriş ----------
   Hesaplar printcost/auth/users/{e-posta} altında tutulur:
   { email, passHash (SHA-256, e-posta ile tuzlanmış), createdAt }.
   Şifrenin kendisi ne kodda ne veritabanında düz metin olarak bulunur.
   Veritabanında hesap kaydı yoksa, yalnızca kurulum hesabının doğru girilmesi
   hâlinde ilk girişte kayıt otomatik oluşturulur. */
const AUTH_SALT = 'printcost';
const BOOTSTRAP_EMAIL = 'uretken3d@gmail.com';
const BOOTSTRAP_HASH = 'abe54bb98ce7e7ba35e53b967ab0f7bbf9c122745e0de742ac55ef54de250e80';
const MAX_FAILS = 5, LOCK_MS = 30000;
let appStarted = false, failCount = 0, lockUntil = 0;

const emailKey = email => email.replace(/[.#$\[\]\/]/g, ',');
const passHashOf = (email, password) => sha256Hex(`${AUTH_SALT}::${email}::${password}`);

async function verifyCredentials(rawEmail, password) {
  const email = String(rawEmail).trim().toLowerCase();
  const hash = await passHashOf(email, password);
  const ref = rootRef.child('auth/users').child(emailKey(email));
  const snap = await ref.once('value');
  if (!snap.exists()) {
    if (email === BOOTSTRAP_EMAIL && hash === BOOTSTRAP_HASH) {
      await ref.set({ email, passHash: hash, createdAt: firebase.database.ServerValue.TIMESTAMP });
      return { ok: true, email, hash };
    }
    return { ok: false };
  }
  const record = snap.val() || {};
  return { ok: record.passHash === hash, email, hash };
}
function showLogin(message) {
  document.body.classList.add('auth-locked');
  $('loginOverlay').hidden = false;
  if (message) showLoginError(message);
  setTimeout(() => { const el = $('loginEmail'); if (el) el.focus(); }, 30);
}
function showLoginError(message) {
  const box = $('loginError');
  box.textContent = message;
  box.hidden = !message;
}
function authUnavailable(message) {
  showLogin(message);
  $('loginSubmit').disabled = true;
}
function enterApp(email) {
  $('loginOverlay').hidden = true;
  document.body.classList.remove('auth-locked');
  $('userEmail').textContent = email;
  $('userChip').hidden = false;
  $('logoutBtn').hidden = false;
  if (!appStarted) { appStarted = true; attachCloudListeners(); }
}
function signOut() {
  prefDel('pc_session');
  location.reload();   // dinleyiciler ve bellekteki veri tamamen temizlenir
}
async function initAuth() {
  const saved = (() => { try { return JSON.parse(prefGet('pc_session') || 'null'); } catch (e) { return null; } })();
  if (saved && saved.email && saved.hash) {
    try {
      const snap = await rootRef.child('auth/users').child(emailKey(saved.email)).once('value');
      if (snap.exists() && (snap.val() || {}).passHash === saved.hash) { enterApp(saved.email); return; }
      prefDel('pc_session');
    } catch (error) {
      console.error('oturum doğrulama', error);
      showLogin('Oturum doğrulanamadı. Bağlantını kontrol edip tekrar giriş yap.');
      return;
    }
  }
  showLogin('');
}

// Arka planda 5 dakikadan uzun kalan oturum, sekmeye dönüldüğünde kapatılır.
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){hiddenSince=Date.now();return;}
  if(hiddenSince && Date.now()-hiddenSince>=5*60*1000){hiddenSince=0;toast('Güvenlik nedeniyle 5 dakikalık arka plan zaman aşımı oluştu.','warning');signOut();}
  hiddenSince=0;
});
window.addEventListener('pagehide',()=>{if(!document.hidden)hiddenSince=Date.now();});

function initLoginForm() {
  $('passToggle').addEventListener('click', () => {
    const input = $('loginPassword');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    $('passToggle').setAttribute('aria-label', reveal ? 'Şifreyi gizle' : 'Şifreyi göster');
  });
  $('logoutBtn').addEventListener('click', signOut);
  $('loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!cloudReady) { showLoginError('Firebase bağlantısı hazır değil.'); return; }
    const now = Date.now();
    if (now < lockUntil) { showLoginError(`Çok fazla hatalı deneme. ${Math.ceil((lockUntil - now) / 1000)} sn sonra tekrar dene.`); return; }
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    if (!email || !password) { showLoginError('E-posta ve şifre alanlarını doldur.'); return; }
    const submit = $('loginSubmit');
    submit.disabled = true; submit.textContent = 'Doğrulanıyor…'; showLoginError('');
    try {
      const result = await verifyCredentials(email, password);
      if (result.ok) {
        failCount = 0;
        prefSet('pc_session', JSON.stringify({ email: result.email, hash: result.hash }));
        $('loginPassword').value = '';
        enterApp(result.email);
      } else {
        failCount += 1;
        if (failCount >= MAX_FAILS) { lockUntil = Date.now() + LOCK_MS; failCount = 0; }
        showLoginError('E-posta veya şifre hatalı.');
        $('loginPassword').select();
      }
    } catch (error) {
      console.error('giriş', error);
      showLoginError('Sunucuya ulaşılamadı veya okuma izni yok. Bağlantını ve Firebase kurallarını kontrol et.');
    } finally {
      submit.disabled = false; submit.textContent = 'Giriş yap';
    }
  });
}
function initUi() { initThemeBar(); initSidebarToggle(); initLoginForm(); initSalesChartUi(); initPackageUi(); initMaintenanceUi(); initDataManagementUi(); }

/* =========================================================
 * ARKA PLAN ŞEFFAFLAŞTIRMA (ürün fotoğrafları)
 * Kenarlardan başlayan renk benzerliği taramasıyla düz renkli stüdyo
 * arka planını siler; kenarlar yumuşatılır, PNG alfa kanalıyla saklanır.
 * Güvenlik: köşe renkleri tutarsızsa, görsel zaten şeffafsa veya silinen alan
 * mantıksız (çok az / çok fazla) ise fotoğrafa dokunulmaz.
 * Dönüş: 'done' | 'already' | 'skipped'
 * ========================================================= */
function removeBackground(canvas) {
  const w = canvas.width, h = canvas.height;
  if (w < 8 || h < 8) return 'skipped';
  const ctx = canvas.getContext('2d');
  let image;
  try { image = ctx.getImageData(0, 0, w, h); } catch (e) { return 'skipped'; }
  const d = image.data;
  const at = (x, y) => (y * w + x) * 4;
  // Zaten şeffaf mı? (kenar piksellerinin en az %8'i yarı saydamsa)
  let borderTotal = 0, borderClear = 0;
  const probe = (x, y) => { borderTotal++; if (d[at(x, y) + 3] < 200) borderClear++; };
  for (let x = 0; x < w; x++) { probe(x, 0); probe(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { probe(0, y); probe(w - 1, y); }
  if (borderClear / borderTotal >= 0.08) return 'already';
  // Köşe örneklerinden arka plan rengi
  const size = Math.max(2, Math.min(6, Math.floor(Math.min(w, h) / 20)));
  const corner = (x0, y0) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) {
      const i = at(x, y); r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    return [r / n, g / n, b / n];
  };
  const dist = (r, g, b, c) => Math.sqrt((r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2);
  const corners = [corner(0, 0), corner(w - size, 0), corner(0, h - size), corner(w - size, h - size)];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    if (dist(corners[i][0], corners[i][1], corners[i][2], corners[j]) > 60) return 'skipped'; // karmaşık arka plan
  }
  const bg = [0, 1, 2].map(k => corners.reduce((sum, c) => sum + c[k], 0) / 4);
  const TOL = 44, SOFT = 84;
  const distAt = i => dist(d[i], d[i + 1], d[i + 2], bg);
  const removed = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0, removedCount = 0;
  const seed = (x, y) => {
    const p = y * w + x;
    if (!removed[p] && distAt(p * 4) <= TOL) { removed[p] = 1; stack[sp++] = p; removedCount++; }
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (sp) {
    const p = stack[--sp], x = p % w, y = (p - x) / w;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }
  const fraction = removedCount / (w * h);
  if (fraction < 0.03 || fraction > 0.93) return 'skipped';
  // Silinen alanı şeffaf yap; komşu kenar piksellerini yumuşat.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, i = p * 4;
    if (removed[p]) { d[i + 3] = 0; continue; }
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && removed[ny * w + nx]) { near = true; break; }
    }
    if (near) {
      const dd = distAt(i);
      if (dd < SOFT) d[i + 3] = Math.round(255 * Math.min(1, Math.max(0.15, (dd - TOL) / (SOFT - TOL))));
    }
  }
  ctx.putImageData(image, 0, 0);
  return 'done';
}
// Kayıtlı bir fotoğrafın arka planını sonradan şeffaflaştırır (ürün detay penceresi).
function makeProductPhotoTransparent(id) {
  const product = productById(id);
  if (!product || !product.photo) return;
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan fotoğraf güncellenemez.'); return; }
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const result = removeBackground(canvas);
    if (result === 'already') { toast('Bu fotoğraf zaten şeffaf arka plana sahip.', 'info'); return; }
    if (result !== 'done') { toast('Düz bir arka plan algılanamadı; fotoğraf değiştirilmedi.', 'warning'); return; }
    try {
      const dataUrl = canvasToDataUrl(canvas, 0.82);
      if (dataUrl.length > 2_000_000) { toast('Fotoğraf Base64 olarak çok büyük; kaydedilmedi.', 'error'); return; }
      productsRef.child(id).update({ photo: dataUrl })
        .then(() => {
          product.photo = dataUrl;
          renderProducts();
          toast('Fotoğraf şeffaflaştırıldı ve Base64 olarak Realtime Database’e kaydedildi.', 'success');
        })
        .catch(error => cloudError(error, 'şeffaf fotoğrafı kaydetme'));
    } catch (error) {
      console.error('şeffaf fotoğraf dönüştürme', error);
      toast('Fotoğraf Base64 formatına dönüştürülemedi.', 'error');
    }
  };
  img.onerror = () => toast('Fotoğraf okunamadı.');
  img.src = product.photo;
}

/* =========================================================
 * SATIŞ GRAFİKLERİ — Çubuk / Çizgi · Günlük / Haftalık / Aylık
 * Tüm satış kayıtları (tekli + paket) kullanılır. Veri veya filtre değişince
 * değerler akıcı biçimde yeni duruma geçer; sayfaya her girişte sıfırdan büyür.
 * ========================================================= */
const SC = {
  type:'bar', range:'day', hidden:new Set(),
  buckets:[], from:null, to:null, cur:null, sig:'',
  raf:0, animating:false, layout:null
};
const SC_RANGES = {
  day:  {count:14, label:'Son 14 gün'},
  week: {count:12, label:'Son 12 hafta'},
  month:{count:12, label:'Son 12 ay'}
};
const clamp01 = v => Math.min(1, Math.max(0, v));
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const compactMoney = new Intl.NumberFormat('tr-TR', {notation:'compact', maximumFractionDigits:1});

function isoOf(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function weekStartOf(d) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}
function bucketKeyOf(d, range) {
  if (range === 'day') return isoOf(d);
  if (range === 'week') return isoOf(weekStartOf(d));
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function buildSalesBuckets(range) {
  const info = SC_RANGES[range];
  const today = new Date(); today.setHours(0,0,0,0);
  const list = [];
  for (let i = info.count - 1; i >= 0; i--) {
    let d, label, title;
    if (range === 'day') {
      d = new Date(today); d.setDate(d.getDate() - i);
      label = d.toLocaleDateString('tr-TR', {day:'2-digit', month:'2-digit'});
      title = d.toLocaleDateString('tr-TR', {day:'numeric', month:'long', year:'numeric', weekday:'long'});
    } else if (range === 'week') {
      d = weekStartOf(today); d.setDate(d.getDate() - i * 7);
      const end = new Date(d); end.setDate(end.getDate() + 6);
      label = d.toLocaleDateString('tr-TR', {day:'2-digit', month:'2-digit'});
      title = `${dateLabel(d)} – ${dateLabel(end)}`;
    } else {
      d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      label = d.toLocaleDateString('tr-TR', {month:'short'});
      title = d.toLocaleDateString('tr-TR', {month:'long', year:'numeric'});
    }
    list.push({key:bucketKeyOf(d, range), label, title, revenue:0, cost:0, profit:0, units:0, count:0});
  }
  const map = new Map(list.map(b => [b.key, b]));
  sales.forEach(s => {
    const date = localDate(s.date);
    if (!date) return;
    const bucket = map.get(bucketKeyOf(date, range));
    if (!bucket) return;
    bucket.revenue += Number(s.revenue) || 0;
    bucket.cost += Number(s.totalCost) || 0;
    bucket.profit += Number(s.profit) || 0;
    bucket.units += Number(s.unitsTotal ?? s.qty) || 0;
    bucket.count += 1;
  });
  return list;
}
function niceNum(range, round) {
  const exp = Math.floor(Math.log10(range)), f = range / Math.pow(10, exp);
  const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
  return nf * Math.pow(10, exp);
}
function niceDomain(min, max, count) {
  min = Math.min(0, min); max = Math.max(0, max);
  if (max - min <= 0) return {min:0, max:100, ticks:[0, 25, 50, 75, 100]};
  const step = niceNum((max - min) / count, true);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return {min:lo, max:hi, ticks};
}
// Fritsch–Carlson tekdüze kübik eğri: değerlerin dışına taşmayan yumuşak çizgi.
function monotonePath(p) {
  const n = p.length;
  if (!n) return '';
  if (n === 1) return `M${p[0][0]},${p[0][1]}`;
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = p[i+1][0] - p[i][0]; m[i] = (p[i+1][1] - p[i][1]) / dx[i]; }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t[i] = m[i-1] * m[i] <= 0 ? 0 : (m[i-1] + m[i]) / 2;
  t[n-1] = m[n-2];
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i+1] = 0; continue; }
    const a = t[i] / m[i], b = t[i+1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i+1] = k * b * m[i]; }
  }
  let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(p[i][0]+h).toFixed(1)},${(p[i][1]+t[i]*h).toFixed(1)} ${(p[i+1][0]-h).toFixed(1)},${(p[i+1][1]-t[i+1]*h).toFixed(1)} ${p[i+1][0].toFixed(1)},${p[i+1][1].toFixed(1)}`;
  }
  return d;
}
function computeSalesTarget() {
  SC.buckets = buildSalesBuckets(SC.range);
  const rev = SC.buckets.map(b => b.revenue), prof = SC.buckets.map(b => b.profit);
  const visible = [0];
  if (!SC.hidden.has('revenue')) visible.push(...rev);
  if (!SC.hidden.has('profit')) visible.push(...prof);
  const dom = niceDomain(Math.min(...visible), Math.max(...visible), 4);
  SC.to = {rev, prof, dom:[dom.min, dom.max], ticks:dom.ticks};
}
function drawSalesChart(t) {
  const stage = $('salesChartStage'), svg = $('salesChartSvg');
  if (!stage || !svg || !SC.to || !SC.from) return;
  const W = stage.clientWidth, H = stage.clientHeight;
  if (W < 60 || H < 60) return;                      // sayfa gizliyken çizme
  const n = SC.to.rev.length, STAGGER = 0.55;
  const prog = i => easeOutCubic(clamp01(t * (1 + STAGGER) - (n > 1 ? i / (n - 1) : 0) * STAGGER));
  const e = easeOutCubic(t);
  const dom = [0, 1].map(k => SC.from.dom[k] + (SC.to.dom[k] - SC.from.dom[k]) * e);
  const blend = (a, b) => b.map((v, i) => a[i] + (v - a[i]) * prog(i));
  const rev = blend(SC.from.rev, SC.to.rev), prof = blend(SC.from.prof, SC.to.prof);
  SC.cur = {rev, prof, dom};
  const m = {l:58, r:14, t:14, b:32};
  const pw = W - m.l - m.r, ph = H - m.t - m.b, band = pw / n;
  const y = v => m.t + ph - ((v - dom[0]) / ((dom[1] - dom[0]) || 1)) * ph;
  const y0 = y(0);
  SC.layout = {W, H, m, pw, ph, n, band};
  const series = [
    {key:'revenue', vals:rev, color:'var(--sky)'},
    {key:'profit',  vals:prof, color:'var(--emerald)'}
  ].filter(s => !SC.hidden.has(s.key));

  let out = '<defs>' + series.map(s => `<linearGradient id="scg-${s.key}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${s.color};stop-opacity:.32"/><stop offset="1" style="stop-color:${s.color};stop-opacity:0"/></linearGradient>`).join('') + '</defs>';
  // Izgara + y ekseni
  SC.to.ticks.forEach(tick => {
    const ty = y(tick);
    if (ty < m.t - 1 || ty > m.t + ph + 1) return;
    out += `<line x1="${m.l}" x2="${W - m.r}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" class="sc-grid${tick === 0 ? ' sc-zero' : ''}"/>`;
    out += `<text x="${m.l - 8}" y="${(ty + 3.5).toFixed(1)}" text-anchor="end" class="sc-axis">${esc(compactMoney.format(tick))}</text>`;
  });
  // x ekseni etiketleri (en sağdaki her zaman görünür)
  const step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 46))));
  SC.buckets.forEach((b, i) => {
    if ((n - 1 - i) % step) return;
    out += `<text x="${(m.l + band * (i + .5)).toFixed(1)}" y="${H - 10}" text-anchor="middle" class="sc-axis">${esc(b.label)}</text>`;
  });
  if (SC.type === 'bar') {
    const count = series.length || 1, gap = 3;
    const groupW = Math.min(band * .74, count * 34), bw = (groupW - (count - 1) * gap) / count;
    series.forEach((s, si) => s.vals.forEach((v, i) => {
      const cx = m.l + band * (i + .5), bx = cx - groupW / 2 + si * (bw + gap);
      const yy = y(v), top = Math.min(yy, y0), hh = Math.abs(yy - y0);
      if (hh < .5) return;
      const fill = s.key === 'profit' && v < 0 ? 'var(--rose)' : s.color;
      out += `<rect x="${bx.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="${Math.min(4, bw / 2).toFixed(1)}" style="fill:${fill}" opacity=".92"/>`;
    }));
  } else {
    series.forEach(s => {
      const pts = s.vals.map((v, i) => [m.l + band * (i + .5), y(v)]);
      const d = monotonePath(pts);
      if (pts.length > 1) out += `<path d="${d} L${pts[n-1][0].toFixed(1)},${y0.toFixed(1)} L${pts[0][0].toFixed(1)},${y0.toFixed(1)} Z" style="fill:url(#scg-${s.key})" stroke="none"/>`;
      out += `<path d="${d}" fill="none" style="stroke:${s.color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
      pts.forEach(p => { out += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.6" style="fill:${s.color};stroke:var(--bg-soft)" stroke-width="1.6"/>`; });
    });
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = out;
}
function retargetSalesChart(mode, animate) {
  const n = SC.to.rev.length, zeros = () => new Array(n).fill(0);
  cancelAnimationFrame(SC.raf);
  SC.animating = false;
  if (mode === 'tween' && SC.cur && SC.cur.rev.length === n) {
    SC.from = {rev:[...SC.cur.rev], prof:[...SC.cur.prof], dom:[...SC.cur.dom]};
  } else {
    SC.from = {rev:zeros(), prof:zeros(), dom:[...SC.to.dom]};   // sıfırdan büyür
  }
  if (!animate || prefersReducedMotion()) { drawSalesChart(1); return; }
  const started = performance.now(), duration = mode === 'zero' ? 900 : 650;
  SC.animating = true;
  drawSalesChart(0);
  const step = now => {
    const t = Math.min(1, (now - started) / duration);
    drawSalesChart(t);
    if (t < 1) SC.raf = requestAnimationFrame(step); else SC.animating = false;
  };
  SC.raf = requestAnimationFrame(step);
}
function salesChartSignature() {
  const r = v => Math.round(v * 100);
  return JSON.stringify([SC.range, SC.type, [...SC.hidden].sort(), SC.to.rev.map(r), SC.to.prof.map(r)]);
}
function syncSalesChartControls() {
  document.querySelectorAll('[data-chart-type]').forEach(b => {
    const on = b.dataset.chartType === SC.type;
    b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('[data-chart-range]').forEach(b => {
    const on = b.dataset.chartRange === SC.range;
    b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('[data-series]').forEach(b => {
    const on = !SC.hidden.has(b.dataset.series);
    b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
  });
  syncSlidingPills();
}
// forceMode: 'zero' (sıfırdan büyür) | 'tween' (mevcut değerlerden akıcı geçiş) | undefined (veri değişince)
function renderSalesChart(forceMode) {
  if (!$('salesChartCard')) return;
  computeSalesTarget();
  const totalRev = SC.to.rev.reduce((a, b) => a + b, 0), totalProf = SC.to.prof.reduce((a, b) => a + b, 0);
  $('salesChartCaption').textContent = `${SC_RANGES[SC.range].label} · Ciro ${money(totalRev)} · Net kâr ${money(totalProf)}`;
  $('salesChartSvg').setAttribute('aria-label', `Satış grafiği: ${SC_RANGES[SC.range].label}, toplam ciro ${money(totalRev)}, net kâr ${money(totalProf)}`);
  const has = sales.length > 0;
  $('salesChartEmpty').style.display = has ? 'none' : 'block';
  $('salesChartStage').style.display = has ? '' : 'none';
  syncSalesChartControls();
  const sig = salesChartSignature();
  if (!forceMode && sig === SC.sig) return;          // aynı veri: yeniden animasyon yok
  const first = !SC.sig;
  SC.sig = sig;
  if (!has) return;
  retargetSalesChart(forceMode || (first ? 'zero' : 'tween'), isPageActive('sales'));
}
// Satış sayfasına her girişte grafik sıfırdan dolar.
function playSalesChart(animate) {
  if (!$('salesChartCard')) return;
  computeSalesTarget();
  SC.sig = salesChartSignature();
  if (!sales.length) return;
  retargetSalesChart('zero', animate);
}
function initSalesChartUi() {
  const card = $('salesChartCard'), stage = $('salesChartStage');
  if (!card || !stage) return;
  card.addEventListener('click', event => {
    const typeBtn = event.target.closest('[data-chart-type]');
    if (typeBtn) { SC.type = typeBtn.dataset.chartType; renderSalesChart('zero'); return; }
    const rangeBtn = event.target.closest('[data-chart-range]');
    if (rangeBtn) { SC.range = rangeBtn.dataset.chartRange; renderSalesChart('zero'); return; }
    const seriesBtn = event.target.closest('[data-series]');
    if (seriesBtn) {
      const key = seriesBtn.dataset.series;
      if (SC.hidden.has(key)) SC.hidden.delete(key);
      else if (SC.hidden.size < 1) SC.hidden.add(key);   // en az bir seri görünür kalır
      renderSalesChart('tween');
    }
  });
  const tip = $('salesChartTip'), band = $('salesChartBand');
  const hide = () => { tip.hidden = true; band.style.opacity = '0'; };
  const show = event => {
    const L = SC.layout;
    if (!L || !SC.buckets.length) return;
    const rect = stage.getBoundingClientRect();
    const i = Math.floor((event.clientX - rect.left - L.m.l) / L.band);
    if (i < 0 || i >= L.n) { hide(); return; }
    const b = SC.buckets[i];
    band.style.left = `${L.m.l + L.band * i}px`; band.style.width = `${L.band}px`; band.style.opacity = '1';
    tip.innerHTML = `<strong>${esc(b.title)}</strong>
      <div><i style="background:var(--sky)"></i>Ciro<b>${money(b.revenue)}</b></div>
      <div><i style="background:var(--rose)"></i>Maliyet<b>${money(b.cost)}</b></div>
      <div><i style="background:var(--emerald)"></i>Net kâr<b class="${b.profit >= 0 ? 'profit-positive' : 'profit-negative'}">${money(b.profit)}</b></div>
      <small>${fmt(b.count, 0)} kayıt · ${fmt(b.units, 0)} adet</small>`;
    tip.hidden = false;
    const half = tip.offsetWidth / 2;
    const center = Math.min(L.W - half - 4, Math.max(half + 4, L.m.l + L.band * (i + .5)));
    tip.style.left = `${center}px`;
  };
  stage.addEventListener('pointermove', show);
  stage.addEventListener('pointerdown', show);
  stage.addEventListener('pointerleave', hide);
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => { if (!SC.animating && SC.to && SC.from) drawSalesChart(1); }).observe(stage);
  }
  syncSalesChartControls();
}

/* =========================================================
 * PAKET SATIŞ — çoklu ürün paketi, otomatik maliyet ve net kâr
 * Paket, normal satış kaydıyla aynı alanları taşır (revenue, totalCost, profit);
 * bu yüzden ciro ve kâr toplamlarına, grafiklere ve ana sayfa kartına kendiliğinden
 * dahil olur. type:'package' alanı listede "Paket" etiketi gösterir.
 * ========================================================= */
const PKG = { items:[{productId:'', qty:1}], sig:null };
function packageItemsOf(sale) {
  const value = sale?.items;
  const list = Array.isArray(value) ? value : (value && typeof value === 'object' ? Object.values(value) : []);
  return list.map(item => ({
    productId: String(item?.productId ?? ''), name: String(item?.name ?? 'Ürün'),
    qty: Math.max(0, Number(item?.qty) || 0), unitCost: Number(item?.unitCost) || 0, lineCost: Number(item?.lineCost) || 0
  }));
}
function pkgCompute() {
  const x = params();
  const lines = PKG.items.map(item => {
    const p = productById(item.productId);
    const qty = Math.max(0, Math.floor(Number(item.qty) || 0));
    const unitCost = p ? calc(p, x).unit : 0;
    const unitSale = p ? Math.max(0, Number(p.sale) || 0) : 0;
    return {item, p, qty, unitCost, lineCost: unitCost * qty, lineSale: unitSale * qty};
  });
  const cost = lines.reduce((sum, l) => sum + l.lineCost, 0);
  const listPrice = lines.reduce((sum, l) => sum + l.lineSale, 0);
  const price = num('pkgPrice');
  const pq = Math.max(1, Math.floor(num('pkgQty')));
  return {
    lines, cost, listPrice, price, pq, profit: price - cost, margin: price > 0 ? (price - cost) / price * 100 : 0,
    revenue: price * pq, totalCost: cost * pq, totalProfit: (price - cost) * pq
  };
}
function renderPackageRows() {
  const wrap = $('pkgItemRows');
  if (!wrap) return;
  const options = state.products.length
    ? '<option value="">Ürün seç…</option>' + state.products.map(p => `<option value="${esc(p.id)}">${esc(p.name || 'İsimsiz ürün')} · hazır ${fmt(readyStockOf(p),0)} adet</option>`).join('')
    : '<option value="">Önce ürün ekle</option>';
  wrap.innerHTML = PKG.items.map((item, i) => `<div class="pkg-item-row" data-pkg-row="${i}">
    <select data-pkg-field="productId" aria-label="Pakete dahil ürün">${options}</select>
    <input type="number" min="1" max="100000" step="1" value="${Number(item.qty) || 0}" data-pkg-field="qty" aria-label="Ürün adedi">
    <span class="pkg-line-cost" data-pkg-cost="${i}">—</span>
    <button class="delete-btn" type="button" data-pkg-remove="${i}" title="Satırı kaldır" aria-label="Satırı kaldır">×</button>
  </div>`).join('');
  wrap.querySelectorAll('select').forEach((select, i) => {
    select.value = PKG.items[i].productId || '';
    if (select.value !== (PKG.items[i].productId || '')) { PKG.items[i].productId = ''; select.value = ''; }
  });
  updatePackageSummary();
}
function updatePackageSummary() {
  const box = $('pkgSummary');
  if (!box) return;
  const c = pkgCompute();
  document.querySelectorAll('[data-pkg-cost]').forEach(el => {
    const l = c.lines[Number(el.dataset.pkgCost)];
    el.textContent = l && l.p && l.qty > 0 ? `${money(l.unitCost)} × ${fmt(l.qty, 0)} = ${money(l.lineCost)}` : '—';
  });
  const valid = c.lines.filter(l => l.p && l.qty > 0);
  const unitCount = valid.reduce((sum, l) => sum + l.qty, 0);
  const good = c.profit >= 0;
  box.innerHTML = `
    <article><span>Paket maliyeti</span><strong>${money(c.cost)}</strong><small>${fmt(valid.length, 0)} kalem · ${fmt(unitCount, 0)} ürün</small></article>
    <article><span>Paket satış fiyatı</span><strong>${money(c.price)}</strong><small>1 paket için</small></article>
    <article class="${good ? 'is-profit' : 'is-loss'}"><span>Net kâr / paket</span><strong class="${good ? 'profit-positive' : 'profit-negative'}">${money(c.profit)}</strong><small>Kâr marjı %${fmt(c.margin, 1)}</small></article>
    <article><span>Toplam (${fmt(c.pq, 0)} paket)</span><strong class="${c.totalProfit >= 0 ? 'profit-positive' : 'profit-negative'}">${money(c.totalProfit)}</strong><small>Ciro ${money(c.revenue)} · maliyet ${money(c.totalCost)}</small></article>`;
  const suggest = $('pkgSuggest');
  if (suggest) suggest.innerHTML = c.listPrice > 0
    ? `Ürünlerin tekil satış fiyatları toplamı: <strong>${money(c.listPrice)}</strong> <button type="button" class="link-btn" data-pkg-apply-list>Paket fiyatı olarak kullan</button>`
    : '';
}
// Ürün listesi değişince (ekleme, silme, yeniden adlandırma) satırları yeniler; aksi halde yalnızca özeti.
function syncPackageProducts() {
  if (!$('pkgItemRows')) return;
  const sig = state.products.map(p => `${p.id}:${p.name || ''}`).join('|');
  if (sig !== PKG.sig) {
    PKG.sig = sig;
    PKG.items.forEach(item => { if (item.productId && !productById(item.productId)) item.productId = ''; });
    renderPackageRows();
  } else {
    updatePackageSummary();
  }
}
function setSaleMode(mode) {
  const pkgOn = mode === 'package';
  $('saleForm').hidden = pkgOn;
  $('packageForm').hidden = !pkgOn;
  document.querySelectorAll('[data-sale-mode]').forEach(btn => {
    const on = btn.dataset.saleMode === mode;
    btn.classList.toggle('active', on); btn.setAttribute('aria-selected', String(on));
  });
  syncSlidingPills();
  if (pkgOn) syncPackageProducts();
}
function savePackageSale(event) {
  event.preventDefault();
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan satış kaydedilemez.'); return; }
  if (!validateFormInputs($('packageForm'))) return;
  const c = pkgCompute();
  if (!c.lines.length || c.lines.some(l => !l.p || l.qty < 1)) {
    toast('Her satır için bir ürün seç ve adedi en az 1 gir.', 'warning'); return;
  }
  if (!(c.price > 0)) { toast('Paket satış fiyatını gir.', 'warning'); return; }
  // Aynı ürün birden fazla satırdaysa tek kalemde birleştirilir.
  const merged = new Map();
  c.lines.forEach(l => {
    const prev = merged.get(l.p.id);
    if (prev) { prev.qty += l.qty; prev.lineCost += l.lineCost; }
    else merged.set(l.p.id, {p: l.p, qty: l.qty, unitCost: l.unitCost, lineCost: l.lineCost});
  });
  const x = params();
  const lines = [...merged.values()];
  const shortageLine = lines.find(l => readyStockOf(l.p) < l.qty * c.pq);
  if (shortageLine) {
    toast(`${stockGuardMessage()}. "${shortageLine.p.name || 'İsimsiz ürün'}" için hazır ${fmt(readyStockOf(shortageLine.p),0)} adet var, ${fmt(shortageLine.qty * c.pq,0)} adet gerekiyor.`, 'warning', {title:'Mamul stok yetersiz'});
    return;
  }
  const maintenanceShare = round2(lines.reduce(
    (sum, l) => sum + maintenanceShareForProduct(l.p, l.qty * c.pq, x), 0
  ));
  const items = lines.map(l => ({
    productId: l.p.id, name: l.p.name || 'İsimsiz ürün', qty: l.qty,
    unitCost: l.unitCost, lineCost: l.lineCost, unitListPrice: Math.max(0, Number(l.p.sale) || 0)
  }));
  const perPackageUnits = items.reduce((sum, i) => sum + i.qty, 0);
  const typedName = $('pkgName').value.trim();
  const record = {
    type: 'package',
    date: $('pkgDate').value || todayISO(),
    productName: typedName || items.map(i => `${i.name} ×${i.qty}`).join(' + '),
    items,
    qty: c.pq, unitsTotal: perPackageUnits * c.pq,
    unitPrice: c.price, unitCost: c.cost,
    revenue: c.revenue, totalCost: c.totalCost, profit: c.totalProfit,
    maintenanceShare,
    note: $('pkgNote').value.trim(), createdAt: Date.now(),
    costSnapshot: {
      params: clone(x),
      items: lines.map(l => {
        const b = calc(l.p, x);
        return {
          productId: l.p.id, name: l.p.name || 'İsimsiz ürün', qty: l.qty, hours: Number(l.p.hours) || 0,
          breakdown: {filament:b.filament, electric:b.electric, stand:b.stand, machine:b.machine, wear:b.wear, fire:b.fire, lighter:b.lighter, unit:b.unit}
        };
      }),
      capturedAt: new Date().toISOString()
    }
  };
  const requirements = lines.map(line => ({
    productId: line.p.id, name: line.p.name || 'İsimsiz ürün', qty: line.qty * c.pq
  }));
  commitSaleWithFinishedStock(record, requirements, maintenanceShare)
    .then(() => {
      PKG.items = [{productId:'', qty:1}];
      $('pkgName').value = ''; $('pkgNote').value = ''; $('pkgQty').value = 1; $('pkgPrice').value = 0;
      $('pkgDate').value = todayISO();
      renderPackageRows();
      toast(`Paket satışı buluta kaydedildi. Net kâr: ${money(record.profit)}${maintenanceShare > 0 ? ` · Bakım fonuna ${money(maintenanceShare)} aktarıldı` : ''}`);
    })
    .catch(error => { if(!['insufficient-finished-stock','offline-stock-guard','transaction-aborted'].includes(error.message)) cloudError(error, 'paket satışı kaydetme'); });
}
function saleNameCell(sale) {
  if (sale.type !== 'package') return esc(sale.productName);
  const contents = packageItemsOf(sale).map(i => `${esc(i.name)} ×${fmt(i.qty, 0)}`).join(' + ');
  return `<span class="sale-badge package">Paket</span>${esc(sale.productName)}${contents ? `<small class="pkg-contents">${contents}</small>` : ''}`;
}
function saleQtyCell(sale) {
  return sale.type === 'package' ? `${fmt(sale.qty, 0)} paket` : fmt(sale.qty, 0);
}
function showPackageDetails(sale) {
  const items = packageItemsOf(sale);
  const perPackageUnits = items.reduce((sum, i) => sum + i.qty, 0);
  $('saleDetailTitle').textContent = `${sale.productName} — paket satışı`;
  $('saleDetailSubtitle').textContent = `Satış tarihi: ${sale.date} · Birim maliyetler satış anındaki değerlerle saklanır; bugünkü fiyatlarla yeniden hesaplanmaz.`;
  $('saleDetailContent').innerHTML = `
    <h3 class="detail-section-title">Paket içeriği ve maliyeti (1 paket için)</h3>
    <div class="table-wrap"><table class="detail-table"><thead><tr><th>Ürün</th><th>Adet</th><th>Birim maliyet</th><th>Kalem maliyeti</th></tr></thead><tbody>
      ${items.map(i => `<tr><td>${esc(i.name)}</td><td>${fmt(i.qty, 0)}</td><td>${money(i.unitCost)}</td><td>${money(i.lineCost)}</td></tr>`).join('')}
      <tr><td><strong>Paket maliyeti</strong></td><td><strong>${fmt(perPackageUnits, 0)}</strong></td><td></td><td><strong>${money(sale.unitCost)}</strong></td></tr>
    </tbody></table></div>
    <div class="detail-total"><span>Paket satış fiyatı<strong>${money(sale.unitPrice)}</strong></span><span>Paket adedi<strong>${fmt(sale.qty, 0)}</strong></span><span>Toplam ciro<strong>${money(sale.revenue)}</strong></span><span>Toplam maliyet<strong>${money(sale.totalCost)}</strong></span><span>Bu satışın net kârı<strong>${money(sale.profit)}</strong></span></div>`;
  $('saleDetailModal').hidden = false;
}
function initPackageUi() {
  const form = $('packageForm');
  if (!form) return;
  document.querySelectorAll('[data-sale-mode]').forEach(btn => btn.addEventListener('click', () => setSaleMode(btn.dataset.saleMode)));
  form.addEventListener('input', event => {
    const el = event.target;
    if (el.matches('[data-pkg-field="qty"]')) {
      const row = el.closest('[data-pkg-row]');
      if (row && PKG.items[Number(row.dataset.pkgRow)]) PKG.items[Number(row.dataset.pkgRow)].qty = Math.max(0, Number(el.value) || 0);
    }
    if (el.matches('[data-pkg-field="qty"], #pkgPrice, #pkgQty')) updatePackageSummary();
  });
  form.addEventListener('change', event => {
    const el = event.target;
    if (el.matches('[data-pkg-field="productId"]')) {
      const row = el.closest('[data-pkg-row]');
      if (row && PKG.items[Number(row.dataset.pkgRow)]) PKG.items[Number(row.dataset.pkgRow)].productId = el.value;
      updatePackageSummary();
    }
  });
  form.addEventListener('click', event => {
    if (event.target.closest('#pkgAddItem')) {
      PKG.items.push({productId:'', qty:1});
      renderPackageRows();
      const selects = $('pkgItemRows').querySelectorAll('select');
      if (selects.length) selects[selects.length - 1].focus();
      return;
    }
    const removeBtn = event.target.closest('[data-pkg-remove]');
    if (removeBtn) {
      PKG.items.splice(Number(removeBtn.dataset.pkgRemove), 1);
      if (!PKG.items.length) PKG.items.push({productId:'', qty:1});
      renderPackageRows();
      return;
    }
    if (event.target.closest('[data-pkg-apply-list]')) {
      $('pkgPrice').value = Math.round(pkgCompute().listPrice * 100) / 100;
      updatePackageSummary();
    }
  });
  form.addEventListener('submit', savePackageSale);
  $('pkgDate').value = todayISO();
}

/* =========================================================
 * BAKIM & GİDER YÖNETİMİ
 * Satışlardan biriken teorik bakım payı (maintenanceFund.balance) burada
 * gösterilir; girilen gerçek masraflar maintenanceLogs'a yazılır ve aynı
 * atomik transaction içinde fondan düşülür.
 * ========================================================= */
function renderMaintenance() {
  if (!$('maintenanceBalance')) return;
  const balance = Number(maintenanceFund.balance) || 0;
  $('maintenanceBalance').textContent = money(balance);
  $('maintenanceBalance').classList.toggle('profit-negative', balance < 0);
  $('maintenanceBalance').classList.toggle('profit-positive', balance >= 0);
  if ($('maintenanceAccrued')) $('maintenanceAccrued').textContent = money(maintenanceFund.totalAccrued || 0);
  if ($('maintenanceSpent')) $('maintenanceSpent').textContent = money(maintenanceFund.totalSpent || 0);
  if ($('maintenanceCount')) $('maintenanceCount').textContent = `${maintenanceLogs.length} masraf kaydı`;
  const rowsEl = $('maintenanceRows');
  if (rowsEl) {
    rowsEl.innerHTML = maintenanceLogs.map(log => `<tr>
      <td>${esc(log.date || '—')}</td>
      <td>${esc(log.description || 'Bakım masrafı')}</td>
      <td>${esc(log.part || 'Diğer')}</td>
      <td class="profit-negative">− ${money(log.amount)}</td>
      <td><button class="delete-btn" type="button" data-maintenance-delete="${esc(log.id)}" title="Masraf kaydını sil" aria-label="Masraf kaydını sil">×</button></td>
    </tr>`).join('');
    refreshTableLabels(rowsEl.closest('table'));
  }
  if ($('maintenanceEmpty')) $('maintenanceEmpty').style.display = maintenanceLogs.length ? 'none' : 'block';
}
async function saveMaintenanceExpense(event) {
  event.preventDefault();
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan masraf kaydedilemez.'); return; }
  if (!firebaseConnected || navigator.onLine === false) { toast('Bağlantı yok. Masraf kaydı bağlantı gelene kadar yapılamaz.', 'warning'); return; }
  if (!validateFormInputs($('maintenanceForm'))) return;
  const description = $('maintenanceDescription').value.trim();
  if (!description) { toast('Masraf açıklaması gir.', 'warning'); $('maintenanceDescription').focus(); return; }
  const parsed = parseStrictNumber($('maintenanceAmount').value, {min:0.01, max:100000000});
  if (!parsed.ok) { toast(`Tutar: ${parsed.reason}.`, 'error'); return; }
  const amount = round2(parsed.value);
  const date = $('maintenanceDate').value || todayISO();
  const part = $('maintenancePart').value || 'Diğer';
  if (amount > (Number(maintenanceFund.balance) || 0)) {
    const ok = await confirmDialog({
      title:'Fon bakiyesi yetersiz',
      message:`Masraf (${money(amount)}) biriken fondan (${money(maintenanceFund.balance)}) büyük. Bakiye eksiye düşecek. Devam edilsin mi?`,
      confirmText:'Yine de kaydet', danger:true
    });
    if (!ok) return;
  }
  const logRef = maintenanceLogsRef.push();
  const log = {description, amount, date, part, type:'expense', createdAt:Date.now()};
  const apply = attempt => new Promise((resolve, reject) => {
    rootRef.transaction(current => {
      const root = current || {};
      const fund = root.maintenanceFund && typeof root.maintenanceFund === 'object' ? root.maintenanceFund : {};
      root.maintenanceLogs = {...(root.maintenanceLogs || {}), [logRef.key]: log};
      root.maintenanceFund = {
        ...fund,
        balance: round2((Number(fund.balance) || 0) - amount),
        totalAccrued: round2(Number(fund.totalAccrued) || 0),
        totalSpent: round2((Number(fund.totalSpent) || 0) + amount),
        updatedAt: Date.now()
      };
      return root;
    }, (error, committed) => {
      if (error) {
        if (attempt < TX_MAX_ATTEMPTS - 1 && txShouldRetry(error)) {
          setTimeout(() => apply(attempt + 1).then(resolve, reject), txRetryDelay(attempt));
          return;
        }
        toast('Masraf kaydedilemedi, lütfen tekrar deneyin.', 'error');
        reject(error); return;
      }
      if (!committed) {
        if (attempt < TX_MAX_ATTEMPTS - 1) { setTimeout(() => apply(attempt + 1).then(resolve, reject), txRetryDelay(attempt)); return; }
        toast('Masraf kaydedilemedi (eşzamanlı çakışma).', 'error');
        reject(new Error('transaction-aborted')); return;
      }
      resolve();
    }, false);
  });
  const releaseRootCache = await acquireRootCache();
  try {
    await apply(0);
    $('maintenanceDescription').value = ''; $('maintenanceAmount').value = '';
    $('maintenanceDate').value = todayISO();
    toast(`Bakım masrafı ${money(amount)} fondan düşüldü.`, 'success');
  } catch (error) {
    console.error('bakım masrafı', error);
  } finally {
    releaseRootCache();
  }
}
function initMaintenanceUi() {
  const form = $('maintenanceForm');
  if (!form) return;
  form.addEventListener('submit', saveMaintenanceExpense);
  if ($('maintenanceDate')) $('maintenanceDate').value = todayISO();
  if ($('maintenanceRows')) {
    $('maintenanceRows').addEventListener('click', event => {
      const button = event.target.closest('[data-maintenance-delete]');
      if (!button || !cloudReady) return;
      const log = maintenanceLogs.find(item => String(item.id) === String(button.dataset.maintenanceDelete));
      if (!log) return;
      confirmDialog({
        title:'Masraf kaydını sil',
        message:`${log.description || 'Bakım masrafı'} (${money(log.amount)}) kaydı silinecek ve tutar fona geri eklenecek.`,
        confirmText:'Sil ve fona iade et', danger:true
      }).then(ok => {
        if (!ok) return;
        acquireRootCache().then(release => rootRef.transaction(current => {
          const root = current || {};
          if (!root.maintenanceLogs || !root.maintenanceLogs[log.id]) return;
          delete root.maintenanceLogs[log.id];
          const fund = root.maintenanceFund && typeof root.maintenanceFund === 'object' ? root.maintenanceFund : {};
          root.maintenanceFund = {
            ...fund,
            balance: round2((Number(fund.balance) || 0) + (Number(log.amount) || 0)),
            totalAccrued: round2(Number(fund.totalAccrued) || 0),
            totalSpent: round2(Math.max(0, (Number(fund.totalSpent) || 0) - (Number(log.amount) || 0))),
            updatedAt: Date.now()
          };
          return root;
        }, error => {
          if (error) { cloudError(error, 'bakım masrafı silme'); return; }
          toast('Masraf kaydı silindi; tutar bakım fonuna iade edildi.', 'success');
        }, false).then(release, release));
      });
    });
  }
  renderMaintenance();
}

/* =========================================================
 * VERİ YÖNETİMİ — Excel (.xlsx), CSV, JSON yedek / geri yükleme
 * ========================================================= */
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link);
  link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function fileStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}
function colorSummary(product) {
  const colors = productColors(product);
  return colors.length ? colors.map(c => `${c.name || 'Renk'} ${c.grams} g`).join(' | ') : 'Renk tanımlanmadı';
}
/* SheetJS (xlsx) yalnızca Excel dışa aktarımında, isteğe bağlı yüklenir.
 * Öncelik aynı kaynaklı yerel dosyadır: tarayıcı gizlilik/tracking koruması
 * üçüncü taraf CDN betiklerinin depolama erişimini engellediği için CDN uyarısı
 * oluşmaz. Yerel dosya yoksa ağ hatasına karşı CDN tek yedek olarak denenir. */
let xlsxLoadPromise = null;
function loadXlsxLibrary() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxLoadPromise) return xlsxLoadPromise;
  const sources = [
    'vendor/xlsx.full.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
  ];
  xlsxLoadPromise = new Promise((resolve, reject) => {
    const trySource = index => {
      if (index >= sources.length) { reject(new Error('xlsx-unavailable')); return; }
      const script = document.createElement('script');
      script.src = sources[index];
      script.async = true;
      script.referrerPolicy = 'no-referrer';
      script.onload = () => {
        if (window.XLSX) { resolve(window.XLSX); return; }
        script.remove();
        trySource(index + 1);
      };
      script.onerror = () => { script.remove(); trySource(index + 1); };
      document.head.appendChild(script);
    };
    trySource(0);
  }).catch(error => {
    xlsxLoadPromise = null;
    throw error;
  });
  return xlsxLoadPromise;
}
async function exportExcel() {
  try {
    await loadXlsxLibrary();
  } catch (error) {
    toast('Excel kütüphanesi yüklenemedi. vendor/xlsx.full.min.js dosyasını veya internet bağlantısını kontrol et.', 'error');
    return;
  }
  if (typeof XLSX === 'undefined') { toast('Excel kütüphanesi yüklenemedi.', 'error'); return; }
  try {
    const wb = XLSX.utils.book_new();
    const addSheet = (name, headers, rows, widths) => {
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      ws['!cols'] = widths.map(w => ({wch:w}));
      if (ws['!ref']) ws['!autofilter'] = {ref: ws['!ref']};
      XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    };
    const p = params();
    addSheet('Urunler',
      ['Ürün', 'Adet', 'Hazır mamul stok', 'Toplam gram', 'Baskı süresi (saat)', 'Satış fiyatı (TL)', 'Renkler', 'Birim maliyet (TL)', 'Birim kâr (TL)'],
      state.products.map(prod => {
        const c = calc(prod);
        return [prod.name || 'İsimsiz ürün', Number(prod.qty) || 0, readyStockOf(prod), Number(prod.grams) || 0, Number(prod.hours) || 0,
          round2(prod.sale), colorSummary(prod), round2(c.unit), round2(c.profit)];
      }),
      [28, 8, 18, 14, 20, 18, 40, 18, 16]);
    addSheet('Uretim',
      ['Tarih', 'Ürün', 'Adet', 'Renk tüketimi', 'Toplam gram', 'Üretim sonrası mamul'],
      productionLogs.map(log => {
        const colors = Array.isArray(log.colors) ? log.colors : Object.values(log.colors || {});
        return [log.date || '', log.productName || '', Number(log.qty) || 0,
          colors.map(color => `${color.name} ${color.grams} g`).join(' | '),
          round2(log.totalGrams), Number(log.readyStockAfter) || 0];
      }),
      [12, 30, 8, 50, 14, 22]);
    addSheet('Satislar',
      ['Tarih', 'Tür', 'Ürün / paket', 'Adet', 'Satılan birim', 'Birim fiyat (TL)', 'Ciro (TL)', 'Birim maliyet (TL)', 'Toplam maliyet (TL)', 'Net kâr (TL)', 'Bakım payı (TL)', 'Not'],
      sales.map(sale => [sale.date || '', sale.type === 'package' ? 'Paket' : 'Tekli', sale.productName || '',
        Number(sale.qty) || 0, Number(sale.unitsTotal ?? sale.qty) || 0, round2(sale.unitPrice),
        round2(sale.revenue), round2(sale.unitCost), round2(sale.totalCost), round2(sale.profit),
        round2(sale.maintenanceShare), sale.note || '']),
      [12, 10, 34, 8, 14, 16, 14, 18, 18, 14, 16, 30]);
    addSheet('FilamentStok',
      ['Renk', 'Stok (kg)', 'Toplam ağırlık (g)', 'Ağırlıklı ortalama fiyat (TL/kg)'],
      Object.entries(filamentStock).map(([color, raw]) => {
        const entry = normalizeStockEntry(raw);
        return [color, round3(entry.kg), Math.round(entry.totalWeightGrams), round2(entry.weightedAveragePricePerKg ?? p.filamentPrice)];
      }),
      [24, 14, 20, 30]);
    addSheet('Parametreler',
      ['Anahtar', 'Değer'],
      Object.entries({...p, minStockKg:Math.max(0, Number(state.minStockKg) || 0), filamentStockKg:Math.max(0, Number(state.filamentStockKg) || 0)}),
      [28, 18]);
    addSheet('BakimFonu',
      ['Tarih', 'Açıklama', 'Parça', 'Tutar (TL)'],
      maintenanceLogs.map(log => [log.date || '', log.description || '', log.part || 'Diğer', round2(log.amount)]),
      [14, 40, 18, 16]);
    addSheet('BakimOzeti',
      ['Alan', 'Değer'],
      [['Biriken fon (TL)', round2(maintenanceFund.balance)], ['Toplam tahakkuk (TL)', round2(maintenanceFund.totalAccrued)], ['Toplam masraf (TL)', round2(maintenanceFund.totalSpent)]],
      [30, 18]);
    XLSX.writeFile(wb, `PrintCost_Yedek_${fileStamp()}.xlsx`);
    toast('Excel dosyası tüm veri sekmeleriyle indirildi.', 'success');
  } catch (error) {
    console.error('excel', error);
    toast('Excel dosyası oluşturulamadı.', 'error');
  }
}
function csvEscape(value) {
  const text = String(value ?? '');
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function exportCsv() {
  const dataset = $('csvDataset')?.value || 'sales';
  let headers = [], rows = [];
  if (dataset === 'products') {
    headers = ['Ürün', 'Adet', 'Hazır mamul stok', 'Toplam gram', 'Baskı süresi (saat)', 'Satış fiyatı', 'Renkler'];
    rows = state.products.map(prod => [prod.name || '', Number(prod.qty) || 0, readyStockOf(prod), Number(prod.grams) || 0, Number(prod.hours) || 0, round2(prod.sale), colorSummary(prod)]);
  } else if (dataset === 'stock') {
    headers = ['Renk', 'Stok (kg)', 'Toplam gram', 'Ağırlıklı ortalama fiyat (TL/kg)'];
    rows = Object.entries(filamentStock).map(([color, raw]) => {
      const entry = normalizeStockEntry(raw);
      return [color, round3(entry.kg), Math.round(entry.totalWeightGrams), round2(entry.weightedAveragePricePerKg ?? params().filamentPrice)];
    });
  } else {
    headers = ['Tarih', 'Ürün', 'Adet', 'Ciro', 'Toplam maliyet', 'Net kâr'];
    rows = sales.map(sale => [sale.date || '', sale.productName || '', Number(sale.qty) || 0, round2(sale.revenue), round2(sale.totalCost), round2(sale.profit)]);
  }
  const csv = '﻿' + [headers, ...rows].map(row => row.map(csvEscape).join(';')).join('\r\n');
  downloadBlob(`PrintCost_${dataset}_${fileStamp()}.csv`, new Blob([csv], {type:'text/csv;charset=utf-8'}));
  toast('CSV dosyası indirildi.', 'success');
}
function exportJsonBackup() {
  if (!cloudReady || !rootRef) { toast('Bulut bağlantısı olmadan yedek alınamaz.', 'warning'); return; }
  rootRef.once('value')
    .then(snap => {
      const payload = JSON.stringify(snap.val() || {}, null, 2);
      downloadBlob(`PrintCost_Yedek_${fileStamp()}.json`, new Blob([payload], {type:'application/json;charset=utf-8'}));
      toast('Ham JSON yedeği indirildi.', 'success');
    })
    .catch(error => cloudError(error, 'JSON yedeği'));
}
const BACKUP_ALLOWED_KEYS = ['params', 'filamentStock', 'products', 'sales', 'costHistory', 'maintenanceFund', 'maintenanceLogs', 'productionLogs', 'filamentPurchases', 'auth', 'system'];
function restoreJsonBackup(file) {
  if (!file) return;
  if (!cloudReady || !rootRef) { toast('Bulut bağlantısı olmadan yedek geri yüklenemez.', 'warning'); return; }
  if (file.size > 20 * 1024 * 1024) { toast('Yedek dosyası en fazla 20 MB olabilir.', 'error'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    let payload;
    try {
      const parsed = JSON.parse(String(reader.result || '{}'));
      payload = parsed && typeof parsed === 'object' && parsed.root && typeof parsed.root === 'object' ? parsed.root : parsed;
    } catch (error) {
      toast('JSON dosyası okunamadı. Geçerli bir yedek dosyası seç.', 'error'); return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      toast('Yedek formatı geçersiz: kök nesne bekleniyor.', 'error'); return;
    }
    const unknown = Object.keys(payload).filter(key => !BACKUP_ALLOWED_KEYS.includes(key));
    if (unknown.length) { toast(`Yedekte tanınmayan alanlar var: ${unknown.slice(0, 5).join(', ')}`, 'error'); return; }
    if (!Object.keys(payload).length) { toast('Yedek dosyası boş.', 'error'); return; }
    const ok = await confirmDialog({
      title:'Yedekten geri yükle',
      message:'Mevcut bulut verileri yedekteki içerikle değiştirilecek. Oturum hesapları korunur. Bu işlem geri alınamaz; önce güncel bir yedek almanız önerilir.',
      confirmText:'Geri yükle', danger:true
    });
    if (!ok) return;
    try {
      // Oturum hesaplarının kazara silinmesini önlemek için auth düğümü korunur.
      const authSnap = await rootRef.child('auth').once('value');
      if (authSnap.exists() && !payload.auth) payload.auth = authSnap.val();
      await rootRef.set(payload);
      toast('Yedek Firebase Realtime Database’e geri yüklendi.', 'success');
    } catch (error) {
      cloudError(error, 'yedek geri yükleme');
    }
  };
  reader.onerror = () => toast('Yedek dosyası okunamadı.', 'error');
  reader.readAsText(file);
}
function initDataManagementUi() {
  $('exportExcelBtn')?.addEventListener('click', exportExcel);
  $('exportCsvBtn')?.addEventListener('click', exportCsv);
  $('exportJsonBtn')?.addEventListener('click', exportJsonBackup);
  const input = $('restoreJsonInput');
  if (input) {
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      restoreJsonBackup(file);
      input.value = '';
    });
  }
  $('restoreJsonBtn')?.addEventListener('click', () => { if (input) input.click(); });
}

/* ---------- Başlangıç ---------- */
syncInputs();
lastCommittedParams = clone(params());
renderProducts();
renderSales();
renderCostHistory();
renderInventory();
initUi();
initFirebase();
const initialPage = location.hash.slice(1);
showPage(['production','sales','inventory','analysis','maintenance','settings'].includes(initialPage) ? initialPage : 'production');
