const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
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

let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
    console.log('Firebase: B64 ile yüklendi');
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
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

function bugun() { return new Date().toISOString().split('T')[0]; }
function yarinStr() { const d = new Date(); d.setDate(d.getDate()+1); return d.toISOString().split('T')[0]; }
function gunFarki(d1, d2) { return Math.round((new Date(d2) - new Date(d1)) / 86400000); }
function formatPara(n) { return '₺' + (n||0).toLocaleString('tr-TR'); }
function temizTel(tel) { return tel.replace(/[^0-9]/g,'').replace(/^0/,'').replace(/^(?!90)/,'90'); }
function bugunStr() { return bugun(); }
function tarihEkle(baslangic, gun) {
  const d = new Date(baslangic + 'T12:00:00');
  d.setDate(d.getDate() + gun);
  return d.toISOString().split('T')[0];
}

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
C: Primary hesap 1 konsolda sınırsız, secondary aynı anda 1 kişi.
S: PS4 oyununu PS5te oynayabilir miyim?
C: Evet, büyük çoğunluğu çalışır.
S: İade olur mu?
C: Dijital ürün olduğu için süre bitmeden iade yapılamaz.

=== MEVCUT OYUNLAR ===
${oyunListesi || 'Oyun listesi yüklenemedi'}

=== KURALLAR ===
Kısa ve samimi cevaplar ver. Türkçe yaz. Emoji kullanabilirsin.
Oyun sorarlarsa listeye göre müsait olanları fiyatlarıyla öner.
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

