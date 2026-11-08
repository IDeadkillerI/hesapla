'use strict';
const $ = id => document.getElementById(id);

/* =========================================================
 * BULUT MİMARİSİ
 * Tüm kalıcı veriler Firebase Realtime Database üzerinde tutulur.
 * Yerel dosya veya tarayıcı hafızası kullanılmaz.
 * Veri yolu: printcost/{params|products|sales|costHistory|device}
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
}
document.querySelectorAll('.sidebar nav a[data-page]').forEach(link => {
  link.addEventListener('click', event => {
    event.preventDefault();
    showPage(link.dataset.page);
    history.replaceState(null, '', `#${link.dataset.page}`);
  });
});

const inputIds = ['filamentPrice','standGrams','lighterCost','targetUnits','wasteRate','printerPower','energyPrice','printerPrice','printerLifeHours','wearCost'];
const stockInputIds = ['filamentStockKg','minStockKg'];
const defaults = {
  filamentPrice:700, standGrams:210, lighterCost:400, targetUnits:48,
  wasteRate:8, printerPower:120, energyPrice:2.6, printerPrice:18000, printerLifeHours:5000, wearCost:1.5,
  filamentStockKg:0, minStockKg:2
};
const clone = value => JSON.parse(JSON.stringify(value));
let state = {...clone(defaults), products: []};
let sales = [];
let costHistory = [];
let deviceState = {};
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
let deviceRef = null;

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
    return;
  }
  if (typeof firebase === 'undefined') {
    setCloudStatus('error', 'Firebase SDK yüklenemedi', 'İnternet bağlantısını kontrol edip sayfayı yenile.');
    toast('Firebase SDK yüklenemedi. İnternet bağlantısını kontrol et.');
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
    deviceRef = rootRef.child('device');
    cloudReady = true;
    const banner = $('cloudBanner');
    if (banner) banner.hidden = true;
    attachCloudListeners();
  } catch (error) {
    cloudReady = false;
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
    [...inputIds, ...stockInputIds].forEach(key => {
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

  // ESP32 cihaz durumu, telemetrisi ve kontrol düğümleri
  deviceRef.on('value', snap => {
    deviceState = snap.val() || {};
    renderDevice();
  }, error => cloudError(error, 'cihaz verisini okuma'));
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
function writeDeviceControl(fields) {
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan cihaz kontrol edilemez.'); return; }
  deviceRef.child('control').update({...fields, updatedAt: Date.now()})
    .catch(error => cloudError(error, 'cihaz komutu'));
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
  // Filament ve stand gram üzerinden; süreye bağlı giderler adet başına düşen baskı süresi üzerinden.
  const filament = qty > 0 ? (grams/qty)*gramPrice : 0;
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
  return {gram:qty>0?grams/qty:0,hours,filament,electric,stand,machine,wear,fire,lighter,unit,profit,total:unit*qty,totalProfit:profit*qty};
}
function syncInputs() {
  inputIds.forEach(id => { if ($(id)) $(id).value = state[id] ?? defaults[id]; });
  stockInputIds.forEach(id => { if ($(id)) $(id).value = state[id] ?? defaults[id]; });
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
function toast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}
function productById(id) {
  return state.products.find(product => String(product.id) === String(id));
}
// Depodaki filamentle basılabilecek adet ve plan ihtiyacı (fire dahil).
function stockCalc(x=params()) {
  const waste = 1 + Math.min(90,Math.max(0,x.wasteRate))/100;
  const stockKg = Math.max(0, Number(state.filamentStockKg)||0);
  const items = state.products.map(p => {
    const qty = Math.max(0,Number(p.qty)||0);
    const grams = Math.max(0,Number(p.grams)||0);
    const gpu = qty>0 ? grams/qty : 0;
    const standGpu = qty>0 ? x.standGrams/qty : 0;
    const effGpu = (gpu+standGpu)*waste;
    const producible = effGpu>0 ? Math.floor(stockKg*1000/effGpu) : 0;
    const plannedKg = (grams+x.standGrams)*waste/1000;
    return {p,qty,grams,gpu,standGpu,effGpu,producible,plannedKg,shortfall:Math.max(0,qty-producible)};
  });
  const neededKg = items.reduce((sum,item)=>sum+item.plannedKg,0);
  return {stockKg,neededKg,remaining:stockKg-neededKg,items,minStockKg:Math.max(0,Number(state.minStockKg)||0),waste};
}
function renderProducts() {
  const x = params();
  const rates = hourlyRates(x);
  const stock = stockCalc(x);
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
    const stockItem = stock.items.find(item => item.p.id === p.id);
    const producible = stockItem ? stockItem.producible : 0;
    const stockClass = stockItem && stockItem.shortfall>0 ? 'stock-short' : 'stock-ok';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="photo-cell"><div class="product-photo-wrap">${p.photo ? `<button class="product-photo-btn" type="button" data-photo-open="${esc(p.id)}" aria-label="${esc(p.name)} fotoğrafını büyüt" title="Büyütmek için tıkla"><img class="product-photo" src="${p.photo}" alt="${esc(p.name)} fotoğrafı" loading="lazy"><span class="photo-zoom-hint" aria-hidden="true">⤢</span></button>` : '<div class="photo-placeholder">Fotoğraf<br>yok</div>'}<label class="photo-upload">Fotoğraf seç<input type="file" accept="image/*" data-photo-id="${esc(p.id)}" aria-label="${esc(p.name)} fotoğrafı yükle"></label></div></td>
      <td><input class="name-input" aria-label="Ürün adı" data-pid="${esc(p.id)}" data-k="name" value="${esc(p.name)}"></td>
      <td><input type="number" min="0" step="1" aria-label="Adet" data-pid="${esc(p.id)}" data-k="qty" value="${Number(p.qty)||0}"></td>
      <td><input type="number" min="0" step="0.1" aria-label="Toplam gram" data-pid="${esc(p.id)}" data-k="grams" value="${Number(p.grams)||0}"></td>
      <td><input type="number" min="0" step="0.1" aria-label="Baskı süresi saat" data-pid="${esc(p.id)}" data-k="hours" value="${Number(p.hours)||0}" placeholder="Saat"></td>
      <td>${fmt(c.gram)} g</td><td>${money(c.filament)}</td><td title="(Baskı süresi ÷ adet) × yazıcı gücü (kW) × kWh fiyatı">${money(c.electric)}</td><td>${money(c.stand)}</td><td title="(Baskı süresi ÷ adet) × (yazıcı bedeli ÷ ömür)">${money(c.machine)}</td><td title="(Baskı süresi ÷ adet) × saatlik bakım fonu (nozzle, PTFE, PEI, dişli, fan)">${money(c.wear)}</td><td title="Fire oranı: %${fmt(x.wasteRate,1)}">${money(c.fire)}</td><td>${money(c.lighter)}</td><td class="money">${money(c.unit)}</td>
      <td><input class="sale-input" type="number" min="0" step="0.01" aria-label="Satış fiyatı" data-pid="${esc(p.id)}" data-k="sale" value="${Number(p.sale)||0}"></td>
      <td class="${c.profit>=0?'profit-positive':'profit-negative'}">${money(c.profit)}</td>
      <td class="stock-cell ${stockClass}" title="${producible} adet üretilebilir; plan ${fmt(Number(p.qty)||0,0)} adet">${producible} adet</td>
      <td class="money">${money(c.total)}</td>
      <td><button class="delete-btn" data-delete="${esc(p.id)}" title="Ürünü sil" aria-label="Ürünü sil">×</button></td>`;
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
  $('costGrandTotal').textContent = money(totalCost);
  $('costDonut').style.background = totalCost>0 ? `conic-gradient(${gradient.join(',')})` : '#eceef4';
  $('costBreakdown').innerHTML = costs.map(([name,value],index)=>{
    const pct = totalCost>0 ? value/totalCost*100 : 0;
    return `<div class="break-row"><span class="break-name"><i style="background:${palette[index]}"></i>${name}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(0,pct)}%;background:${palette[index]}"></div></div><span class="break-value">${money(value)} <small>%${fmt(pct,1)}</small></span></div>`;
  }).join('');
  renderSaleProductOptions();
  renderInventory();
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
  $('stockTag').textContent = stock.stockKg >= stock.neededKg && stock.stockKg > 0 ? 'Stok yeterli' : 'Stok uyarısı';

  // --- Uyarı listesi ---
  const alerts = [];
  if (stock.stockKg <= 0) alerts.push(['danger','Depoda filament görünmüyor. Envanter sayfasından stok girişi yap.']);
  else if (stock.minStockKg > 0 && stock.stockKg < stock.minStockKg) alerts.push(['danger',`Kritik stok: ${fmt(stock.stockKg,2)} kg, belirlediğin ${fmt(stock.minStockKg,2)} kg eşiğinin altında.`]);
  if (stock.stockKg > 0 && stock.neededKg > stock.stockKg) alerts.push(['danger',`Planı tamamlamak için ${fmt(stock.neededKg-stock.stockKg,2)} kg filament eksik.`]);
  stock.items.filter(item=>item.shortfall>0 && item.gpu>0).forEach(item=>{
    alerts.push(['warn',`"${item.p.name || 'İsimsiz ürün'}" için stok ${fmt(item.producible,0)} adede yetiyor; plan ${fmt(item.qty,0)} adet. Yaklaşık ${fmt((item.shortfall*item.effGpu)/1000,2)} kg daha gerekiyor.`]);
  });
  if (!alerts.length) alerts.push(['ok','Stok, mevcut üretim planını karşılamaya yeterli görünüyor.']);
  $('stockAlerts').innerHTML = alerts.map(([type,text])=>`<div class="alert-item ${type}"><span class="alert-dot"></span><p>${esc(text)}</p></div>`).join('');

  // --- Stok tablosu ---
  $('stockRows').innerHTML = stock.items.map(item=>`<tr>
    <td>${esc(item.p.name || 'İsimsiz ürün')}</td>
    <td>${fmt(item.gpu)} g</td>
    <td>${fmt(item.effGpu)} g</td>
    <td>${fmt(item.qty,0)}</td>
    <td class="${item.shortfall>0?'stock-short':'stock-ok'}">${fmt(item.producible,0)} adet</td>
    <td>${fmt(item.plannedKg,2)} kg</td>
    <td>${item.gpu<=0 ? '<span class="status-pill neutral">Gram girilmedi</span>' : item.shortfall>0 ? `<span class="status-pill danger">${fmt(item.shortfall,0)} adet eksik</span>` : '<span class="status-pill ok">Yeterli</span>'}</td>
  </tr>`).join('');
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
  $('priceBars').innerHTML = series.map(s=>`<div class="price-bar${s.current?' current':''}" title="${s.label}: ${money(s.price)}"><span class="price-bar-fill" style="height:${Math.max(6,(s.price/maxPrice)*100)}%"></span><small>${esc(s.label)}</small></div>`).join('');

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
  const kg = Math.max(0, num('stockAddKg'));
  const price = Math.max(0, num('stockAddPrice'));
  const dateValue = $('stockAddDate').value || todayISO();
  if (!kg) { toast('Eklemek için en az 0,01 kg girmelisin.'); return; }
  const previous = params().filamentPrice;
  const newStock = Math.round(((Number(state.filamentStockKg)||0)+kg)*1000)/1000;
  const priceChanged = price > 0 && Math.abs(price-previous) > 0.001;
  const updates = {};
  updates['params/filamentStockKg'] = newStock;
  if (priceChanged) updates['params/filamentPrice'] = price;
  let historyEntry = null;
  if (priceChanged) {
    const stamp = new Date(`${dateValue}T12:00:00`);
    const historyKey = historyRef.push().key;
    historyEntry = {
      id:historyKey, date:Number.isNaN(stamp.getTime())?new Date().toISOString():stamp.toISOString(),
      key:'filamentPrice', label:'Filament fiyatı (TL/kg)', oldValue:previous, newValue:price,
      source:'Alım kaydı', note:`${fmt(kg,2)} kg filament alımı`
    };
    updates[`costHistory/${historyKey}`] = historyEntry;
  }
  rootRef.update(updates)
    .then(() => {
      state.filamentStockKg = newStock;
      $('filamentStockKg').value = newStock;
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
        ? `Stoğa ${fmt(kg,2)} kg eklendi. Yeni fiyat ${money(price)} / kg buluta işlendi.`
        : `Stoğa ${fmt(kg,2)} kg filament eklendi.`);
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
  $('statProfit').textContent = money(profit);
  $('statProfitCaption').textContent = $('salesPeriod').selectedOptions[0]?.textContent || 'Seçili satış dönemine göre';
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
    product: { id: product.id, name: product.name || 'İsimsiz ürün', qty: Number(product.qty)||0, grams: Number(product.grams)||0, hours: Number(product.hours)||0, usesLighter: Boolean(product.usesLighter), photo: product.photo || '' },
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
$('productRows').addEventListener('change',event=>{
  const fileInput = event.target.closest('input[data-photo-id]');
  if (fileInput) {
    if (!cloudReady) { toast('Bulut bağlantısı kurulmadan fotoğraf yüklenemez.'); return; }
    const file = fileInput.files && fileInput.files[0];
    const id = fileInput.dataset.photoId;
    const product = productById(id);
    if (!file || !product) return;
    if (!file.type.startsWith('image/')) { toast('Lütfen bir fotoğraf dosyası seç.'); return; }
    if (file.size > 12*1024*1024) { toast('Fotoğraf en fazla 12 MB olabilir.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxSide = 480;
        const scale = Math.min(1,maxSide/Math.max(img.width,img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1,Math.round(img.width*scale));
        canvas.height = Math.max(1,Math.round(img.height*scale));
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        // PNG olarak kaydet: alfa kanalı korunur, şeffaf alanlar siyaha dönüşmez.
        const dataUrl = canvas.toDataURL('image/png');
        if (dataUrl.length > 1500000) { toast('Fotoğraf bulut kaydı için çok büyük. Daha küçük bir görsel seç.'); return; }
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
    return;
  }
  const el=event.target; if (!el.dataset.pid || !el.dataset.k) return;
  const product=productById(el.dataset.pid); if(!product)return;
  const key=el.dataset.k; product[key]=key==='name'?el.value:Math.max(0,Number(el.value)||0);
  writeProductItem(product.id,{[key]:product[key]});
  renderProducts(); renderSales();
});
$('productRows').addEventListener('click',event=>{
  const photoButton=event.target.closest('[data-photo-open]');
  if(photoButton){openLightbox(photoButton.dataset.photoOpen,photoButton);return;}
  const button=event.target.closest('[data-delete]'); if(!button)return;
  const product=productById(button.dataset.delete); if(!product)return;
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan ürün silinemez.'); return; }
  if(confirm(`"${product.name||'Ürün'}" ürününü silmek istiyor musun? Satış geçmişindeki kayıtlar korunur.`)){
    state.products = state.products.filter(item=>String(item.id)!==String(product.id));
    renderProducts(); renderSales();
    productsRef.child(product.id).remove().catch(error=>cloudError(error,'ürün silme'));
    toast('Ürün buluttan silindi.');
  }
});
$('salesRows').addEventListener('click',event=>{
  const detailButton=event.target.closest('[data-sale-detail]');
  if(detailButton){showSaleDetails(detailButton.dataset.saleDetail);return;}
  const button=event.target.closest('[data-sale-delete]'); if(!button)return;
  const record=sales.find(s=>String(s.id)===button.dataset.saleDelete);
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan satış silinemez.'); return; }
  if(confirm(`${record?.productName||'Bu'} satış kaydını silmek istiyor musun?`)){
    sales=sales.filter(s=>String(s.id)!==button.dataset.saleDelete);
    renderSales();
    salesRef.child(button.dataset.saleDelete).remove().catch(error=>cloudError(error,'satış silme'));
    toast('Satış kaydı buluttan silindi.');
  }
});
$('costHistoryRows').addEventListener('click',event=>{
  const button=event.target.closest('[data-history-delete]');
  if(!button) return;
  const id=button.dataset.historyDelete;
  const item=costHistory.find(entry=>String(entry.id)===String(id));
  if(!item) return;
  if (!cloudReady) { toast('Bulut bağlantısı kurulmadan kayıt silinemez.'); return; }
  if(confirm(`${item.label} değişim kaydını silmek istiyor musun? Bu işlem geri alınamaz.`)){
    costHistory=costHistory.filter(entry=>String(entry.id)!==String(id));
    renderCostHistory(); renderInventory();
    historyRef.child(id).remove().catch(error=>cloudError(error,'fiyat geçmişi silme'));
    toast('Maliyet değişim kaydı buluttan silindi.');
  }
});
$('saleForm').addEventListener('submit',saveSale);
$('stockForm').addEventListener('submit',saveStockEntry);
$('saleProduct').addEventListener('change',()=>{const p=productById($('saleProduct').value); if(p && Number(p.sale)>0) $('salePrice').value=p.sale;});
$('salesPeriod').addEventListener('change',renderSales);
$('closeSaleDetail').addEventListener('click',()=>$('saleDetailModal').hidden=true);
$('saleDetailModal').addEventListener('click',event=>{if(event.target===$('saleDetailModal')) $('saleDetailModal').hidden=true;});
document.addEventListener('keydown',event=>{if(event.key==='Escape') $('saleDetailModal').hidden=true;});
$('addProduct').addEventListener('click',addProduct); $('addProductTop').addEventListener('click',addProduct);
$('searchInput').addEventListener('input',renderProducts);
$('saleDate').value=todayISO();
if ($('stockAddDate')) $('stockAddDate').value=todayISO();
if ($('stockAddPrice')) $('stockAddPrice').value=state.filamentPrice ?? defaults.filamentPrice;
window.addEventListener('beforeunload',()=>{ if (pendingWriteCount()) flushParamWrites(); });

/* =========================================================
 * ESP32 CİHAZ SAYFASI
 * ========================================================= */
