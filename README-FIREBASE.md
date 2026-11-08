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
│   └── filamentStockKg, minStockKg
├── products/{pushId}/
│   ├── name, qty, grams, hours, sale, usesLighter, photo
│   └── createdAt
├── sales/{pushId}/
│   ├── date, productId, productName, qty, unitPrice, unitCost,
│   └── revenue, totalCost, profit, note, createdAt, costSnapshot
├── costHistory/{pushId}/
│   └── date, key, label, oldValue, newValue, source, note
└── device/
    ├── control/       relay (bool), targetTemp (int), updatedAt
    ├── telemetry/     temperature, humidity, filamentPresent, relay,
    │                  targetTemp, rssi, uptime, updatedAt
    ├── status/        online, ip, firmware, mac, lastSeen
    ├── command/       action, requestedAt, nonce
    └── commandResult/ action, result, handledAt
```

- Parametre değişiklikleri `update()` ile ilgili alanlara yazılır.
- Ürün ekleme/silme `push()` / `remove()` ile yapılır.
- Her yazma sonrası `onValue` dinleyicisi tüm açık sekmeleri günceller.
- Fotoğraflar 480 px PNG olarak ürün kaydında base64 saklanır. Çok sayıda fotoğraf
  kullanacaksan Firebase Storage'a taşımak daha uygundur (Realtime Database'de
  düğüm başına 10 MB sınırı vardır).

## 3. Güvenlik kuralları

Test modu 30 gün sonra kapanır ve varsayılan olarak herkese açıktır. Canlı kullanımda
**Realtime Database → Rules** ekranında en azından şu yapıyı kullan:

```json
{
  "rules": {
    "printcost": {
      ".read": "auth != null",
      ".write": "auth != null",
      "device": {
        "telemetry": { ".write": "auth != null" },
        "status":    { ".write": "auth != null" }
      }
    }
  }
}
```

Web tarafında Firebase Authentication eklemek istersen `firebase-auth-compat.js`
dosyasını da yükleyip `signInWithEmailAndPassword` ile oturum açman gerekir.
Test modundayken kimlik doğrulama olmadan da okuma/yazma çalışır.

## 4. ESP32 tarafı

Kod: `esp32/PrintCost_ESP32/PrintCost_ESP32.ino`

Arduino IDE'de gerekli kütüphaneler:

- **Firebase ESP Client** (mobizt) — Library Manager'dan kur.
- **DHT sensor library** + **Adafruit Unified Sensor** — yalnızca `USE_DHT 1` ise.

Sketch içindeki şu alanları doldur:

```cpp
#define WIFI_SSID     "..."
#define WIFI_PASSWORD "..."
#define API_KEY       "..."
#define DATABASE_URL  "https://PROJE_ID-default-rtdb.europe-west1.firebasedatabase.app"
#define USER_EMAIL    "..."
#define USER_PASSWORD "..."
```

Firebase konsolunda **Authentication → Sign-in method → Email/Password** etkinleştir ve
**Users → Add user** ile bir cihaz kullanıcısı oluştur. Aynı bilgileri sketch'e yaz.

Cihaz her 2 saniyede `device/control` düğümünü okur, her 5 saniyede telemetriyi yazar,
her 15 saniyede durum bilgisini ve `lastSeen` zaman damgasını günceller. Web arayüzü
"Cihaz / ESP32" sayfasında röle ve hedef sıcaklık komutlarını buluta yazar; cihaz bunları
bir sonraki döngüde alır.

### Donanım notları

- `RELAY_PIN` (varsayılan 26): genel dijital çıkış / röle.
- `FILAMENT_SENSOR_PIN` (varsayılan 27): `INPUT_PULLUP`, sensör LOW çektiğinde filament var.
- `DHT_PIN` (varsayılan 4): DHT22; kullanmak için `USE_DHT 1`.
- Röle çıkışı yüksek güçlü bir ısıtıcıyı doğrudan anahtarlamamalıdır. Uygun röle/kontaktör
  ve donanımsal güvenlik önlemleri kullan.

## 5. Eski veriler hakkında

Bu sürümde `localStorage` tamamen kaldırıldı. Daha önce tarayıcıda tutulan ürün, satış ve
fiyat geçmişi otomatik olarak Firebase'e taşınmaz. İstersen eski kayıtları Firebase
konsolunda **Realtime Database → Import JSON** ile içe aktarabilirsin; ancak veri modeli
`products` ve `sales` düğümleri altında nesne (push ID) yapısında olmalıdır.

`Excel_Sablon_Ornek.xlsx` dosyası artık hiçbir kod tarafından kullanılmıyor; istersen silebilirsin.
