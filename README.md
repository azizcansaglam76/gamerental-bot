# 🎮 GameRental WhatsApp Bot

Otomatik kiralama hatırlatıcısı, gecikme uyarısı ve Claude destekli akıllı cevap botu.

---

## ✅ Ne Yapıyor?

| Özellik | Detay |
|---|---|
| ⏰ Sabah 09:00 | Yarın süresi dolacaklara otomatik mesaj |
| 🚨 Her saat | Gecikmiş iadelere uyarı (günde 1 kez) |
| 👋 Yeni mesaj | Menü göster |
| *1* komutu | Kiralama durumunu göster |
| *2* komutu | Süre uzatma (onay + Firebase güncelle) |
| *3* komutu | İade bildirimi (onay + Firebase güncelle) |
| 🤖 Diğer mesajlar | Claude API ile akıllı cevap |

---

## 🚀 Kurulum (Adım Adım)

### 1. Firebase Service Account Key Al

1. https://console.firebase.google.com adresine git
2. Proje: **gamerental-fb121**
3. ⚙️ Proje Ayarları → **Hizmet Hesapları** sekmesi
4. **"Yeni özel anahtar oluştur"** butonuna tıkla
5. İnen JSON dosyasını `serviceAccountKey.json` olarak bu klasöre kaydet

### 2. Firebase UID'ni Bul

1. https://azizcansaglam76.github.io/gamerental adresini aç
2. Giriş yap
3. Tarayıcıda F12 → Console sekmesi
4. Şunu yaz: `firebase.auth().currentUser.uid`
5. Çıkan değeri kopyala → `.env` dosyasına `USER_UID=` kısmına yapıştır

### 3. Claude API Key Al

1. https://console.anthropic.com adresine git
2. Kayıt ol (ilk $5 ücretsiz — bu bot için aylarca yeter)
3. API Keys → Create Key
4. Kopyala → `.env` dosyasına `ANTHROPIC_API_KEY=` kısmına yapıştır

### 4. .env Dosyasını Oluştur

```bash
cp .env.example .env
# Sonra .env dosyasını açıp değerleri doldur
```

### 5. Lokal Test

```bash
npm install
node index.js
```

Terminalde QR kodu göreceksin → WhatsApp Business telefonunla tara → bağlandı!

---

## ☁️ Railway'e Deploy

### 1. Railway Hesabı Aç
https://railway.app → GitHub ile giriş yap (ücretsiz)

### 2. Yeni Proje Oluştur
- **New Project** → **Deploy from GitHub repo**
- Bu bot klasörünü GitHub'a push et, oradan seç

### 3. Ortam Değişkenlerini Ekle
Railway panelinde **Variables** sekmesi:
```
USER_UID          = (firebase uid)
ANTHROPIC_API_KEY = (sk-ant-...)
BENIM_NUMARAM     = 905xxxxxxxxx
```

### 4. serviceAccountKey.json Ekle
Railway **Files** sekmesinden ya da GitHub repo'ya ekle  
⚠️ `.gitignore`'a ekle, asla public repoya koyma!

### 5. İlk Çalıştırma — QR Kod Tarama
Railway loglarında QR kodu göreceksin:
- Railway → **Logs** sekmesi
- QR'ı WhatsApp Business telefonunla tara
- Bir kez taradıktan sonra oturum kaydedilir, tekrar taramana gerek kalmaz

---

## 📱 Müşteri Komutları

Müşteriler sana yazdığında:

```
merhaba / selam / menü  → Ana menü
1                        → Kiralama durumu
2                        → Süre uzatma
3                        → İade bildirimi
evet / tamam             → Onay
hayır / iptal            → İptal
(başka bir şey)          → Claude akıllı cevap
```

---

## 🔧 Özelleştirme

`index.js` içinde `menuMesaji()` ve `kiralamaDurumuMesaji()` fonksiyonlarını 
düzenleyerek mesaj metinlerini değiştirebilirsin.

Claude'un karakterini değiştirmek için `claudeCevap()` içindeki `system` prompt'u düzenle.

---

## ⚠️ Önemli Notlar

- **serviceAccountKey.json** dosyasını asla GitHub'a push etme
- Railway ücretsiz planında ayda ~500 saat çalışır (yeterli)
- WhatsApp Business numarasını kullandığın için ban riski düşük
- Müşterilerden gelen "evet/hayır" cevapları sadece bot aktifken işlenir
