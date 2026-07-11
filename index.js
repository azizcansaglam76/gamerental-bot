const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

const CONFIG = {
  FIREBASE_PROJECT: 'gamerental-fb121',
  USER_UID: process.env.USER_UID,
  BENIM_NUMARAM: process.env.BENIM_NUMARAM,
  WAHA_URL: process.env.WAHA_URL || 'http://localhost:3000',
  WAHA_API_KEY: process.env.WAHA_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  PORT: process.env.PORT || 3001,
  IBAN: process.env.IBAN || 'IBAN bilgisi eklenmedi',
  HESAP_ISIM: process.env.HESAP_ISIM || 'GameRental',
};

// ── FIREBASE ──
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
    console.log('Firebase: B64 ile yüklendi');
  } else {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 eksik');
  }
} catch (e) {
  console.error('Firebase hatası:', e.message);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: CONFIG.FIREBASE_PROJECT });
const db = admin.firestore();

async function getVeri() {
  const doc = await db.collection('users').doc(CONFIG.USER_UID).collection('data').doc('psrental').get();
  return doc.exists ? doc.data() : null;
}
async function setVeri(data) {
  await db.collection('users').doc(CONFIG.USER_UID).collection('data').doc('psrental').set(data);
}

// ── YARDIMCI ──
function bugun() { return new Date().toISOString().split('T')[0]; }
function yarinStr() { const d = new Date(); d.setDate(d.getDate()+1); return d.toISOString().split('T')[0]; }
function gunFarki(d1, d2) { return Math.round((new Date(d2) - new Date(d1)) / 86400000); }
function fmt(n) { return '₺' + (n||0).toLocaleString('tr-TR'); }
function fmtTarih(t) { if(!t) return '?'; const [y,m,d]=t.split('-'); return `${d}.${m}.${y}`; }
function temizTel(t) {
  const s = t.replace(/[^0-9+]/g,'');
  // + ile başlıyorsa uluslararası format — olduğu gibi bırak, sadece + kaldır
  if (s.startsWith('+')) return s.slice(1);
  const n = s.replace(/^0/,'');
  // Sadece 10 haneli Türk numaralarına 90 ekle (5xxxxxxxxx)
  if (n.length === 10 && n.startsWith('5')) return '90' + n;
  // Zaten 90 ile başlıyorsa dokunma
  if (n.startsWith('90')) return n;
  // Diğer her şeyi olduğu gibi bırak
  return n;
}
function tarihEkle(bas, gun) {
  const d = new Date(bas + 'T12:00:00');
  d.setDate(d.getDate() + gun);
  return d.toISOString().split('T')[0];
}
function gunlukFiyat(oyun, tip) {
  return tip === 'primary'
    ? (oyun.gunlukPri || oyun.gunluk || 0)
    : (oyun.gunlukSec || Math.round((oyun.gunluk||0) * 0.85));
}

// ── BEKLEYENLERİ ÇİFT KAYDET (hem lid hem tel) ──
function bekleyenSet(musteri, veri_obj) {
  if (musteri.whatsappLid) bekleyenOnaylar.set(musteri.whatsappLid, veri_obj);
  if (musteri.tel) {
    const telKey = temizTel(musteri.tel) + '@c.us';
    bekleyenOnaylar.set(telKey, veri_obj);
  }
}

// ── TİER SİSTEMİ ──
function getMusteriTierBot(musteriId, veri) {
  const d3ay = new Date();
  d3ay.setMonth(d3ay.getMonth() - 3);
  const d3ayStr = d3ay.toISOString().slice(0, 10);
  const kiralar = veri.kiralamalar.filter(k => k.musteriId === musteriId && k.bas >= d3ayStr);
  // Bakiyeden ödenen kiralamaları çift saymamak için hariç tut
  let toplam = kiralar.reduce((s, k) => s + (k.odemeTip === 'bakiye' ? 0 : k.net), 0);
  // Harici harcamaları da dahil et
  const musteri = veri.musteriler.find(m => m.id === musteriId);
  if (musteri && musteri.hariciplHarcamalar) {
    musteri.hariciplHarcamalar.forEach(h => {
      if (h.tarih >= d3ayStr) toplam += (h.tutar || 0);
    });
  }
  // Bakiye yüklemelerini de dahil et (son 3 ay içindekiler)
  if (musteri && musteri.bakiyeGecmis) {
    musteri.bakiyeGecmis.forEach(b => {
      if (b.tutar > 0 && b.tarih >= d3ayStr) toplam += b.tutar;
    });
  }
  // Eşikler Firebase'deki tierAyarlar'dan veya varsayılan
  const ta = veri.tierAyarlar || {};
  const T = {
    platinplus: ta.platinplus ?? 5000,
    platin:     ta.platin     ?? 3000,
    altin:      ta.altin      ?? 1500,
    gumus:      ta.gumus      ?? 750,
  };
  if (toplam >= T.platinplus) return { seviye: 'platinplus', emoji: '👑', label: 'Platin+', indirim: ta.platinplusIndirim??20, toplam, sonraki: null, kalanTL: 0, oncelikliRezervHakki: true };
  if (toplam >= T.platin)     return { seviye: 'platin', emoji: '💎', label: 'Platin', indirim: ta.platinIndirim??15, toplam, sonraki: 'Platin+ 👑', kalanTL: T.platinplus - toplam };
  if (toplam >= T.altin)      return { seviye: 'altin',  emoji: '🥇', label: 'Altın',  indirim: ta.altinIndirim??10,  toplam, sonraki: 'Platin 💎',  kalanTL: T.platin - toplam };
  if (toplam >= T.gumus)      return { seviye: 'gumus',  emoji: '🥈', label: 'Gümüş',  indirim: ta.gumusIndirim??5,   toplam, sonraki: 'Altın 🥇',   kalanTL: T.altin - toplam };
  return                             { seviye: 'bronz',  emoji: '🥉', label: 'Bronz',  indirim: 0, toplam, sonraki: 'Gümüş 🥈', kalanTL: T.gumus - toplam };
}

function tierMesajiOlustur(tier, musteriAd, veri) {
  const adSoyad = musteriAd || 'Müşterimiz';
  // Dinamik eşikler
  const ta = (veri && veri.tierAyarlar) || {};
  const T = {
    gumus:      ta.gumus      ?? 750,
    altin:      ta.altin      ?? 1500,
    platin:     ta.platin     ?? 3000,
    platinplus: ta.platinplus ?? 5000,
  };
  const I = {
    gumus:      ta.gumusIndirim      ?? 5,
    altin:      ta.altinIndirim      ?? 10,
    platin:     ta.platinIndirim     ?? 15,
    platinplus: ta.platinplusIndirim ?? 20,
  };

  let mesaj = `🎮 *${adSoyad}*\n\n`;
  mesaj += `${tier.emoji} *${tier.label} Üye*\n`;
  mesaj += `📊 Son 3 ay harcama: *${fmt(tier.toplam)}*\n\n`;

  // Mevcut avantajlar
  mesaj += `*✨ Mevcut Avantajlarınız:*\n`;
  if (tier.seviye === 'bronz') {
    mesaj += `• Standart fiyatlar\n`;
    mesaj += `• Tüm oyunlara erişim\n`;
  } else if (tier.seviye === 'gumus') {
    mesaj += `• 🏷️ *%${I.gumus} indirim* tüm kiralamalarda\n`;
    mesaj += `• Tüm oyunlara erişim\n`;
  } else if (tier.seviye === 'altin') {
    mesaj += `• 🏷️ *%${I.altin} indirim* tüm kiralamalarda\n`;
    mesaj += `• Öncelikli destek\n`;
    mesaj += `• Tüm oyunlara erişim\n`;
  } else if (tier.seviye === 'platin') {
    mesaj += `• 🏷️ *%${I.platin} indirim* tüm kiralamalarda\n`;
    mesaj += `• 🎁 *10+ günlük kiralamalarda 5 gün hediye*\n`;
    mesaj += `• ⚡ Öncelikli destek\n`;
    mesaj += `• Tüm oyunlara erişim\n`;
  } else if (tier.seviye === 'platinplus') {
    mesaj += `• 🏷️ *%${I.platinplus} indirim* tüm kiralamalarda\n`;
    mesaj += `• 🎁 *10+ günlük kiralamalarda 5 gün hediye*\n`;
    mesaj += `• 👑 *Öncelikli rezerv hakkı* — sıra beklemeden 24 saat öncelik\n`;
    mesaj += `• ⚡ Öncelikli VIP destek\n`;
    mesaj += `• Tüm oyunlara erişim\n`;
  }

  // Tüm seviyelerin avantajları — dinamik eşiklerle
  mesaj += `\n*📋 Üyelik Seviyeleri:*\n`;
  mesaj += `🥉 *Bronz* — ₺0+\n`;
  mesaj += `🥈 *Gümüş* — ₺${T.gumus.toLocaleString('tr-TR')}+ → %${I.gumus} indirim\n`;
  mesaj += `🥇 *Altın* — ₺${T.altin.toLocaleString('tr-TR')}+ → %${I.altin} indirim\n`;
  mesaj += `💎 *Platin* — ₺${T.platin.toLocaleString('tr-TR')}+ → %${I.platin} indirim + hediye gün\n`;
  mesaj += `👑 *Platin+* — ₺${T.platinplus.toLocaleString('tr-TR')}+ → %${I.platinplus} indirim + öncelikli rezerv\n\n`;

  if (tier.sonraki) {
    mesaj += `📈 *${tier.sonraki}* için *${fmt(tier.kalanTL)}* daha harca!\n`;
  } else {
    mesaj += `🏆 En üst seviyedesin, tebrikler!\n`;
  }
  return mesaj;
}

// ── SSS FONKSİYONU ──
function sssKontrol(metin, musteriAd) {
  const ad = musteriAd || 'Müşterimiz';

  // Çalışma saatleri
  if (metin.includes('saat') || metin.includes('çalışma') || metin.includes('kaçta') ||
      metin.includes('kaça kadar') || metin.includes('açık') || metin.includes('müsait')) {
    return `🕐 *Çalışma Saatleri*\n\nMerhaba ${ad}! 😊\n\nBiz 7/24 hizmetinizdeyiz! Gece gündüz her saatte mesaj atabilirsiniz, bot size yardımcı olacaktır.\n\nİşletmecimize ulaşmak istiyorsanız da mesajınızı bırakın, en kısa sürede dönüş yapılır 🙏`;
  }

  // Nasıl kiralıyorum
  if (metin.includes('nasıl kirala') || metin.includes('kiralama süreci') || metin.includes('nasıl çalış') ||
      metin.includes('ne yapacağım') || metin.includes('ne yapmalı') || metin.includes('ilk kez')) {
    return `🎮 *Kiralama Süreci*\n\nMerhaba ${ad}! Çok basit:\n\n*1️⃣* Menüden *5* yazarak oyun listesini gör\n*2️⃣* Beğendiğin oyunu ve kaç gün istediğini söyle\n*3️⃣* IBAN bilgisi sana gönderilir, ödemeyi yap\n*4️⃣* Dekontu buraya gönder\n*5️⃣* Hesabına erişim bilgileri iletilir ✅\n\nHerhangi bir adımda takılırsan yardımcı oluruz 😊`;
  }

  // Ödeme yöntemleri
  if (metin.includes('ödeme') || metin.includes('iban') || metin.includes('havale') ||
      metin.includes('eft') || metin.includes('para') || metin.includes('nasıl öde')) {
    return `💳 *Ödeme Yöntemleri*\n\nŞu an ödeme *banka havalesi / EFT* ile yapılmaktadır.\n\nIBAN bilgisi için *5* yazarak kiralama başlatın, otomatik olarak gönderilecektir.\n\nÖdeme sonrası dekontu bu sohbete iletin, hemen işleme alınır ✅`;
  }

  // İade
  if ((metin.includes('iade') && !metin.includes('nasıl')) || metin.includes('teslim') ||
      metin.includes('geri ver') || metin.includes('bitir')) {
    return `📦 *İade Süreci*\n\nMerhaba ${ad}!\n\nİade için menüden *3* yazmanız yeterli 😊\n\nOyunu bitirdiğinizde bildirim gönderirsiniz, hesap erişimi tarafımızdan sonlandırılır.\n\n⚠️ Hesabı kendiniz çıkmayın, iade bildirimi yapmadan çıkış yapmak sorun oluşturabilir.`;
  }

  // Gecikme / geç iade
  if (metin.includes('gecik') || metin.includes('geç kald') || metin.includes('uzatsam') ||
      metin.includes('süre doldu') || metin.includes('sürem doldu') || metin.includes('süresi geçt')) {
    return `⏰ *Gecikme Politikası*\n\nMerhaba ${ad}!\n\nİlk gecikmede ek ücret uygulanmaz, anlayışla karşılarız 😊\n\nAncak tekrarlayan gecikmelerde müşteri güven skorunuza göre günlük ek ücret uygulanabilir (₺3 → ₺5 → ₺7 şeklinde artan).\n\nSkorunuz düşerse kara listeye alınabilir ve ileriki kiralamalarda ön ödeme şartı getirilebilir.\n\nEn iyisi uzatma gerekirse önceden *2* yazarak bilgi vermek 🙏`;
  }

  // Kara liste
  if (metin.includes('kara liste') || metin.includes('karalist') || metin.includes('yasaklı') ||
      metin.includes('engellenm')) {
    return `🚫 *Kara Liste*\n\nKara liste; gecikmeli iade, ödeme sorunları veya hesap ihlali gibi durumlarda uygulanır.\n\nKara listede olan müşterilerimiz yeni kiralama yapamaz.\n\nHerhangi bir sorun yaşadıysanız doğrudan işletmeci ile iletişime geçin, çözüme kavuşturalım 🙏`;
  }

  // Fiyat soru
  if (metin.includes('fiyat') || metin.includes('kaç para') || metin.includes('ne kadar') ||
      metin.includes('ücret') || metin.includes('kaça')) {
    return `💰 *Fiyatlar*\n\nMerhaba ${ad}!\n\nFiyatlar oyuna ve kiralama tipine göre değişiyor:\n\n🔵 *Primary* — oyunu ana hesaptan oynarsın, tam deneyim\n🟣 *Secondary* — daha uygun fiyatlı seçenek\n\nGüncel fiyatları görmek için *4* yazarak oyun listesine bakabilirsin 🎮`;
  }

  // Primary / Secondary ne demek
  if (metin.includes('primary ne') || metin.includes('secondary ne') || metin.includes('primary mı') ||
      metin.includes('secondary mı') || metin.includes('fark ne') || metin.includes('fark nedir')) {
    return `🎮 *Primary & Secondary Farkı*\n\n🔵 *Primary (Ana Hesap)*\nOyunu hesabın ana kullanıcısı olarak oynarsın. Tam erişim, çevrimiçi özellikler dahil. Biraz daha pahalı.\n\n🟣 *Secondary (İkinci Kullanıcı)*\nOyunu kendi PS hesabında oynarsın, daha uygun fiyatlı. Çevrimiçi özellikler için PS Plus gerekmeyebilir.\n\nHer ikisi de sorunsuz çalışır, bütçene göre seçebilirsin 😊`;
  }

  return null; // SSS eşleşmedi, Claude'a git
}

async function mesajGonder(tel, metin) {
  try {
    const chatId = tel.includes('@') ? tel : tel + '@c.us';
    await axios.post(`${CONFIG.WAHA_URL}/api/sendText`,
      { session: 'default', chatId, text: metin },
      { headers: CONFIG.WAHA_API_KEY ? { 'X-Api-Key': CONFIG.WAHA_API_KEY } : {} }
    );
    console.log(`📤 → ${chatId.slice(0,20)}`);
    // Benim numaram değilse, bu kişiyi son mesaj gönderilenler listesine ekle
    const benim9 = (CONFIG.BENIM_NUMARAM || '').replace(/[^0-9]/g,'').slice(-9);
    const hedef9 = chatId.replace(/[^0-9]/g,'').slice(-9);
    if (hedef9 !== benim9 && hedef9.length >= 9) {
      sonMesajGonderilenLid.set(hedef9, chatId);
    }
  } catch (e) { console.error('Gönderim hatası:', e.message); }
}
async function banaGonder(metin) {
  if (CONFIG.BENIM_NUMARAM) await mesajGonder(CONFIG.BENIM_NUMARAM, metin);
}

// ── STATE ──
// bekleyenOnaylar: tel -> { tip, ... }
// tipler: telefon_bekle | kiralama_oyun_bekle | kiralama_tip_bekle | kiralama_gun_bekle
//         yeni_kiralama_dekont | yeni_kiralama_bekle
//         uzatma_gun_bekle | uzatma_dekont | uzatma_isletmeci_bekle
//         iade_onay
const bekleyenOnaylar = new Map();
const insanDevraldi = new Map();
const sonMenuGonderilen = new Map(); // Menü spam önleme
const bildirimGonderildi = new Map(); // Çift bildirim önleme (tarih bazlı)

