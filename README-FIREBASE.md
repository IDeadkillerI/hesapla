# PrintCost — Firebase Bulut Mimarisi

Bu proje artık **Excel, CSV ve tarayıcı `localStorage` kullanmıyor**. Tüm kalıcı veriler
Google Firebase Realtime Database üzerinde tutulur. Sayfa hangi cihazdan veya hangi
internet ağından açılırsa açılsın, `onValue` dinleyicileri buluttaki en güncel veriyi
anlık olarak ekrana getirir.

## 1. Firebase projesi kurulumu

1. <https://console.firebase.google.com> adresinde **Add project** ile yeni proje oluştur.
2. **Build → Realtime Database → Create Database**.
   - Konum seç (ör. `europe-west1`).
   - Başlangıç için **Start in test mode** seç.
3. **Project settings (⚙) → Your apps → Web (`</>`)** ile bir web uygulaması ekle.
   SDK config değerlerini kopyala.
4. `firebase-config.js` dosyasını aç ve şu alanları doldur:

```js
window.FIREBASE_CONFIG = {
  apiKey: "...",
  databaseURL: "https://PROJE_ID-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "...",
  // diğer alanlar opsiyonel
};
```

`databaseURL` değeri Realtime Database ekranının üst kısmında görünen URL'dir.
Dosya doldurulmadan arayüz açılır ama üstte "Firebase yapılandırması gerekli"
uyarısı görünür ve hiçbir veri kaydedilmez.

> İpucu: `index.html` dosyasını doğrudan çift tıklayarak da açabilirsin, ancak
> tarayıcı güvenlik politikaları nedeniyle yerel bir sunucu kullanmak daha
> sorunsuzdur: `python -m http.server 8080` veya VS Code "Live Server".

## 2. Veri modeli

Kök düğüm: `printcost`

```text
printcost/
├── params/
│   ├── filamentPrice, standGrams, lighterCost,
│   ├── targetUnits, wasteRate, printerPower,
│   ├── energyPrice, printerPrice, printerLifeHours, wearCost,
│   └── minStockKg
├── filamentStock/
│   └── {renkAdı}: kilogram (örn. "Siyah": 1.25)
├── products/{pushId}/
│   ├── name, qty, grams, hours, sale, usesLighter, photo (Base64 Data URL),
│   ├── colors/ [{ name, grams }]  (renk başına adet gramı)
│   └── createdAt
├── sales/{pushId}/
│   ├── date, productId, productName, qty, unitPrice, unitCost,
│   ├── revenue, totalCost, profit, note, createdAt, costSnapshot
│   └── (paket satışı) type:"package", items[{productId, name, qty, unitCost, lineCost, unitListPrice}], unitsTotal
└── costHistory/{pushId}/
    └── date, key, label, oldValue, newValue, source, note
```

- Filament stoğu renk adına göre ayrı anahtarlarda saklanır. Envanter sayfasından
  renk ve kilogram girilerek eklenir, satır içindeki alandan güncellenir.
- Ürünün `colors` dizisi, her renkten adet başına kaç gram kullanıldığını tutar.
  Ürün detay modalında renk eklenip çıkarılabilir; toplam gram otomatik güncellenir.
- Parametre değişiklikleri `update()` ile ilgili alanlara yazılır.
- Ürün ekleme/silme `push()` / `remove()` ile yapılır.
- Her yazma sonrası `onValue` dinleyicisi tüm açık sekmeleri günceller. Realtime Database Web SDK, sekme açık kaldığı sürece çevrimdışı yazmaları bellekte kuyruğa alır ve bağlantı gelince otomatik tekrar gönderir. Bu kuyruk sekme kapatılır/yenilenirse diskte saklanmaz; Web SDK'da Android/iOS'taki `setPersistenceEnabled()` API'si yoktur. Satışlar stok düşümü ve satış kaydını tek Realtime Database transaction'ında yazar.
- Ürün fotoğrafları istemci tarafında 640 px sınırında küçültülür, WebP (desteklenmiyorsa JPEG/PNG) olarak optimize edilir ve `FileReader` + canvas ile Base64 Data URL'e dönüştürülür. Sonuç doğrudan `products/{pushId}/photo` alanında metin olarak saklanır; Firebase Storage kullanılmaz. Fotoğraf veritabanı yazma sınırını aşmasın diye Base64 uzunluğu kontrol edilir.


## 2.1 Kurumsal stok, fotoğraf ve oturum ayarları