function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} sa ${m} dk`;
  if (m > 0) return `${m} dk ${s} sn`;
  return `${s} sn`;
}
function renderDevice() {
  if (!$('deviceStatusValue')) return;
  const status = deviceState.status || {};
  const telemetry = deviceState.telemetry || {};
  const control = deviceState.control || {};
  const lastSeen = Number(status.lastSeen) || Number(telemetry.updatedAt) || 0;
  const online = lastSeen > 0 && (Date.now() - lastSeen < 90000);
  $('deviceStatusValue').textContent = online ? 'Çevrimiçi' : (lastSeen ? 'Çevrimdışı' : 'Bekleniyor');
  $('deviceStatusValue').classList.toggle('is-good', online);
  $('deviceStatusValue').classList.toggle('is-bad', Boolean(lastSeen) && !online);
  const tag = $('deviceStatusTag');
  if (tag) {
    tag.textContent = online ? 'Cihaz bağlı' : 'Cihaz bekleniyor';
    tag.classList.toggle('tag-offline', !online);
  }
  $('deviceLastSeen').textContent = lastSeen
    ? `Son görülme: ${new Date(lastSeen).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`
    : 'Henüz veri yok';
  $('deviceIp').textContent = status.ip || '—';
  $('deviceFirmware').textContent = status.firmware || 'ESP32 · firmware bekleniyor';
  $('deviceRssi').textContent = Number.isFinite(Number(telemetry.rssi)) ? `${fmt(telemetry.rssi,0)}` : '—';
  $('deviceUptime').textContent = Number.isFinite(Number(telemetry.uptime)) ? formatUptime(telemetry.uptime) : '—';
  $('deviceTempValue').textContent = Number.isFinite(Number(telemetry.temperature)) ? fmt(telemetry.temperature,1) : '—';
  $('deviceHumidityValue').textContent = Number.isFinite(Number(telemetry.humidity)) ? fmt(telemetry.humidity,0) : '—';
  $('deviceFilamentValue').textContent = telemetry.filamentPresent === undefined ? '—' : (telemetry.filamentPresent ? 'Var' : 'Yok');
  $('deviceFilamentValue').classList.toggle('is-bad', telemetry.filamentPresent === false);
  $('deviceFilamentValue').classList.toggle('is-good', telemetry.filamentPresent === true);
  $('deviceTelemetryTime').textContent = Number.isFinite(Number(telemetry.updatedAt))
    ? new Date(Number(telemetry.updatedAt)).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'})
    : '—';
  const relay = Boolean(control.relay);
  const toggle = $('deviceRelayToggle');
  toggle.textContent = relay ? 'Açık' : 'Kapalı';
  toggle.classList.toggle('is-on', relay);
  toggle.setAttribute('aria-pressed', String(relay));
  $('deviceRelayHint').textContent = control.updatedAt
    ? `Son komut: ${new Date(Number(control.updatedAt)).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'})}`
    : 'Komut gönderilmedi';
  const tempEl = $('deviceTargetTemp');
  if (tempEl && document.activeElement !== tempEl) tempEl.value = Number.isFinite(Number(control.targetTemp)) ? Number(control.targetTemp) : 0;
}
if ($('deviceRelayToggle')) {
  $('deviceRelayToggle').addEventListener('click',()=>{
    const next = !Boolean((deviceState.control || {}).relay);
    writeDeviceControl({relay:next});
    toast(next ? 'Röle açma komutu buluta yazıldı.' : 'Röle kapatma komutu buluta yazıldı.');
  });
}
if ($('deviceTargetTemp')) {
  $('deviceTargetTemp').addEventListener('change',()=>{
    const value = Math.max(0, Math.min(300, Number($('deviceTargetTemp').value) || 0));
    $('deviceTargetTemp').value = value;
    writeDeviceControl({targetTemp:value});
    toast(`Hedef sıcaklık ${value} °C olarak buluta yazıldı.`);
  });
}
if ($('devicePingBtn')) {
  $('devicePingBtn').addEventListener('click',()=>{
    if (!cloudReady) { toast('Bulut bağlantısı kurulmadan ping gönderilemez.'); return; }
    deviceRef.child('command').set({action:'ping', requestedAt:Date.now(), nonce:Math.random().toString(36).slice(2,8)})
      .then(()=>toast('Ping komutu buluta yazıldı.'))
      .catch(error=>cloudError(error,'ping komutu'));
  });
}
setInterval(renderDevice, 30000);

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

/* ---------- Başlangıç ---------- */
syncInputs();
lastCommittedParams = clone(params());
renderProducts();
renderSales();
renderCostHistory();
renderInventory();
renderDevice();
initFirebase();
const initialPage = location.hash.slice(1);
showPage(['production','sales','inventory','device','analysis'].includes(initialPage) ? initialPage : 'production');