const HOSGELDIN_MESAJ = `👋 *Merhaba! GameRental'a hoş geldiniz* 🎮

Kayıt olmak için birkaç bilgiye ihtiyacımız var, hemen başlayalım!

━━━━━━━━━━━━━━━━━━━━━
🎮 *GameRental Hakkında*

PlayStation 4 ve PlayStation 5 oyunlarını günlük kiralama sistemiyle uygun fiyata oynayabilirsiniz.

*Nasıl çalışır?*
• Oyun seçersiniz → ödeme yaparsınız → QR koduyla PS hesabına giriş yaparsınız
• Süre bitince iade edersiniz veya uzatırsınız, bu kadar!

*Kiralama Tipleri:*
🔵 *Primary* — Oyunu çevrimdışı oynayabilirsiniz, en avantajlı seçenek
🟣 *Secondary* — Online bağlantı gerektirir, daha uygun fiyatlı

━━━━━━━━━━━━━━━━━━━━━
🎁 *Hediye Gün Avantajı*

Piyasaya çıkalı 1 ayı dolan oyunlarda *10 gün ve üzeri* kiralamalarda *5 gün hediye* eklenir!

💎 *Platin üyeler* bu avantajı *yeni çıkan oyunlarda bile* kullanabilir
👑 *Platin+ üyeler* de aynı şekilde tüm oyunlarda hediye günden yararlanır

━━━━━━━━━━━━━━━━━━━━━
🏅 *Üyelik Avantajları*

Ne kadar çok kiralama yaparsanız o kadar çok kazanırsınız!

🥉 Bronz → Standart fiyat
🥈 Gümüş (₺750+) → %5 indirim
🥇 Altın (₺1.500+) → %10 indirim
💎 Platin (₺3.000+) → %15 indirim + yeni oyunlarda da hediye gün
👑 Platin+ → %20 indirim + öncelikli rezerv + tüm oyunlarda hediye gün

━━━━━━━━━━━━━━━━━━━━━
Şimdi kaydınızı oluşturalım 😊
*Adınızı* yazar mısınız?`; // tel -> timestamp
const INSAN_SURESI = 8 * 60 * 60 * 1000; // 8 saat (pratik olarak kalıcı)
const sonMesajGonderilenLid = new Map(); // numara9 -> lid (botun son mesaj gönderdiği müşteri LID'i)
let benimLid = process.env.BENIM_LID || null;
// İlk mesajda otomatik öğren


// ── RESET KOMUTU için tüm state temizle ──
function stateTemizle(tel) {
  bekleyenOnaylar.delete(tel);
  insanDevraldi.delete(tel);
}

// ── MEDYA KONTROLÜ ──
// Waha'dan gelen mesajda medya var mı?
function medyaVarMi(msg) {
  // Waha farklı formatlarda gönderebilir
  if (msg.hasMedia === true) return true;
  if (msg._data && msg._data.mimetype) return true;
  if (msg.type && ['image','document','video','audio','ptt','sticker'].includes(msg.type)) return true;
  if (msg.mimetype) return true;
  // body boş veya çok kısaysa ve type varsa medya say
  if (msg.type && msg.type !== 'chat' && msg.type !== 'text') return true;
  return false;
}

