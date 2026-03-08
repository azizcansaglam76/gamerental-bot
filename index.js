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
  BENIM_NUMARAM: process.env.BENIM_NUMARAM, // 905xxxxxxxxx
  WAHA_URL: process.env.WAHA_URL || 'http://localhost:3000',
  WAHA_API_KEY: process.env.WAHA_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  PORT: process.env.PORT || 3001,
};

// ══════════════════════════════════════════
// FIREBASE
// ══════════════════════════════════════════
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
    console.log('Firebase: B64 ile yüklendi');
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('Firebase: JSON ile yüklendi');
  } else {
    throw new Error('Service account bulunamadi');
  }
} catch (e) {
  console.error('Firebase service account parse hatası:', e.message);
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

// ══════════════════════════════════════════
// YARDIMCI
// ══════════════════════════════════════════
function bugun() { return new Date().toISOString().split('T')[0]; }
function yarinStr() { const d = new Date(); d.setDate(d.getDate()+1); return d.toISOString().split('T')[0]; }
function gunFarki(d1, d2) { return Math.round((new Date(d2) - new Date(d1)) / 86400000); }
function formatPara(n) { return '₺' + (n||0).toLocaleString('tr-TR'); }
function temizTel(tel) { return tel.replace(/[^0-9]/g,'').replace(/^0/,'').replace(/^(?!90)/,'90'); }

// ══════════════════════════════════════════
// WAHA MESAJ GÖNDER
// ══════════════════════════════════════════
async function mesajGonder(tel, metin) {
  try {
    const chatId = tel.includes('@') ? tel : tel + '@c.us';
    await axios.post(`${CONFIG.WAHA_URL}/api/sendText`, {
      session: 'default', chatId, text: metin,
    }, { headers: CONFIG.WAHA_API_KEY ? { 'X-Api-Key': CONFIG.WAHA_API_KEY } : {} });
    console.log(`📤 Gönderildi: ${chatId}`);
  } catch (e) { console.error('Mesaj gönderim hatası:', e.message); }
}

async function benimEkranim(metin) {
  if (CONFIG.BENIM_NUMARAM) await mesajGonder(CONFIG.BENIM_NUMARAM, metin);
}

// ══════════════════════════════════════════
// CLAUDE API
// ══════════════════════════════════════════
const konusmalar = new Map();

async function claudeCevap(musteriAd, mesaj, musteriGecmis, oyunListesi) {
  const history = konusmalar.get(musteriAd) || [];
  history.push({ role: 'user', content: mesaj });
  const kisaltilmis = history.slice(-6);

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: `Sen GameRental adlı PlayStation oyun kiralama işletmesinin WhatsApp asistanısın.
Müşteri adı: ${musteriAd}
Müşterinin kiralama geçmişi: ${musteriGecmis}

=== İŞLETME BİLGİLERİ ===
- Dijital PS4 ve PS5 oyun kiralama
- Minimum kiralama: 5 gün
- Ödeme: Havale/EFT
- Teslimat: Dijital hesap paylaşımı ile anında

=== SIKÇA SORULAN SORULAR ===
S: Nasıl çalışıyor?
C: PS hesabı konsolunuza eklenir, oyunu indirip oynarsınız. Süre sonunda hesap kaldırılır.
S: Kaç kişi oynayabilir?
C: Primary hesap olarak 1 konsolda sınırsız, secondary olarak aynı anda 1 kişi.
S: PS4 oyununu PS5te oynayabilir miyim?
C: Evet, büyük çoğunluğu çalışır.
S: Ödeme nasıl?
C: Havale/EFT. Onaydan sonra hesap bilgileri paylaşılır.
S: İade olur mu?
C: Dijital ürün olduğu için süre bitmeden iade yapılamaz.

=== MEVCUT OYUNLAR ===
${oyunListesi || 'Oyun listesi yüklenemedi'}

=== KURALLAR ===
Kısa ve samimi cevaplar ver. Türkçe yaz. Emoji kullanabilirsin.
Oyun sorarlarsa listeye göre müsait olanları fiyatlarıyla öner.
Kiralama yapmak isteyenlere "işletmecimiz sizinle iletişime geçecek" de ve işletmeciye bildirim gittiğini söyle.
Emin olmadığın şeyleri "birazdan dönüş yapacağım" diyerek yönet.
Asla uydurma bilgi verme. Cevabın 4-5 cümleyi geçmesin.`,
    messages: kisaltilmis,
  }, {
    headers: { 'x-api-key': CONFIG.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
  });

  const cevap = response.data.content[0].text;
  history.push({ role: 'assistant', content: cevap });
  if (history.length > 20) history.splice(0, 2);
  konusmalar.set(musteriAd, history);
  return cevap;
}