- Tekli ve paket satışları, renk bazlı filament stoğunu önce kontrol eder. Yetersiz stokta satış kaydı oluşturulmaz; stok ve satış aynı veritabanı transaction'ında güncellenir. Renksiz ürünler mevcut renk stoklarından sırayla düşülür.
- Üretim adet/gramaj değişiklikleri stok yetersiz olsa bile kaydedilir; ürün listesinde "Stokta Yok / 0 Adet" veya "Kısmi stok" rozetiyle uyarılır. Stok kontrolü yalnızca satış kaydında uygulanır. Sayısal alanlar boş, NaN, negatif veya tanımlı sınırların dışındaysa kaydedilmez ve Toast gösterilir.
- Ürün/satış silme işlemleri 5 saniye geciktirilir; bu sürede Geri Al ile kayıt eski anahtarına geri yüklenebilir. Ürün tablosunda toplu silme ve yüzde bazlı satış fiyatı artırma; satış geçmişinde toplu silme bulunur. Tarihsel satış fiyatları muhasebe tutarlılığı için toplu zamdan etkilenmez.
- Firebase Storage entegrasyonu tamamen kaldırılmıştır; `firebase-storage-compat.js` yüklenmez ve Storage kuralları gerekmez. Fotoğraf yükleme `FileReader` ile okunur, canvas üzerinde en fazla 640 px'e küçültülür ve Base64 Data URL olarak Realtime Database'e yazılır. Veritabanı kurallarında `products` düğümüne yazma izni verilmesi yeterlidir.
- Uygulama sekmesi arka planda 5 dakika veya daha uzun kaldıktan sonra tekrar görünür olduğunda oturum kapatılır. Bağlantı kesikken ürün/parametre gibi normal yazmalar sekme açık kaldığı sürece Firebase Web SDK kuyruğunda tutulur; stok transaction'ı gerektiren satışlar stok güvenliği için çevrimdışıyken engellenir.
- 768 px altındaki ekranlarda ürün, satış ve envanter tabloları etiketli kart düzenine geçer.

## 3. Güvenlik kuralları

Test modu 30 gün sonra kapanır ve varsayılan olarak herkese açıktır. Canlı kullanımda
**Realtime Database → Rules** ekranında en azından şu yapıyı kullan:

```json
{
  "rules": {
    "printcost": {
      ".read": "auth != null",
      ".write": "auth != null"
    }
  }
}
```

Web tarafında Firebase Authentication eklemek istersen `firebase-auth-compat.js`
dosyasını da yükleyip `signInWithEmailAndPassword` ile oturum açman gerekir.
Test modundayken kimlik doğrulama olmadan da okuma/yazma çalışır.

## 4. Eski veriler hakkında

Bu sürümde `localStorage` tamamen kaldırıldı. Daha önce tarayıcıda tutulan ürün, satış ve
fiyat geçmişi otomatik olarak Firebase'e taşınmaz. İstersen eski kayıtları Firebase
konsolunda **Realtime Database → Import JSON** ile içe aktarabilirsin; ancak veri modeli
`products` ve `sales` düğümleri altında nesne (push ID) yapısında olmalıdır.

`Excel_Sablon_Ornek.xlsx` dosyası artık hiçbir kod tarafından kullanılmıyor; istersen silebilirsin.

## 5. Giriş (login), tema ve kenar çubuğu

- **Giriş:** Uygulama açılışta giriş ekranı gösterir. Hesaplar `printcost/auth/users/{eposta}`
  altında `{ email, passHash, createdAt }` olarak tutulur; `passHash`, e-posta ile tuzlanmış
  SHA-256 özetidir (şifre düz metin saklanmaz). Veritabanında hesap yoksa, kurulum hesabı
  (`uretken3d@gmail.com`) ilk doğru girişte otomatik oluşturulur. Veri dinleyicileri
  yalnızca giriş doğrulandıktan sonra bağlanır. Oturum tarayıcıda `pc_session` anahtarında
  tutulur ve her açılışta veritabanıyla yeniden doğrulanır; sağ üstteki çıkış düğmesi siler.
  Yeni kullanıcı eklemek için Firebase konsolunda aynı yapıda bir düğüm oluştur
  (`passHash` = `SHA-256("printcost::" + eposta + "::" + şifre)`, eposta küçük harf).