// ── ANA WEBHOOK ──
const islenenMesajlar = new Set(); // duplicate koruması

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    const msg = event.payload;
    if (!msg) return;

    // Giden mesaj (fromMe) — message.any VEYA message event'inden yakala
    const fromMeEvent = (event.event === 'message.any' || event.event === 'message') && msg.fromMe && msg.to;
    if (fromMeEvent) {
      const body = (msg.body || '').trim();
      console.log(`📤 fromMe event: ${event.event} | to: ${msg.to} | body: "${body.slice(0,30)}"`);
      if (!body.startsWith('#')) {
        const sade9 = msg.to.replace(/[^0-9]/g,'').slice(-9);
        insanDevraldi.set(msg.to, Date.now());
        insanDevraldi.set(sade9 + '@c.us' , Date.now());
        insanDevraldi.set(sade9 + '@lid', Date.now());
        console.log(`👤 Giden mesaj → susturuldu: ${msg.to} | sade9: ${sade9}`);
      }
      return;
    }

    if (event.event !== 'message') return;

    // Duplicate koruması — aynı mesaj ID'si tekrar gelirse atla
    const msgId = msg.id || (msg.from + '_' + msg.timestamp);
    if (islenenMesajlar.has(msgId)) return;
    islenenMesajlar.add(msgId);
    if (islenenMesajlar.size > 500) { // bellek temizliği
      const arr = [...islenenMesajlar];
      arr.slice(0, 250).forEach(k => islenenMesajlar.delete(k));
    }

    // Grup mesajlarını atla
    if (msg.from && msg.from.includes('@g.us')) return;

    const tel = msg.from;
    if (!tel) return;
    const metin = (msg.body || '').trim().toLowerCase();
    const metinOrijinal = (msg.body || '').trim();
    const medya = medyaVarMi(msg);

    // ── KENDİ MESAJLARIM ──
    const benimTelSade = (CONFIG.BENIM_NUMARAM || '').replace(/[^0-9]/g,'').replace(/^90/,'');
    const telNumara = tel.replace('@c.us','').replace('@lid','').replace(/[^0-9]/g,'');
    const benimLidKayitli = (process.env.BENIM_LID || benimLid || '').replace(/[^0-9]/g,'');
    const benimLidTam = (process.env.BENIM_LID || benimLid || '');
    // Telefon numarası sonu veya LID eşleşmesi
    const benimMesajim = msg.fromMe
      || tel === benimLid
      || tel === benimLidTam
      || telNumara === benimLidKayitli
      || (benimLidKayitli.length > 5 && telNumara === benimLidKayitli)
      || (benimTelSade.length >= 9 && telNumara.endsWith(benimTelSade))
      || (benimTelSade.length >= 9 && telNumara.slice(-9) === benimTelSade.slice(-9));


    // LID'i kaydet
    if (benimMesajim && !benimLid) { benimLid = tel; console.log(`📱 Benim LID: ${benimLid}`); }

    if (benimMesajim) {
      if (metinOrijinal.startsWith('## ') || metinOrijinal === '##') {
        // ## 905xxx — o numarayı sustur (kendi numarana yaz)
        // ## — msg.to ile sustur (eski yöntem, çalışmazsa yukarıdakini kullan)
        const parcalar = metinOrijinal.split(' ');
        const hedefNumara = parcalar[1] ? parcalar[1].replace(/[^0-9]/g,'') : null;
        const hedef = hedefNumara
          ? (hedefNumara + '@c.us')
          : msg.to;
        if (hedef) {
          const s9 = hedef.replace(/[^0-9]/g,'').slice(-9);
          insanDevraldi.set(hedef, Date.now());
          insanDevraldi.set(s9 + '@c.us', Date.now());
          insanDevraldi.set(s9 + '@lid', Date.now());
          // LID varsa onu da sustur
          try {
            const veriS = await getVeri();
            const mS = veriS.musteriler.find(m => (m.tel||'').replace(/[^0-9]/g,'').endsWith(s9));
            if (mS?.whatsappLid) insanDevraldi.set(mS.whatsappLid, Date.now());
          } catch(e) {}
          console.log(`🔇 ## → susturuldu: ${hedef}`);
          await banaGonder(`🔇 Susturuldu: ${hedef}`);
        }
        return;
      } else if (metinOrijinal.startsWith('##a ') || metinOrijinal === '##a' || metinOrijinal === '##ac') {
        // ##a 905xxx — susturmayı aç
        const parcalar = metinOrijinal.split(' ');
        const hedefNumara = parcalar[1] ? parcalar[1].replace(/[^0-9]/g,'') : null;
        const hedef = hedefNumara ? (hedefNumara + '@c.us') : msg.to;
        if (hedef) {
          const s9 = hedef.replace(/[^0-9]/g,'').slice(-9);
          insanDevraldi.delete(hedef);
          insanDevraldi.delete(s9 + '@c.us');
          insanDevraldi.delete(s9 + '@lid');
          console.log(`🔊 ##a → susturma kaldırıldı: ${hedef}`);
        }
        return;
      } else if (metinOrijinal.startsWith('#')) {
        // # komutu — aşağıda işle
      } else {
        // Ben bir müşteriye yazdım — sadece o sohbeti sustur
        const hedef = msg.fromMe ? msg.to : null;
        if (hedef) {
          const s9 = hedef.replace(/[^0-9]/g,'').slice(-9);
          insanDevraldi.set(hedef, Date.now());
          insanDevraldi.set(s9 + '@c.us', Date.now());
          insanDevraldi.set(s9 + '@lid', Date.now());
          console.log(`👤 İşletmeci yazdı → susturuldu: ${hedef}`);
        }
        return;
      }
    }

    console.log(`📨 ${tel} → "${metin.slice(0,40)}" | fromMe:${msg.fromMe} | benimMesajim:${benimMesajim}`);

    if (benimMesajim) {
      // ── İŞLETMECİ KOMUTLARI ──

// #reset — tüm state temizle
      if (metin === '#reset') {
        bekleyenOnaylar.clear();
        insanDevraldi.clear();
        benimLid = null;
        await banaGonder('🔄 Bot sıfırlandı! Tüm bekleyen işlemler temizlendi.');
        return;
      }

      // #resetmusteri 905xxx — belirli müşteri state'ini sıfırla
      if (metin.startsWith('#resetmusteri')) {
        const hedefTel = metinOrijinal.split(' ')[1];
        if (hedefTel) {
          const hedefKey = hedefTel.includes('@') ? hedefTel : hedefTel + '@c.us';
          stateTemizle(hedefKey);
          stateTemizle(hedefTel + '@lid');
          await banaGonder(`✅ ${hedefTel} sıfırlandı.`);
        }
        return;
      }

      // #s — tüm aktif müşterileri sustur (parametresiz, hızlı komut)
      if (metin === '#s' || (metin.startsWith('#s ') && !metin.startsWith('#sustur'))) {
        const kismi = metin === '#s' ? '' : (metinOrijinal.split(' ')[1] || '');
        let susturulanSayisi = 0;
        // sonMesajGonderilenLid (bot'un son konuştuğu müşteriler)
        for (const [s9, lid] of sonMesajGonderilenLid) {
          if (!kismi || s9.endsWith(kismi.replace(/[^0-9]/g,'')) || lid.includes(kismi)) {
            insanDevraldi.set(lid, Date.now());
            insanDevraldi.set(s9 + '@c.us', Date.now());
            insanDevraldi.set(s9 + '@lid', Date.now());
            susturulanSayisi++;
          }
        }
        sonMesajGonderilenLid.clear();
        // bekleyenOnaylar (ödeme/işlem bekleyenler)
        for (const [k] of bekleyenOnaylar) {
          const ks9 = k.replace(/[^0-9]/g,'').slice(-9);
          if (!kismi || ks9.endsWith(kismi.replace(/[^0-9]/g,''))) {
            insanDevraldi.set(k, Date.now());
            insanDevraldi.set(ks9 + '@c.us', Date.now());
            insanDevraldi.set(ks9 + '@lid', Date.now());
            susturulanSayisi++;
          }
        }
        await banaGonder(`🤫 ${susturulanSayisi} müşteri susturuldu.
Açmak için: #ac [numara] veya #menu [numara]`);
        return;
      }

      // #sustur 905xxx veya #devral 905xxx — botu sustur
      if (metin.startsWith('#sustur') || metin.startsWith('#devral')) {
        const hedef = metinOrijinal.split(' ')[1];
        if (hedef) {
          const sade = hedef.replace(/[^0-9]/g,'');
          insanDevraldi.set(sade + '@c.us', Date.now());
          insanDevraldi.set(sade + '@lid', Date.now());
          // Firebase whatsappLid ile de sustur
          try {
            const veriS = await getVeri();
            const mS = veriS.musteriler.find(m =>
              (m.tel||'').replace(/[^0-9]/g,'').endsWith(sade.slice(-9)) ||
              (m.whatsappLid||'').replace(/[^0-9]/g,'').includes(sade.slice(-9))
            );
            if (mS && mS.whatsappLid) {
              insanDevraldi.set(mS.whatsappLid, Date.now());
              console.log(`🤫 whatsappLid ile de susturuldu: ${mS.whatsappLid}`);
            }
          } catch(e) {}
          // bekleyenOnaylar'da bu müşteriyle eşleşen LID key'lerini de sustur
          for (const [k, v] of bekleyenOnaylar) {
            const kSade = k.replace(/[^0-9]/g,'');
            if (kSade.endsWith(sade.slice(-9))) {
              insanDevraldi.set(k, Date.now());
              console.log(`🤫 bekleyen key ile susturuldu: ${k}`);
            }
          }
          await banaGonder(`🤫 Bot susturuldu: ${hedef}\n\nGeri açmak için: #ac ${hedef}`);
        } else {
          await banaGonder('Kullanim: #sustur 905xxxxxxxxx');
        }
        return;
      }

      // #ac 905xxx veya #bota 905xxx — botu geri ac
      if (metin.startsWith('#ac') || metin.startsWith('#bota')) {
        const hedef = metinOrijinal.split(' ')[1];
        if (hedef) {
          const sade = hedef.replace(/[^0-9]/g,'');
          const sade9 = sade.slice(-9);
          const silinecekler = [];
          for (const [k] of insanDevraldi) {
            if (k.replace(/[^0-9]/g,'').includes(sade9)) silinecekler.push(k);
          }
          silinecekler.forEach(k => insanDevraldi.delete(k));
          stateTemizle(sade + '@c.us');
          stateTemizle(sade + '@lid');
          try {
            const veriAc = await getVeri();
            const mAc = veriAc.musteriler.find(m => (m.tel||'').replace(/[^0-9]/g,'').endsWith(sade9) || (m.whatsappLid||'').includes(sade9));
            if (mAc && mAc.whatsappLid) insanDevraldi.delete(mAc.whatsappLid);
          } catch(e) {}
          await banaGonder(`🤖 Bot aktif edildi: ${hedef}`);
        } else {
          await banaGonder('Kullanim: #ac 905xxxxxxxxx');
        }
        return;
      }

      // #menu 905xxx — musteriye menu gonder (botu da acar)
      if (metin.startsWith('#menu')) {
        const hedef = metinOrijinal.split(' ')[1];
        if (hedef) {
          const sade = hedef.replace(/[^0-9]/g,'');
          const silinecekler2 = [];
          for (const [k] of insanDevraldi) {
            if (k.includes(sade)) silinecekler2.push(k);
          }
          silinecekler2.forEach(k => insanDevraldi.delete(k));
          try {
            const veriM = await getVeri();
            const mM = veriM.musteriler.find(m => (m.tel||'').replace(/[^0-9]/g,'').endsWith(sade) || (m.whatsappLid||'').includes(sade));
            const adM = mM ? (((mM.ad||'') + ' ' + (mM.soyad||'')).trim() || mM.tel || 'Müşteri') : 'Müşteri';
            const hedefKey = (mM && mM.whatsappLid) ? mM.whatsappLid : (sade + '@c.us');
            stateTemizle(hedefKey);
            await mesajGonder(hedefKey,
              `👋 Merhaba *${adM}*! 🎮\n\n*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon\n*9* - 💰 Bakiye Yükle`
            );
            await banaGonder(`📋 Menü gönderildi: ${hedef}`);
          } catch(e) {
            await banaGonder(`❌ Hata: ${e.message}`);
          }
        } else {
          await banaGonder('Kullanim: #menu 905xxxxxxxxx');
        }
        return;
      }

      // #mesaj 905xxx Metin buraya — musteriye ozel mesaj gonder (botu susturur)
      if (metin.startsWith('#mesaj')) {
        const parcalar = metinOrijinal.split(' ');
        const hedef = parcalar[1];
        const mesajMetni = parcalar.slice(2).join(' ');
        if (hedef && mesajMetni) {
          const sade = hedef.replace(/[^0-9]/g,'');
          insanDevraldi.set(sade + '@c.us', Date.now());
          insanDevraldi.set(sade + '@lid', Date.now());
          try {
            const veriMes = await getVeri();
            const mMes = veriMes.musteriler.find(m => (m.tel||'').replace(/[^0-9]/g,'').endsWith(sade) || (m.whatsappLid||'').includes(sade));
            const hedefKeyMes = (mMes && mMes.whatsappLid) ? mMes.whatsappLid : (sade + '@c.us');
            await mesajGonder(hedefKeyMes, mesajMetni);
            await banaGonder(`✅ Mesaj gönderildi → ${hedef}\n(Bot susturuldu, açmak için: #ac ${hedef})`);
          } catch(e) {
            await banaGonder(`❌ Hata: ${e.message}`);
          }
        } else {
          await banaGonder('Kullanim: #mesaj 905xxxxxxxxx Mesaj metni buraya');
        }
        return;
      }

      // #durum — bot durumu ozeti
      if (metin === '#durum') {
        try {
          const veriDurum = await getVeri();
          const bugunStr = bugun();
          const yarinDate = new Date(); yarinDate.setDate(yarinDate.getDate()+1);
          const yarinStr2 = yarinDate.toISOString().split('T')[0];
          const aktifler = veriDurum.kiralamalar.filter(k => k.durum === 'aktif');
          const bugunBitenler = aktifler.filter(k => k.bit === bugunStr);
          const yarinBitenler = aktifler.filter(k => k.bit === yarinStr2);
          const gecikmisBitenler = aktifler.filter(k => k.bit < bugunStr);
          // Bugün biten isimleri
          const bugunIsimler = bugunBitenler.map(k => {
            const m = veriDurum.musteriler.find(x => x.id === k.musteriId);
            const o = veriDurum.oyunlar.find(x => x.id === k.oyunId);
            return `• ${(m?.ad||m?.soyad||m?.tel||'?')} — ${o?.ad||'?'} (${k.tip})`;
          }).join('\n');
          const yarinIsimler = yarinBitenler.map(k => {
            const m = veriDurum.musteriler.find(x => x.id === k.musteriId);
            const o = veriDurum.oyunlar.find(x => x.id === k.oyunId);
            return `• ${(m?.ad||m?.soyad||m?.tel||'?')} — ${o?.ad||'?'} (${k.tip})`;
          }).join('\n');
          const gecikmeIsimler = gecikmisBitenler.slice(0,5).map(k => {
            const m = veriDurum.musteriler.find(x => x.id === k.musteriId);
            const o = veriDurum.oyunlar.find(x => x.id === k.oyunId);
            return `• ${(m?.ad||m?.soyad||m?.tel||'?')} — ${o?.ad||'?'} (${k.bit})`;
          }).join('\n');
          let durumMesaj = `📊 *Bot & Kiralama Durumu*\n\n`;
          durumMesaj += `🎮 *Aktif kiralama:* ${aktifler.length}\n`;
          durumMesaj += `⏰ *Bugün bitiyor:* ${bugunBitenler.length}${bugunBitenler.length>0?'\n'+bugunIsimler:''}\n`;
          durumMesaj += `🔔 *Yarın bitiyor:* ${yarinBitenler.length}${yarinBitenler.length>0?'\n'+yarinIsimler:''}\n`;
          if (gecikmisBitenler.length > 0) durumMesaj += `⚠️ *Gecikmiş:* ${gecikmisBitenler.length}\n${gecikmeIsimler}\n`;
          durumMesaj += `\n🤫 Susturulan: ${insanDevraldi.size} kişi\n`;
          durumMesaj += `⏳ İşlem bekleyen: ${bekleyenOnaylar.size} kişi\n\n`;
          durumMesaj += `📋 *Komutlar:*\n`;
          durumMesaj += `#sustur 905xxx | #ac 905xxx | #s\n`;
          durumMesaj += `#menu 905xxx | #mesaj 905xxx Metin\n`;
          durumMesaj += `#onayla 905xxx | #resetmusteri 905xxx | #reset`;
          await banaGonder(durumMesaj);
        } catch(e) {
          await banaGonder(`📊 Bot çalışıyor\n🤫 Susturulan: ${insanDevraldi.size}\n⏳ Bekleyen: ${bekleyenOnaylar.size}`);
        }
        return;
      }

      // #onayla 905xxx — ödeme onayla
      // #bakiye 905xxx tutar aciklama — bakiye yükle
      if (metin.startsWith('#bakiye ')) {
        const parcalar = metinOrijinal.split(' ');
        const hedefNumara = parcalar[1]?.replace(/[^0-9]/g,'');
        const tutar = parseFloat(parcalar[2]);
        const aciklama = parcalar.slice(3).join(' ') || 'İşletmeci yüklemesi';
        if (hedefNumara && !isNaN(tutar) && tutar > 0) {
          const veriBakiye = await getVeri();
          const mBakiye = veriBakiye.musteriler.find(m => (m.tel||'').replace(/[^0-9]/g,'').endsWith(hedefNumara.slice(-10)));
          if (!mBakiye) { await banaGonder(`❌ Müşteri bulunamadı: ${hedefNumara}`); return; }
          mBakiye.bakiye = (mBakiye.bakiye || 0) + tutar;
          if (!mBakiye.bakiyeGecmis) mBakiye.bakiyeGecmis = [];
          mBakiye.bakiyeGecmis.push({ tarih: bugun(), tutar, aciklama });
          await setVeri(veriBakiye);
          // Müşteriye bildirim
          const hedefBakiye = mBakiye.whatsappLid || (mBakiye.tel ? temizTel(mBakiye.tel) + '@c.us' : null);
          if (hedefBakiye) {
            await mesajGonder(hedefBakiye,
              `💰 *Bakiye Yüklendi!*\n\n` +
              `*+${fmt(tutar)}* hesabınıza yüklendi.\n` +
              `Güncel bakiyeniz: *${fmt(mBakiye.bakiye)}*\n\n` +
              `Kiralamalarınızda bakiyenizi kullanabilirsiniz 🎮\n\n` +
              `${BAKIYE_BILGI}`
            );
          }
          await banaGonder(`✅ Bakiye yüklendi:\n👤 ${mBakiye.ad} ${mBakiye.soyad}\n💰 +${fmt(tutar)} → Toplam: ${fmt(mBakiye.bakiye)}`);
        } else {
          await banaGonder('Kullanım: #bakiye 905xxxxxxxxx 500 açıklama');
        }
        return;
      }

      // #kara 905xxx sebep — kara listeye al
      if (metin.startsWith('#kara ')) {
        const parcalar = metinOrijinal.split(' ');
        const hedefNumara = parcalar[1]?.replace(/[^0-9]/g,'');
        const sebep = parcalar.slice(2).join(' ') || 'Belirtilmedi';
        if (hedefNumara && hedefNumara.length >= 10) {
          const veriKara = await getVeri();
          const mKara = veriKara.musteriler.find(m => (m.tel||'').replace(/[^0-9]/g,'').endsWith(hedefNumara.slice(-10)));
          if (!mKara) { await banaGonder(`❌ Müşteri bulunamadı: ${hedefNumara}`); return; }
          if (!veriKara.karaListe) veriKara.karaListe = [];
          const zatenVar = veriKara.karaListe.some(k => k.musteriId === mKara.id);
          if (zatenVar) { await banaGonder(`⚠️ ${mKara.ad} ${mKara.soyad} zaten kara listede`); return; }
          veriKara.karaListe.push({ musteriId: mKara.id, sebep, tarih: bugun() });
          await setVeri(veriKara);
          await banaGonder(`🚫 Kara listeye eklendi:\n👤 ${mKara.ad} ${mKara.soyad}\n📱 ${mKara.tel}\n📝 Sebep: ${sebep}`);
          // Müşteriye bildirim gitsin mi?
          const hedefKara = mKara.whatsappLid || (mKara.tel ? temizTel(mKara.tel) + '@c.us' : null);
          if (hedefKara) {
            await mesajGonder(hedefKara, `🚫 Hesabınız askıya alınmıştır.\nDetay için işletmecimizle iletişime geçin.`);
          }
        } else {
          await banaGonder('Kullanım: #kara 905xxxxxxxxx sebep');
        }
        return;
      }

      // #karaaç 905xxx — kara listeden çıkar
      if (metin.startsWith('#karaac') || metin.startsWith('#kara-ac') || metin.startsWith('#kara aç')) {
        const hedefNumara = metinOrijinal.split(' ')[1]?.replace(/[^0-9]/g,'');
        if (hedefNumara) {
          const veriKaraAc = await getVeri();
          const mKaraAc = veriKaraAc.musteriler.find(m => (m.tel||'').replace(/[^0-9]/g,'').endsWith(hedefNumara.slice(-10)));
          if (!mKaraAc) { await banaGonder(`❌ Müşteri bulunamadı: ${hedefNumara}`); return; }
          veriKaraAc.karaListe = (veriKaraAc.karaListe||[]).filter(k => k.musteriId !== mKaraAc.id);
          await setVeri(veriKaraAc);
          await banaGonder(`✅ Kara listeden çıkarıldı: ${mKaraAc.ad} ${mKaraAc.soyad}`);
        } else {
          await banaGonder('Kullanım: #karaac 905xxxxxxxxx');
        }
        return;
      }

      if (metin.startsWith('#tamam')) {
        const hedefNumara = metinOrijinal.split(' ')[1];
        if (hedefNumara) {
          const sade = hedefNumara.replace(/[^0-9]/g,'').slice(-10);
          // Müşteriyi bul
          const veriT = await getVeri();
          const mT = veriT.musteriler.find(m => (m.tel||'').replace(/[^0-9]/g,'').slice(-10) === sade || (m.whatsappLid||'').includes(sade));
          const hedefKey = mT?.whatsappLid || (sade + '@c.us');
          const bekleyenT = bekleyenOnaylar.get(hedefKey) || bekleyenOnaylar.get('90'+sade+'@c.us') || bekleyenOnaylar.get(sade+'@c.us');
          const oyunAd = bekleyenT?.oyunAd || '?';
          // Müşteriye bildirim
          await mesajGonder(hedefKey,
            `✅ *Giriş Sağlandı!*\n\n` +
            `🎮 *${oyunAd}* hesabına başarıyla giriş yapıldı.\n\n` +
            `İyi oyunlar! 🎮🎉\n\n` +
            `Süreniz bittiğinde veya uzatmak istediğinizde menüden işlem yapabilirsiniz.`
          );
          bekleyenOnaylar.delete(hedefKey);
          await banaGonder(`✅ Giriş tamamlandı: ${mT?.ad||sade} — ${oyunAd}`);
        } else {
          await banaGonder('Kullanım: #tamam 905xxxxxxxxx');
        }
        return;
      }

      if (metin.startsWith('#onayla')) {
        const hedefTel = metinOrijinal.split(' ')[1];
        if (!hedefTel) { await banaGonder('Kullanım: #onayla 905xxxxxxxxx'); return; }

        const hedefSade = hedefTel.replace(/[^0-9]/g,'').replace(/^90/,'');

        // 1) Direkt key ile ara (@c.us ve @lid)
        const araKeys = [
          hedefTel.includes('@') ? hedefTel : hedefTel + '@c.us',
          hedefTel.replace(/[^0-9]/g,'') + '@lid',
        ];
        let hedefKey = null;
        let hedefBekleyen = null;
        for (const k of araKeys) {
          if (bekleyenOnaylar.has(k)) { hedefKey = k; hedefBekleyen = bekleyenOnaylar.get(k); break; }
        }

        // 2) Bulunamazsa tüm bekleyenler arasında müşteri telefonu ile eşleştir
        if (!hedefBekleyen) {
          const veriAra = await getVeri();
          for (const [key, val] of bekleyenOnaylar.entries()) {
            if (!val.musteriId) continue;
            const m = veriAra.musteriler.find(x => x.id === val.musteriId);
            if (!m) continue;
            const mTel = (m.tel||'').replace(/[^0-9]/g,'').replace(/^0/,'').replace(/^90/,'');
            if (mTel === hedefSade) { hedefKey = key; hedefBekleyen = val; break; }
          }
        }

        if (!hedefBekleyen) { await banaGonder(`Bekleyen işlem yok: ${hedefTel}`); return; }
        const veri2 = await getVeri();

        // Yeni kiralama onayla
        if (hedefBekleyen.tip === 'yeni_kiralama_bekle') {
          // Güvenli ID üretimi — mevcut max ID'den hesapla, race condition önlenir
          const maxKiraId = veri2.kiralamalar.reduce((m, k) => Math.max(m, k.id || 0), 0);
          const yeniId = Math.max(maxKiraId, veri2.nextId?.k || 0) + 1;
          const bas = hedefBekleyen.bas || bugun();
          const bit = hedefBekleyen.bit || tarihEkle(bas, hedefBekleyen.toplamGun || hedefBekleyen.gun);
          const hediyeGun = hedefBekleyen.hediye || 0;
          // Tier kontrolü — ÖNCE (kiralama eklenmeden)
          const tierOncesi = getMusteriTierBot(hedefBekleyen.musteriId, veri2);
          veri2.kiralamalar.push({
            id: yeniId, oyunId: hedefBekleyen.oyunId, musteriId: hedefBekleyen.musteriId,
            tip: hedefBekleyen.kiraTip, bas, bit,
            ucret: (hedefBekleyen.ucret + (hedefBekleyen.indirim||0)), indirim: (hedefBekleyen.indirim||0), net: hedefBekleyen.ucret,
            onOdeme: hedefBekleyen.ucret, hediyeGun, notlar: 'Bot ile eklendi', durum: 'aktif',
          });
          if (!veri2.nextId) veri2.nextId = {};
          veri2.nextId.k = yeniId + 1; // Sonraki için +1 kaydet
          // Oyun istatistiklerini güncelle
          const oyunStat = veri2.oyunlar.find(o => o.id === hedefBekleyen.oyunId);
          if (oyunStat) {
            oyunStat.kiralamaSayisi = (oyunStat.kiralamaSayisi || 0) + 1;
            oyunStat.toplamGelir = (oyunStat.toplamGelir || 0) + hedefBekleyen.ucret;
            oyunStat.durum = 'kirada';
          }
          await setVeri(veri2);
          bekleyenOnaylar.delete(hedefKey);
          // Tier kontrolü — SONRA
          const tierSonrasi = getMusteriTierBot(hedefBekleyen.musteriId, veri2);
          const tierAtladi = tierOncesi.seviye !== tierSonrasi.seviye;
          let onayMesaj = `✅ *Ödemeniz onaylandı!*\n\n🎮 *${hedefBekleyen.oyunAd}*\n📅 ${bas} → ${bit}`;
          if (hediyeGun > 0) onayMesaj += ` 🎁 *(+${hediyeGun} gün hediye)*`;
          onayMesaj += `\n💰 ${fmt(hedefBekleyen.ucret)}\n\n` +
            `📲 *Hesaba giriş için:*\n` +
            `PlayStation'ınızda şu adımları takip edin:\n` +
            `*1.* Ayarlar → Kullanıcılar ve Hesaplar\n` +
            `*2.* Diğer → QR Koduyla Oturum Aç\n` +
            `*3.* Açılan QR ekranının fotoğrafını buraya gönderin 📸\n\n` +
            `QR'ı aldıktan sonra giriş işleminizi tamamlayacağız 🙏`;
          // QR bekleme state'ini kaydet
          bekleyenOnaylar.set(hedefKey, { tip: 'qr_bekle', oyunAd: hedefBekleyen.oyunAd, oyunId: hedefBekleyen.oyunId, musteriAd: hedefBekleyen.musteriAd, kiraId: yeniId });
          if (tierAtladi) {
            onayMesaj += `\n\n🎉 *Tebrikler!* ${tierOncesi.emoji} ${tierOncesi.label} → ${tierSonrasi.emoji} *${tierSonrasi.label}* seviyesine yükseldin!`;
            if (tierSonrasi.indirim > 0) onayMesaj += `\n✨ Artık *%${tierSonrasi.indirim} indirim* hakkın var!`;
          }
          await mesajGonder(hedefKey, onayMesaj);
          if (tierAtladi) {
            await banaGonder(`🏅 *Tier Değişimi*\n👤 ${hedefBekleyen.musteriAd}\n${tierOncesi.emoji} ${tierOncesi.label} → ${tierSonrasi.emoji} ${tierSonrasi.label}`);
          }
          await banaGonder(`✅ Kiralama eklendi!\n🎮 ${hedefBekleyen.oyunAd}\n👤 ${hedefBekleyen.musteriAd}\n📅 ${bas} → ${bit}${hediyeGun > 0 ? ` (+${hediyeGun} gün hediye)` : ''}\n\n📲 QR bekleniyor — müşteri gönderince sana iletilecek.\nGiriş sonrası: *#tamam ${hedefKey.replace('@c.us','').replace('@lid','')}*`);
          return;
        }

        // Uzatma onayla
        if (hedefBekleyen.tip === 'uzatma_isletmeci_bekle') {
          const k = veri2.kiralamalar.find(x => x.id === hedefBekleyen.kiraId);
          if (k) {
            const tierOncesi = getMusteriTierBot(k.musteriId, veri2);
            k.bit = tarihEkle(k.bit, hedefBekleyen.gun);
            k.ucret = (k.ucret||0) + hedefBekleyen.ucret;
            k.net = (k.net||0) + hedefBekleyen.ucret;
            // Uzatma sayısı ve geçmişi kaydet
            k.uzatmaSayisi = (k.uzatmaSayisi || 0) + 1;
            if (!k.uzatmalar) k.uzatmalar = [];
            k.uzatmalar.push({ tarih: bugun(), gun: hedefBekleyen.gun, ucret: hedefBekleyen.ucret });
            // Oyun toplamGelir güncelle
            const oyunStatUzat = veri2.oyunlar.find(o => o.id === k.oyunId);
            if (oyunStatUzat) {
              oyunStatUzat.toplamGelir = (oyunStatUzat.toplamGelir || 0) + hedefBekleyen.ucret;
            }
            await setVeri(veri2);
            bekleyenOnaylar.delete(hedefKey);
            const tierSonrasi = getMusteriTierBot(k.musteriId, veri2);
            const tierAtladi = tierOncesi.seviye !== tierSonrasi.seviye;
            let uzatmaMesaj = `✅ Uzatma onaylandı! ${hedefBekleyen.gun} gün eklendi.\nYeni bitiş: *${k.bit}* 🎮`;
            if (tierAtladi) {
              uzatmaMesaj += `\n\n🎉 *Tebrikler!* ${tierOncesi.emoji} ${tierOncesi.label} → ${tierSonrasi.emoji} *${tierSonrasi.label}* seviyesine yükseldin!`;
              if (tierSonrasi.indirim > 0) uzatmaMesaj += `\n✨ Artık *%${tierSonrasi.indirim} indirim* hakkın var!`;
              await banaGonder(`🏅 *Tier Değişimi*\n👤 Müşteri #${k.musteriId}\n${tierOncesi.emoji} ${tierOncesi.label} → ${tierSonrasi.emoji} ${tierSonrasi.label}`);
            }
            await mesajGonder(hedefKey, uzatmaMesaj);
            await banaGonder(`✅ Uzatma yapıldı: ${hedefTel}`);
          }
          return;
        }
        await banaGonder(`Bilinmeyen bekleyen tip: ${hedefBekleyen.tip}`);
        return;
      }

      return; // diğer benim mesajlarımı işleme
    }

    // ── İNSAN DEVRALMA KONTROLÜ ──
    const telSade = tel.replace(/[^0-9]/g,'');
    const telSade9 = telSade.slice(-9);
    // Tüm formatlarda ara — key ne formatta kaydolduysa bulsun
    let devralZamani = insanDevraldi.get(tel)
      || insanDevraldi.get(telSade + '@c.us')
      || insanDevraldi.get(telSade + '@lid');
    // Bulunamazsa son 9 hane ile tüm key'leri tara
    if (!devralZamani) {
      for (const [k, v] of insanDevraldi) {
        if (k.replace(/[^0-9]/g,'').endsWith(telSade9)) {
          devralZamani = v;
          break;
        }
      }
    }
    if (devralZamani && Date.now() - devralZamani < INSAN_SURESI) {
      console.log(`🤫 Susturuldu: ${tel}`);
      return;
    }

    // ── VERİ ÇEK ──
    const veri = await getVeri();
    if (!veri) { await mesajGonder(tel, 'Sistem şu an bakımda 🙏'); return; }

    // ── MÜŞTERİ BUL ──
    const isLid = tel.includes('@lid');
    let musteri = veri.musteriler.find(m => m.whatsappLid === tel);

    // ── KARA LİSTE KONTROLÜ ──
    if (musteri && (veri.karaListe||[]).some(k => k.musteriId === musteri.id)) {
      const sonKara = sonMenuGonderilen.get('kara_' + tel) || 0;
      if (Date.now() - sonKara > 24 * 60 * 60 * 1000) {
        sonMenuGonderilen.set('kara_' + tel, Date.now());
        await mesajGonder(tel, `🚫 Hesabınız askıya alınmıştır.\nDetay için işletmecimizle iletişime geçin.`);
      }
      return;
    }
    if (!musteri && !isLid) {
      const sade = tel.replace('@c.us','').replace(/^90/,'').replace(/^0/,'');
      musteri = veri.musteriler.find(m => {
        if (!m.tel) return false;
        const mSade = m.tel.replace(/[^0-9]/g,'').replace(/^90/,'').replace(/^0/,'');
        return mSade === sade || mSade.endsWith(sade) || sade.endsWith(mSade);
      });
    }
    // LID ile geldi ama whatsappLid kayıtlı değil → telefon numarasıyla da ara
    if (!musteri && isLid) {
      const lidSade = tel.replace('@lid','');
      // Daha önce bu LID'i başka bir müşteriyle eşleştirdik mi diye bak
      musteri = veri.musteriler.find(m => (m.whatsappLid||'').replace('@lid','') === lidSade);
    }
    if (musteri && isLid && !musteri.whatsappLid) {
      musteri.whatsappLid = tel;
      try { await setVeri(veri); } catch(e) {}
    }

    const musteriAd = musteri ? ((musteri.ad||'') + ' ' + (musteri.soyad||'')).trim() || musteri.tel || 'Müşteri' : 'Misafir';
    const aktifKiralar = musteri ? veri.kiralamalar.filter(k => k.musteriId === musteri.id && k.durum === 'aktif') : [];
    const aktifKira = aktifKiralar[0] || null;


    // ── GENEL İPTAL — herhangi bir state'deyken "iptal" yazarsa menüye dön ──
    const bekleyenKontrol = bekleyenOnaylar.get(tel);
    if (bekleyenKontrol && (metin === 'iptal' || metin === 'vazgeç' || metin === 'vazgec' || metin === 'geri')) {
      bekleyenOnaylar.delete(tel);
      await mesajGonder(tel,
        `İptal edildi 😊\n\n👋 *${musteriAd}*, başka bir şey yapabilir miyim?\n\n` +
        `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon\n*9* - 💰 Bakiye Yükle`
      );
      return;
    }

    // ── TELEFON BEKLEME ──
    const bekleyen = bekleyenOnaylar.get(tel);
    if (bekleyen?.tip === 'telefon_bekle') {
      const numara = metinOrijinal.replace(/[^0-9]/g,'').replace(/^90/,'').replace(/^0/,'');
      if (numara.length >= 10) {
        const bulunan = veri.musteriler.find(m => m.tel && m.tel.replace(/[^0-9]/g,'').replace(/^0/,'') === numara);
        bekleyenOnaylar.delete(tel);
        if (bulunan) {
          bulunan.whatsappLid = tel;
          await setVeri(veri);
          await mesajGonder(tel,
            `✅ Merhaba *${(bulunan.ad||bulunan.soyad||'').trim()}*!\n\n*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon\n*9* - 💰 Bakiye Yükle`
          );
        } else {
          // Kayıt akışı başlat — tatil mesajı kayıt onayında gönderilecek
          bekleyenOnaylar.set(tel, { tip: 'kayit_ad_bekle', numara: '90' + numara });
          await mesajGonder(tel, HOSGELDIN_MESAJ);
        }
      } else {
        await mesajGonder(tel, `Lütfen geçerli telefon numaranızı yazın (örn: 5301234567) 📱`);
      }
      return;
    }

    // ── SİSTEMDE KAYITLI DEĞİL (hem LID hem @c.us) ──
    // Bakiye yükleme — dekont bekleniyor
    if (bekleyen?.tip === 'bakiye_yukle_dekont') {
      if (medya) {
        // Dekont geldi — sana ilet
        const sBakiye = bekleyen.musteriAd || 'Müşteri';
        await banaGonder(
          `💰 *Bakiye Yükleme Talebi*\n\n` +
          `👤 ${sBakiye}\n` +
          `📱 ${tel.replace(/[^0-9]/g,'').slice(-10)}\n\n` +
          `Yüklemek için: *#bakiye ${tel.replace(/[^0-9]/g,'').slice(-10)} [tutar]*`
        );
        await mesajGonder(tel,
          `✅ Dekontunuz alındı! Kısa sürede bakiyenize yüklenecektir 🙏\n\n` +
          `İşlem tamamlandığında bildirim alacaksınız.`
        );
        bekleyenOnaylar.delete(tel);
      } else if (metin === 'iptal') {
        bekleyenOnaylar.delete(tel);
        await mesajGonder(tel, `❌ Bakiye yükleme iptal edildi.`);
      } else {
        await mesajGonder(tel,
          `📸 Lütfen havale dekontunu fotoğraf veya PDF olarak gönderin.\n\n❌ İptal için *iptal* yazın.`
        );
      }
      return;
    }

    // QR bekleme — musteri null olsa bile devam et
    if (bekleyen?.tip === 'qr_bekle') {
      if (medya) {
        // QR görseli geldi — sana ilet
        const musteriTelSade = tel.replace(/[^0-9]/g,'').slice(-10);
        await banaGonder(
          `📲 *QR Kodu Geldi!*\n\n` +
          `👤 *${bekleyen.musteriAd}*\n` +
          `🎮 *${bekleyen.oyunAd}*\n` +
          `📱 Tel: ${musteriTelSade}\n\n` +
          `QR'ı okutunca: *#tamam ${musteriTelSade}*`
        );
        // Görseli de ilet
        try {
          await axios.post(`${CONFIG.WAHA_URL}/api/sendImage`, {
            session: 'default',
            chatId: CONFIG.BENIM_NUMARAM,
            caption: `QR — ${bekleyen.musteriAd} / ${bekleyen.oyunAd}`,
            file: { mimetype: msg.media?.mimetype || 'image/jpeg', data: msg.media?.data || '' }
          }, { headers: { 'X-Api-Key': CONFIG.WAHA_API_KEY } });
        } catch(e) { console.log('QR görsel iletme hatası:', e.message); }
        await mesajGonder(tel, `📸 QR kodunuz alındı! Giriş işlemi tamamlanınca bildirim alacaksınız 🙏`);
        bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'qr_onay_bekle' });
      } else {
        await mesajGonder(tel,
          `📲 *QR Bekleniyor*\n\n` +
          `PlayStation'ınızda:\n` +
          `*1.* Ayarlar → Kullanıcılar ve Hesaplar\n` +
          `*2.* Diğer → QR Koduyla Oturum Aç\n` +
          `*3.* Açılan QR ekranının fotoğrafını gönderin 📸`
        );
      }
      return;
    }

    // Kayıt akışı — musteri null olsa bile devam et
    if (bekleyen?.tip === 'kayit_ad_bekle') {
      const ad = metinOrijinal.trim();
      if (ad.length < 2) { await mesajGonder(tel, `Lütfen adınızı yazın:`); return; }
      bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'kayit_soyad_bekle', ad });
      await mesajGonder(tel, `👍 Merhaba *${ad}*!\n\nSoyadınızı yazar mısınız?`);
      return;
    }

    if (bekleyen?.tip === 'kayit_soyad_bekle') {
      const soyad = metinOrijinal.trim();
      if (soyad.length < 2) { await mesajGonder(tel, `Lütfen soyadınızı yazın:`); return; }
      if (!veri.musteriler) veri.musteriler = [];
      const maxMId = veri.musteriler.reduce((m, x) => Math.max(m, x.id || 0), 0);
      const yeniMId = Math.max(maxMId, veri.nextId?.m || 0) + 1;
      // Tel normalize: 905321234567 → 5321234567 (sistemle tutarlı)
      const telNorm = (bekleyen.numara||'').replace(/^90/, '');
      const yeniMusteri = {
        id: yeniMId,
        ad: bekleyen.ad,
        soyad,
        tel: telNorm,
        whatsappLid: tel,
        onKayit: true,
        kayitTarih: bugun(),
      };
      veri.musteriler.push(yeniMusteri);
      if (!veri.nextId) veri.nextId = {};
      veri.nextId.m = yeniMId + 1;
      await setVeri(veri);
      bekleyenOnaylar.delete(tel);
      await mesajGonder(tel,
        `✅ *Kaydınız oluşturuldu!*\n\n` +
        `👤 ${bekleyen.ad} ${soyad}\n` +
        `📱 ${bekleyen.numara}\n\n` +
        `İşletmecimiz kaydınızı onayladıktan sonra tüm hizmetlerimizden yararlanabilirsiniz.\n` +
        `En kısa sürede bildirim alacaksınız 🙏`
      );
      await banaGonder(
        `🆕 *Yeni Ön Kayıt!*\n\n` +
        `👤 ${bekleyen.ad} ${soyad}\n` +
        `📱 ${bekleyen.numara}\n` +
        `💬 WhatsApp: ${tel}\n\n` +
        `Onaylamak için siteden müşteri profilini düzenle.`
      );
      return;
    }

    if (!musteri) {
      const zatenBekliyor = bekleyen?.tip === 'telefon_bekle';
      if (!zatenBekliyor) {
        bekleyenOnaylar.set(tel, { tip: 'telefon_bekle' });
        // Tatil modunda da olsa kayıtsız birine sadece numara sor — tatil mesajı kayıt sonrası gelecek
        await mesajGonder(tel, `👋 Merhaba! GameRental'a hoş geldiniz 🎮\n\nSizi sistemde bulmak için kayıtlı telefon numaranızı yazar mısınız?\n(Örn: 5301234567)`);
        await banaGonder(`🆕 *Yeni/Kayıtsız Ziyaretçi*\n\nWhatsApp: ${tel}\nMesaj: "${metinOrijinal.slice(0,60)}"\n\n💬 Sisteme eklemek için siteden müşteri oluştur.`);
      }
      return;
    }

    // ── BEKLEYEN İŞLEMLER ──
    if (bekleyen) {

      // Kiralama akışı — oyun seçimi
      if (bekleyen.tip === 'kiralama_oyun_bekle') {
        const { musaitOyunlar, kiradaOyunlar = [] } = bekleyen;
        let secilen = null;
        let secilenKirada = false;
        const sayi = parseInt(metin);
        if (!isNaN(sayi) && sayi >= 1 && sayi <= musaitOyunlar.length) {
          secilen = musaitOyunlar[sayi - 1];
        } else if (!isNaN(sayi) && sayi >= 1 && sayi <= (musaitOyunlar.length + (kiradaOyunlar||[]).length)) {
          secilenKirada = true;
          secilen = (kiradaOyunlar||[])[sayi - musaitOyunlar.length - 1];
        } else {
          secilen = musaitOyunlar.find(o => o.ad.toLowerCase().includes(metin));
        }
        // Müsait değil ama kirada olanlar arasında var mı?
        if (!secilen) {
          secilenKirada = true;
          secilen = kiradaOyunlar.find(o => o.ad.toLowerCase().includes(metin));
        }
        if (!secilen) { await mesajGonder(tel, `Oyun bulunamadı. Listeden numara veya isim yazın.`); return; }

        // Kirada oyun seçildi → sıraya gir seçeneği sun
        if (secilenKirada) {
          const siradaki = (veri.rezervasyonlar||[]).filter(r => r.oyunId === secilen.id && r.durum === 'bekliyor').length;
          const pri = gunlukFiyat(secilen, 'primary');
          const sec = gunlukFiyat(secilen, 'secondary');
          await mesajGonder(tel,
            `⏳ *${secilen.ad}* şu an kirada.\n\n` +
            `${siradaki > 0 ? `👥 Sırada ${siradaki} kişi var.\n\n` : ''}` +
            `🔵 Primary: ${fmt(pri)}/gün\n🟣 Secondary: ${fmt(sec)}/gün\n\n` +
            `Sıraya girmek ister misiniz? Slot açılınca size haber verilir 🔔\n\n*1* - 🔵 Primary sıraya gir\n*2* - 🟣 Secondary sıraya gir\n*iptal* - Vazgeç`
          );
          bekleyenOnaylar.set(tel, { tip: 'rezerv_tip_bekle', musteriId: musteri.id, musteriAd, oyunId: secilen.id, oyunAd: secilen.ad });
          return;
        }

        const pri = gunlukFiyat(secilen, 'primary');
        const sec = gunlukFiyat(secilen, 'secondary');
        const aktif2 = veri.kiralamalar.filter(k => k.oyunId === secilen.id && k.durum === 'aktif');
        const priDolu = aktif2.filter(k=>k.tip==='primary').length >= (secilen.ciftPrimary?2:1);
        const secDolu = aktif2.filter(k=>k.tip==='secondary').length >= 1;
        let tipSecim = `Hangi tipi tercih edersiniz?\n`;
        if (!priDolu) tipSecim += `*1* - 🔵 Primary: ${fmt(pri)}/gün\n`;
        if (!secDolu) tipSecim += `*2* - 🟣 Secondary: ${fmt(sec)}/gün\n`;
        await mesajGonder(tel, `🎮 *${secilen.ad}* seçildi!\n\n${tipSecim}`);
        bekleyenOnaylar.set(tel, { tip: 'kiralama_tip_bekle', musteriId: musteri.id, musteriAd, oyunId: secilen.id, oyunAd: secilen.ad, priDolu, secDolu });
        return;
      }

      // Kiralama akışı — tip seçimi
      // Rezervasyon akışı — tip seçimi
      // Ön rezervasyon — oyun seçimi
      if (bekleyen.tip === 'on_rezerv_oyun_bekle') {
        const { cikacakOyunlar } = bekleyen;
        const sayi = parseInt(metin);
        let secilen = null;
        if (!isNaN(sayi) && sayi >= 1 && sayi <= cikacakOyunlar.length) {
          secilen = cikacakOyunlar[sayi - 1];
        } else {
          secilen = cikacakOyunlar.find(o => o.ad.toLowerCase().includes(metin));
        }
        if (!secilen) {
          await mesajGonder(tel, `Oyun bulunamadı. Lütfen listeden bir numara yazın.`);
          return;
        }
        const pri = gunlukFiyat(secilen, 'primary');
        const sec = gunlukFiyat(secilen, 'secondary');
        await mesajGonder(tel,
          `🎮 *${secilen.ad}*\n📅 Çıkış tarihi: ${fmtTarih(secilen.cikis)}\n\nHangi slot için yer ayırtmak istiyorsunuz?\n\n*1* - 🔵 Primary (${fmt(pri)}/gün)\n*2* - 🟣 Secondary (${fmt(sec)}/gün)`
        );
        bekleyenOnaylar.set(tel, { tip: 'on_rezerv_tip_bekle', musteriId: bekleyen.musteriId, oyunId: secilen.id, oyunAd: secilen.ad, musteriAd });
        return;
      }

      // Ön rezervasyon — tip seçimi
      if (bekleyen.tip === 'on_rezerv_tip_bekle') {
        let kiraTip = null;
        if (metin.includes('primary') || metin === '1') kiraTip = 'primary';
        else if (metin.includes('secondary') || metin === '2') kiraTip = 'secondary';
        if (!kiraTip) { await mesajGonder(tel, `*1* - 🔵 Primary\n*2* - 🟣 Secondary`); return; }

        const veri2 = await getVeri();
        if (!veri2.rezervasyonlar) veri2.rezervasyonlar = [];

        // Müşteri zaten bu oyun için sırada mı?
        const zatenSiradaOn = veri2.rezervasyonlar.find(r =>
          r.oyunId === bekleyen.oyunId &&
          r.musteriId === bekleyen.musteriId &&
          r.tip === kiraTip &&
          r.durum === 'bekliyor'
        );
        if (zatenSiradaOn) {
          const noOn = veri2.rezervasyonlar.filter(r => r.oyunId === bekleyen.oyunId && r.tip === kiraTip && r.durum === 'bekliyor' && r.id <= zatenSiradaOn.id).length;
          bekleyenOnaylar.delete(tel);
          await mesajGonder(tel,
            `ℹ️ *Zaten Sıradasınız!*\n\n` +
            `*${bekleyen.oyunAd}* için ${noOn}. sıradasınız.\n\n` +
            `Oyun çıkınca otomatik bildirim alacaksınız 🔔`
          );
          return;
        }

        const siradakiSayi = veri2.rezervasyonlar.filter(r => r.oyunId === bekleyen.oyunId && r.tip === kiraTip && r.durum === 'bekliyor').length;
        const maxRezervId = veri2.rezervasyonlar?.reduce((m, r) => Math.max(m, r.id || 0), 0) || 0;
        const yeniRezervId = Math.max(maxRezervId, veri2.nextId?.r || 0) + 1;
        if (!veri2.nextId) veri2.nextId = {};
        veri2.nextId.r = yeniRezervId + 1;
        veri2.rezervasyonlar.push({
          id: yeniRezervId,
          oyunId: bekleyen.oyunId,
          musteriId: bekleyen.musteriId,
          tip: kiraTip,
          tarih: bugun(),
          notlar: 'Bot - ön rezervasyon',
          durum: 'bekliyor',
          alinantarih: bugun()
        });
        await setVeri(veri2);
        bekleyenOnaylar.delete(tel);
        const tipLabel = kiraTip === 'primary' ? '🔵 Primary' : '🟣 Secondary';
        const o = veri2.oyunlar.find(x => x.id === bekleyen.oyunId);
        await mesajGonder(tel,
          `✅ *${bekleyen.oyunAd}* için ön rezervasyonunuz alındı!\n\n${tipLabel}\n📅 Oyun çıkış tarihi: ${fmtTarih(o?.cikis||'')}\n\nOyun çıktığında sıranız gelince otomatik bildirim gönderilir 🔔`
        );
        await banaGonder(`🗓 *Ön Rezervasyon (Bot)*\n👤 ${bekleyen.musteriAd}\n🎮 ${bekleyen.oyunAd} (${tipLabel})\n📅 Çıkış: ${o?.cikis||'?'}\n📍 Sıra: ${siradakiSayi + 1}`);
        return;
      }

      if (bekleyen.tip === 'rezerv_tip_bekle') {
        let kiraTip = null;
        if (metin.includes('primary') || metin === '1') kiraTip = 'primary';
        else if (metin.includes('secondary') || metin === '2') kiraTip = 'secondary';
        if (!kiraTip) { await mesajGonder(tel, `*1* - 🔵 Primary\n*2* - 🟣 Secondary`); return; }

        // Firebase'e rezervasyon ekle
        const veri2 = await getVeri();
        if (!veri2.rezervasyonlar) veri2.rezervasyonlar = [];

        // Müşteri zaten bu oyun için sırada mı?
        const zatenSirada = veri2.rezervasyonlar.find(r =>
          r.oyunId === bekleyen.oyunId &&
          r.musteriId === bekleyen.musteriId &&
          r.tip === kiraTip &&
          r.durum === 'bekliyor'
        );
        if (zatenSirada) {
          const siradakiNo = veri2.rezervasyonlar.filter(r => r.oyunId === bekleyen.oyunId && r.tip === kiraTip && r.durum === 'bekliyor' && r.id <= zatenSirada.id).length;
          const tipLabel2 = kiraTip === 'primary' ? '🔵 Primary' : '🟣 Secondary';
          bekleyenOnaylar.delete(tel);
          await mesajGonder(tel,
            `ℹ️ *Zaten Sıradasınız!*\n\n` +
            `*${bekleyen.oyunAd}* için ${tipLabel2} sırasında ${siradakiNo}. sıradasınız.\n\n` +
            `Slot açılınca otomatik bildirim alacaksınız 🔔`
          );
          return;
        }

        const siradakiSayi = veri2.rezervasyonlar.filter(r => r.oyunId === bekleyen.oyunId && r.tip === kiraTip && r.durum === 'bekliyor').length;
        const maxRezervId = veri2.rezervasyonlar?.reduce((m, r) => Math.max(m, r.id || 0), 0) || 0;
        const yeniRezervId = Math.max(maxRezervId, veri2.nextId?.r || 0) + 1;
        if (!veri2.nextId) veri2.nextId = {};
        veri2.nextId.r = yeniRezervId + 1;
        veri2.rezervasyonlar.push({
          id: yeniRezervId,
          oyunId: bekleyen.oyunId,
          musteriId: bekleyen.musteriId,
          tip: kiraTip,
          tarih: bugun(),
          notlar: 'Bot üzerinden eklendi',
          durum: 'bekliyor',
          alinantarih: bugun()
        });
        await setVeri(veri2);
        bekleyenOnaylar.delete(tel);
        const tipLabel = kiraTip === 'primary' ? '🔵 Primary' : '🟣 Secondary';
        await mesajGonder(tel,
          `✅ *${bekleyen.oyunAd}* için sıraya girdiniz!\n\n${tipLabel}\n\nSlot açılınca size otomatik bildirim gönderilir 🔔`
        );
        await banaGonder(`🔔 *Yeni Rezervasyon (Bot)*\n👤 ${bekleyen.musteriAd}\n🎮 ${bekleyen.oyunAd} (${tipLabel})\n📍 Sıra: ${siradakiSayi + 1}`);
        return;
      }

      if (bekleyen.tip === 'kiralama_tip_bekle') {
        let kiraTip = null;
        if (metin.includes('primary') || metin === '1') kiraTip = 'primary';
        else if (metin.includes('secondary') || metin === '2') kiraTip = 'secondary';
        if (!kiraTip) { await mesajGonder(tel, `*1* - 🔵 Primary\n*2* - 🟣 Secondary`); return; }
        // Dolu mu kontrol et
        if (kiraTip === 'primary' && bekleyen.priDolu) {
          await mesajGonder(tel, `🔵 Primary dolu! Lütfen 🟣 Secondary seçin (*2*) veya sıraya girin.`); return;
        }
        if (kiraTip === 'secondary' && bekleyen.secDolu) {
          await mesajGonder(tel, `🟣 Secondary dolu! Lütfen 🔵 Primary seçin (*1*) veya sıraya girin.`); return;
        }
        const oyun = veri.oyunlar.find(o => o.id === bekleyen.oyunId);
        const gf = gunlukFiyat(oyun, kiraTip);
        await mesajGonder(tel, `*${kiraTip === 'primary' ? '🔵 Primary' : '🟣 Secondary'}* seçildi.\n💰 Günlük: ${fmt(gf)}\n\nKaç gün kiralamak istiyorsunuz? (Min. 5 gün)`);
        bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'kiralama_gun_bekle', kiraTip, gunluk: gf });
        return;
      }

      // Kiralama akışı — gün girişi
      if (bekleyen.tip === 'kiralama_gun_bekle') {
        const gun = parseInt(metin);
        if (isNaN(gun) || gun < 5) { await mesajGonder(tel, `Minimum 5 gün. Kaç gün?`); return; }
        const bas = bugun();
        // Hediye gün hesapla: 10+ günde yeni çıkmış değilse +5, Platin ise yeni oyunda da +5
        const oyunHediye = veri.oyunlar.find(o => o.id === bekleyen.oyunId);
        const yeniOyun = oyunHediye?.yeniOyun || false;
        const tierHediye = getMusteriTierBot(musteri.id, veri);
        const platinMi = tierHediye.seviye === 'platin' || tierHediye.seviye === 'platinplus';
        const hediye = ((!yeniOyun || platinMi) && gun >= 10) ? 5 : 0;
        const toplamGun = gun + hediye;
        const bit = tarihEkle(bas, toplamGun);
        // Tier indirimini hesapla
        const tierMusteri = getMusteriTierBot(musteri.id, veri);
        const hamUcret = bekleyen.gunluk * gun;
        const indirimOrani = tierMusteri.indirim || 0;
        const indirimTL = Math.round(hamUcret * indirimOrani / 100);
        const ucret = hamUcret - indirimTL;
        let ozet = `📋 *Kiralama Özeti*\n\n🎮 *${bekleyen.oyunAd}*\n🎯 ${bekleyen.kiraTip}\n📅 ${gun} gün`;
        if (hediye > 0) ozet += platinMi && yeniOyun ? ` *+${hediye} gün hediye 🎁 (💎 Platin ayrıcalığı)*` : ` *+${hediye} gün hediye 🎁*`;
        ozet += ` (${bas} → ${bit})\n`;
        if (indirimOrani > 0) {
          ozet += `💰 Normal fiyat: ${fmt(hamUcret)}\n`;
          ozet += `${tierMusteri.emoji} *${tierMusteri.label} indirimi %${indirimOrani}: -${fmt(indirimTL)}*\n`;
          ozet += `✅ Ödenecek tutar: *${fmt(ucret)}*\n\n`;
        } else {
          ozet += `💰 Toplam: *${fmt(ucret)}*\n\n`;
        }
        // Bakiye kontrolü
        const mGuncel = veri.musteriler.find(m => m.id === bekleyen.musteriId);
        const mevcutBakiye = mGuncel?.bakiye || 0;
        if (mevcutBakiye >= ucret) {
          ozet += `💰 *Bakiyeniz yeterli!* (${fmt(mevcutBakiye)})\n\nBakiyenizden ödensin mi?\n*evet* → Bakiyeden öde\n*hayır* → Havale ile öde`;
          await mesajGonder(tel, ozet);
          bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'bakiye_onay', gun, hediye, toplamGun, ucret, indirim: indirimTL, bas, bit });
        } else {
          if (mevcutBakiye > 0) ozet += `💰 Mevcut bakiyeniz: *${fmt(mevcutBakiye)}*\n`;
          ozet += `*Ödeme Bilgileri:*\nIBAN: \`${CONFIG.IBAN}\`\nHesap Sahibi: ${CONFIG.HESAP_ISIM}\n\nÖdemeyi yaptıktan sonra dekontu buraya gönderin 📎`;
          await mesajGonder(tel, ozet);
          bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'yeni_kiralama_dekont', gun, hediye, toplamGun, ucret, indirim: indirimTL, bas, bit });
        }
        return;
      }

      // Yeni kiralama — dekont bekleniyor
      // Bakiyeden ödeme onayı
      if (bekleyen.tip === 'bakiye_onay') {
        if (metin === 'evet') {
          const mBakiyeOde = veri.musteriler.find(m => m.id === bekleyen.musteriId);
          if (!mBakiyeOde) { await mesajGonder(tel, 'Bir hata oluştu, tekrar deneyin.'); return; }
          if ((mBakiyeOde.bakiye||0) < bekleyen.ucret) {
            await mesajGonder(tel, `❌ Bakiyeniz yetersiz (${fmt(mBakiyeOde.bakiye||0)}). Havale ile ödeme yapın:\n💳 ${CONFIG.IBAN}\n👤 ${CONFIG.HESAP_ISIM}`);
            bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'yeni_kiralama_dekont' });
            return;
          }
          // Bakiyeden düş
          mBakiyeOde.bakiye = (mBakiyeOde.bakiye||0) - bekleyen.ucret;
          if (!mBakiyeOde.bakiyeGecmis) mBakiyeOde.bakiyeGecmis = [];
          mBakiyeOde.bakiyeGecmis.push({ tarih: bugun(), tutar: -bekleyen.ucret, aciklama: `${bekleyen.oyunAd} kiralaması` });
          await setVeri(veri);
          // Direkt onayla — dekont yok
          bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'yeni_kiralama_bekle', odemeTip: 'bakiye' });
          await banaGonder(`💰 *Bakiyeden Ödeme*\n👤 ${bekleyen.musteriAd}\n🎮 ${bekleyen.oyunAd}\n💰 ${fmt(bekleyen.ucret)} bakiyeden düşüldü\n\n#onayla ${tel.replace(/[^0-9]/g,'').slice(-10)}`);
          await mesajGonder(tel, `✅ *Bakiyenizden ${fmt(bekleyen.ucret)} düşüldü!*\n\nKalan bakiye: *${fmt(mBakiyeOde.bakiye)}*\n\nKiralamanız işleme alındı, kısa sürede onaylanacak 🙏`);
        } else if (metin === 'hayır' || metin === 'hayir') {
          bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'yeni_kiralama_dekont' });
          await mesajGonder(tel, `Ödemeyi yaptıktan sonra dekontu gönderin 📸\n\n💳 IBAN: ${CONFIG.IBAN}\n👤 ${CONFIG.HESAP_ISIM}`);
        } else {
          await mesajGonder(tel, `Bakiyenizden ödensin mi?\n*evet* → Bakiyeden öde\n*hayır* → Havale ile öde`);
        }
        return;
      }

      if (bekleyen.tip === 'yeni_kiralama_dekont') {
        if (medya) {
          bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'yeni_kiralama_bekle' });
          await mesajGonder(tel, `✅ Dekontunuz alındı! İşletmecimiz onayladıktan sonra kiralamanız başlayacak.\nBirkaç dakika içinde bildirim alacaksınız 🙏`);
          await banaGonder(
            `💰 *YENİ KİRALAMA DEKONTU!*\n\n` +
            `👤 Müşteri: *${musteriAd}*\n` +
            `🎮 Oyun: *${bekleyen.oyunAd}*\n` +
            `🎯 Tip: ${bekleyen.kiraTip}\n` +
            `📅 ${bekleyen.gun} gün (${bekleyen.bas} → ${bekleyen.bit})\n` +
            `💵 Tutar: *${fmt(bekleyen.ucret)}*\n\n` +
            `Onaylamak için:\n*#onayla ${tel.replace('@c.us','').replace('@lid','')}*`
          );
        } else if (metin === 'iptal' || metin === '#iptal' || metin === 'vazgeç' || metin === 'vazgec') {
          bekleyenOnaylar.delete(tel);
          await mesajGonder(tel, `❌ Kiralama iptal edildi.`);
        } else {
          await mesajGonder(tel, `Lütfen ödeme dekontunu *fotoğraf veya PDF* olarak gönderin 📎\n\n❌ İptal etmek için *iptal* yazın.`);
        }
        return;
      }

      // Uzatma — gün girişi
      if (bekleyen.tip === 'uzatma_gun_bekle') {
        const gun = parseInt(metin);
        if (isNaN(gun) || gun < 1) { await mesajGonder(tel, `Kaç gün uzatmak istiyorsunuz? (sayı yazın)`); return; }
        // Tier indirimi hesapla
        const tierUzat = getMusteriTierBot(musteri.id, veri);
        const hamUcretUzat = bekleyen.gunluk * gun;
        const indirimOraniUzat = tierUzat.indirim || 0;
        const indirimTLUzat = Math.round(hamUcretUzat * indirimOraniUzat / 100);
        const ucret = hamUcretUzat - indirimTLUzat;
        let uzatmaMesaj = `🔄 *${gun} gün uzatma*\n`;
        if (indirimOraniUzat > 0) {
          uzatmaMesaj += `💰 Normal: ${fmt(hamUcretUzat)}\n`;
          uzatmaMesaj += `${tierUzat.emoji} *${tierUzat.label} indirimi %${indirimOraniUzat}: -${fmt(indirimTLUzat)}*\n`;
          uzatmaMesaj += `✅ Ödenecek: *${fmt(ucret)}*\n\n`;
        } else {
          uzatmaMesaj += `💰 Tutar: *${fmt(ucret)}*\n\n`;
        }
        uzatmaMesaj += `*Ödeme:*\nIBAN: \`${CONFIG.IBAN}\`\nHesap Sahibi: ${CONFIG.HESAP_ISIM}\n\nDekontu buraya gönderin 📎`;
        await mesajGonder(tel, uzatmaMesaj);
        bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'uzatma_dekont', gun, ucret });
        return;
      }

      // Uzatma — dekont bekleniyor
      if (bekleyen.tip === 'uzatma_dekont') {
        if (medya) {
          bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'uzatma_isletmeci_bekle' });
          await mesajGonder(tel, `✅ Dekontunuz alındı! Onaylandıktan sonra uzatma yapılacak 🙏`);
          const oyun = veri.oyunlar.find(o => o.id === bekleyen.kiraId);
          await banaGonder(
            `💰 *UZATMA DEKONTU!*\n\n👤 *${musteriAd}*\n🎮 ${oyun?.ad||'?'}\n📅 ${bekleyen.gun} gün\n💵 ${fmt(bekleyen.ucret)}\n\n` +
            `Onaylamak için:\n*#onayla ${tel.replace('@c.us','').replace('@lid','')}*`
          );
        } else {
          await mesajGonder(tel, `Lütfen dekontu *fotoğraf veya PDF* olarak gönderin 📎`);
        }
        return;
      }

      // İade — onay bekleniyor
      // Tavsiye seçimi — iade sonrası
      if (bekleyen.tip === 'tavsiye_secim') {
        const { oneriler } = bekleyen;
        const sayi = parseInt(metin);
        let secilen = null;
        if (!isNaN(sayi) && sayi >= 1 && sayi <= oneriler.length) {
          secilen = oneriler[sayi - 1];
        } else if (metin === 'menü' || metin === 'menu' || metin === 'iptal') {
          bekleyenOnaylar.delete(tel);
          await mesajGonder(tel,
            `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon\n*9* - 💰 Bakiye Yükle`
          );
          return;
        }
        if (!secilen && metin.length > 2) {
          // Oyun adıyla arama
          const aramaMetin = metin.toLowerCase().replace(/[^a-z0-9ğüşıöç ]/gi, '');
          const bulunanlar = [...musaitOyunlar, ...(kiradaOyunlar||[])].filter(o =>
            o.ad.toLowerCase().includes(aramaMetin) ||
            aramaMetin.split(' ').some(k => k.length > 2 && o.ad.toLowerCase().includes(k))
          );
          if (bulunanlar.length === 1) {
            secilen = bulunanlar[0];
            secilenKirada = (kiradaOyunlar||[]).some(o => o.id === secilen.id);
          } else if (bulunanlar.length > 1) {
            const oneri = bulunanlar.slice(0,3).map((o,i)=>`*${i+1}* ${o.ad}`).join('\n');
            await mesajGonder(tel, `🔍 Şunları mı demek istediniz?\n\n${oneri}\n\nNumarasını yazın.`);
            bekleyenOnaylar.set(tel, { ...bekleyen, musaitOyunlar: bulunanlar.filter(o=>musaitOyunlar.includes(o)), kiradaOyunlar: bulunanlar.filter(o=>(kiradaOyunlar||[]).includes(o)) });
            return;
          }
        }
        if (!secilen) {
          await mesajGonder(tel, `Listeden bir numara yaz (1-${oneriler.length}), veya *menü* yaz.`);
          return;
        }
        // Seçilen oyunu kiralama akışına aktar
        const priDolu = veri.kiralamalar.filter(k => k.oyunId === secilen.id && k.tip === 'primary' && k.durum === 'aktif').length >= (secilen.ciftPrimary ? 2 : 1);
        const secDolu = veri.kiralamalar.filter(k => k.oyunId === secilen.id && k.tip === 'secondary' && k.durum === 'aktif').length >= 1;
        const pri = gunlukFiyat(secilen, 'primary');
        const sec = gunlukFiyat(secilen, 'secondary');
        await mesajGonder(tel,
          `🎮 *${secilen.ad}* (${secilen.platform})\n\nHangi tip kiralamak istiyorsunuz?\n\n` +
          `*1* - 🔵 Primary (${fmt(pri)}/gün)${priDolu ? ' — Dolu, sıraya girebilirsin' : ''}\n` +
          `*2* - 🟣 Secondary (${fmt(sec)}/gün)${secDolu ? ' — Dolu, sıraya girebilirsin' : ''}`
        );
        bekleyenOnaylar.set(tel, { tip: 'kiralama_tip_bekle', musteriId: bekleyen.musteriId, musteriAd, oyunId: secilen.id, oyunAd: secilen.ad, priDolu, secDolu });
        return;
      }

      // Oyun listesi — sıralama veya arama
      if (bekleyen.tip === 'oyun_liste_secim') {
        if (metin === 'a' || metin === 'alfabetik') {
          const tumO = veri.oyunlar.filter(o => !o.deaktif).sort((a,b) => a.ad.localeCompare(b.ad, 'tr'));
          const liste = tumO.map((o, i) => {
            const kirada = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
            const musait = ((o.kopyalar?.length||0)+1) - kirada > 0;
            const pri = gunlukFiyat(o, 'primary');
            const sec = gunlukFiyat(o, 'secondary');
            return `*${i+1}* ${musait?'✅':'⏳'} *${o.ad}* (${o.platform})\n   🔵 ${fmt(pri)}/gün  🟣 ${fmt(sec)}/gün`;
          }).join('\n\n');
          await mesajGonder(tel, `🎮 *Oyun Listesi (A-Z)*\n\n${liste}\n\n✅ Müsait  ⏳ Kirada`);
          bekleyenOnaylar.set(tel, { ...bekleyen, oyunIds: tumO.map(o=>o.id) });
          return;
        }
        // Oyun adıyla arama
        if (metin.length > 1) {
          const aramaMetin = metin.toLowerCase();
          const tumO = veri.oyunlar.filter(o => !o.deaktif);
          const bulunanlar = tumO.filter(o =>
            o.ad.toLowerCase().includes(aramaMetin) ||
            aramaMetin.split(' ').some(k => k.length > 2 && o.ad.toLowerCase().includes(k))
          );
          if (bulunanlar.length === 1) {
            const o = bulunanlar[0];
            const kirada = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
            const musait = ((o.kopyalar?.length||0)+1) - kirada > 0;
            const pri = gunlukFiyat(o, 'primary');
            const sec = gunlukFiyat(o, 'secondary');
            await mesajGonder(tel,
              `🎮 *${o.ad}* (${o.platform})\n\n` +
              `${musait ? '✅ Müsait' : '⏳ Şu an kirada'}\n` +
              `🔵 Primary: ${fmt(pri)}/gün\n🟣 Secondary: ${fmt(sec)}/gün\n\n` +
              (musait ? `Kiralamak için *5* yazın 🎮` : `Sıraya girmek için *5* yazın 🎮`)
            );
            bekleyenOnaylar.delete(tel);
            return;
          } else if (bulunanlar.length > 1 && bulunanlar.length <= 5) {
            const oneri = bulunanlar.map((o,i) => {
              const musait = ((o.kopyalar?.length||0)+1) - veri.kiralamalar.filter(k=>k.oyunId===o.id&&k.durum==='aktif').length > 0;
              return `*${i+1}* ${musait?'✅':'⏳'} ${o.ad}`;
            }).join('\n');
            await mesajGonder(tel, `🔍 *Şunları mı demek istediniz?*\n\n${oneri}\n\nNumarasını yazın veya tam adı girin.`);
            bekleyenOnaylar.set(tel, { ...bekleyen, oyunIds: bulunanlar.map(o=>o.id) });
            return;
          }
        }
        // Numara seçimi — state'i temizle, normal akışa bırak
        bekleyenOnaylar.delete(tel);
      }

      // Çoklu kiralama — uzatma oyun seçimi
      if (bekleyen.tip === 'uzatma_oyun_sec') {
        const sayi = parseInt(metin);
        const kiralar = bekleyen.kiralar || [];
        if (isNaN(sayi) || sayi < 1 || sayi > kiralar.length) {
          await mesajGonder(tel, `Lütfen listeden bir numara yazın (1-${kiralar.length})`);
          return;
        }
        const secilenKiraId = kiralar[sayi - 1];
        const secilenKira = veri.kiralamalar.find(k => k.id === secilenKiraId);
        const o = veri.oyunlar.find(x => x.id === secilenKira?.oyunId);
        const gf = gunlukFiyat(o, secilenKira?.tip);
        await mesajGonder(tel, `🔄 *Süre Uzatma*\n\n🎮 *${o?.ad}*\n📅 Bitiş: ${secilenKira?.bit}\n💰 Günlük: ${fmt(gf)}\n\nKaç gün uzatmak istiyorsunuz?`);
        bekleyenOnaylar.set(tel, { tip: 'uzatma_gun_bekle', kiraId: secilenKiraId, musteriId: secilenKira?.musteriId, gunluk: gf });
        return;
      }

      // Çoklu kiralama — iade oyun seçimi
      if (bekleyen.tip === 'iade_oyun_sec') {
        const sayi = parseInt(metin);
        const kiralar = bekleyen.kiralar || [];
        if (isNaN(sayi) || sayi < 1 || sayi > kiralar.length) {
          await mesajGonder(tel, `Lütfen listeden bir numara yazın (1-${kiralar.length})`);
          return;
        }
        const secilenKiraId = kiralar[sayi - 1];
        const secilenKira = veri.kiralamalar.find(k => k.id === secilenKiraId);
        const o = veri.oyunlar.find(x => x.id === secilenKira?.oyunId);
        await mesajGonder(tel, `📦 *${o?.ad}* oyununu iade etmek istiyorsunuz.\n\n*evet* yazarak onaylayın.`);
        bekleyenOnaylar.set(tel, { tip: 'iade_onay', kiraId: secilenKiraId });
        return;
      }

      // Bildirim sonrası seçim (bugün/yarın biten)
      if (bekleyen.tip === 'bildirim_secim') {
        const kiraId = bekleyen.kiraId;
        const gf = bekleyen.gunluk;
        if (metin === '3') {
          // İade
          const iadeKira = veri.kiralamalar.find(k => k.id === kiraId);
          const oyunIade = iadeKira ? veri.oyunlar.find(o => o.id === iadeKira.oyunId) : null;
          bekleyenOnaylar.set(tel, { tip: 'iade_onay', kiraId });
          await mesajGonder(tel,
            `📦 *İade Onayı*\n\n` +
            `*${oyunIade?.ad || 'Oyun'}* için iade işlemini onaylıyor musunuz?\n\n` +
            `*evet* yazarak onaylayın.`
          );
          return;
        } else if (metin === '2') {
          // Uzatma
          bekleyenOnaylar.set(tel, { tip: 'uzatma_gun_bekle', kiraId, gunluk: gf });
          await mesajGonder(tel, `🔄 *Süre Uzatma*\n\nKaç gün uzatmak istiyorsunuz?`);
          return;
        } else {
          await mesajGonder(tel, `📦 *İade etmek için* → *3* yazın\n🔄 *Uzatmak için* → *2* yazın`);
          return;
        }
      }

      if (bekleyen.tip === 'iade_onay') {
        if (metin === 'evet') {
          // Taze veri çek — stale veri sorunu önle
          const veriIade = await getVeri();
          const aktifKiralar = veriIade.kiralamalar.filter(k => k.musteriId === musteri.id && k.durum === 'aktif');
          const iadeKira = bekleyen.kiraId
            ? veriIade.kiralamalar.find(k => k.id == bekleyen.kiraId)
            : aktifKiralar[0];
          if (iadeKira) {
            iadeKira.durum = 'teslim';
            iadeKira.teslimTarih = new Date().toISOString().split('T')[0];
            // Oyun durumunu güncelle
            const oyunIade = veriIade.oyunlar.find(o => o.id === iadeKira.oyunId);
            if (oyunIade) {
              const halaKirada = veriIade.kiralamalar.some(k => k.id !== iadeKira.id && k.oyunId === iadeKira.oyunId && k.durum === 'aktif');
              if (!halaKirada) oyunIade.durum = 'mevcut';
            }
            bekleyenOnaylar.delete(tel);
            await setVeri(veriIade);
            const oyun = veri.oyunlar.find(o => o.id === iadeKira.oyunId);
            // Tipe göre hesap silme hatırlatması
            let iadeMesaj = `✅ İade bildiriminiz alındı! *${oyun?.ad}* için teşekkürler 🎮\n\n`;
            if (iadeKira.tip === 'primary') {
              iadeMesaj += `⚠️ *Önemli Hatırlatma:*\nLütfen konsolunuzdan şu adımları uygulayın:\n\n`;
              iadeMesaj += `*Ayarlar → Kullanıcılar ve Hesaplar → Diğer → Çevrimdışı Oynama → Devre Dışı Bırak*\n\n`;
              iadeMesaj += `Bu adımı tamamladıktan sonra hesabı konsolunuzdan silebilirsiniz 🙏`;
            } else {
              iadeMesaj += `⚠️ *Önemli Hatırlatma:*\nLütfen hesabı konsolunuzdan silmeyi unutmayın 🙏`;
            }
            await mesajGonder(tel, iadeMesaj);
            await banaGonder(`📦 *İADE BİLDİRİMİ*\n\n👤 ${musteriAd}\n🎮 ${oyun?.ad}\n🎯 ${iadeKira.tip}\n\n⚠️ Hesabı geri almayı unutma!`);

            // Tavsiye sistemi — müşterinin geçmiş kiralamaları dışındaki müsait oyunları öner
            try {
              await new Promise(r => setTimeout(r, 2000)); // 2 sn bekle
              const kiraliOyunIds = new Set(veriIade.kiralamalar.filter(k => k.musteriId === musteri.id).map(k => k.oyunId));
              // Collaborative filtering — aynı oyunları kiralayan müşterilerin tercihlerini baz al
              const benzerlik = new Map();
              veriIade.kiralamalar.forEach(k => {
                if (k.musteriId === musteri.id) return;
                if (kiraliOyunIds.has(k.oyunId)) benzerlik.set(k.musteriId, (benzerlik.get(k.musteriId)||0)+1);
              });
              const colSkor = new Map();
              veri.kiralamalar.forEach(k => {
                if (k.musteriId === musteri.id || kiraliOyunIds.has(k.oyunId)) return;
                const b = benzerlik.get(k.musteriId)||0;
                if (b > 0) colSkor.set(k.oyunId, (colSkor.get(k.oyunId)||0)+b);
              });
              const popSkor = new Map();
              veri.kiralamalar.forEach(k => {
                if (!kiraliOyunIds.has(k.oyunId)) {
                  if (!popSkor.has(k.oyunId)) popSkor.set(k.oyunId, new Set());
                  popSkor.get(k.oyunId).add(k.musteriId);
                }
              });
              const musaitOneriler = veri.oyunlar.filter(o =>
                !o.deaktif &&
                (!o.cikis || o.cikis <= bugun()) &&
                o.id !== iadeKira.oyunId &&
                !kiraliOyunIds.has(o.id)
              ).map(o => ({
                oyun: o,
                skor: (colSkor.get(o.id)||0)*3 + (popSkor.has(o.id)?popSkor.get(o.id).size:0)
              }))
              .filter(s => s.skor > 0)
              .sort((a, b) => b.skor - a.skor)
              .slice(0, 3)
              .map(s => s.oyun);

              // Skor yoksa popülerliğe göre fallback
              const oneriler = musaitOneriler.length > 0 ? musaitOneriler :
                veri.oyunlar.filter(o => !o.deaktif && (!o.cikis||o.cikis<=bugun()) && o.id !== aktifKira.oyunId && !kiraliOyunIds.has(o.id))
                  .sort((a,b) => (b.kiralamaSayisi||0)-(a.kiralamaSayisi||0)).slice(0,3);

              if (oneriler.length > 0) {
                let tavsiyeMesaj = `🎮 *Sana Özel Öneriler*\n\n`;
                tavsiyeMesaj += `*${oyun?.ad}* oyununu bitirdin, teşekkürler! 🙏\n\nBeğenebileceğini düşündüğümüz oyunlar:\n\n`;
                oneriler.forEach((o, i) => {
                  const aktifler = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif');
                  const priMusait = aktifler.filter(k => k.tip==='primary').length < (o.ciftPrimary ? 2 : 1);
                  const secMusait = aktifler.filter(k => k.tip==='secondary').length < 1;
                  const durum = (priMusait || secMusait) ? '✅ Müsait' : '⏳ Sıraya girebilirsin';
                  const pri = gunlukFiyat(o, 'primary');
                  const sec = gunlukFiyat(o, 'secondary');
                  tavsiyeMesaj += `*${i+1}* - 🎮 ${o.ad} (${o.platform})\n   ${durum} | 🔵${fmt(pri)} 🟣${fmt(sec)}/gün\n\n`;
                });
                tavsiyeMesaj += `Hemen kiralamak için numara yaz 👆\nVeya *menü* yaz 😊`;
                await mesajGonder(tel, tavsiyeMesaj);
                bekleyenOnaylar.set(tel, { tip: 'tavsiye_secim', musteriId: musteri.id, musteriAd, oneriler });
              }
            } catch(e) { console.error('Tavsiye hatası:', e.message); }
          }
        } else if (metin === 'hayır' || metin === 'hayir' || metin === 'iptal') {
          bekleyenOnaylar.delete(tel);
          await mesajGonder(tel,
            `İptal edildi 😊\n\n👋 *${musteriAd}*, başka bir şey yapabilir miyim?\n\n` +
            `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon\n*9* - 💰 Bakiye Yükle`
          );
          return;
        } else {
          await mesajGonder(tel, `İade için *evet*, iptal için *hayır* yazın.`);
          return;
        }
        bekleyenOnaylar.delete(tel);
        return;
      }
    }

    // ── ANA MENÜ ──
    if (['merhaba','selam','menu','menü','hi','başla','baslat','başlat','hey'].includes(metin)) {
      await mesajGonder(tel,
        `👋 Merhaba *${musteriAd}*!\n\nGameRental'a hoş geldiniz 🎮\n\n` +
        `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon\n*9* - 💰 Bakiye Yükle\n\nVeya sorunuzu yazın!`
      );
      return;
    }

    // 1 — Kiralama durumu
    if (metin === '1' || metin.includes('durumum') || metin.includes('kiralamam')) {
      // Aktif kiralama varsa durumu + kural hatırlatması göster
      if (musteri && aktifKiralar.length > 0) {
        let txt = `📋 *Aktif Kiralamalarınız*\n\n`;
        for (const k of aktifKiralar) {
          const o = veri.oyunlar.find(x => x.id === k.oyunId);
          const now = bugun();
          const gecGun = k.bit < now ? gunFarki(k.bit, now) : 0;
          const kalanGun = k.bit >= now ? gunFarki(now, k.bit) : 0;
          txt += `🎮 *${o?.ad||'?'}* (${k.tip})\n📅 Bitiş: ${k.bit}\n`;
          txt += gecGun > 0 ? `⚠️ *${gecGun} gün gecikmiş!*\n\n` : `✅ *${kalanGun} gün kaldı*\n\n`;
        }
        txt += `━━━━━━━━━━━━━━\n📌 *Hatırlatma*\n\n`;
        txt += `• Süreniz dolduğunda hesaba erişmeye devam etmeyin\n`;
        txt += `• 🔵 Primary bitince: önce ana hesabı devre dışı bırakın, sonra silin\n`;
        txt += `• 🟣 Secondary bitince: hesabı direkt silebilirsiniz\n`;
        txt += `• Sıra olan oyunlarda uzatma *1 kez* ile sınırlıdır`;
        await mesajGonder(tel, txt);
      } else {
        // Aktif kiralama yoksa süreç + kuralları anlat
        await mesajGonder(tel,
          `📋 *Kiralama Süreci & Kurallar*\n\n` +
          `*Nasıl kiralıyorum?*\n` +
          `1️⃣ *5* yazarak müsait oyunları gör\n` +
          `2️⃣ Oyunu ve kaç gün istediğini söyle\n` +
          `3️⃣ IBAN'a ödemeyi yap, dekontu gönder\n` +
          `4️⃣ Hesap bilgilerin iletilir ✅\n\n` +
          `*📌 Önemli Kurallar*\n\n` +
          `🔵 *Primary kiralama bitince:*\nÖnce PS hesabında "Ana Hesap"ı devre dışı bırakın, ardından hesabı silin.\n\n` +
          `🟣 *Secondary kiralama bitince:*\nHesabı direkt silebilirsiniz.\n\n` +
          `⏰ *Süre:*\nKiraladığınız gün kadar hesaba erişebilirsiniz. Süre dolduktan sonra hesaba erişmeye devam etmek güven ihlali sayılır.\n\n` +
          `🔄 *Uzatma:*\nSırası olan oyunlarda uzatma hakkı yalnızca *1 kez* kullanılabilir.\n\n` +
          `🎁 *Hediye Gün:*\nYeni çıkmış oyunlar hariç tüm oyunlarda 10 gün kiralamada *+5 gün hediye* otomatik eklenir.\n\n` +
          `Yeni kiralama için *5* yazın 🎮`
        );
      }
      return;
    }

    // 2 — Uzatma
    if (metin === '2' || metin.includes('uzat')) {
      if (!aktifKira) { await mesajGonder(tel, `Aktif kiralama bulunmuyor 🎮`); return; }
      if (aktifKiralar.length === 1) {
        // Tek kiralama — direkt uzat
        const o = veri.oyunlar.find(x => x.id === aktifKira.oyunId);
        const gf = gunlukFiyat(o, aktifKira.tip);
        await mesajGonder(tel, `🔄 *Süre Uzatma*\n\n🎮 *${o?.ad}*\n📅 Bitiş: ${aktifKira.bit}\n💰 Günlük: ${fmt(gf)}\n\nKaç gün uzatmak istiyorsunuz?`);
        bekleyenOnaylar.set(tel, { tip: 'uzatma_gun_bekle', kiraId: aktifKira.id, musteriId: aktifKira.musteriId, gunluk: gf });
      } else {
        // Birden fazla kiralama — hangisini uzatacak?
        let txt = `🔄 *Süre Uzatma*\n\nHangi oyunu uzatmak istiyorsunuz?\n\n`;
        aktifKiralar.forEach((k, i) => {
          const o = veri.oyunlar.find(x => x.id === k.oyunId);
          txt += `*${i+1}* - 🎮 ${o?.ad||'?'} (${k.tip}) — bitiş: ${k.bit}\n`;
        });
        await mesajGonder(tel, txt);
        bekleyenOnaylar.set(tel, { tip: 'uzatma_oyun_sec', kiralar: aktifKiralar.map(k => k.id) });
      }
      return;
    }

    // 3 — İade
    if (metin === '3' || metin.includes('iade') || metin.includes('teslim') || metin.includes('bitir')) {
      if (!aktifKira) { await mesajGonder(tel, `Aktif kiralama bulunmuyor 🎮`); return; }
      if (aktifKiralar.length === 1) {
        // Tek kiralama — direkt iade
        const o = veri.oyunlar.find(x => x.id === aktifKira.oyunId);
        await mesajGonder(tel, `📦 *${o?.ad}* oyununu iade etmek istiyorsunuz.\n\n*evet* yazarak onaylayın.`);
        bekleyenOnaylar.set(tel, { tip: 'iade_onay', kiraId: aktifKira.id });
      } else {
        // Birden fazla kiralama — hangisini iade edecek?
        let txt = `📦 *İade*\n\nHangi oyunu iade etmek istiyorsunuz?\n\n`;
        aktifKiralar.forEach((k, i) => {
          const o = veri.oyunlar.find(x => x.id === k.oyunId);
          txt += `*${i+1}* - 🎮 ${o?.ad||'?'} (${k.tip}) — bitiş: ${k.bit}\n`;
        });
        await mesajGonder(tel, txt);
        bekleyenOnaylar.set(tel, { tip: 'iade_oyun_sec', kiralar: aktifKiralar.map(k => k.id) });
      }
      return;
    }

    // 4 — Oyun listesi
    if (metin === '4' || metin === 'oyunlar' || metin.includes('müsait') || metin.includes('musait') || metin.includes('liste')) {
      function oyunListesiGonder(sirala) {
        const tumO = veri.oyunlar.filter(o => !o.deaktif).sort((a,b) => {
          if (sirala === 'alfa') return a.ad.localeCompare(b.ad, 'tr');
          // Varsayılan: müsait önce, sonra id
          const aM = ((a.kopyalar?.length||0)+1) - veri.kiralamalar.filter(k=>k.oyunId===a.id&&k.durum==='aktif').length > 0;
          const bM = ((b.kopyalar?.length||0)+1) - veri.kiralamalar.filter(k=>k.oyunId===b.id&&k.durum==='aktif').length > 0;
          if (aM && !bM) return -1; if (!aM && bM) return 1;
          return b.id - a.id;
        });
        const liste = tumO.map((o, i) => {
          const kirada = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
          const musait = ((o.kopyalar?.length||0)+1) - kirada > 0;
          const pri = gunlukFiyat(o, 'primary');
          const sec = gunlukFiyat(o, 'secondary');
          return `*${i+1}* ${musait?'✅':'⏳'} *${o.ad}* (${o.platform})\n   🔵 ${fmt(pri)}/gün  🟣 ${fmt(sec)}/gün`;
        }).join('\n\n');
        return { liste, tumO };
      }
      const { liste, tumO } = oyunListesiGonder('varsayilan');
      await mesajGonder(tel,
        `🎮 *Oyun Listesi*\n\n${liste}\n\n` +
        `✅ Müsait  ⏳ Kirada\n\n` +
        `📌 Alfabetik sıralamak için *A* yazın\n` +
        `🔍 Aklınızda bir oyun varsa adını yazın`
      );
      bekleyenOnaylar.set(tel, { tip: 'oyun_liste_secim', oyunIds: tumO.map(o=>o.id) });
      return;
    }

    // 6 — Tier / Üyelik seviyesi
    if (metin === '6' || metin.includes('tier') || metin.includes('seviyem') || metin.includes('üyeliğim') || metin.includes('uyelik') || metin.includes('seviye') || metin.includes('kaç puan') || metin.includes('indirimim') || metin.includes('puanım')) {
      if (!musteri) {
        await mesajGonder(tel, `Üyelik bilgisi için önce kayıtlı olmanız gerekiyor.\nİşletmecimize ulaşın 🎮`);
        return;
      }
      const tier = getMusteriTierBot(musteri.id, veri);
      await mesajGonder(tel, tierMesajiOlustur(tier, musteriAd, veri));
      return;
    }

    // 5 — Yeni kiralama
    if (metin === '5' || metin.includes('yeni kiralama') || metin.includes('kiralamak istiyorum') || metin.includes('kiralayabilir miyim')) {
      if (!musteri) {
        await mesajGonder(tel, `Kiralama için önce kayıtlı olmanız gerekiyor.\nİşletmecimize ulaşın 🎮`);
        await banaGonder(`🛒 *Kayıtsız Kiralama Talebi*\nWhatsApp: ${tel}\nMesaj: "${metinOrijinal}"`);
        return;
      }
      if (musteri.onKayit) {
        await mesajGonder(tel,
          `⏳ *Kaydınız Henüz Onaylanmadı*\n\n` +
          `Üyeliğiniz işletmecimiz tarafından inceleniyor.\n` +
          `Onaylandıktan sonra tüm hizmetlerimizden yararlanabilirsiniz.\n\n` +
          `En kısa sürede bildirim alacaksınız 🙏`
        );
        return;
      }
      const tumOyunlar = veri.oyunlar.filter(o => !o.deaktif).sort((a,b) => b.id - a.id);

      function slotDurumu(o) {
        const aktif = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif');
        const priKirada = aktif.filter(k => k.tip === 'primary').length;
        const secKirada = aktif.filter(k => k.tip === 'secondary').length;
        const maxPri = (o.ciftPrimary ? 2 : 1) + (o.kopyalar||[]).filter(k=>!k.satildi).reduce((s,k)=>s+(k.ciftPrimary?2:1),0);
        const maxSec = 1 + (o.kopyalar||[]).filter(k=>!k.satildi).length;
        return { priMusait: priKirada < maxPri, secMusait: secKirada < maxSec };
      }

      const musaitOyunlar = tumOyunlar.filter(o => { const s=slotDurumu(o); return s.priMusait||s.secMusait; });
      const kiradaOyunlar = tumOyunlar.filter(o => { const s=slotDurumu(o); return !s.priMusait&&!s.secMusait; });

      let liste = '';
      musaitOyunlar.forEach((o, i) => {
        const pri = gunlukFiyat(o, 'primary');
        const sec = gunlukFiyat(o, 'secondary');
        const s = slotDurumu(o);
        const priLabel = s.priMusait ? `🔵${fmt(pri)}/gün` : `🔵dolu`;
        const secLabel = s.secMusait ? `🟣${fmt(sec)}/gün` : `🟣dolu`;
        liste += `*${i+1}* - ✅ ${o.ad} (${o.platform}) | ${priLabel}  ${secLabel}\n`;
      });
      if (kiradaOyunlar.length > 0) {
        liste += `\n⏳ *Şu an kirada (sıraya girebilirsin):*\n`;
        kiradaOyunlar.forEach(o => {
          const pri = gunlukFiyat(o, 'primary');
          const sec = gunlukFiyat(o, 'secondary');
          const siradaki = (veri.rezervasyonlar||[]).filter(r => r.oyunId === o.id && r.durum === 'bekliyor').length;
          liste += `❌ ${o.ad} (${o.platform}) | 🔵${fmt(pri)} 🟣${fmt(sec)}/gün${siradaki > 0 ? ` | 👥 ${siradaki} kişi sırada` : ''}\n`;
        });
      }

      if (!liste) { await mesajGonder(tel, `Şu an müsait oyun bulunmuyor 😔`); return; }
      await mesajGonder(tel, `🎮 *Oyun Listesi*\n\n${liste}\nKiralamak veya sıraya girmek istediğiniz oyunun adını ya da numarasını yazın.`);
      bekleyenOnaylar.set(tel, { tip: 'kiralama_oyun_bekle', musteriId: musteri.id, musteriAd, musaitOyunlar, kiradaOyunlar });
      return;
    }

    // ── SSS — Claude'a gitmeden önce keyword kontrolü ──
    const sssCevap = sssKontrol(metin, musteriAd);
    if (sssCevap) {
      await mesajGonder(tel, sssCevap);
      return;
    }

    // Kiralama talebi bildirimi
    if (metin.includes('kiralamak') || metin.includes('kiralayabilir')) {
      await banaGonder(`🎮 *Kiralama Talebi*\n👤 ${musteriAd}\n💬 "${metinOrijinal}"`);
    }

    // 8 — Çıkacak Oyunlar / Ön Rezervasyon
    if (metin === '8' || metin.includes('çıkacak') || metin.includes('ön rezerv') || metin.includes('on rezerv') || metin.includes('çıkacak oyun')) {
      const veriOn = await getVeri();
      const now = bugun();
      const cikacakOyunlar = veriOn.oyunlar.filter(o => !o.deaktif && o.cikis && o.cikis > now)
        .sort((a, b) => a.cikis.localeCompare(b.cikis));
      if (cikacakOyunlar.length === 0) {
        await mesajGonder(tel, `🗓 Şu an henüz çıkmamış oyun bulunmuyor.\n\nYeni oyunlar eklendiğinde buradan görebilirsiniz! 🎮`);
        return;
      }
      let onListe = `🗓 *Çıkacak Oyunlar*\n\nAşağıdaki oyunlar için ön rezervasyon yapabilirsiniz.\nOyun çıktığında sıranız gelince otomatik bildirim alırsınız! 🔔\n\n`;
      cikacakOyunlar.forEach((o, i) => {
        const siradaki = (veriOn.rezervasyonlar||[]).filter(r => r.oyunId === o.id && r.durum === 'bekliyor').length;
        onListe += `*${i+1}* - 🎮 ${o.ad} (${o.platform})\n`;
        onListe += `   📅 Çıkış: ${fmtTarih(o.cikis)}\n`;
      });
      onListe += `\nHangi oyun için yer ayırtmak istiyorsunuz? Numarasını yazın.`;
      await mesajGonder(tel, onListe);
      bekleyenOnaylar.set(tel, { tip: 'on_rezerv_oyun_bekle', musteriId: musteri.id, cikacakOyunlar });
      return;
    }

    // 9 — Bakiye Yükle
    if (metin === '9' || metin.includes('bakiye') || metin.includes('bakiyem')) {
      const mBakiyeGor = veri.musteriler.find(m => m.id === musteri.id);
      const bakiyeMevcut = mBakiyeGor?.bakiye || 0;
      await mesajGonder(tel,
        `💰 *Bakiye Yükleme*\n\n` +
        `Mevcut bakiyeniz: *${fmt(bakiyeMevcut)}*\n\n` +
        `Bakiye yüklemek için aşağıdaki hesaba havale yapın:\n\n` +
        `💳 IBAN: \`${CONFIG.IBAN}\`\n` +
        `👤 Hesap Sahibi: ${CONFIG.HESAP_ISIM}\n\n` +
        `Havale açıklamasına *adınızı ve soyadınızı* yazmayı unutmayın!\n\n` +
        `Dekontu buraya gönderin, bakiyeniz kısa sürede yüklenecektir 🙏\n\n` +
        `${BAKIYE_BILGI}`
      );
      bekleyenOnaylar.set(tel, { tip: 'bakiye_yukle_dekont', musteriId: musteri.id, musteriAd });
      return;
    }

    // 7 — Yetkili ile görüş
    if (metin === '7' || metin.includes('yetkili') || metin.includes('hocam') ||
        metin.includes('insan') || metin.includes('sizi') || metin.includes('sizinle') ||
        metin.includes('görüşmek') || metin.includes('konuşmak') || metin.includes('aramak') ||
        metin.includes('arayabilir') || metin.includes('yetkiliye') || metin.includes('sahibi')) {
      // Tatil modu kontrolü
      if (veri.tatilModu && veri.tatilModu.aktif) {
        const tMesaj = (veri.tatilModu.mesaj || '')
          .replace(/\[İsim\]/g, musteriAd)
          .replace(/\[Tarih\]/g, veri.tatilModu.tarih ? fmtTarih(veri.tatilModu.tarih) : '?')
          .replace(/\[Süre\]/g,  veri.tatilModu.sure  || '1-2 saat');
        if (tMesaj) { await mesajGonder(tel, tMesaj); return; }
      }
      await mesajGonder(tel,
        `👤 *Yetkili ile Görüşme*\n\n` +
        `Mesajınız alındı, yetkili en kısa sürede sizinle ilgilenecek 🙏\n\n` +
        `Lütfen bekleyin, bağlanıyor...`
      );
      const ytkLidKisa = tel.replace(/[^0-9]/g,"").slice(-10);
      await banaGonder(`🔔 *Yetkili Talebi*\n\n👤 ${musteriAd}\n📞 ${tel}\n💬 "${metinOrijinal}"\n\n✅ Bot susturuldu.\n➡️ Açmak için: #ac ${ytkLidKisa}`);
      const telSadeYetkili = tel.replace(/[^0-9]/g,'');
      insanDevraldi.set(tel, Date.now());
      insanDevraldi.set(telSadeYetkili + '@c.us', Date.now());
      insanDevraldi.set(telSadeYetkili + '@lid', Date.now());
      await banaGonder('\u2705 Bot susturuldu. A\u00e7mak i\u00e7in: #ac ' + telSadeYetkili);
      return;
    }

    // Tatil modu — menü göndermeden önce kontrol
    if (veri.tatilModu?.aktif) {
      const sonTatil = sonMenuGonderilen.get('tatil_' + tel) || 0;
      if (Date.now() - sonTatil > 3 * 60 * 60 * 1000) { // 3 saatte bir hatırlat
        const tatilMesajF = (veri.tatilModu.mesaj || '')
          .replace(/\[İsim\]/g, musteriAd)
          .replace(/\[Tarih\]/g, veri.tatilModu.tarih ? fmtTarih(veri.tatilModu.tarih) : '?')
          .replace(/\[Süre\]/g,  veri.tatilModu.sure  || '1-2 saat');
        if (tatilMesajF) {
          sonMenuGonderilen.set('tatil_' + tel, Date.now());
          // Sadece bekleyen state yoksa gönder
          if (!bekleyen) await mesajGonder(tel, tatilMesajF);
        }
      }
    }

    // #iptal — müşteri akışı iptal edebilir
    if (metin === 'iptal' || metin === '#iptal' || metin === 'vazgeç' || metin === 'vazgec') {
      bekleyenOnaylar.delete(tel);
      await mesajGonder(tel, `❌ İşlem iptal edildi.\n\nAna menü için *menü* yazabilirsiniz.`);
      return;
    }

    // Anlaşılmayan mesaj — menüye yönlendir
    // İnsan devralıyorsa veya son 30 dakika içinde menü gönderildiyse gönderme
    const sonMenu = sonMenuGonderilen.get(tel) || 0;
    const menuAralik = 30 * 60 * 1000; // 30 dakika
    const insanVar = insanDevraldi.has(tel) || insanDevraldi.has(tel.replace('@lid','@c.us')) || insanDevraldi.has(tel.replace('@c.us','@lid'));
    if (!insanVar && Date.now() - sonMenu > menuAralik) {
      sonMenuGonderilen.set(tel, Date.now());
      await mesajGonder(tel,
        `Merhaba ${musteriAd}! 😊\n\nAşağıdaki seçeneklerden birini yazabilirsin:\n\n` +
        `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon\n*9* - 💰 Bakiye Yükle`
      );
    }

  } catch (err) {
    console.error('Webhook genel hata:', err.message, err.stack);
  }
});

