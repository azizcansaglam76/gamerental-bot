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
function temizTel(t) { return t.replace(/[^0-9]/g,'').replace(/^0/,'').replace(/^(?!90)/,'90'); }
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

// ── MESAJ GÖNDER ──
async function mesajGonder(tel, metin) {
  try {
    const chatId = tel.includes('@') ? tel : tel + '@c.us';
    await axios.post(`${CONFIG.WAHA_URL}/api/sendText`,
      { session: 'default', chatId, text: metin },
      { headers: CONFIG.WAHA_API_KEY ? { 'X-Api-Key': CONFIG.WAHA_API_KEY } : {} }
    );
    console.log(`📤 → ${chatId.slice(0,20)}`);
  } catch (e) { console.error('Gönderim hatası:', e.message); }
}
async function banaGonder(metin) {
  if (CONFIG.BENIM_NUMARAM) await mesajGonder(CONFIG.BENIM_NUMARAM, metin);
}

// ── CLAUDE ──
const konusmalar = new Map();
async function claudeCevap(musteriAd, mesaj, gecmis, oyunlar) {
  const hist = konusmalar.get(musteriAd) || [];
  hist.push({ role: 'user', content: mesaj });
  const kisaltilmis = hist.slice(-6);
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: `Sen GameRental PlayStation oyun kiralama işletmesinin WhatsApp asistanısın.
Müşteri: ${musteriAd} | Geçmiş: ${gecmis}

Oyunlar:
${oyunlar}

Kurallar: Kısa/samimi cevap ver. Türkçe. Max 4-5 cümle.
Kiralama talebinde "işletmecimiz sizinle iletişime geçecek" de.
PS hesabı konsolda oynatır, min 5 gün, ödeme havale/EFT.`,
    messages: kisaltilmis,
  }, { headers: { 'x-api-key': CONFIG.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  const cevap = res.data.content[0].text;
  hist.push({ role: 'assistant', content: cevap });
  if (hist.length > 20) hist.splice(0, 2);
  konusmalar.set(musteriAd, hist);
  return cevap;
}

// ── STATE ──
// bekleyenOnaylar: tel -> { tip, ... }
// tipler: telefon_bekle | kiralama_oyun_bekle | kiralama_tip_bekle | kiralama_gun_bekle
//         yeni_kiralama_dekont | yeni_kiralama_bekle
//         uzatma_gun_bekle | uzatma_dekont | uzatma_isletmeci_bekle
//         iade_onay
const bekleyenOnaylar = new Map();
const insanDevraldi = new Map(); // tel -> timestamp
const INSAN_SURESI = 30 * 60 * 1000;
let benimLid = null;

// ── RESET KOMUTU için tüm state temizle ──
function stateTemizle(tel) {
  bekleyenOnaylar.delete(tel);
  insanDevraldi.delete(tel);
  konusmalar.delete(tel);
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
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    if (event.event !== 'message' && event.event !== 'message.any') return;
    const msg = event.payload;
    if (!msg) return;

    // Grup mesajlarını atla
    if (msg.from && msg.from.includes('@g.us')) return;

    // ── KENDİ MESAJLARIM (fromMe) ──
    if (msg.fromMe) {
      if (!benimLid) { benimLid = msg.from; console.log(`📱 Benim LID: ${benimLid}`); }
      // Müşteriye yazdıysam → botu sustur
      if (msg.to) {
        insanDevraldi.set(msg.to, Date.now());
        console.log(`👤 İşletmeci yazdı → bot susturuldu: ${msg.to}`);
      }
      return;
    }

    const tel = msg.from;
    if (!tel) return;
    const metin = (msg.body || '').trim().toLowerCase();
    const metinOrijinal = (msg.body || '').trim();
    const medya = medyaVarMi(msg);

    console.log(`📨 ${tel} → "${metin.slice(0,40)}" | medya:${medya} | type:${msg.type}`);

    // ── İŞLETMECİ NUMARASI KONTROLÜ ──
    const benimTelSade = (CONFIG.BENIM_NUMARAM || '').replace(/[^0-9]/g,'');
    const telNumara = tel.replace('@c.us','').replace('@lid','').replace(/[^0-9]/g,'');
    const benimMesajim = telNumara === benimTelSade || tel === benimLid;

    if (benimMesajim) {
      // ── İŞLETMECİ KOMUTLARI ──

      // #reset — tüm state temizle
      if (metin === '#reset') {
        bekleyenOnaylar.clear();
        insanDevraldi.clear();
        konusmalar.clear();
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

      // #devral 905xxx — botu sustur
      if (metin.startsWith('#devral')) {
        const hedef = metinOrijinal.split(' ')[1];
        if (hedef) {
          const k = hedef.includes('@') ? hedef : hedef + '@c.us';
          insanDevraldi.set(k, Date.now());
          await banaGonder(`👤 Bot susturuldu: ${hedef} (30 dk)`);
        }
        return;
      }

      // #bota 905xxx — botu geri aç
      if (metin.startsWith('#bota')) {
        const hedef = metinOrijinal.split(' ')[1];
        if (hedef) {
          const k = hedef.includes('@') ? hedef : hedef + '@c.us';
          insanDevraldi.delete(k);
          await banaGonder(`🤖 Bot aktif: ${hedef}`);
        }
        return;
      }

      // #onayla 905xxx — ödeme onayla
      if (metin.startsWith('#onayla')) {
        const hedefTel = metinOrijinal.split(' ')[1];
        if (!hedefTel) { await banaGonder('Kullanım: #onayla 905xxxxxxxxx'); return; }

        // Hem @c.us hem @lid formatında ara
        const araKeys = [
          hedefTel.includes('@') ? hedefTel : hedefTel + '@c.us',
          hedefTel.replace(/[^0-9]/g,'') + '@lid',
        ];
        let hedefKey = null;
        let hedefBekleyen = null;
        for (const k of araKeys) {
          if (bekleyenOnaylar.has(k)) { hedefKey = k; hedefBekleyen = bekleyenOnaylar.get(k); break; }
        }

        if (!hedefBekleyen) { await banaGonder(`Bekleyen işlem yok: ${hedefTel}`); return; }
        const veri2 = await getVeri();

        // Yeni kiralama onayla
        if (hedefBekleyen.tip === 'yeni_kiralama_bekle') {
          const yeniId = (veri2.nextId?.k || 400) + 1;
          const bas = bugun();
          const bit = tarihEkle(bas, hedefBekleyen.gun);
          veri2.kiralamalar.push({
            id: yeniId, oyunId: hedefBekleyen.oyunId, musteriId: hedefBekleyen.musteriId,
            tip: hedefBekleyen.kiraTip, bas, bit,
            ucret: hedefBekleyen.ucret, indirim: 0, net: hedefBekleyen.ucret,
            onOdeme: hedefBekleyen.ucret, hediyeGun: 0, notlar: 'Bot ile eklendi', durum: 'aktif',
          });
          if (!veri2.nextId) veri2.nextId = {};
          veri2.nextId.k = yeniId;
          await setVeri(veri2);
          bekleyenOnaylar.delete(hedefKey);
          await mesajGonder(hedefKey,
            `✅ *Ödemeniz onaylandı!*\n\n🎮 *${hedefBekleyen.oyunAd}*\n📅 ${bas} → ${bit}\n💰 ${fmt(hedefBekleyen.ucret)}\n\nHesap bilgileri için işletmecimiz kısa sürede sizinle iletişime geçecek 🙏`
          );
          await banaGonder(`✅ Kiralama eklendi!\n🎮 ${hedefBekleyen.oyunAd}\n👤 ${hedefBekleyen.musteriAd}\n📅 ${bas} → ${bit}\n\n⚠️ Hesabı paylaşmayı unutma!`);
          return;
        }

        // Uzatma onayla
        if (hedefBekleyen.tip === 'uzatma_isletmeci_bekle') {
          const k = veri2.kiralamalar.find(x => x.id === hedefBekleyen.kiraId);
          if (k) {
            k.bit = tarihEkle(k.bit, hedefBekleyen.gun);
            k.ucret = (k.ucret||0) + hedefBekleyen.ucret;
            k.net = (k.net||0) + hedefBekleyen.ucret;
            await setVeri(veri2);
            bekleyenOnaylar.delete(hedefKey);
            await mesajGonder(hedefKey, `✅ Uzatma onaylandı! ${hedefBekleyen.gun} gün eklendi.\nYeni bitiş: *${k.bit}* 🎮`);
            await banaGonder(`✅ Uzatma yapıldı: ${hedefTel}`);
          }
          return;
        }
        await banaGonder(`Bilinmeyen bekleyen tip: ${hedefBekleyen.tip}`);
        return;
      }

      // #durum — aktif kiralamaları göster
      if (metin === '#durum') {
        const veri2 = await getVeri();
        const aktifler = veri2.kiralamalar.filter(k => k.durum === 'aktif');
        const bugunTar = bugun();
        let msg2 = `📊 *Aktif Kiralamalar (${aktifler.length})*\n\n`;
        aktifler.forEach(k => {
          const o = veri2.oyunlar.find(x => x.id === k.oyunId);
          const m = veri2.musteriler.find(x => x.id === k.musteriId);
          const gecikme = k.bit < bugunTar ? `⚠️ ${gunFarki(k.bit, bugunTar)}g gecikme` : `✅ ${gunFarki(bugunTar, k.bit)}g kaldı`;
          msg2 += `🎮 ${o?.ad||'?'} | ${m?.soyad||m?.ad||'?'} | ${k.bit} | ${gecikme}\n`;
        });
        await banaGonder(msg2);
        return;
      }

      return; // diğer benim mesajlarımı işleme
    }

    // ── İNSAN DEVRALMA KONTROLÜ ──
    const devralZamani = insanDevraldi.get(tel);
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
    if (!musteri && !isLid) {
      const sade = tel.replace('@c.us','').replace(/^90/,'');
      musteri = veri.musteriler.find(m => m.tel && m.tel.replace(/[^0-9]/g,'').replace(/^0/,'') === sade);
    }
    if (musteri && isLid && !musteri.whatsappLid) {
      musteri.whatsappLid = tel;
      try { await setVeri(veri); } catch(e) {}
    }

    const musteriAd = musteri ? ((musteri.ad||'') + ' ' + (musteri.soyad||'')).trim() || musteri.tel || 'Müşteri' : 'Misafir';
    const aktifKiralar = musteri ? veri.kiralamalar.filter(k => k.musteriId === musteri.id && k.durum === 'aktif') : [];
    const aktifKira = aktifKiralar[0] || null;

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
            `✅ Merhaba *${(bulunan.ad||bulunan.soyad||'').trim()}*!\n\n*1* - 📋 Kiralama durumum\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama`
          );
        } else {
          await mesajGonder(tel, `Sistemde kayıtlı bulunamadınız. Kayıt için işletmecimize ulaşın 🎮`);
          await banaGonder(`📵 *Yeni Müşteri*\n\nNumara: ${numara}\nWhatsApp: ${tel}`);
        }
      } else {
        await mesajGonder(tel, `Lütfen geçerli telefon numaranızı yazın (örn: 5301234567) 📱`);
      }
      return;
    }

    // ── LID İLE GELİYOR AMA SİSTEMDE YOK ──
    if (!musteri && isLid) {
      bekleyenOnaylar.set(tel, { tip: 'telefon_bekle' });
      await mesajGonder(tel, `👋 Merhaba! GameRental'a hoş geldiniz 🎮\n\nSizi sistemde bulmak için kayıtlı telefon numaranızı yazar mısınız?\n(Örn: 5301234567)`);
      return;
    }

    // ── BEKLEYEN İŞLEMLER ──
    if (bekleyen) {

      // Kiralama akışı — oyun seçimi
      if (bekleyen.tip === 'kiralama_oyun_bekle') {
        const { musaitOyunlar } = bekleyen;
        let secilen = null;
        const sayi = parseInt(metin);
        if (!isNaN(sayi) && sayi >= 1 && sayi <= musaitOyunlar.length) {
          secilen = musaitOyunlar[sayi - 1];
        } else {
          secilen = musaitOyunlar.find(o => o.ad.toLowerCase().includes(metin));
        }
        if (!secilen) { await mesajGonder(tel, `Oyun bulunamadı. Listeden numara veya isim yazın.`); return; }
        const pri = gunlukFiyat(secilen, 'primary');
        const sec = gunlukFiyat(secilen, 'secondary');
        await mesajGonder(tel, `🎮 *${secilen.ad}* seçildi!\n\n🔵 Primary: ${fmt(pri)}/gün\n🟣 Secondary: ${fmt(sec)}/gün\n\nHangi tipi tercih edersiniz?\n*1* - 🔵 Primary\n*2* - 🟣 Secondary`);
        bekleyenOnaylar.set(tel, { tip: 'kiralama_tip_bekle', musteriId: musteri.id, musteriAd, oyunId: secilen.id, oyunAd: secilen.ad });
        return;
      }

      // Kiralama akışı — tip seçimi
      if (bekleyen.tip === 'kiralama_tip_bekle') {
        let kiraTip = null;
        if (metin.includes('primary') || metin === '1') kiraTip = 'primary';
        else if (metin.includes('secondary') || metin === '2') kiraTip = 'secondary';
        if (!kiraTip) { await mesajGonder(tel, `*1* - 🔵 Primary\n*2* - 🟣 Secondary`); return; }
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
        const ucret = bekleyen.gunluk * gun;
        const bas = bugun();
        const bit = tarihEkle(bas, gun);
        await mesajGonder(tel,
          `📋 *Kiralama Özeti*\n\n🎮 *${bekleyen.oyunAd}*\n🎯 ${bekleyen.kiraTip}\n📅 ${gun} gün (${bas} → ${bit})\n💰 Toplam: *${fmt(ucret)}*\n\n` +
          `*Ödeme Bilgileri:*\nIBAN: \`${CONFIG.IBAN}\`\nHesap Sahibi: ${CONFIG.HESAP_ISIM}\n\n` +
          `Ödemeyi yaptıktan sonra dekontu buraya gönderin 📎`
        );
        bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'yeni_kiralama_dekont', gun, ucret, bas, bit });
        return;
      }

      // Yeni kiralama — dekont bekleniyor
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
        } else {
          await mesajGonder(tel, `Lütfen ödeme dekontunu *fotoğraf veya PDF* olarak gönderin 📎\n\nBaşka bir şey yazmak istiyorsanız önce işlemi tamamlayın.`);
        }
        return;
      }

      // Uzatma — gün girişi
      if (bekleyen.tip === 'uzatma_gun_bekle') {
        const gun = parseInt(metin);
        if (isNaN(gun) || gun < 1) { await mesajGonder(tel, `Kaç gün uzatmak istiyorsunuz? (sayı yazın)`); return; }
        const ucret = bekleyen.gunluk * gun;
        await mesajGonder(tel,
          `🔄 *${gun} gün uzatma*\n💰 Tutar: *${fmt(ucret)}*\n\n` +
          `*Ödeme:*\nIBAN: \`${CONFIG.IBAN}\`\nHesap Sahibi: ${CONFIG.HESAP_ISIM}\n\n` +
          `Dekontu buraya gönderin 📎`
        );
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
      if (bekleyen.tip === 'iade_onay') {
        if (metin === 'evet') {
          if (aktifKira) {
            aktifKira.durum = 'teslim';
            await setVeri(veri);
            const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
            await mesajGonder(tel, `✅ İade bildiriminiz alındı! *${oyun?.ad}* için teşekkürler 🎮`);
            await banaGonder(`📦 *İADE BİLDİRİMİ*\n\n👤 ${musteriAd}\n🎮 ${oyun?.ad}\n\n⚠️ Hesabı geri almayı unutma!`);
          }
        } else if (metin === 'hayır' || metin === 'hayir' || metin === 'iptal') {
          await mesajGonder(tel, `İptal edildi 😊`);
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
        `*1* - 📋 Kiralama durumum\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n\nVeya sorunuzu yazın!`
      );
      return;
    }

    // 1 — Kiralama durumu
    if (metin === '1' || metin.includes('durumum') || metin.includes('kiralamam')) {
      if (!musteri || aktifKiralar.length === 0) {
        await mesajGonder(tel, `📋 Aktif kiralama bulunmuyor.\n\nYeni kiralama için *5* yazın 🎮`);
        return;
      }
      let txt = `📋 *Aktif Kiralamalarınız*\n\n`;
      for (const k of aktifKiralar) {
        const o = veri.oyunlar.find(x => x.id === k.oyunId);
        const now = bugun();
        const gecGun = k.bit < now ? gunFarki(k.bit, now) : 0;
        const kalanGun = k.bit >= now ? gunFarki(now, k.bit) : 0;
        txt += `🎮 *${o?.ad||'?'}* (${k.tip})\n📅 Bitiş: ${k.bit}\n`;
        txt += gecGun > 0 ? `⚠️ *${gecGun} gün gecikmiş!*\n\n` : `✅ *${kalanGun} gün kaldı*\n\n`;
      }
      await mesajGonder(tel, txt);
      return;
    }

    // 2 — Uzatma
    if (metin === '2' || metin.includes('uzat')) {
      if (!aktifKira) { await mesajGonder(tel, `Aktif kiralama bulunmuyor 🎮`); return; }
      const o = veri.oyunlar.find(x => x.id === aktifKira.oyunId);
      const gf = gunlukFiyat(o, aktifKira.tip);
      await mesajGonder(tel, `🔄 *Süre Uzatma*\n\n🎮 *${o?.ad}*\n📅 Bitiş: ${aktifKira.bit}\n💰 Günlük: ${fmt(gf)}\n\nKaç gün uzatmak istiyorsunuz?`);
      bekleyenOnaylar.set(tel, { tip: 'uzatma_gun_bekle', kiraId: aktifKira.id, gunluk: gf });
      return;
    }

    // 3 — İade
    if (metin === '3' || metin.includes('iade') || metin.includes('teslim') || metin.includes('bitir')) {
      if (!aktifKira) { await mesajGonder(tel, `Aktif kiralama bulunmuyor 🎮`); return; }
      const o = veri.oyunlar.find(x => x.id === aktifKira.oyunId);
      await mesajGonder(tel, `📦 *${o?.ad}* oyununu iade etmek istiyorsunuz.\n\n*evet* yazarak onaylayın.`);
      bekleyenOnaylar.set(tel, { tip: 'iade_onay', kiraId: aktifKira.id });
      return;
    }

    // 4 — Oyun listesi
    if (metin === '4' || metin === 'oyunlar' || metin.includes('müsait') || metin.includes('musait') || metin.includes('liste')) {
      const liste = veri.oyunlar.filter(o => !o.deaktif).map(o => {
        const kirada = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
        const musait = ((o.kopyalar?.length||0) + 1) - kirada > 0;
        const pri = gunlukFiyat(o, 'primary');
        const sec = gunlukFiyat(o, 'secondary');
        return `${musait ? '✅' : '❌'} *${o.ad}* (${o.platform})\n   🔵 ${fmt(pri)}/gün  🟣 ${fmt(sec)}/gün`;
      }).join('\n');
      await mesajGonder(tel, `🎮 *Oyun Listesi*\n\n${liste}`);
      return;
    }

    // 5 — Yeni kiralama
    if (metin === '5' || metin.includes('yeni kiralama') || metin.includes('kiralamak istiyorum') || metin.includes('kiralayabilir miyim') || metin.includes('kiralamak istiyorum')) {
      if (!musteri) {
        await mesajGonder(tel, `Kiralama için önce kayıtlı olmanız gerekiyor.\nİşletmecimize ulaşın 🎮`);
        await banaGonder(`🛒 *Kayıtsız Kiralama Talebi*\nWhatsApp: ${tel}\nMesaj: "${metinOrijinal}"`);
        return;
      }
      const musaitOyunlar = veri.oyunlar.filter(o => {
        if (o.deaktif) return false;
        const kirada = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
        return kirada < ((o.kopyalar?.length||0) + 1);
      });
      if (musaitOyunlar.length === 0) { await mesajGonder(tel, `Şu an müsait oyun bulunmuyor 😔`); return; }
      const liste = musaitOyunlar.map((o, i) => {
        const pri = gunlukFiyat(o, 'primary');
        const sec = gunlukFiyat(o, 'secondary');
        return `*${i+1}* - ${o.ad} (${o.platform}) | 🔵${fmt(pri)} 🟣${fmt(sec)}/gün`;
      }).join('\n');
      await mesajGonder(tel, `🎮 *Müsait Oyunlar*\n\n${liste}\n\nHangi oyunu kiralamak istiyorsunuz? (Numara veya isim yazın)`);
      bekleyenOnaylar.set(tel, { tip: 'kiralama_oyun_bekle', musteriId: musteri.id, musteriAd, musaitOyunlar });
      return;
    }

    // ── CLAUDE'A YÖNLENDIR ──
    const gecmis = musteri
      ? `${veri.kiralamalar.filter(k=>k.musteriId===musteri.id).length} kiralama, ${aktifKira?'aktif var (bitiş:'+aktifKira.bit+')':'aktif yok'}`
      : 'Kayıtsız';
    const oyunlarStr = veri.oyunlar.filter(o=>!o.deaktif).map(o => {
      const kirada = veri.kiralamalar.filter(k=>k.oyunId===o.id&&k.durum==='aktif').length;
      const musait = ((o.kopyalar?.length||0)+1) - kirada > 0;
      return `${o.ad} (${o.platform}, Primary:${fmt(gunlukFiyat(o,'primary'))}, Secondary:${fmt(gunlukFiyat(o,'secondary'))}, ${musait?'müsait':'kirada'})`;
    }).join('\n');

    // Kiralama talebi bildirimi
    if (metin.includes('kiralamak') || metin.includes('kiralayabilir')) {
      await banaGonder(`🎮 *Kiralama Talebi*\n👤 ${musteriAd}\n💬 "${metinOrijinal}"`);
    }

    // Görüşme talebi bildirimi
    if (metin.includes('görüşmek') || metin.includes('konuşmak') || metin.includes('aramak') || metin.includes('arayabilir')) {
      await banaGonder(`📞 *Görüşme Talebi*\n👤 ${musteriAd} (${tel})\n💬 "${metinOrijinal}"`);
    }

    try {
      const cevap = await claudeCevap(musteriAd, metinOrijinal, gecmis, oyunlarStr);
      await mesajGonder(tel, cevap);
    } catch (e) {
      console.error('Claude hatası:', e.message, e.response?.data);
      await mesajGonder(tel, `Şu an cevap vermekte güçlük çekiyorum, birazdan tekrar dener misiniz? 🙏`);
      await banaGonder(`⚠️ Bot hatası!\n${musteriAd}: "${metinOrijinal}"\n${e.message}`);
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
    await mesajGonder(hedef, `🔔 *Hatırlatıcı*\n\nMerhaba!\n*${o?.ad}* oyununuz *yarın* bitiyor.\n\nUzatmak için *2* yazın 🎮`);
    bekleyenOnaylar.set(hedef, { tip: 'uzatma_gun_bekle', kiraId: k.id, gunluk: gf });
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
    const m = veri.musteriler.find(x => x.id === k.musteriId);
    const o = veri.oyunlar.find(x => x.id === k.oyunId);
    if (!m) continue;
    const hedef = m.whatsappLid || (m.tel ? temizTel(m.tel) + '@c.us' : null);
    if (!hedef) continue;
    const gecGun = gunFarki(k.bit, now);
    const gf = gunlukFiyat(o, k.tip);
    await mesajGonder(hedef,
      `⚠️ *Gecikmiş İade*\n\nMerhaba!\n*${o?.ad}* *${gecGun} gün* gecikmiş.\nEkstra: *${fmt(gf*gecGun)}*\n\nİade için *3*, uzatmak için *2* yazın 🙏`
    );
    try { await db.collection('botState').doc(`uyari_${k.id}`).set({ tarih: now }); } catch(e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
}

// Restart sonrası hemen çalışmasın — ilk kontrol 1 saat sonra
// Gecikme kontrolü: Firebase'e tarih yazar, aynı gün tekrar atmaz
let _ilkBaslangic = Date.now();
setInterval(async () => {
  // Restart'tan sonra 60 dakika geçmediyse hiç çalışma
  if (Date.now() - _ilkBaslangic < 60 * 60 * 1000) {
    console.log('⏳ Zamanlayıcı bekleme modunda (restart sonrası)');
    return;
  }
  const saat = new Date().getHours();
  if (saat === 15) await yarinBitenKontrol();
  await gecikmeKontrol();
}, 60 * 60 * 1000);

app.get('/', (req, res) => res.send('🎮 GameRental Bot çalışıyor!'));
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Port ${CONFIG.PORT} hazır`);
});