const bekleyenOnaylar = new Map();
const insanDevraldi = new Map();
const INSAN_SURESI = 30 * 60 * 1000;
const telefonBekle = new Map();
let benimLid = null;

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const event = req.body;
    if (event.event !== 'message') return;
    const msg = event.payload;
    if (!msg || !msg.body) return;
    if (msg.from.includes('@g.us')) return;

    if (msg.fromMe) {
      if (!benimLid) { benimLid = msg.from; console.log(`📱 Benim LID: ${benimLid}`); }
      insanDevraldi.set(msg.to, Date.now());
      console.log(`👤 İşletmeci devraldı: ${msg.to}`);
      return;
    }

    const tel = msg.from;
    const metin = (msg.body || '').trim().toLowerCase();
    const metinOrijinal = (msg.body || '').trim();

    console.log(`📨 Mesaj: ${tel} → ${metin}`);

    // İşletmeci komutları
    const benimTelSade = (CONFIG.BENIM_NUMARAM || '').replace(/[^0-9]/g, '');
    const telNumara = tel.replace('@c.us','').replace('@lid','').replace(/[^0-9]/g,'');
    if (telNumara === benimTelSade || tel === benimLid) {
      if (metin.startsWith('#onayla')) {
        const parcalar = metinOrijinal.split(' ');
        const hedefTel = parcalar[1];
        if (!hedefTel) { await mesajGonder(tel, 'Kullanım: #onayla 905xxxxxxxxx'); return; }
        const hedefKey = hedefTel.includes('@') ? hedefTel : hedefTel + '@c.us';
        const hedefBekleyen = bekleyenOnaylar.get(hedefKey);
        if (!hedefBekleyen) { await mesajGonder(tel, `Bekleyen işlem yok: ${hedefTel}`); return; }

        const veri2 = await getVeri();

        // Yeni kiralama ekleme
        if (hedefBekleyen.tip === 'yeni_kiralama_bekle') {
          const yeniId = (veri2.nextId?.k || 400) + 1;
          const bas = bugunStr();
          const bit = tarihEkle(bas, hedefBekleyen.gun);
          const yeniKira = {
            id: yeniId,
            oyunId: hedefBekleyen.oyunId,
            musteriId: hedefBekleyen.musteriId,
            tip: hedefBekleyen.kiraTip,
            bas, bit,
            ucret: hedefBekleyen.ucret,
            indirim: 0,
            net: hedefBekleyen.ucret,
            onOdeme: hedefBekleyen.ucret,
            hediyeGun: 0,
            notlar: 'Bot üzerinden eklendi',
            durum: 'aktif',
          };
          if (!veri2.kiralamalar) veri2.kiralamalar = [];
          veri2.kiralamalar.push(yeniKira);
          if (!veri2.nextId) veri2.nextId = {};
          veri2.nextId.k = yeniId;
          await setVeri(veri2);
          bekleyenOnaylar.delete(hedefKey);
          await mesajGonder(hedefKey,
            `✅ *Ödemeniz onaylandı!*\n\n🎮 *${hedefBekleyen.oyunAd}*\n📅 Başlangıç: ${bas}\n📅 Bitiş: ${bit}\n💰 Tutar: ${formatPara(hedefBekleyen.ucret)}\n\nHesap bilgileriniz için işletmecimiz kısa süre içinde sizinle iletişime geçecek 🙏`
          );
          await mesajGonder(tel, `✅ Kiralama eklendi!\n🎮 ${hedefBekleyen.oyunAd}\n👤 ${hedefBekleyen.musteriAd}\n📅 ${bas} → ${bit}\n\nHesabı paylaşmayı unutma!`);
          return;
        }

        // Uzatma onaylama
        if (hedefBekleyen.tip === 'isletmeci_onay_bekle') {
          const k = veri2.kiralamalar.find(x => x.id === hedefBekleyen.kiraId);
          if (k) {
            const yeniBit = tarihEkle(k.bit, hedefBekleyen.gun);
            k.bit = yeniBit;
            k.ucret = (k.ucret||0) + hedefBekleyen.ucret;
            k.net = (k.net||0) + hedefBekleyen.ucret;
            if (!k.uzatmalar) k.uzatmalar = [];
            k.uzatmalar.push({ gun: hedefBekleyen.gun, ucret: hedefBekleyen.ucret, tarih: bugunStr() });
            await setVeri(veri2);
            bekleyenOnaylar.delete(hedefKey);
            await mesajGonder(hedefKey, `✅ Ödemeniz onaylandı! ${hedefBekleyen.gun} gün uzatıldı.\nYeni bitiş tarihi: *${yeniBit}* 🎮`);
            await mesajGonder(tel, `✅ Uzatma onaylandı: ${hedefTel}`);
          }
          return;
        }
      }

      if (metin.startsWith('#devral')) {
        const hedef = metinOrijinal.split(' ')[1];
        if (hedef) { insanDevraldi.set(hedef.includes('@') ? hedef : hedef + '@c.us', Date.now()); await mesajGonder(tel, `👤 Bot susturuldu: ${hedef}`); }
        return;
      }
      if (metin.startsWith('#bota')) {
        const hedef = metinOrijinal.split(' ')[1];
        if (hedef) { insanDevraldi.delete(hedef.includes('@') ? hedef : hedef + '@c.us'); await mesajGonder(tel, `🤖 Bot aktif: ${hedef}`); }
        return;
      }
      return;
    }

    // İnsan devralma kontrolü
    const devralZamani = insanDevraldi.get(tel);
    if (devralZamani && Date.now() - devralZamani < INSAN_SURESI) {
      console.log(`🤫 Bot susturuldu: ${tel}`);
      return;
    }

    const veri = await getVeri();
    if (!veri) { await mesajGonder(tel, 'Sistem şu an bakımda 🙏'); return; }

    // Müşteri bulma
    const isLid = tel.includes('@lid');
    let musteri = veri.musteriler.find(m => m.whatsappLid === tel);
    if (!musteri && !isLid) {
      const telSade = tel.replace('@c.us','').replace(/^90/,'');
      musteri = veri.musteriler.find(m => m.tel && m.tel.replace(/[^0-9]/g,'').replace(/^0/,'') === telSade);
    }
    if (musteri && isLid && !musteri.whatsappLid) {
      musteri.whatsappLid = tel;
      try { await setVeri(veri); console.log(`📱 LID kaydedildi: ${musteri.soyad||musteri.ad}`); } catch(e) {}
    }

    // Telefon bekleniyor
    if (telefonBekle.get(tel)) {
      const numara = metinOrijinal.replace(/[^0-9]/g,'').replace(/^90/,'').replace(/^0/,'');
      if (numara.length >= 10) {
        const bulunan = veri.musteriler.find(m => m.tel && m.tel.replace(/[^0-9]/g,'').replace(/^0/,'') === numara);
        telefonBekle.delete(tel);
        if (bulunan) {
          bulunan.whatsappLid = tel;
          await setVeri(veri);
          await mesajGonder(tel,
            `✅ Sizi bulduk! Merhaba *${bulunan.ad||bulunan.soyad}*!\n\n` +
            `*1* - 📋 Kiralama durumum\n*2* - 🔄 Süre uzat\n*3* - 📦 İade bildirimi\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama`
          );
        } else {
          await mesajGonder(tel, `Sistemde kayıtlı bulunamadınız.\nKiralama yapmak ister misiniz? Bilgilerinizi alıyoruz 🎮`);
          await benimEkranim(`📵 *Yeni Müşteri Talebi*\n\nNumara: ${numara}\nWhatsApp: ${tel}\n\nSiteden ekleyip tekrar yazmalarını söyle.`);
        }
      } else {
        await mesajGonder(tel, `Geçerli telefon numarası girin (örn: 5301234567) 📱`);
      }
      return;
    }

    // Müşteri bulunamadı → telefon sor
    if (!musteri && isLid) {
      telefonBekle.set(tel, true);
      await mesajGonder(tel,
        `👋 Merhaba! GameRental'a hoş geldiniz 🎮\n\nSizi sistemimizde bulmak için kayıtlı telefon numaranızı yazar mısınız?\n(Örn: 5301234567)`
      );
      return;
    }

    const musteriAd = musteri ? (musteri.ad || musteri.soyad || 'Müşteri') : 'Misafir';
    const aktifKiralar = musteri ? veri.kiralamalar.filter(k => k.musteriId === musteri.id && k.durum === 'aktif') : [];
    const aktifKira = aktifKiralar[0] || null;

    // Bekleyen onaylar
    const bekleyen = bekleyenOnaylar.get(tel);
    if (bekleyen) {

      // YENİ KİRALAMA AKIŞI
      if (bekleyen.tip === 'kiralama_tip_bekle') {
        let kiraTip = null;
        if (metin.includes('primary') || metin === '1') kiraTip = 'primary';
        else if (metin.includes('secondary') || metin === '2') kiraTip = 'secondary';
        if (!kiraTip) {
          await mesajGonder(tel, `*1* - 🔵 Primary\n*2* - 🟣 Secondary\n\nHangisini tercih edersiniz?`);
          return;
        }
        const oyun = veri.oyunlar.find(o => o.id === bekleyen.oyunId);
        const gunluk = kiraTip === 'primary' ? (oyun?.gunlukPri||oyun?.gunluk||0) : (oyun?.gunlukSec||Math.round((oyun?.gunluk||0)*0.85));
        await mesajGonder(tel,
          `🔵 *${kiraTip === 'primary' ? 'Primary' : '🟣 Secondary'}* seçildi.\n💰 Günlük: ${formatPara(gunluk)}\n\nKaç gün kiralamak istiyorsunuz? (Min. 5 gün)`
        );
        bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'kiralama_gun_bekle', kiraTip, gunluk });
        return;
      }

      if (bekleyen.tip === 'kiralama_gun_bekle') {
        const gun = parseInt(metin);
        if (isNaN(gun) || gun < 5) {
          await mesajGonder(tel, `Minimum kiralama süresi 5 gündür. Kaç gün? (Min. 5)`);
          return;
        }
        const ucret = bekleyen.gunluk * gun;
        const bas = bugunStr();
        const bit = tarihEkle(bas, gun);
        await mesajGonder(tel,
          `📋 *Kiralama Özeti*\n\n🎮 Oyun: *${bekleyen.oyunAd}*\n🎯 Tip: ${bekleyen.kiraTip}\n📅 Süre: ${gun} gün (${bas} → ${bit})\n💰 Toplam: *${formatPara(ucret)}*\n\n` +
          `*Ödeme Bilgileri:*\nIBAN: \`${CONFIG.IBAN}\`\nHesap Sahibi: ${CONFIG.HESAP_ISIM}\nAçıklama: ${musteriAd} - ${bekleyen.oyunAd}\n\n` +
          `Ödemeyi yaptıktan sonra dekontu bu sohbete gönderin 📎`
        );
        bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'yeni_kiralama_dekont', gun, ucret, bas, bit });
        return;
      }

      if (bekleyen.tip === 'yeni_kiralama_dekont') {
        const medyaVar = msg.hasMedia || msg.type === 'image' || msg.type === 'document';
        if (medyaVar) {
          await mesajGonder(tel, `✅ Dekontunuz alındı! İşletmecimiz onayladıktan sonra kiralamanız başlayacak.\nBirkaç dakika içinde bildirim alacaksınız 🙏`);
          await benimEkranim(
            `💰 *Yeni Kiralama Talebi!*\n\n` +
            `👤 Müşteri: *${musteriAd}*\n` +
            `🎮 Oyun: *${bekleyen.oyunAd}*\n` +
            `🎯 Tip: ${bekleyen.kiraTip}\n` +
            `📅 Süre: ${bekleyen.gun} gün\n` +
            `💵 Tutar: ${formatPara(bekleyen.ucret)}\n\n` +
            `Onaylamak için:\n*#onayla ${tel.replace('@c.us','').replace('@lid','')}*`
          );
          bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'yeni_kiralama_bekle' });
        } else {
          await mesajGonder(tel, `Lütfen ödeme dekontunu *fotoğraf veya PDF* olarak gönderin 📎`);
        }
        return;
      }

      // UZATMA AKIŞI
      if (bekleyen.tip === 'uzatma_gun_bekle') {
        const gun = parseInt(metin);
        if (isNaN(gun) || gun < 1) { await mesajGonder(tel, 'Kaç gün uzatmak istiyorsunuz? (sayı yazın)'); return; }
        const ucret = bekleyen.gunluk * gun;
        await mesajGonder(tel,
          `🔄 *${gun} gün uzatma*\n💰 Tutar: *${formatPara(ucret)}*\n\n` +
          `*Ödeme:*\nIBAN: \`${CONFIG.IBAN}\`\nHesap Sahibi: ${CONFIG.HESAP_ISIM}\n\nDekontu gönderin 📎`
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
            `💰 *Uzatma Dekontu*\n\n👤 *${musteriAd}*\n🎮 ${oyun?.ad||'?'}\n📅 ${bekleyen.gun} gün\n💵 ${formatPara(bekleyen.ucret)}\n\nOnaylamak için:\n*#onayla ${tel.replace('@c.us','').replace('@lid','')}*`
          );
          bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'isletmeci_onay_bekle' });
        } else {
          await mesajGonder(tel, `Lütfen dekontu *fotoğraf veya PDF* olarak gönderin 📎`);
        }
        return;
      }

      // İADE AKIŞI
      if (bekleyen.tip === 'iade_onay') {
        if (metin === 'evet') {
          if (aktifKira) {
            aktifKira.durum = 'teslim';
            await setVeri(veri);
            const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
            await mesajGonder(tel, `✅ İade bildiriminiz alındı! *${oyun?.ad}* için teşekkürler 🎮`);
            await benimEkranim(`📦 *İade Bildirimi*\n\n👤 ${musteriAd}\n🎮 ${oyun?.ad}\n\nHesabı geri almayı unutma!`);
          }
          bekleyenOnaylar.delete(tel);
        } else {
          await mesajGonder(tel, `İptal edildi 😊`);
          bekleyenOnaylar.delete(tel);
        }
        return;
      }
    }

    // ANA MENÜ KOMUTLARI
    if (metin === 'merhaba' || metin === 'selam' || metin === 'selamlar' || metin === 'menu' || metin === 'menü' || metin === 'hi' || metin === 'başla') {
      await mesajGonder(tel,
        `👋 Merhaba *${musteriAd}*!\n\nGameRental'a hoş geldiniz 🎮\n\n` +
        `*1* - 📋 Kiralama durumum\n*2* - 🔄 Süre uzat\n*3* - 📦 İade bildirimi\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n\nVeya sorunuzu yazın!`
      );
      return;
    }

    if (metin === '1' || metin.includes('durumum') || metin.includes('kiralamam')) {
      if (!musteri || aktifKiralar.length === 0) {
        await mesajGonder(tel, `📋 *${musteriAd}* — aktif kiralama bulunmuyor.\n\nYeni kiralama için *5* yazın 🎮`);
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

    if (metin === '2' || metin.includes('uzat') || metin.includes('süre uzat')) {
      if (!aktifKira) { await mesajGonder(tel, `Aktif kiralama bulunmuyor 🎮`); return; }
      const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
      const gunluk = aktifKira.tip === 'primary' ? (oyun?.gunlukPri||oyun?.gunluk||0) : (oyun?.gunlukSec||Math.round((oyun?.gunluk||0)*0.85));
      await mesajGonder(tel,
        `🔄 *Süre Uzatma*\n\n🎮 *${oyun?.ad}*\n📅 Bitiş: ${aktifKira.bit}\n💰 Günlük: ${formatPara(gunluk)}\n\nKaç gün uzatmak istiyorsunuz?`
      );
      bekleyenOnaylar.set(tel, { tip: 'uzatma_gun_bekle', kiraId: aktifKira.id, gunluk });
      return;
    }

    if (metin === '3' || metin.includes('iade') || metin.includes('teslim') || metin.includes('bitir')) {
      if (!aktifKira) { await mesajGonder(tel, `Aktif kiralama bulunmuyor 🎮`); return; }
      const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
      await mesajGonder(tel, `📦 *${oyun?.ad}* oyununu iade etmek istediğinizi onaylıyor musunuz?\n\n*evet* yazarak onaylayın.`);
      bekleyenOnaylar.set(tel, { tip: 'iade_onay', kiraId: aktifKira.id });
      return;
    }

    if (metin === '4' || metin === 'oyunlar' || metin.includes('müsait') || metin.includes('musait') || metin.includes('liste')) {
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

    // YENİ KİRALAMA
    if (metin === '5' || metin.includes('yeni kiralama') || metin.includes('kiralamak istiyorum') || metin.includes('kiralayabilir miyim')) {
      if (!musteri) {
        await mesajGonder(tel, `Kiralama için önce sisteme kayıtlı olmanız gerekiyor.\nBize ulaşın, sizi ekleyelim 🎮`);
        await benimEkranim(`🛒 *Kayıtsız Kiralama Talebi*\n\nWhatsApp: ${tel}\nMesaj: "${metinOrijinal}"`);
        return;
      }
      const musaitOyunlar = veri.oyunlar.filter(o => {
        if (o.deaktif) return false;
        const kiraSayisi = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
        const toplamSlot = (o.kopyalar?.length||0) + 1;
        return kiraSayisi < toplamSlot;
      });
      if (musaitOyunlar.length === 0) {
        await mesajGonder(tel, `Şu an müsait oyun bulunmuyor 😔\nYakında yeni oyunlar eklenecek!`);
        return;
      }
      const liste = musaitOyunlar.map((o, i) => {
        const pri = o.gunlukPri || o.gunluk || 0;
        const sec = o.gunlukSec || Math.round((o.gunluk||0)*0.85);
        return `*${i+1}* - ${o.ad} (${o.platform}) | 🔵₺${pri} 🟣₺${sec}/gün`;
      }).join('\n');
      await mesajGonder(tel, `🎮 *Müsait Oyunlar*\n\n${liste}\n\nHangi oyunu kiralamak istiyorsunuz? (Numara veya isim yazın)`);
      bekleyenOnaylar.set(tel, { tip: 'kiralama_oyun_bekle', musteriId: musteri.id, musteriAd, musaitOyunlar });
      return;
    }

    // Oyun seçimi (kiralama akışında)
    const bekleyenKiralama = bekleyenOnaylar.get(tel);
    if (bekleyenKiralama?.tip === 'kiralama_oyun_bekle') {
      const { musaitOyunlar } = bekleyenKiralama;
      let secilen = null;
      const sayi = parseInt(metin);
      if (!isNaN(sayi) && sayi >= 1 && sayi <= musaitOyunlar.length) {
        secilen = musaitOyunlar[sayi - 1];
      } else {
        secilen = musaitOyunlar.find(o => o.ad.toLowerCase().includes(metin.toLowerCase()));
      }
      if (!secilen) {
        await mesajGonder(tel, `Oyun bulunamadı. Lütfen listeden numara veya isim yazın.`);
        return;
      }
      const pri = secilen.gunlukPri || secilen.gunluk || 0;
      const sec = secilen.gunlukSec || Math.round((secilen.gunluk||0)*0.85);
      await mesajGonder(tel,
        `🎮 *${secilen.ad}* seçildi!\n\n🔵 Primary: ${formatPara(pri)}/gün\n🟣 Secondary: ${formatPara(sec)}/gün\n\nHangi tipi tercih edersiniz?\n*1* - 🔵 Primary\n*2* - 🟣 Secondary`
      );
      bekleyenOnaylar.set(tel, { tip: 'kiralama_tip_bekle', musteriId: bekleyenKiralama.musteriId, musteriAd, oyunId: secilen.id, oyunAd: secilen.ad });
      return;
    }

    // CLAUDE'A YÖNLENDIR
    const gecmisOzet = musteri
      ? `${veri.kiralamalar.filter(k => k.musteriId === musteri.id).length} kiralama, ${aktifKira ? 'aktif kiralama var (bitiş: ' + aktifKira.bit + ')' : 'aktif kiralama yok'}`
      : 'Kayıtlı müşteri değil';

    const oyunListesi = veri.oyunlar.filter(o => !o.deaktif).map(o => {
      const kirada = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
      const musait = ((o.kopyalar?.length||0) + 1) - kirada;
      const pri = o.gunlukPri || o.gunluk || 0;
      const sec = o.gunlukSec || Math.round((o.gunluk||0)*0.85);
      return `${o.ad} (${o.platform}, Primary: ₺${pri}/gün, Secondary: ₺${sec}/gün, ${musait > 0 ? 'müsait' : 'kirada'})`;
    }).join('\n');

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

// ZAMANLANMIŞ
async function yarinBitenKontrol() {
  const veri = await getVeri(); if (!veri) return;
  const yarin = yarinStr();
  for (const k of veri.kiralamalar.filter(k => k.durum === 'aktif' && k.bit === yarin)) {
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
  for (const k of veri.kiralamalar.filter(k => k.durum === 'aktif' && k.bit < now)) {
    try {
      const s = await db.collection('botState').doc(`uyari_${k.id}`).get();
      if (s.exists && s.data().tarih === now) continue;
    } catch(e) {}
    const musteri = veri.musteriler.find(m => m.id === k.musteriId);
    const oyun = veri.oyunlar.find(o => o.id === k.oyunId);
    if (!musteri) continue;
    const hedef = musteri.whatsappLid || (musteri.tel ? temizTel(musteri.tel) + '@c.us' : null);
    if (!hedef) continue;
    const gecGun = gunFarki(k.bit, now);
    const gunluk = k.tip === 'primary' ? (oyun?.gunlukPri||oyun?.gunluk||0) : (oyun?.gunlukSec||Math.round((oyun?.gunluk||0)*0.85));
    await mesajGonder(hedef, `⚠️ *Gecikmiş İade*\n\nMerhaba *${musteri.ad||musteri.soyad}*!\n*${oyun?.ad}* *${gecGun} gün* gecikmiş.\nEkstra: *${formatPara(gunluk*gecGun)}*\n\nİade için *3*, uzatmak için *2* yazın 🙏`);
    try { await db.collection('botState').doc(`uyari_${k.id}`).set({ tarih: now }); } catch(e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
}

setInterval(async () => {
  const saat = new Date().getHours();
  if (saat === 9) await yarinBitenKontrol();
  await gecikmeKontrol();
}, 60 * 60 * 1000);

app.get('/', (req, res) => res.send('🎮 GameRental Bot çalışıyor!'));
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Webhook port ${CONFIG.PORT}`);
  console.log('⏰ Zamanlanmış kontroller aktif');
});