- **Tema:** Sağ üstteki palet düğmesi altı seçenek sunar: Koyu, Açık, Gece mavisi ve renk paletleri
  Mat zeytin, Karbon & neon turuncu, Slate & indigo. Seçim `pc_theme` anahtarında saklanır ve
  `<html data-theme>` ile uygulanır. Yeni palet eklemek için `style.css` sonundaki bir
  `:root[data-theme="..."]` bloğunu kopyalayıp değişkenleri değiştirmek yeterlidir.
- **Kenar çubuğu:** Sol üstteki düğme paneli açar/kapatır; durum `pc_sidebar` anahtarında saklanır.

> **Güvenlik notu:** İstemci tarafı doğrulama, kuralların herkese açık olduğu (test modu)
> bir veritabanında gerçek koruma sağlamaz; veritabanı adresini bilen biri doğrudan okuyabilir.
> Gerçek erişim denetimi için Firebase Authentication'a geçip yukarıdaki kuralları
> `auth != null` olarak uygula.

## 6. Bildirimler ve grafik animasyonları

- **Bildirimler:** Tüm geri bildirimler `toast()` ile sağ alt köşedeki cam efektli yığında gösterilir
  (başarı / uyarı / hata / bilgi; otomatik kapanır, üzerine gelince durur). Silme onayları
  tarayıcının `confirm()` penceresi yerine `confirmDialog()` ile site içi pencerede sorulur.
  Kodda `alert`, `confirm` veya `Notification` kullanılmaz.
- **Grafikler:** Maliyet dağılımı donut'u saat yönünde dolar, çubuklar sıfırdan büyür; enflasyon
  fiyat çubukları aşağıdan yukarı açılır. Animasyon sayfaya her girişte ve veri değiştiğinde
  çalışır; aynı veri tekrar gelirse yeniden oynatılmaz. `prefers-reduced-motion` açıkken animasyon atlanır.

## 7. Şeffaf fotoğraflar, Glass teması, satış grafikleri ve paket satış

- **Şeffaf ürün fotoğrafları:** Fotoğraf yüklenirken düz renkli (stüdyo/beyaz) arka plan köşelerden
  taranarak silinir ve görsel alfa kanallı PNG olarak kaydedilir. Köşe renkleri tutarsızsa, görsel
  zaten şeffafsa veya silinecek alan mantıksızsa fotoğrafa dokunulmaz. Eski fotoğraflar için ürün
  detay penceresindeki **Arka planı şeffaflaştır** düğmesi kullanılır. Çerçeve ve dikdörtgen zemin
  kaldırıldığı için görsel her temanın üzerinde yüzer; gölge ürünün siluetini izler.
- **Glass teması:** Tema menüsünde **Glass** seçeneği. Sabit, hafif bulanık ve yavaşça kayan renk
  akışı arka planı; `backdrop-filter: blur()` ile yarı saydam paneller; ince parlak kenarlıklar.
  Arka plan görselini değiştirmek için `style.css` içindeki `--glass-image` değişkenine kendi
  `url(...)` veya gradient değerini ver. `prefers-reduced-motion` açıkken kayma animasyonu durur.
- **Satış grafikleri:** Satış Kayıtları sayfasında Çubuk/Çizgi ve Günlük (son 14 gün) / Haftalık
  (son 12 hafta, Pazartesi başlangıçlı) / Aylık (son 12 ay) filtreleri. Ciro ve net kâr serileri
  ayrı ayrı açılıp kapatılabilir; üzerine gelince ciro, maliyet, kâr ve adet gösterilir. Filtre veya
  veri değişince değerler akıcı geçişle güncellenir, sayfaya her girişte grafik sıfırdan büyür.
  Grafik ek bir kütüphane kullanmaz (saf SVG).
- **Paket satışı:** **Paket Satış Ekle** sekmesinde ürünler, adetleri, paket adedi ve paket satış
  fiyatı girilir. Paket maliyeti, ürünlerin o anki birim maliyetlerinin adetle çarpılıp toplanmasıyla,
  net kâr da *paket fiyatı − paket maliyeti* olarak otomatik hesaplanır. Kayıt, normal satışla aynı
  alanları (`revenue`, `totalCost`, `profit`) taşıdığı için ciro/kâr kartlarına, dönem özetine ve
  grafiklere kendiliğinden dahil olur; listede **Paket** etiketiyle ve içerik özetiyle görünür.
  "Satış adedi" paketlerde içerdeki toplam ürün adedini sayar. Maliyetler satış anında kaydedildiği
  için ürün fiyatları sonradan değişse de geçmiş kâr değişmez.