// ══════════════════════════════════════════
// STATE
// ══════════════════════════════════════════
const bekleyenOnaylar = new Map();
const insanDevraldi = new Map();   // chatId -> timestamp
const INSAN_SURESI = 30 * 60 * 1000;
const telefonBekle = new Map();    // chatId -> true (telefon numarası bekleniyor)

// Benim LID'im — ilk mesajımda öğreneceğiz
let benimLid = null;

// ══════════════════════════════════════════
// ANA MESAJ İŞLEYİCİ
// ══════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const event = req.body;
    if (event.event !== 'message') return;
    const msg = event.payload;
    if (!msg || !msg.body) return;
    if (msg.from.includes('@g.us')) return;

    // Kendi gönderdiğim mesajlar
    if (msg.fromMe) {
      const hedef = msg.to;
      // Benim LID'imi öğren
      if (!benimLid) {
        benimLid = msg.from;
        console.log(`📱 Benim LID: ${benimLid}`);
      }
      // O kişi için botu sustur (insan devraldı)
      insanDevraldi.set(hedef, Date.now());
      console.log(`👤 İşletmeci devraldı: ${hedef} (30 dk bot susacak)`);
      return;
    }

    const tel = msg.from;
    const metin = (msg.body || '').trim().toLowerCase();
    const metinOrijinal = (msg.body || '').trim();

    console.log(`📨 Mesaj: ${tel} → ${metin}`);

    // Benim numaramdan veya LID'imden gelen mesajları atla (işletmeci kendi kendine)
    const benimTelSade = (CONFIG.BENIM_NUMARAM || '').replace(/[^0-9]/g, '');
    const telNumara = tel.replace('@c.us','').replace('@lid','').replace(/[^0-9]/g,'');
    if (telNumara === benimTelSade || tel === benimLid) {
      // İşletmeci komutları
      if (metin.startsWith('#devral')) {
        const hedef = metinOrijinal.split(' ')[1];
        if (hedef) { insanDevraldi.set(hedef + '@c.us', Date.now()); await mesajGonder(tel, `👤 Bot susturuldu: ${hedef}`); }
        return;
      }
      if (metin.startsWith('#bota')) {
        const hedef = metinOrijinal.split(' ')[1];
        if (hedef) { insanDevraldi.delete(hedef + '@c.us'); await mesajGonder(tel, `🤖 Bot aktif: ${hedef}`); }
        return;
      }
      if (metin.startsWith('#onayla')) {
        const hedefTel = metinOrijinal.split(' ')[1];
        if (!hedefTel) { await mesajGonder(tel, 'Kullanım: #onayla 905xxxxxxxxx'); return; }
        const hedefKey = hedefTel.includes('@') ? hedefTel : hedefTel + '@c.us';
        const hedefBekleyen = bekleyenOnaylar.get(hedefKey);
        if (!hedefBekleyen) { await mesajGonder(tel, `Bekleyen işlem yok: ${hedefTel}`); return; }
        const veri2 = await getVeri();
        const k = veri2.kiralamalar.find(x => x.id === hedefBekleyen.kiraId);
        if (k) {
          const yeniBit = new Date(k.bit + 'T12:00:00');
          yeniBit.setDate(yeniBit.getDate() + hedefBekleyen.gun);
          k.bit = yeniBit.toISOString().split('T')[0];
          k.ucret = (k.ucret||0) + hedefBekleyen.ucret;
          k.net = (k.net||0) + hedefBekleyen.ucret;
          if (!k.uzatmalar) k.uzatmalar = [];
          k.uzatmalar.push({ gun: hedefBekleyen.gun, ucret: hedefBekleyen.ucret, tarih: bugun() });
          await setVeri(veri2);
          bekleyenOnaylar.delete(hedefKey);
          await mesajGonder(hedefKey, `✅ Ödemeniz onaylandı! ${hedefBekleyen.gun} gün uzatıldı. Yeni bitiş: *${k.bit}* 🎮`);
          await mesajGonder(tel, `✅ Onaylandı: ${hedefTel}`);
        }
        return;
      }
      return; // Diğer kendi mesajlarımı işleme
    }

    // İnsan devralma kontrolü
    const devralZamani = insanDevraldi.get(tel);
    if (devralZamani && Date.now() - devralZamani < INSAN_SURESI) {
      console.log(`🤫 Bot susturuldu: ${tel}`);
      return;
    }

    // Firebase'den veri çek
    const veri = await getVeri();
    if (!veri) { await mesajGonder(tel, 'Sistem şu an bakımda 🙏'); return; }

    // ── MÜŞTERİ BULMA ──
    const isLid = tel.includes('@lid');

    // 1. LID ile ara
    let musteri = veri.musteriler.find(m => m.whatsappLid === tel);

    // 2. Telefon ile ara (LID değilse)
    if (!musteri && !isLid) {
      const telSade = tel.replace('@c.us','').replace(/^90/,'');
      musteri = veri.musteriler.find(m =>
        m.tel && m.tel.replace(/[^0-9]/g,'').replace(/^0/,'') === telSade
      );
    }

    // 3. Bulunduysa LID kaydet
    if (musteri && isLid && !musteri.whatsappLid) {
      musteri.whatsappLid = tel;
      try { await setVeri(veri); console.log(`📱 LID kaydedildi: ${musteri.soyad||musteri.ad}`); } catch(e) {}
    }

    // 4. Telefon numarası bekleniyor mu?
    if (telefonBekle.get(tel)) {
      const numara = metinOrijinal.replace(/[^0-9]/g,'').replace(/^90/,'').replace(/^0/,'');
      if (numara.length >= 10) {
        const bulunan = veri.musteriler.find(m =>
          m.tel && m.tel.replace(/[^0-9]/g,'').replace(/^0/,'') === numara
        );
        telefonBekle.delete(tel);
        if (bulunan) {
          bulunan.whatsappLid = tel;
          await setVeri(veri);
          await mesajGonder(tel,
            `✅ Sizi bulduk! Merhaba *${bulunan.ad || bulunan.soyad}*!\n\n` +
            `*1* - 📋 Kiralama durumum\n*2* - 🔄 Süre uzat\n*3* - 📦 İade bildirimi\n*4* - 🎮 Oyun listesi`
          );
        } else {
          await mesajGonder(tel, `Sistemde kayıtlı müşteri bulunamadı.\nKiralama için bize ulaşabilirsiniz! 🎮`);
          await benimEkranim(`📵 *Kayıtsız Müşteri*\n\nNumara: ${numara}\nWhatsApp: ${tel}\n\nSisteme eklemek isteyebilirsiniz.`);
        }
      } else {
        await mesajGonder(tel, `Geçerli bir telefon numarası girin (örn: 5301234567) 📱`);
      }
      return;
    }

    // 5. Müşteri bulunamadıysa telefon sor
    if (!musteri && isLid) {
      telefonBekle.set(tel, true);
      await mesajGonder(tel,
        `👋 Merhaba! GameRental'a hoş geldiniz 🎮\n\n` +
        `Sizi sistemimizde bulmak için lütfen kayıtlı telefon numaranızı yazın:\n` +
        `(Örn: 5301234567)`
      );
      return;
    }

    const musteriAd = musteri ? (musteri.ad || musteri.soyad || 'Müşteri') : 'Misafir';
    const aktifKiralar = musteri ? veri.kiralamalar.filter(k => k.musteriId === musteri.id && k.durum === 'aktif') : [];
    const aktifKira = aktifKiralar[0] || null;

    // ── BEKLEYEN ONAY ──
    const bekleyen = bekleyenOnaylar.get(tel);
    if (bekleyen) {
      if (bekleyen.tip === 'uzatma_gun_bekle') {
        const gun = parseInt(metin);
        if (isNaN(gun) || gun < 1) { await mesajGonder(tel, 'Kaç gün uzatmak istediğinizi sayı olarak yazın (örn: 7) 📅'); return; }
        const ucret = bekleyen.gunluk * gun;
        await mesajGonder(tel,
          `${gun} gün uzatma için tutar: *${formatPara(ucret)}*\n\n` +
          `IBAN: TR00 0000 0000 0000 0000 0000 00\n\n` +
          `Ödeme dekontunu bu sohbete gönderin 📎`
        );
        bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'dekont_bekle', gun, ucret });
        return;
      }

      if (bekleyen.tip === 'dekont_bekle') {
        const medyaVar = msg.hasMedia || msg.type === 'image' || msg.type === 'document';
        if (medyaVar) {
          await mesajGonder(tel, `✅ Dekontunuz alındı! Onaylandıktan sonra uzatma yapılacak 🙏`);
          const oyun = veri.oyunlar.find(o => o.id === bekleyen.kiraId);
          await benimEkranim(
            `💰 *Ödeme Dekontu*\n\n👤 Müşteri: *${musteriAd}*\n🎮 Oyun: ${oyun?.ad||'?'}\n📅 Uzatma: ${bekleyen.gun} gün\n💵 Tutar: ${formatPara(bekleyen.ucret)}\n\nOnaylamak için:\n*#onayla ${tel.replace('@c.us','').replace('@lid','')}*`
          );
          bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'isletmeci_onay_bekle' });
        } else {
          await mesajGonder(tel, `Lütfen ödeme dekontunu *fotoğraf veya PDF* olarak gönderin 📎`);
        }
        return;
      }

      if (bekleyen.tip === 'iade_onay') {
        if (metin === 'evet') {
          if (aktifKira) {
            aktifKira.durum = 'teslim';
            await setVeri(veri);
            const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
            await mesajGonder(tel, `✅ İade bildiriminiz alındı! *${oyun?.ad}* için teşekkürler 🎮`);
            await benimEkranim(`📦 *İade Bildirimi*\n\n👤 ${musteriAd}\n🎮 ${oyun?.ad}\n\nHesabı geri almayı unutmayın!`);
          }
          bekleyenOnaylar.delete(tel);
        } else {
          await mesajGonder(tel, `İptal edildi 😊`);
          bekleyenOnaylar.delete(tel);
        }
        return;
      }
    }

    // ── MENÜ ──
    if (metin === 'merhaba' || metin === 'selam' || metin === 'menu' || metin === 'menü' || metin === 'hi') {
      await mesajGonder(tel,
        `👋 Merhaba *${musteriAd}*!\n\nGameRental'a hoş geldiniz 🎮\n\n` +
        `*1* - 📋 Kiralama durumum\n*2* - 🔄 Süre uzat\n*3* - 📦 İade bildirimi\n*4* - 🎮 Oyun listesi\n\nVeya sorunuzu yazın!`
      );
      return;
    }

    // ── KİRALAMA DURUMU ──
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
        mesajMetni += `🎮 *${oyun?.ad||'?'}* (${k.tip})\n📅 Bitiş: ${k.bit}\n` +
          (gecGun > 0 ? `⚠️ *${gecGun} gün gecikmiş!*\n` : `✅ *${kalanGun} gün kaldı*\n`) +
          `💰 Ücret: ${formatPara(k.ucret)}\n\n`;
      }
      await mesajGonder(tel, mesajMetni);
      return;
    }

    // ── UZATMA ──
    if (metin === '2' || metin.includes('uzat') || metin.includes('süre')) {
      if (!aktifKira) { await mesajGonder(tel, `Aktif kiralama yok 🎮`); return; }
      const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
      const gunluk = aktifKira.tip === 'primary' ? (oyun?.gunlukPri||oyun?.gunluk||0) : (oyun?.gunlukSec||Math.round((oyun?.gunluk||0)*0.85));
      await mesajGonder(tel,
        `🔄 *Süre Uzatma*\n\n🎮 *${oyun?.ad}*\n📅 Bitiş: ${aktifKira.bit}\n💰 Günlük: ${formatPara(gunluk)}\n\nKaç gün uzatmak istiyorsunuz?`
      );
      bekleyenOnaylar.set(tel, { tip: 'uzatma_gun_bekle', kiraId: aktifKira.id, gunluk });
      return;
    }

    // ── İADE ──
    if (metin === '3' || metin.includes('iade') || metin.includes('bitir') || metin.includes('teslim')) {
      if (!aktifKira) { await mesajGonder(tel, `Aktif kiralama yok 🎮`); return; }
      const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
      await mesajGonder(tel, `📦 *${oyun?.ad}* oyununu iade etmek istediğinizi onaylıyor musunuz?\n\n*evet* yazarak onaylayın.`);
      bekleyenOnaylar.set(tel, { tip: 'iade_onay', kiraId: aktifKira.id });
      return;
    }

    // ── OYUN LİSTESİ ──
    if (metin === '4' || metin === 'oyunlar' || metin.includes('müsait') || metin.includes('musait')) {
      const liste = veri.oyunlar.filter(o => !o.deaktif).map(o => {
        const kiraSayisi = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
        const toplamSlot = (o.kopyalar?.length||0) + 1;
        const musait = kiraSayisi < toplamSlot;
        const pri = o.gunlukPri || o.gunluk || 0;
        const sec = o.gunlukSec || Math.round((o.gunluk||0)*0.85);
        return `${musait ? '✅' : '❌'} *${o.ad}* (${o.platform})\n   🔵 Primary: ${formatPara(pri)}/gün  🟣 Secondary: ${formatPara(sec)}/gün`;
      }).join('\n');
      await mesajGonder(tel, `🎮 *Oyun Listesi*\n\n${liste}`);
      return;
    }

    // ── CLAUDE ──
    const gecmisOzet = musteri
      ? `${veri.kiralamalar.filter(k => k.musteriId === musteri.id).length} kiralama geçmişi, ${aktifKira ? 'aktif kiralama var (bitiş: ' + aktifKira.bit + ')' : 'aktif kiralama yok'}`
      : 'Kayıtlı müşteri değil';

    const oyunListesi = veri.oyunlar.filter(o => !o.deaktif).map(o => {
      const kirada = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
      const musait = ((o.kopyalar?.length||0) + 1) - kirada;
      const pri = o.gunlukPri || o.gunluk || 0;
      const sec = o.gunlukSec || Math.round((o.gunluk||0)*0.85);
      return `${o.ad} (${o.platform}, Primary: ₺${pri}/gün, Secondary: ₺${sec}/gün, ${musait > 0 ? 'müsait' : 'kirada'})`;
    }).join('\n');

    // Kiralama talebi varsa bana bildir
    if (metin.includes('kiralamak') || metin.includes('kiralamak istiyorum') || metin.includes('kiralayabilir miyim')) {
      await benimEkranim(`🎮 *Kiralama Talebi*\n\n👤 ${musteriAd} (${tel})\n💬 "${metinOrijinal}"`);
    }

    try {
      const cevap = await claudeCevap(musteriAd, metinOrijinal, gecmisOzet, oyunListesi);
      await mesajGonder(tel, cevap);
    } catch (e) {
      console.error('Claude hatası:', e.message, e.response?.data);
      await mesajGonder(tel, `Şu an cevap vermekte güçlük çekiyorum, birazdan tekrar dener misiniz? 🙏`);
      await benimEkranim(`⚠️ Bot hatası!\n${musteriAd}: "${metinOrijinal}"\nHata: ${e.message}`);
    }

  } catch (err) {
    console.error('Webhook genel hata:', err.message);
  }
});

