const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
app.use(express.json());

// ══════════════════════════════════════════
// YAPILANDIRMA
// ══════════════════════════════════════════
const CONFIG = {
  FIREBASE_PROJECT: 'gamerental-fb121',
  USER_UID: process.env.USER_UID,
  BENIM_NUMARAM: process.env.BENIM_NUMARAM, // 905xxxxxxxxx formatında
  WAHA_URL: process.env.WAHA_URL || 'http://localhost:3000',
  WAHA_API_KEY: process.env.WAHA_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  PORT: process.env.PORT || 3001,
};

// ══════════════════════════════════════════
// FIREBASE BAŞLAT
// ══════════════════════════════════════════
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(decoded);
    console.log('Firebase: B64 ile yüklendi');
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('Firebase: JSON ile yüklendi');
  } else {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 veya FIREBASE_SERVICE_ACCOUNT tanımlı değil');
  }
} catch (e) {
  console.error('Firebase service account parse hatası:', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: CONFIG.FIREBASE_PROJECT,
});
const db = admin.firestore();

async function getVeri() {
  const doc = await db
    .collection('users').doc(CONFIG.USER_UID)
    .collection('data').doc('psrental')
    .get();
  return doc.exists ? doc.data() : null;
}

async function setVeri(data) {
  await db
    .collection('users').doc(CONFIG.USER_UID)
    .collection('data').doc('psrental')
    .set(data);
}

// ══════════════════════════════════════════
// YARDIMCI FONKSİYONLAR
// ══════════════════════════════════════════
function bugun() {
  return new Date().toISOString().split('T')[0];
}

function yarinStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

function gunFarki(d1, d2) {
  return Math.round((new Date(d2) - new Date(d1)) / 86400000);
}

function formatPara(n) {
  return '₺' + (n || 0).toLocaleString('tr-TR');
}

function temizTel(tel) {
  // 905xxxxxxxxx formatına çevir
  return tel.replace(/[^0-9]/g, '').replace(/^0/, '90').replace(/^(?!90)/, '90');
}

// ══════════════════════════════════════════
// WAHA — MESAJ GÖNDER
// ══════════════════════════════════════════
async function mesajGonder(tel, metin) {
  try {
    const chatId = tel.includes('@') ? tel : tel + '@c.us';
    await axios.post(`${CONFIG.WAHA_URL}/api/sendText`, {
      session: 'default',
      chatId,
      text: metin,
    }, {
      headers: CONFIG.WAHA_API_KEY ? { 'X-Api-Key': CONFIG.WAHA_API_KEY } : {},
    });
    console.log(`📤 Mesaj gönderildi: ${tel}`);
  } catch (e) {
    console.error('Mesaj gönderim hatası:', e.message);
  }
}

async function benimEkranim(metin) {
  if (CONFIG.BENIM_NUMARAM) {
    await mesajGonder(CONFIG.BENIM_NUMARAM, metin);
  }
}

// ══════════════════════════════════════════
// CLAUDE API
// ══════════════════════════════════════════
const konusmalar = new Map();

async function claudeCevap(musteriAd, mesaj, musteriGecmis, oyunListesi) {
  const history = konusmalar.get(musteriAd) || [];
  history.push({ role: 'user', content: mesaj });

  // Son 6 mesajı tut (3 tur)
  const kisaltilmisHistory = history.slice(-6);
  console.log('Claude API çağrısı:', musteriAd, 'mesaj sayısı:', kisaltilmisHistory.length);
  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: `Sen GameRental adlı PlayStation oyun kiralama işletmesinin WhatsApp asistanısın.
Müşteri adı: ${musteriAd}
Müşterinin kiralama geçmişi: ${musteriGecmis}

=== İŞLETME BİLGİLERİ ===
- Dijital PS4 ve PS5 oyun kiralama hizmeti
- Minimum kiralama süresi: 5 gün
- Ödeme: Havale / EFT
- Teslimat: Dijital hesap paylaşımı ile anında

=== MEVCUT OYUNLAR ===
${oyunListesi || 'Oyun listesi yüklenemedi'}

=== KURALLAR ===
Kısa ve samimi cevaplar ver. Türkçe yaz. Emoji kullanabilirsin.
Emin olmadığın şeyleri "birazdan dönüş yapacağım" diyerek yönet.
Asla uydurma bilgi verme. Cevabın 4-5 cümleyi geçmesin.`,
    messages: kisaltilmisHistory,
  }, {
    headers: {
      'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
  });

  const cevap = response.data.content[0].text;
  history.push({ role: 'assistant', content: cevap });
  if (history.length > 20) history.splice(0, 2);
  konusmalar.set(musteriAd, history);
  return cevap;
}