// ── ZAMANLANMIŞ ──
async function yarinBitenKontrol() {
  const veri = await getVeri(); if (!veri) return;
  const yarin = yarinStr();
  for (const k of veri.kiralamalar.filter(k => k.durum === 'aktif' && k.bit === yarin)) {
    const m = veri.musteriler.find(x => x.id === k.musteriId);
    const o = veri.oyunlar.find(x => x.id === k.oyunId);
    if (!m) continue;
    const hedef = m.whatsappLid || (m.tel ? temizTel(m.tel) + '@c.us' : null);
    if (!hedef) continue;
    const gf = gunlukFiyat(o, k.tip);
    const yarinKey = `yarin_${k.id}_${yarin}`;
    if (bildirimGonderildi.get(yarinKey)) { console.log(`⏭ Zaten gönderildi: ${yarinKey}`); continue; }
    const musteriAdi = ((m.ad||'') + ' ' + (m.soyad||'')).trim() || 'Değerli Müşteri';
    await mesajGonder(hedef, `🔔 *Hatırlatıcı*\n\nMerhaba *${musteriAdi}*!\n*${o?.ad}* oyununuz *yarın* bitiyor.\n\n📦 *İade etmek için* → *3* yazın\n🔄 *Uzatmak için* → *2* yazın 🎮`);
    bildirimGonderildi.set(yarinKey, true);
    bekleyenSet(m, { tip: 'bildirim_secim', kiraId: parseInt(k.id), gunluk: gf });
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function bugunBitenKontrol() {
  const veri = await getVeri(); if (!veri) return;
  const bugunTarih = bugun();
  for (const k of veri.kiralamalar.filter(k => k.durum === 'aktif' && k.bit === bugunTarih)) {
    const m = veri.musteriler.find(x => x.id === k.musteriId);
    const o = veri.oyunlar.find(x => x.id === k.oyunId);
    if (!m) continue;
    const hedef = m.whatsappLid || (m.tel ? temizTel(m.tel) + '@c.us' : null);
    if (!hedef) continue;
    const gf = gunlukFiyat(o, k.tip);
    const bugunKey = `bugun_${k.id}_${bugunTarih}`;
    if (bildirimGonderildi.get(bugunKey)) { console.log(`⏭ Zaten gönderildi: ${bugunKey}`); continue; }
    const musteriAdiBugun = ((m.ad||'') + ' ' + (m.soyad||'')).trim() || 'Değerli Müşteri';
    await mesajGonder(hedef,
      `⏰ *Süre Bugün Bitiyor!*\n\n` +
      `Merhaba *${musteriAdiBugun}*! *${o?.ad}* oyununuzun kiralama süresi *bugün* sona eriyor.\n\n` +
      `Güven puanınızda sorun yaşamamak için lütfen:\n\n` +
      `📦 *İade etmek için* → *3* yazın\n` +
      `🔄 *Uzatmak için* → *2* yazın\n\n` +
      `Teşekkürler! 🎮`
    );
    bildirimGonderildi.set(bugunKey, true);
    bekleyenSet(m, { tip: 'bildirim_secim', kiraId: parseInt(k.id), gunluk: gf });
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function gecikmeKontrol() {
  const veri = await getVeri(); if (!veri) return;
  const now = bugun();
  const gecikmeOzet = [];
  for (const k of veri.kiralamalar.filter(k => k.durum === 'aktif' && k.bit < now)) {
    try {
      const s = await db.collection('botState').doc(`uyari_${k.id}`).get();
      if (s.exists && s.data().tarih === now) continue;
    } catch(e) {}
    const m = veri.musteriler.find(x => x.id === k.musteriId);
    const o = veri.oyunlar.find(x => x.id === k.oyunId);
    if (!m) continue;
    const hedef = m.whatsappLid || (m.tel ? temizTel(m.tel) + '@c.us' : null);
    if (!hedef) continue;
    const gecGun = gunFarki(k.bit, now);
    const gf = gunlukFiyat(o, k.tip);
    const musteriAdiG = ((m.ad||'') + ' ' + (m.soyad||'')).trim() || 'Değerli Müşteri';
    await mesajGonder(hedef,
      `⚠️ *Gecikmiş İade*\n\nMerhaba *${musteriAdiG}*!\n\n*${o?.ad}* oyununuzun iade süresi *${gecGun} gün* geçti.\n💰 Gecikme ücreti: *${fmt(gf*gecGun)}*\n\n📦 İade için → *3* yazın\n🔄 Uzatmak için → *2* yazın\n\nLütfen en kısa sürede işlem yapın 🙏`
    );
    bekleyenSet(m, { tip: 'bildirim_secim', kiraId: parseInt(k.id), gunluk: gf });
    gecikmeOzet.push(`• ${musteriAdiG} — ${o?.ad} (${gecGun}g, +${fmt(gf*gecGun)})`);
    try { await db.collection('botState').doc(`uyari_${k.id}`).set({ tarih: now }); } catch(e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  // İşletmeciye özet
  if (gecikmeOzet.length > 0) {
    await banaGonder(`⚠️ *Gecikme Özeti* (${now})\n\n${gecikmeOzet.join('\n')}`);
  }
}

async function rezervSiraKontrol() {
  const veri = await getVeri(); if (!veri) return;
  const now = bugun();

  // Her oyun+tip kombinasyonu için kontrol et
  const oyunTipCiftleri = new Set(
    veri.rezervasyonlar.filter(r => r.durum === 'bekliyor')
      .map(r => `${r.oyunId}_${r.tip}`)
  );

  for (const cift of oyunTipCiftleri) {
    const [oyunIdStr, tip] = cift.split('_');
    const oyunId = parseInt(oyunIdStr);
    const o = veri.oyunlar.find(x => x.id === oyunId);
    if (!o) continue;


    // Oyun henüz çıkmadıysa bildirim atma
    if (o.cikis && o.cikis > now) {
      console.log(`⏳ ${o.ad} henüz çıkmadı (${o.cikis}), rezerv bildirimi atlandı`);
      continue;
    }

    // Slot müsait mi?
    const aktifSayisi = veri.kiralamalar.filter(k => k.oyunId === oyunId && k.tip === tip && k.durum === 'aktif').length;
    const maxSlot = tip === 'primary' ? (o.ciftPrimary ? 2 : 1) : 1;
    if (aktifSayisi >= maxSlot) continue; // slot dolu, geç

    // Slot müsait — sıradaki ilk kişiyi bul
    // Platin+ üyeler sıranın başına geçer
    const siralar = veri.rezervasyonlar
      .filter(r => r.oyunId === oyunId && r.tip === tip && r.durum === 'bekliyor' && !r.atla)
      .sort((a, b) => {
        const tierA = getMusteriTierBot(a.musteriId, veri);
        const tierB = getMusteriTierBot(b.musteriId, veri);
        const platinPlusA = tierA.seviye === 'platinplus' ? 0 : 1;
        const platinPlusB = tierB.seviye === 'platinplus' ? 0 : 1;
        if (platinPlusA !== platinPlusB) return platinPlusA - platinPlusB;
        return (a.sira || a.id) - (b.sira || b.id);
      });

    if (!siralar.length) continue;
    const ilk = siralar[0];
    const ilkTier = getMusteriTierBot(ilk.musteriId, veri);
    const oncelikli = ilkTier.seviye === 'platinplus';

    // Bu kişiye bugün zaten bildirim attık mı? — rezervasyon kaydında tut
    if (ilk.sonBildirimTarih === now) {
      console.log(`⏭ Bugün zaten bildirim gönderildi: ${ilk.id}`);
      continue;
    }

    const m = veri.musteriler.find(x => x.id === ilk.musteriId);
    if (!m) continue;
    const hedef = m.whatsappLid || (m.tel ? temizTel(m.tel) + '@c.us' : null);
    if (!hedef) continue;

    const musteriAd = m.ad || m.soyad || m.tel;
    const tipLabel = tip === 'primary' ? '🔵 Primary' : '🟣 Secondary';

    const oncelikMesaji = oncelikli ? `\n\n👑 *Platin+ Ayrıcalığı:* Sıra önceliğiniz sayesinde ilk bildirim size gönderildi! 24 saat öncelikli hakkınız var.` : '';
    await mesajGonder(hedef,
      `🎉 *Sıran Geldi!*\n\nMerhaba ${musteriAd}!\n\n*${o.ad}* için beklediğin slot artık müsait! ${tipLabel}${oncelikMesaji}\n\nKiralama için ödemeyi yapıp dekontu gönder, hemen aktifleştirelim 🚀\n\n💳 IBAN: ${CONFIG.IBAN}\n👤 ${CONFIG.HESAP_ISIM}`
    );

    await banaGonder(`🔔 *Rezerv Bildirimi Gönderildi*\n• ${musteriAd} → ${o.ad} (${tipLabel})${oncelikli ? '\n👑 Platin+ öncelikli bildirim!' : ''}`);

    // Bildirim tarihini rezervasyona kaydet
    ilk.sonBildirimTarih = now;
    await setVeri(veri);
    await new Promise(r => setTimeout(r, 1000));
  }
}


// Restart sonrası hemen çalışmasın — ilk kontrol 1 saat sonra
// Gecikme kontrolü: Firebase'e tarih yazar, aynı gün tekrar atmaz
let _ilkBaslangic = Date.now();
setInterval(async () => {
  if (Date.now() - _ilkBaslangic < 60 * 60 * 1000) {
    console.log('⏳ Zamanlayıcı bekleme modunda (restart sonrası)');
    return;
  }
  const saat = new Date().getHours();
  if (saat === 15) await yarinBitenKontrol();
  if (saat === 15) await bugunBitenKontrol();
  await gecikmeKontrol();
  // Rezerv bildirimi sadece 09:00-21:00 arası çalışsın
  if (saat >= 9 && saat < 21) await rezervSiraKontrol();
  else console.log(`🌙 Rezerv kontrol atlandı (saat ${saat}:xx)`);
}, 60 * 60 * 1000);

// ── TOPLU DUYURU API ──
// Site buraya POST atar: { mesaj, alicilar: [{tel, ad}], apiKey }
app.post('/api/duyuru-onay', async (req, res) => {
  const { tel, ad, apiKey } = req.body || {};
  if (apiKey !== (CONFIG.WAHA_API_KEY || 'admin')) return res.status(401).json({ hata: 'Yetkisiz' });
  if (!tel) return res.status(400).json({ hata: 'tel gerekli' });
  try {
    const adTemiz = (ad||'Müşterimiz').trim();
    // Tatil modu aktifse onay mesajına tatil bilgisini ekle
    const veriOnay = await db.collection('users').doc(CONFIG.USER_UID).collection('data').doc('psrental').get();
    const tatilModu = veriOnay.exists ? (veriOnay.data().tatilModu || {}) : {};
    let tatilEki = '';
    if (tatilModu.aktif && tatilModu.mesaj) {
      tatilEki = `\n\n━━━━━━━━━━━━━━━━━━━━━\n` + tatilModu.mesaj
        .replace(/\[İsim\]/g, adTemiz)
        .replace(/\[Tarih\]/g, tatilModu.tarih ? fmtTarih(tatilModu.tarih) : '?')
        .replace(/\[Süre\]/g, tatilModu.sure || '1-2 saat');
    }
    await mesajGonder(tel,
      `✅ *Kaydınız Onaylandı!*\n\n` +
      `Merhaba *${adTemiz}*! 🎉\n\n` +
      `GameRental üyeliğiniz onaylandı, artık tüm hizmetlerimizden yararlanabilirsiniz.\n\n` +
      `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon\n*9* - 💰 Bakiye Yükle\n\nHoş geldiniz! 🎮` +
      tatilEki
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ hata: e.message });
  }
});

app.post('/api/duyuru', async (req, res) => {
  const { mesaj, alicilar, apiKey } = req.body || {};

  // Basit güvenlik: aynı WAHA api key ile doğrula
  if (apiKey !== (CONFIG.WAHA_API_KEY || 'admin')) {
    return res.status(401).json({ hata: 'Yetkisiz' });
  }
  if (!mesaj || !Array.isArray(alicilar) || alicilar.length === 0) {
    return res.status(400).json({ hata: 'mesaj ve alicilar zorunlu' });
  }

  res.json({ durum: 'basliyor', toplam: alicilar.length });

  // Arka planda gönder — her mesaj arasında 2sn bekle (spam koruması)
  let basarili = 0, basarisiz = 0;
  for (const kisi of alicilar) {
    const tel = temizTel(String(kisi.tel || ''));
    if (tel.length < 10) { basarisiz++; continue; }
    const kisiMesaj = mesaj.replace('{isim}', kisi.ad || 'Değerli Müşterimiz');
    await mesajGonder(tel, kisiMesaj);
    basarili++;
    await new Promise(r => setTimeout(r, 2000)); // 2sn ara
  }

  const ozet = `📣 Toplu duyuru tamamlandı\n✅ ${basarili} başarılı\n❌ ${basarisiz} başarısız`;
  console.log(ozet);
  await banaGonder(ozet);
});

app.get('/', (req, res) => res.send('🎮 GameRental Bot çalışıyor!'));
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Port ${CONFIG.PORT} hazır`);
});