// ══════════════════════════════════════════
// ZAMANLANMIŞ KONTROLLER
// ══════════════════════════════════════════
async function yarinBitenKontrol() {
  const veri = await getVeri(); if (!veri) return;
  const yarin = yarinStr();
  const yarinBiten = veri.kiralamalar.filter(k => k.durum === 'aktif' && k.bit === yarin);
  for (const k of yarinBiten) {
    const musteri = veri.musteriler.find(m => m.id === k.musteriId);
    const oyun = veri.oyunlar.find(o => o.id === k.oyunId);
    if (!musteri) continue;
    const hedef = musteri.whatsappLid || (musteri.tel ? temizTel(musteri.tel) + '@c.us' : null);
    if (!hedef) continue;
    const gunluk = k.tip === 'primary' ? (oyun?.gunlukPri||oyun?.gunluk||0) : (oyun?.gunlukSec||Math.round((oyun?.gunluk||0)*0.85));
    await mesajGonder(hedef, `🔔 *Hatırlatıcı*\n\nMerhaba *${musteri.ad||musteri.soyad}*!\n*${oyun?.ad}* oyununuz *yarın* bitiyor.\n\nUzatmak için *2* yazın 🎮`);
    bekleyenOnaylar.set(hedef, { tip: 'uzatma_gun_bekle', kiraId: k.id, gunluk });
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function gecikmeKontrol() {
  const veri = await getVeri(); if (!veri) return;
  const now = bugun();
  const gecikmiş = veri.kiralamalar.filter(k => k.durum === 'aktif' && k.bit < now);
  for (const k of gecikmiş) {
    const sonUyariKey = `uyari_${k.id}`;
    try { const s = await db.collection('botState').doc(sonUyariKey).get(); if (s.exists && s.data().tarih === now) continue; } catch(e) {}
    const musteri = veri.musteriler.find(m => m.id === k.musteriId);
    const oyun = veri.oyunlar.find(o => o.id === k.oyunId);
    if (!musteri) continue;
    const hedef = musteri.whatsappLid || (musteri.tel ? temizTel(musteri.tel) + '@c.us' : null);
    if (!hedef) continue;
    const gecGun = gunFarki(k.bit, now);
    const gunluk = k.tip === 'primary' ? (oyun?.gunlukPri||oyun?.gunluk||0) : (oyun?.gunlukSec||Math.round((oyun?.gunluk||0)*0.85));
    await mesajGonder(hedef,
      `⚠️ *Gecikmiş İade*\n\nMerhaba *${musteri.ad||musteri.soyad}*!\n*${oyun?.ad}* oyununuz *${gecGun} gün* gecikmiş.\nEkstra ücret: *${formatPara(gunluk*gecGun)}*\n\nİade için *3*, uzatmak için *2* yazın 🙏`
    );
    try { await db.collection('botState').doc(sonUyariKey).set({ tarih: now }); } catch(e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
}

setInterval(async () => {
  const saat = new Date().getHours();
  if (saat === 9) await yarinBitenKontrol();
  await gecikmeKontrol();
}, 60 * 60 * 1000);

// ══════════════════════════════════════════
// SUNUCU
// ══════════════════════════════════════════
app.get('/', (req, res) => res.send('🎮 GameRental Bot çalışıyor!'));
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Webhook port ${CONFIG.PORT}`);
  console.log('⏰ Zamanlanmış kontroller aktif');
});