// ══════════════════════════════════════════
// STATE — BEKLEYEN İŞLEMLER
// ══════════════════════════════════════════
const bekleyenOnaylar = new Map(); // tel -> { tip, ... }
const insanDevraldi = new Map();   // tel -> timestamp
const INSAN_SURESI = 30 * 60 * 1000;

// ══════════════════════════════════════════
// ANA MESAJ İŞLEYİCİ
// ══════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Waha'ya hemen 200 dön

  try {
    const event = req.body;

    // Sadece gelen mesajları işle
    if (event.event !== 'message') return;
    const msg = event.payload;
    if (!msg || !msg.body) return;

    // Grup mesajlarını atla
    if (msg.from.includes('@g.us')) return;

    // Botun kendi mesajlarını atla
    if (msg.fromMe) {
      // İşletmeci yazdıysa botu sustur
      insanDevraldi.set(msg.to, Date.now());
      console.log(`👤 İşletmeci devraldı: ${msg.to}`);
      return;
    }

    const tel = msg.from; // 905xxx@c.us formatında
    const metin = (msg.body || '').trim().toLowerCase();
    const metinOrijinal = (msg.body || '').trim();

    console.log(`📨 Mesaj: ${tel} → ${metin}`);

    // İşletmeci devralma kontrolü
    const devralZamani = insanDevraldi.get(tel);
    if (devralZamani && Date.now() - devralZamani < INSAN_SURESI) {
      console.log(`🤫 Bot susturuldu (${tel}), insan konuşuyor`);
      return;
    }

    // Firebase'den veri çek
    const veri = await getVeri();
    if (!veri) {
      await mesajGonder(tel, 'Sistem şu an bakımda, lütfen daha sonra tekrar deneyin 🙏');
      return;
    }

    // Müşteriyi bul (telefon numarasına göre)
    const telSade = tel.replace('@c.us', '').replace(/^90/, '');
    const musteri = veri.musteriler.find(m =>
      m.tel && m.tel.replace(/[^0-9]/g, '').replace(/^0/, '') === telSade
    );
    const musteriAd = musteri ? (musteri.ad || musteri.soyad || 'Müşteri') : 'Misafir';

    // Aktif kiralamayı bul
    const aktifKiralar = musteri
      ? veri.kiralamalar.filter(k => k.musteriId === musteri.id && k.durum === 'aktif')
      : [];
    const aktifKira = aktifKiralar[0] || null;

    // ── BEKLEYEN ONAY VAR MI? ──
    const bekleyen = bekleyenOnaylar.get(tel);
    if (bekleyen) {
      // UZATMA GÜN BEKLENİYOR
      if (bekleyen.tip === 'uzatma_gun_bekle') {
        const gun = parseInt(metin);
        if (isNaN(gun) || gun < 1) {
          await mesajGonder(tel, 'Kaç gün uzatmak istediğinizi sayı olarak yazın (örn: 7) 📅');
          return;
        }
        const ucret = bekleyen.gunluk * gun;
        await mesajGonder(tel,
          `${gun} gün uzatma için tutar: *${formatPara(ucret)}*\n\n` +
          `IBAN: TR00 0000 0000 0000 0000 0000 00\n` +
          `(İşletme adı: GameRental)\n\n` +
          `Ödeme dekontunu bu sohbete gönderin, onaylandıktan sonra uzatma yapılacaktır 📎`
        );
        bekleyenOnaylar.set(tel, {
          tip: 'dekont_bekle',
          kiraId: bekleyen.kiraId,
          gun,
          ucret,
        });
        return;
      }

      // DEKONT BEKLENİYOR
      if (bekleyen.tip === 'dekont_bekle') {
        // Resim/dosya geldi mi?
        const medyaVar = msg.hasMedia || msg.type === 'image' || msg.type === 'document';
        if (medyaVar) {
          await mesajGonder(tel,
            `✅ Dekontunuz alındı! İşletmeci onayladıktan sonra uzatma yapılacak.\n` +
            `Birkaç dakika içinde bildirim alacaksınız 🙏`
          );
          // Bana bildirim gönder
          const oyun = veri.oyunlar.find(o => o.id === bekleyen.kiraId);
          await benimEkranim(
            `💰 *Ödeme Dekontu Geldi!*\n\n` +
            `👤 Müşteri: *${musteriAd}*\n` +
            `📞 Tel: ${telSade}\n` +
            `🎮 Oyun: ${oyun?.ad || '?'}\n` +
            `📅 Uzatma: ${bekleyen.gun} gün\n` +
            `💵 Tutar: ${formatPara(bekleyen.ucret)}\n\n` +
            `Onaylamak için şunu yaz:\n` +
            `*#onayla ${tel.replace('@c.us', '')}*`
          );
          // Onay bekle state'e al
          bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'isletmeci_onay_bekle' });
        } else {
          await mesajGonder(tel,
            `Lütfen ödeme dekontunu *fotoğraf veya PDF* olarak gönderin 📎`
          );
        }
        return;
      }

      // İADE ONAY BEKLENİYOR
      if (bekleyen.tip === 'iade_onay') {
        if (metin === 'evet' || metin === '✅') {
          if (aktifKira) {
            aktifKira.durum = 'teslim';
            await setVeri(veri);
            await mesajGonder(tel,
              `✅ İade bildiriminiz alındı!\n\n` +
              `*${veri.oyunlar.find(o => o.id === aktifKira.oyunId)?.ad}* oyununuz için teşekkürler.\n` +
              `Tekrar görüşmek üzere! 🎮`
            );
            await benimEkranim(
              `📦 *İade Bildirimi*\n\n` +
              `👤 Müşteri: *${musteriAd}* (${telSade})\n` +
              `🎮 Oyun: ${veri.oyunlar.find(o => o.id === aktifKira.oyunId)?.ad}\n\n` +
              `Hesabı geri almayı unutmayın!`
            );
          }
          bekleyenOnaylar.delete(tel);
        } else {
          await mesajGonder(tel, `İptal edildi. Başka bir konuda yardımcı olabilir miyiz? 😊`);
          bekleyenOnaylar.delete(tel);
        }
        return;
      }
    }

    // ── İŞLETMECİ KOMUTLARI ──
    // Benim numaramdan gelen özel komutlar
    const benimTelSade = (CONFIG.BENIM_NUMARAM || '').replace(/[^0-9]/g, '');
    if (telSade === benimTelSade || tel.replace('@c.us','') === benimTelSade) {

      // #onayla 905xxxxxxxxx
      if (metin.startsWith('#onayla')) {
        const hedefTel = metinOrijinal.split(' ')[1];
        if (!hedefTel) {
          await mesajGonder(tel, 'Kullanım: #onayla 905xxxxxxxxx');
          return;
        }
        const hedefKey = hedefTel + '@c.us';
        const hedefBekleyen = bekleyenOnaylar.get(hedefKey);
        if (!hedefBekleyen) {
          await mesajGonder(tel, `Bu numara için bekleyen işlem bulunamadı: ${hedefTel}`);
          return;
        }
        // Uzatmayı yap
        const veri2 = await getVeri();
        const k = veri2.kiralamalar.find(x => x.id === hedefBekleyen.kiraId);
        if (k) {
          const yeniBit = new Date(k.bit + 'T12:00:00');
          yeniBit.setDate(yeniBit.getDate() + hedefBekleyen.gun);
          k.bit = yeniBit.toISOString().split('T')[0];
          k.ucret = (k.ucret || 0) + hedefBekleyen.ucret;
          k.net = (k.net || 0) + hedefBekleyen.ucret;
          if (!k.uzatmalar) k.uzatmalar = [];
          k.uzatmalar.push({ gun: hedefBekleyen.gun, ucret: hedefBekleyen.ucret, tarih: bugun() });
          await setVeri(veri2);
          bekleyenOnaylar.delete(hedefKey);
          await mesajGonder(hedefKey,
            `✅ Ödemeniz onaylandı!\n\n` +
            `*${hedefBekleyen.gun} gün* uzatma yapıldı.\n` +
            `Yeni bitiş tarihi: *${k.bit}* 🎮`
          );
          await mesajGonder(tel, `✅ Onaylandı ve uzatma yapıldı: ${hedefTel}`);
        }
        return;
      }

      // #devral 905xxxxxxxxx — o kişi için botu sustur
      if (metin.startsWith('#devral')) {
        const hedefTel = metinOrijinal.split(' ')[1];
        if (hedefTel) {
          insanDevraldi.set(hedefTel + '@c.us', Date.now());
          await mesajGonder(tel, `👤 ${hedefTel} için bot 30 dk susturuldu`);
        }
        return;
      }

      // #bota 905xxxxxxxxx — botu tekrar devret
      if (metin.startsWith('#bota')) {
        const hedefTel = metinOrijinal.split(' ')[1];
        if (hedefTel) {
          insanDevraldi.delete(hedefTel + '@c.us');
          await mesajGonder(tel, `🤖 ${hedefTel} için bot tekrar aktif`);
        }
        return;
      }
    }

    // ── MENü ──
    if (metin === 'merhaba' || metin === 'selam' || metin === 'hi' || metin === 'menu' || metin === 'menü') {
      await mesajGonder(tel,
        `👋 Merhaba *${musteriAd}*!\n\n` +
        `GameRental'a hoş geldiniz 🎮\n\n` +
        `*1* - 📋 Kiralama durumum\n` +
        `*2* - 🔄 Süre uzat\n` +
        `*3* - 📦 İade bildirimi\n` +
        `*4* - 🎮 Müsait oyunlar\n\n` +
        `Veya sorunuzu yazın, yardımcı olalım!`
      );
      return;
    }

    // ── KİRALAMA DURUM ──
    if (metin === '1' || metin.includes('durumum') || metin.includes('kiralamam')) {
      if (!musteri || aktifKiralar.length === 0) {
        await mesajGonder(tel, `📋 *${musteriAd}* — aktif kiralama bulunmuyor.\n\nYeni kiralama için bize ulaşın! 🎮`);
        return;
      }
      let mesajMetni = `📋 *Aktif Kiralamalarınız*\n\n`;
      for (const k of aktifKiralar) {
        const oyun = veri.oyunlar.find(o => o.id === k.oyunId);
        const now = bugun();
        const gecGun = k.bit < now ? gunFarki(k.bit, now) : 0;
        const kalanGun = k.bit >= now ? gunFarki(now, k.bit) : 0;
        mesajMetni +=
          `🎮 *${oyun?.ad || '?'}* (${k.tip})\n` +
          `📅 Bitiş: ${k.bit}\n` +
          (gecGun > 0 ? `⚠️ *${gecGun} gün gecikmiş!*\n` : `✅ *${kalanGun} gün kaldı*\n`) +
          `💰 Ücret: ${formatPara(k.ucret)}\n\n`;
      }
      await mesajGonder(tel, mesajMetni);
      return;
    }

    // ── UZATMA ──
    if (metin === '2' || metin.includes('uzat') || metin.includes('süre')) {
      if (!aktifKira) {
        await mesajGonder(tel, `Aktif kiralama bulunmuyor. Yeni kiralama için bize ulaşın 🎮`);
        return;
      }
      const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
      const gunluk = aktifKira.tip === 'primary' ? (oyun?.gunluk || 0) : Math.round((oyun?.gunluk || 0) * 0.7);
      await mesajGonder(tel,
        `🔄 *Süre Uzatma*\n\n` +
        `🎮 Oyun: *${oyun?.ad}*\n` +
        `📅 Mevcut bitiş: ${aktifKira.bit}\n` +
        `💰 Günlük ücret: ${formatPara(gunluk)}\n\n` +
        `Kaç gün uzatmak istiyorsunuz?`
      );
      bekleyenOnaylar.set(tel, { tip: 'uzatma_gun_bekle', kiraId: aktifKira.id, gunluk });
      return;
    }

    // ── İADE ──
    if (metin === '3' || metin.includes('iade') || metin.includes('bitir') || metin.includes('teslim')) {
      if (!aktifKira) {
        await mesajGonder(tel, `Aktif kiralama bulunmuyor 🎮`);
        return;
      }
      const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
      await mesajGonder(tel,
        `📦 *İade Bildirimi*\n\n` +
        `🎮 *${oyun?.ad}* oyununu iade etmek istediğinizi onaylıyor musunuz?\n\n` +
        `*evet* yazarak onaylayın.`
      );
      bekleyenOnaylar.set(tel, { tip: 'iade_onay', kiraId: aktifKira.id });
      return;
    }

    // ── MÜSAİT OYUNLAR ──
    if (metin === '4' || metin.includes('oyun') || metin.includes('müsait') || metin.includes('liste')) {
      const musaitOyunlar = veri.oyunlar.filter(o => !o.deaktif).map(o => {
        const kiraSayisi = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
        const toplamSlot = (o.kopyalar?.length || 0) + 1;
        const musait = kiraSayisi < toplamSlot;
        const priGunluk = o.gunlukPri || o.gunluk || 0;
        const secGunluk = o.gunlukSec || Math.round((o.gunluk || 0) * 0.85);
        return `${musait ? '✅' : '❌'} *${o.ad}* (${o.platform})\n   🔵 Primary: ${formatPara(priGunluk)}/gün\n   🟣 Secondary: ${formatPara(secGunluk)}/gün`;
      }).join('\n');
      await mesajGonder(tel, `🎮 *Oyun Listesi*\n\n${musaitOyunlar}`);
      return;
    }

    // ── CLAUDE'A YÖNLENDİR ──
    const gecmisOzet = musteri
      ? `${veri.kiralamalar.filter(k => k.musteriId === musteri.id).length} kiralama, ${aktifKira ? 'aktif kiralama var (bitiş: ' + aktifKira.bit + ')' : 'aktif kiralama yok'}`
      : 'Kayıtlı müşteri değil';

    const oyunListesi = veri.oyunlar.filter(o => !o.deaktif).map(o => {
      const kirada = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
      const musait = ((o.kopyalar?.length || 0) + 1) - kirada;
      const priGunluk = o.gunlukPri || o.gunluk || 0;
      const secGunluk = o.gunlukSec || Math.round((o.gunluk || 0) * 0.85);
      return `${o.ad} (${o.platform}, Primary: ₺${priGunluk}/gün, Secondary: ₺${secGunluk}/gün, ${musait > 0 ? 'müsait' : 'kirada'})`;
    }).join('\n');

    try {
      const cevap = await claudeCevap(musteriAd, metinOrijinal, gecmisOzet, oyunListesi);
      await mesajGonder(tel, cevap);
    } catch (e) {
      console.error('Claude hatası:', e.message);
      await mesajGonder(tel, `Şu an cevap vermekte güçlük çekiyorum, birazdan tekrar dener misiniz? 🙏`);
      await benimEkranim(`⚠️ Bot hatası!\nMüşteri: ${musteriAd} (${telSade})\nMesaj: "${metinOrijinal}"\nHata: ${e.message}`);
    }

  } catch (err) {
    console.error('Webhook genel hata:', err.message);
  }
});

