'use strict';
const $ = id => document.getElementById(id);

/* =========================================================
 * BULUT MİMARİSİ
 * Tüm kalıcı veriler Firebase Realtime Database üzerinde tutulur.
 * Yerel dosya veya tarayıcı hafızası kullanılmaz.
 * Veri yolu: printcost/{params|filamentStock|products|sales|costHistory}
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
  if (pageId === 'inventory' && typeof playPriceBars === 'function') playPriceBars(true);
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
// Renk adı → depodaki kilogram. Ayrı bir bulut düğümünde (printcost/filamentStock) tutulur.
let filamentStock = {};
let filamentStockLoaded = false;
let legacyStockChecked = false;
let detailProductId = null;
let lastCommittedParams = clone(defaults);
const dirtyParamKeys = new Set();
let cloudReady = false;
let paramsInitialized = false;
let db = null;
let rootRef = null;
let paramsRef = null;
let productsRef = null;
let salesRef = null;
let historyRef = null;
let filamentStockRef = null;

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
    rootRef = db.ref(CLOUD_ROOT);
    paramsRef = rootRef.child('params');
    productsRef = rootRef.child('products');
    salesRef = rootRef.child('sales');
    historyRef = rootRef.child('costHistory');
    filamentStockRef = rootRef.child('filamentStock');
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
    setCloudStatus(
      connected ? 'online' : 'offline',
      connected ? 'Bulut bağlı · veriler Firebase’de' : 'Bağlantı kuruluyor…',
      connected ? 'Tüm cihazlar aynı canlı veriyi görür.' : 'İnternet bağlantısı bekleniyor.'
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
      .map(([id, product]) => ({id, ...product}))
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    renderProducts();
    renderSales();
  }, error => cloudError(error, 'ürünleri okuma'));

  // Satışlar
  salesRef.on('value', snap => {
    const value = snap.val() || {};
    sales = Object.entries(value).map(([id, record]) => ({id, ...record}));
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
}

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
  productsRef.child(id).update(fields).catch(error => cloudError(error, 'ürünü güncelleme'));
}
function writeColorStock(color, kg) {
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan stok kaydedilemez.'); return Promise.reject(new Error('offline')); }
  const safe = Math.max(0, Number(kg) || 0);
  return filamentStockRef.child(color).set(Math.round(safe * 1000) / 1000)
    .catch(error => { cloudError(error, 'renk stoğu'); throw error; });
}
function deleteColorStock(color) {
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan stok silinemez.'); return; }
  filamentStockRef.child(color).remove().catch(error => cloudError(error, 'renk stoğu silme'));
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
  const filament = perUnitGrams*gramPrice;
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

function productById(id) {
  return state.products.find(product => String(product.id) === String(id));
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
  Object.entries(filamentStock || {}).forEach(([name, kg]) => {
    const safeName = sanitizeColorName(name);
    if (!safeName) return;
    stockByColor[safeName] = (stockByColor[safeName] || 0) + Math.max(0, Number(kg) || 0);
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
    return {name, stockKg: stockOfColor, neededKg, remaining: stockOfColor - neededKg};
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
    const colorCell = colors.length
      ? `<div class="color-chip-list">${colors.map(color => `<span class="color-chip" title="${esc(color.name || 'Renk')} · adet başına ${fmt(color.grams,1)} g"><i style="background:${colorSwatch(color.name)}"></i>${esc(color.name || 'Renk')} <small>${fmt(color.grams,1)} g</small></span>`).join('')}</div>`
      : '<span class="muted-chip">Renk tanımlanmadı</span>';
    const tr = document.createElement('tr');
    tr.className = 'product-row';
    tr.dataset.productRow = p.id;
    tr.title = 'Ürün detayı için tıkla';
    tr.innerHTML = `
      <td class="photo-cell"><div class="product-photo-wrap">${p.photo ? `<button class="product-photo-btn" type="button" data-product-detail="${esc(p.id)}" aria-label="${esc(p.name)} detayını aç" title="Ürün detayını aç"><img class="product-photo" src="${p.photo}" alt="${esc(p.name)} fotoğrafı" loading="lazy"><span class="photo-zoom-hint" aria-hidden="true">⤢</span></button>` : '<div class="photo-placeholder">Fotoğraf<br>yok</div>'}<label class="photo-upload">Fotoğraf seç<input type="file" accept="image/*" data-photo-id="${esc(p.id)}" aria-label="${esc(p.name)} fotoğrafı yükle"></label></div></td>
      <td><input class="name-input" aria-label="Ürün adı" data-pid="${esc(p.id)}" data-k="name" value="${esc(p.name)}"></td>
      <td><input type="number" min="0" step="1" aria-label="Adet" data-pid="${esc(p.id)}" data-k="qty" value="${Number(p.qty)||0}"></td>
      <td><input type="number" min="0" step="0.1" aria-label="Toplam gram" data-pid="${esc(p.id)}" data-k="grams" value="${Number(p.grams)||0}"></td>
      <td><input type="number" min="0" step="0.1" aria-label="Baskı süresi saat" data-pid="${esc(p.id)}" data-k="hours" value="${Number(p.hours)||0}" placeholder="Saat"></td>
      <td>${fmt(c.gram)} g</td><td>${colorCell}</td><td>${money(c.filament)}</td><td title="(Baskı süresi ÷ adet) × yazıcı gücü (kW) × kWh fiyatı">${money(c.electric)}</td><td>${money(c.stand)}</td><td title="(Baskı süresi ÷ adet) × (yazıcı bedeli ÷ ömür)">${money(c.machine)}</td><td title="(Baskı süresi ÷ adet) × saatlik bakım fonu (nozzle, PTFE, PEI, dişli, fan)">${money(c.wear)}</td><td title="Fire oranı: %${fmt(x.wasteRate,1)}">${money(c.fire)}</td><td>${money(c.lighter)}</td><td class="money">${money(c.unit)}</td>
      <td><input class="sale-input" type="number" min="0" step="0.01" aria-label="Satış fiyatı" data-pid="${esc(p.id)}" data-k="sale" value="${Number(p.sale)||0}"></td>
      <td class="${c.profit>=0?'profit-positive':'profit-negative'}">${money(c.profit)}</td>
      <td class="money">${money(c.total)}</td>
      <td><div class="row-actions"><button class="detail-btn" data-product-detail="${esc(p.id)}" type="button" title="Ürün detayını aç">Detay</button><button class="delete-btn" data-delete="${esc(p.id)}" title="Ürünü sil" aria-label="Ürünü sil">×</button></div></td>`;
    rows.appendChild(tr);
  });
  const all = state.products.map(p=>({p,c:calc(p,x)}));
  const units = state.products.reduce((sum,p)=>sum+(Number(p.qty)||0),0);
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
  const select = $('saleProduct');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = state.products.map(p=>`<option value="${esc(p.id)}">${esc(p.name || 'İsimsiz ürün')}</option>`).join('');
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
        <td><div class="input-wrap mini-input"><input type="number" min="0" step="0.1" data-color-stock="${esc(row.name)}" value="${Number(row.stockKg.toFixed(3))}" aria-label="${esc(row.name)} stoğu kg"><b>kg</b></div></td>
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
}
function saveStockEntry(event) {
  event.preventDefault();
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan stok kaydedilemez.'); return; }
  const color = sanitizeColorName($('stockAddColor').value);
  if (!color) { toast('Eklemek için bir renk adı gir.'); return; }
  const kg = Math.max(0, num('stockAddKg'));
  const price = Math.max(0, num('stockAddPrice'));
  const dateValue = $('stockAddDate').value || todayISO();
  if (!kg) { toast('Eklemek için en az 0,01 kg girmelisin.'); return; }
  const previous = params().filamentPrice;
  const newStock = Math.round(((Number(filamentStock[color])||0)+kg)*1000)/1000;
  const priceChanged = price > 0 && Math.abs(price-previous) > 0.001;
  const updates = {};
  updates[`filamentStock/${color}`] = newStock;
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
      filamentStock[color] = newStock;
      $('stockAddColor').value = color;
      if (priceChanged) {
        state.filamentPrice = price;
        $('filamentPrice').value = price;
        lastCommittedParams = clone(params());
        if (historyEntry) { costHistory.unshift(historyEntry); renderCostHistory(); }
      }
      $('stockAddKg').value = 1;
      $('stockAddDate').value = todayISO();
      renderProducts(); renderSales(); renderInventory();
      toast(priceChanged
        ? `${color} stoğuna ${fmt(kg,2)} kg eklendi. Yeni fiyat ${money(price)} / kg buluta işlendi.`
        : `${color} stoğuna ${fmt(kg,2)} kg filament eklendi.`);
    })
    .catch(error => cloudError(error, 'stok girişi'));
}
function addProduct() {
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan ürün eklenemez.'); return; }
  const product = {name:'Yeni Ürün',qty:1,grams:0,hours:0,sale:0,usesLighter:true,photo:'',createdAt:Date.now()};
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
  const qty = records.reduce((sum,s)=>sum+(Number(s.qty)||0),0);
  const revenue = records.reduce((sum,s)=>sum+(Number(s.revenue)||0),0);
  const cost = records.reduce((sum,s)=>sum+(Number(s.totalCost)||0),0);
  const profit = records.reduce((sum,s)=>sum+(Number(s.profit)||0),0);
  $('salesUnits').textContent = fmt(qty,0); $('salesRevenue').textContent = money(revenue);
  $('salesCost').textContent = money(cost); $('salesProfit').textContent = money(profit);
  // Ana sayfadaki kâr kartı, dönem filtresinden bağımsız olarak gerçek satış kayıtlarından gelir.
  const allProfit = sales.reduce((sum, s) => sum + (Number(s.profit) || 0), 0);
  $('statProfit').textContent = money(allProfit);
  $('statProfitCaption').textContent = sales.length ? `Yapılan ${sales.length} satış kaydından` : 'Henüz satış kaydı yok';
  $('salesEmpty').style.display = records.length ? 'none' : 'block';
  $('salesRows').innerHTML = records.map(s=>`<tr>
    <td>${esc(s.date)}</td><td>${esc(s.productName)}</td><td>${fmt(s.qty,0)}</td><td>${money(s.unitPrice)}</td><td class="money">${money(s.revenue)}</td><td>${money(s.unitCost)}</td><td>${money(s.totalCost)}</td><td class="${s.profit>=0?'profit-positive':'profit-negative'}">${money(s.profit)}</td><td>${esc(s.note||'')}</td><td><button class="detail-btn" data-sale-detail="${esc(s.id)}" type="button">Fiyat detayı</button></td><td><button class="delete-btn" data-sale-delete="${esc(s.id)}" title="Satış kaydını sil" aria-label="Satış kaydını sil">×</button></td>
  </tr>`).join('');
  renderCostHistory();
}
function snapshotForSale(product, x) {
  const c = calc(product, x);
  return {
    params: clone(x),
    product: { id: product.id, name: product.name || 'İsimsiz ürün', qty: Number(product.qty)||0, grams: Number(product.grams)||0, hours: Number(product.hours)||0, usesLighter: Boolean(product.usesLighter), photo: product.photo || '', colors: productColors(product) },
    breakdown: { filament:c.filament, electric:c.electric, stand:c.stand, machine:c.machine, wear:c.wear, fire:c.fire, lighter:c.lighter, unit:c.unit },
    capturedAt: new Date().toISOString()
  };
}
function saveSale(event) {
  event.preventDefault();
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan satış kaydedilemez.'); return; }
  const product = productById($('saleProduct').value);
  if (!product) { toast('Önce ürün maliyet tablosuna ürün ekle.'); return; }
  const qty = Math.max(1,Math.floor(num('saleQty')));
  const unitPrice = num('salePrice');
  const unitCost = calc(product,params()).unit;
  const record = {
    date: $('saleDate').value || todayISO(), productId:product.id, productName:product.name || 'İsimsiz ürün',
    qty, unitPrice, unitCost, costSnapshot:snapshotForSale(product,params()),
    revenue:qty*unitPrice, totalCost:qty*unitCost, profit:qty*(unitPrice-unitCost),
    note:$('saleNote').value.trim(), createdAt:Date.now()
  };
  salesRef.push(record)
    .then(() => {
      $('saleQty').value = 1; $('saleNote').value = '';
      toast(`Satış buluta kaydedildi. Net kâr: ${money(record.profit)}`);
    })
    .catch(error => cloudError(error, 'satış kaydetme'));
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
}
function showSaleDetails(id) {
  const sale = sales.find(item=>String(item.id)===String(id));
  if (!sale) return;
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
    <div class="detail-meta"><span>Baskı süresi<strong>${fmt(snap.product?.hours||0)} saat</strong></span></div>
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
    dirtyParamKeys.add(id);
    state[id]=num(id);
    renderProducts(); renderSales();
    queueParamWrite(id, state[id]);
  });
  el.addEventListener('change',()=>{ state[id]=num(id); recordParameterChanges(); });
});
stockInputIds.forEach(id=>{
  const el = $(id); if (!el) return;
  el.addEventListener('input',()=>{ state[id]=num(id); renderProducts(); queueParamWrite(id, state[id]); });
  el.addEventListener('change',()=>{ state[id]=num(id); queueParamWrite(id, state[id]); renderInventory(); });
});
function processPhotoFile(file, id) {
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan fotoğraf yüklenemez.'); return; }
  const product = productById(id);
  if (!file || !product) return;
  if (!file.type.startsWith('image/')) { toast('Lütfen bir fotoğraf dosyası seç.'); return; }
  if (file.size > 12*1024*1024) { toast('Fotoğraf en fazla 12 MB olabilir.'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const maxSide = 640;
      const scale = Math.min(1,maxSide/Math.max(img.width,img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1,Math.round(img.width*scale));
      canvas.height = Math.max(1,Math.round(img.height*scale));
      canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
      // PNG olarak kaydet: alfa kanalı korunur, şeffaf alanlar siyaha dönüşmez.
      const dataUrl = canvas.toDataURL('image/png');
      if (dataUrl.length > 1800000) { toast('Fotoğraf bulut kaydı için çok büyük. Daha küçük bir görsel seç.'); return; }
      product.photo = dataUrl;
      writeProductItem(id, {photo:dataUrl});
      renderProducts();
      toast('Ürün fotoğrafı Firebase’e kaydedildi.');
    };
    img.onerror = () => toast('Fotoğraf okunamadı.');
    img.src = reader.result;
  };
  reader.onerror = () => toast('Fotoğraf yüklenemedi.');
  reader.readAsDataURL(file);
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
  const key=el.dataset.k;
  if (key === 'name') {
    product.name = el.value;
    writeProductItem(product.id, {name: product.name});
  } else if (key === 'qty') {
    const qty = Math.max(0, Number(el.value) || 0);
    product.qty = qty;
    const fields = {qty};
    const raw = rawColors(product);
    if (raw.length) {
      const unit = raw.reduce((sum, color) => sum + Math.max(0, Number(color?.grams) || 0), 0);
      product.grams = Math.round(unit * qty * 100) / 100;
      fields.grams = product.grams;
    }
    writeProductItem(product.id, fields);
  } else if (key === 'grams') {
    const grams = Math.max(0, Number(el.value) || 0);
    product.grams = grams;
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
      state.products = state.products.filter(item=>String(item.id)!==String(product.id));
      renderProducts(); renderSales();
      productsRef.child(product.id).remove().catch(error=>cloudError(error,'ürün silme'));
      toast('Ürün buluttan silindi.');
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
    sales=sales.filter(s=>String(s.id)!==button.dataset.saleDelete);
    renderSales();
    salesRef.child(button.dataset.saleDelete).remove().catch(error=>cloudError(error,'satış silme'));
    toast('Satış kaydı buluttan silindi.');
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
$('stockForm').addEventListener('submit',saveStockEntry);
$('saleProduct').addEventListener('change',()=>{const p=productById($('saleProduct').value); if(p && Number(p.sale)>0) $('salePrice').value=p.sale;});
$('salesPeriod').addEventListener('change',renderSales);
$('closeSaleDetail').addEventListener('click',()=>$('saleDetailModal').hidden=true);
$('saleDetailModal').addEventListener('click',event=>{if(event.target===$('saleDetailModal')) $('saleDetailModal').hidden=true;});
document.addEventListener('keydown',event=>{
  if (event.key !== 'Escape') return;
  if ($('photoLightbox') && !$('photoLightbox').hidden) return; // önce lightbox kapanır
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
    const stockKg = Number(filamentStock[color.name] || 0);
    return `<div class="color-edit-row">
      <span class="color-dot" style="background:${colorSwatch(color.name)}"></span>
      <input class="color-name-input" list="productColorOptions" data-color-index="${index}" data-color-field="name" value="${esc(color.name)}" placeholder="Renk adı" aria-label="Renk adı" maxlength="24">
      <div class="input-wrap mini-input"><input type="number" min="0" step="0.1" data-color-index="${index}" data-color-field="grams" value="${Number(color.grams)}" aria-label="Adet başına gram"><b>g/adet</b></div>
      <div class="color-edit-meta">Toplam <strong>${fmt(color.grams*qty,1)} g</strong> · ${money(color.grams*qty*gramPrice)} · Stok: ${stockKg > 0 ? `${fmt(stockKg,2)} kg` : 'yok'}</div>
      <button class="delete-btn" type="button" data-color-delete="${index}" title="Rengi üründen kaldır" aria-label="Rengi üründen kaldır">×</button>
    </div>`;
  }).join('') : '<p class="empty-inline">Bu ürüne henüz renk tanımlanmadı. Aşağıdan renk adı ve gram ekleyebilirsin.</p>';
  const metaItems = [
    ['Adet', fmt(qty,0)],
    ['Baskı süresi', `${fmt(Number(product.hours)||0,1)} sa`],
    ['Birim maliyet', money(c.unit)],
    ['Satış fiyatı', money(product.sale)],
    ['Birim kâr', money(c.profit)],
    ['Toplam maliyet', money(c.total)]
  ];
  $('productDetailInfo').innerHTML = `
    <div class="detail-grid product-detail-meta">${metaItems.map(([label,value])=>`<div class="detail-item"><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>`).join('')}</div>
    <h3 class="detail-section-title">Kullanılan renkler ve filament</h3>
    <div class="color-edit-list">${colorRowsHtml}</div>
    <div class="color-add-row">
      <input id="detailNewColor" list="productColorOptions" placeholder="Renk adı" maxlength="24" autocomplete="off" aria-label="Yeni renk adı">
      <div class="input-wrap mini-input"><input id="detailNewGrams" type="number" min="0" step="0.1" placeholder="Gram" aria-label="Yeni rengin adet başına gramı"><b>g/adet</b></div>
      <button class="btn btn-primary" type="button" data-detail-add-color>＋ Renk ekle</button>
    </div>
    <datalist id="productColorOptions">${colorOptions.map(name=>`<option value="${esc(name)}"></option>`).join('')}</datalist>
    <div class="detail-total"><span>Toplam filament<strong>${fmt(totalUnitGrams*qty,1)} g</strong></span><span>Filament maliyeti<strong>${money(c.filament*qty)}</strong></span><span>Renk çeşidi<strong>${fmt(colors.length,0)}</strong></span></div>`;
  const photoEl = $('productDetailPhoto');
  photoEl.innerHTML = product.photo
    ? `<button class="detail-photo-btn" type="button" data-detail-photo-open aria-label="Fotoğrafı büyüt" title="Büyütmek için tıkla"><img src="${product.photo}" alt="${esc(product.name||'Ürün')} fotoğrafı"><span class="detail-photo-hint">Büyüt ⤢</span></button>`
    : '<div class="detail-photo-empty">Fotoğraf yok</div>';
  photoEl.innerHTML += '<label class="photo-upload detail-photo-upload">Fotoğraf seç<input type="file" accept="image/*" data-detail-photo-upload aria-label="Ürün fotoğrafı yükle"></label>';
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
  const grams = Math.max(0, Number(gramsInput?.value) || 0);
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
  else colors[index].grams = Math.max(0, Number(value) || 0);
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
    updateDetailColor(Number(colorInput.dataset.colorIndex), colorInput.dataset.colorField, colorInput.value);
  });
}

/* ---------- Renk stoğu tablosu olayları ---------- */
if ($('colorStockRows')) {
  $('colorStockRows').addEventListener('change', event => {
    const input = event.target.closest('input[data-color-stock]');
    if (!input) return;
    const color = input.dataset.colorStock;
    const kg = Math.max(0, Number(input.value) || 0);
    filamentStock[color] = kg;
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
const THEMES = { dark:'#09090b', light:'#f4f5f7', midnight:'#050b1a', olive:'#0b0e08', carbon:'#070707', indigo:'#0d0f18' };
function prefGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function prefSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* gizli mod vb. */ } }
function prefDel(key) { try { localStorage.removeItem(key); } catch (e) { /* yoksay */ } }

/* ---------- Tema ---------- */
function applyTheme(name, animate) {
  const theme = THEMES[name] ? name : 'dark';
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-anim');
    setTimeout(() => root.classList.remove('theme-anim'), 350);
  }
  root.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEMES[theme]);
  document.querySelectorAll('[data-theme-choice]').forEach(btn =>
    btn.setAttribute('aria-checked', String(btn.dataset.themeChoice === theme)));
  prefSet('pc_theme', theme);
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
    btn.addEventListener('click', () => { applyTheme(btn.dataset.themeChoice, true); setThemeMenu(false); $('themeToggle').focus(); }));
  document.addEventListener('click', event => {
    if ($('themeMenu').hidden) return;
    if (!event.target.closest('#themeMenu') && !event.target.closest('#themeToggle')) setThemeMenu(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('themeMenu').hidden) { setThemeMenu(false); $('themeToggle').focus(); }
  });
}

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
function initUi() { initThemeBar(); initSidebarToggle(); initLoginForm(); }

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
showPage(['production','sales','inventory','analysis'].includes(initialPage) ? initialPage : 'production');