// ══════════════════════════════════════════
// ZAMANLANMIŞ KONTROLLER
// ══════════════════════════════════════════
async function yarinBitenKontrol() {
  console.log('⏰ Yarın biten kontrol...');
  const veri = await getVeri();
  if (!veri) return;
  const yarin = yarinStr();

  const yarinBiten = veri.kiralamalar.filter(k => k.durum === 'aktif' && k.bit === yarin);
  for (const k of yarinBiten) {
    const musteri = veri.musteriler.find(m => m.id === k.musteriId);
    const oyun = veri.oyunlar.find(o => o.id === k.oyunId);
    if (!musteri?.tel) continue;

    const tel = temizTel(musteri.tel) + '@c.us';
    const gunluk = k.tip === 'primary' ? (oyun?.gunluk || 0) : Math.round((oyun?.gunluk || 0) * 0.7);

    await mesajGonder(tel,
      `🔔 *Kiralama Hatırlatıcısı*\n\n` +
      `Merhaba *${musteri.ad || musteri.soyad}*!\n\n` +
      `*${oyun?.ad}* oyununuzun süresi *yarın* doluyor.\n\n` +
      `Uzatmak için *2* yazabilirsiniz 🎮`
    );
    bekleyenOnaylar.set(tel, { tip: 'uzatma_gun_bekle', kiraId: k.id, gunluk });
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function gecikmeKontrol() {
  const veri = await getVeri();
  if (!veri) return;
  const now = bugun();
  const gecikmiş = veri.kiralamalar.filter(k => k.durum === 'aktif' && k.bit < now);

  for (const k of gecikmiş) {
    const sonUyariKey = `uyari_${k.id}`;
    const sonUyari = await db.collection('botState').doc(sonUyariKey).get();
    if (sonUyari.exists && sonUyari.data().tarih === now) continue;

    const musteri = veri.musteriler.find(m => m.id === k.musteriId);
    const oyun = veri.oyunlar.find(o => o.id === k.oyunId);
    if (!musteri?.tel) continue;

    const gecGun = gunFarki(k.bit, now);
    const gunluk = k.tip === 'primary' ? (oyun?.gunluk || 0) : Math.round((oyun?.gunluk || 0) * 0.7);
    const ekstra = gunluk * gecGun;
    const tel = temizTel(musteri.tel) + '@c.us';

    await mesajGonder(tel,
      `⚠️ *Gecikmiş İade*\n\n` +
      `Merhaba *${musteri.ad || musteri.soyad}*!\n\n` +
      `*${oyun?.ad}* oyununuz *${gecGun} gün* gecikmiş.\n` +
      `Ekstra ücret: *${formatPara(ekstra)}*\n\n` +
      `İade için *3*, uzatmak için *2* yazın 🙏`
    );

    await db.collection('botState').doc(sonUyariKey).set({ tarih: now });
    await new Promise(r => setTimeout(r, 1000));
  }
}

// Sabah 09:00 — yarın bitenler
const SAAT_MS = 60 * 60 * 1000;
function zamanlanmisBaslat() {
  // Her saat kontrol et, saat 9 ise yarın bitenleri gönder
  setInterval(async () => {
    const saat = new Date().getHours();
    if (saat === 9) await yarinBitenKontrol();
    await gecikmeKontrol();
  }, SAAT_MS);
  console.log('⏰ Zamanlanmış kontroller aktif');
}

// ══════════════════════════════════════════
// SUNUCU BAŞLAT
// ══════════════════════════════════════════
app.get('/', (req, res) => res.send('🎮 GameRental Bot çalışıyor!'));

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Webhook sunucusu port ${CONFIG.PORT}'de çalışıyor`);
  zamanlanmisBaslat();
});
