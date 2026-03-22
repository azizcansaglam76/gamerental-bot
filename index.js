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

// ── TİER SİSTEMİ ──
function getMusteriTierBot(musteriId, veri) {
  const d3ay = new Date();
  d3ay.setMonth(d3ay.getMonth() - 3);
  const d3ayStr = d3ay.toISOString().slice(0, 10);
  const kiralar = veri.kiralamalar.filter(k => k.musteriId === musteriId && k.bas >= d3ayStr);
  const toplam = kiralar.reduce((s, k) => s + k.net, 0);
  if (toplam >= 3000) return { seviye: 'platin', emoji: '💎', label: 'Platin', indirim: 15, toplam, sonraki: null, kalanTL: 0 };
  if (toplam >= 1500) return { seviye: 'altin',  emoji: '🥇', label: 'Altın',  indirim: 10, toplam, sonraki: 'Platin 💎', kalanTL: 3000 - toplam };
  if (toplam >= 750)  return { seviye: 'gumus',  emoji: '🥈', label: 'Gümüş',  indirim: 5,  toplam, sonraki: 'Altın 🥇',  kalanTL: 1500 - toplam };
  return                     { seviye: 'bronz',  emoji: '🥉', label: 'Bronz',  indirim: 0,  toplam, sonraki: 'Gümüş 🥈',  kalanTL: 750 - toplam };
}

function tierMesajiOlustur(tier, musteriAd) {
  const adSoyad = musteriAd || 'Müşterimiz';
  let mesaj = `🎮 *${adSoyad}*\n\n`;
  mesaj += `${tier.emoji} *${tier.label} Üye*\n`;
  mesaj += `📊 Son 3 ay harcama: *${fmt(tier.toplam)}*\n`;
  if (tier.indirim > 0) mesaj += `✨ İndirim hakkın: *%${tier.indirim}*\n`;
  if (tier.sonraki) {
    mesaj += `\n📈 *${tier.sonraki}* için *${fmt(tier.kalanTL)}* daha harca!\n`;
  } else {
    mesaj += `\n🏆 En üst seviyedesin, tebrikler!\n`;
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
const insanDevraldi = new Map(); // tel -> timestamp
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
    // Telefon numarası sonu veya LID eşleşmesi
    const benimMesajim = msg.fromMe
      || tel === benimLid
      || telNumara === benimLidKayitli
      || (benimTelSade.length >= 9 && telNumara.endsWith(benimTelSade))
      || (benimTelSade.length >= 9 && telNumara.slice(-9) === benimTelSade.slice(-9));


    // LID'i kaydet
    if (benimMesajim && !benimLid) { benimLid = tel; console.log(`📱 Benim LID: ${benimLid}`); }

    if (benimMesajim) {
      if (metinOrijinal.startsWith('#')) {
        // # komutu — aşağıda işle
      } else {
        // Ben bir müşteriye yazdım — o müşteriyi sustur
        // Waha fromMe:false gönderdiği için msg.to güvenilir değil
        // Bunun yerine son bot mesajı gönderilen LID'i sustur (sonMesajGonderilenLid map'inden)
        const hedef = msg.fromMe ? msg.to : null;
        const susturulanlar = new Set();
        if (hedef) {
          const s9 = hedef.replace(/[^0-9]/g,'').slice(-9);
          insanDevraldi.set(hedef, Date.now());
          insanDevraldi.set(s9 + '@c.us', Date.now());
          insanDevraldi.set(s9 + '@lid', Date.now());
          susturulanlar.add(hedef);
        }
        // sonMesajGonderilenLid'den tüm aktif müşterileri sustur
        for (const [s9, lid] of sonMesajGonderilenLid) {
          insanDevraldi.set(lid, Date.now());
          insanDevraldi.set(s9 + '@c.us', Date.now());
          insanDevraldi.set(s9 + '@lid', Date.now());
          susturulanlar.add(lid);
        }
        // bekleyenOnaylar'daki aktif müşterileri de sustur
        for (const [k] of bekleyenOnaylar) {
          const ks9 = k.replace(/[^0-9]/g,'').slice(-9);
          insanDevraldi.set(k, Date.now());
          insanDevraldi.set(ks9 + '@c.us', Date.now());
          insanDevraldi.set(ks9 + '@lid', Date.now());
          susturulanlar.add(k);
        }
        if (susturulanlar.size > 0) {
          console.log(`👤 İşletmeci yazdı → susturuldu: ${susturulanlar.size} kişi`);
        }
        sonMesajGonderilenLid.clear();
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
            const adM = mM ? ((mM.ad || mM.soyad || '').trim() || 'Merhaba') : 'Merhaba';
            const hedefKey = (mM && mM.whatsappLid) ? mM.whatsappLid : (sade + '@c.us');
            stateTemizle(hedefKey);
            await mesajGonder(hedefKey,
              `👋 Merhaba *${adM}*! 🎮\n\n*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon`
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
          const yeniId = (veri2.nextId?.k || 400) + 1;
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
          veri2.nextId.k = yeniId;
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
          onayMesaj += `\n💰 ${fmt(hedefBekleyen.ucret)}\n\nHesap bilgileri için işletmecimiz kısa sürede sizinle iletişime geçecek 🙏`;
          if (tierAtladi) {
            onayMesaj += `\n\n🎉 *Tebrikler!* ${tierOncesi.emoji} ${tierOncesi.label} → ${tierSonrasi.emoji} *${tierSonrasi.label}* seviyesine yükseldin!`;
            if (tierSonrasi.indirim > 0) onayMesaj += `\n✨ Artık *%${tierSonrasi.indirim} indirim* hakkın var!`;
          }
          await mesajGonder(hedefKey, onayMesaj);
          if (tierAtladi) {
            await banaGonder(`🏅 *Tier Değişimi*\n👤 ${hedefBekleyen.musteriAd}\n${tierOncesi.emoji} ${tierOncesi.label} → ${tierSonrasi.emoji} ${tierSonrasi.label}`);
          }
          await banaGonder(`✅ Kiralama eklendi!\n🎮 ${hedefBekleyen.oyunAd}\n👤 ${hedefBekleyen.musteriAd}\n📅 ${bas} → ${bit}${hediyeGun > 0 ? ` (+${hediyeGun} gün hediye)` : ''}\n\n⚠️ Hesabı paylaşmayı unutma!`);
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
    if (!musteri && !isLid) {
      const sade = tel.replace('@c.us','').replace(/^90/,'');
      musteri = veri.musteriler.find(m => m.tel && m.tel.replace(/[^0-9]/g,'').replace(/^0/,'') === sade);
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
        `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon`
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
            `✅ Merhaba *${(bulunan.ad||bulunan.soyad||'').trim()}*!\n\n*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon`
          );
        } else {
          await mesajGonder(tel, `Sistemde kayıtlı bulunamadınız. Kayıt için işletmecimize ulaşın 🎮`);
          const yeniLidKisa = tel.replace(/[^0-9]/g,"").slice(-10);
          await banaGonder(`📵 *Yeni Müşteri*\n\nNumara: ${numara}\nWhatsApp: ${tel}\n\n💬 Susturmak için: #sustur ${yeniLidKisa}\n🤖 Menü için: #menu ${numara}`);
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
        const { musaitOyunlar, kiradaOyunlar = [] } = bekleyen;
        let secilen = null;
        let secilenKirada = false;
        const sayi = parseInt(metin);
        if (!isNaN(sayi) && sayi >= 1 && sayi <= musaitOyunlar.length) {
          secilen = musaitOyunlar[sayi - 1];
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
        const siradakiSayi = veri2.rezervasyonlar.filter(r => r.oyunId === bekleyen.oyunId && r.tip === kiraTip && r.durum === 'bekliyor').length;
        const yeniRezervId = (veri2.nextId?.r || 1);
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
        const siradakiSayi = veri2.rezervasyonlar.filter(r => r.oyunId === bekleyen.oyunId && r.tip === kiraTip && r.durum === 'bekliyor').length;
        const yeniRezervId = (veri2.nextId?.r || 1);
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
        const platinMi = tierHediye.seviye === 'platin';
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
        ozet += `*Ödeme Bilgileri:*\nIBAN: \`${CONFIG.IBAN}\`\nHesap Sahibi: ${CONFIG.HESAP_ISIM}\n\nÖdemeyi yaptıktan sonra dekontu buraya gönderin 📎`;
        await mesajGonder(tel, ozet);
        bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'yeni_kiralama_dekont', gun, hediye, toplamGun, ucret, indirim: indirimTL, bas, bit });
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
            `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon`
          );
          return;
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

      if (bekleyen.tip === 'iade_onay') {
        if (metin === 'evet') {
          if (aktifKira) {
            aktifKira.durum = 'teslim';
            await setVeri(veri);
            const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
            // Tipe göre hesap silme hatırlatması
            let iadeMesaj = `✅ İade bildiriminiz alındı! *${oyun?.ad}* için teşekkürler 🎮\n\n`;
            if (aktifKira.tip === 'primary') {
              iadeMesaj += `⚠️ *Önemli Hatırlatma:*\nLütfen konsolunuzdan şu adımları uygulayın:\n\n`;
              iadeMesaj += `*Ayarlar → Kullanıcılar ve Hesaplar → Diğer → Çevrimdışı Oynama → Devre Dışı Bırak*\n\n`;
              iadeMesaj += `Bu adımı tamamladıktan sonra hesabı konsolunuzdan silebilirsiniz 🙏`;
            } else {
              iadeMesaj += `⚠️ *Önemli Hatırlatma:*\nLütfen hesabı konsolunuzdan silmeyi unutmayın 🙏`;
            }
            await mesajGonder(tel, iadeMesaj);
            await banaGonder(`📦 *İADE BİLDİRİMİ*\n\n👤 ${musteriAd}\n🎮 ${oyun?.ad}\n🎯 ${aktifKira.tip}\n\n⚠️ Hesabı geri almayı unutma!`);

            // Tavsiye sistemi — müşterinin geçmiş kiralamaları dışındaki müsait oyunları öner
            try {
              await new Promise(r => setTimeout(r, 2000)); // 2 sn bekle
              const kiraliOyunIds = new Set(veri.kiralamalar.filter(k => k.musteriId === musteri.id).map(k => k.oyunId));
              // Collaborative filtering — aynı oyunları kiralayan müşterilerin tercihlerini baz al
              const benzerlik = new Map();
              veri.kiralamalar.forEach(k => {
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
                o.id !== aktifKira.oyunId &&
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
            `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon`
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
        `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon\n\nVeya sorunuzu yazın!`
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
      const o = veri.oyunlar.find(x => x.id === aktifKira.oyunId);
      const gf = gunlukFiyat(o, aktifKira.tip);
      await mesajGonder(tel, `🔄 *Süre Uzatma*\n\n🎮 *${o?.ad}*\n📅 Bitiş: ${aktifKira.bit}\n💰 Günlük: ${fmt(gf)}\n\nKaç gün uzatmak istiyorsunuz?`);
      bekleyenOnaylar.set(tel, { tip: 'uzatma_gun_bekle', kiraId: aktifKira.id, musteriId: aktifKira.musteriId, gunluk: gf });
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
      const liste = veri.oyunlar.filter(o => !o.deaktif).sort((a,b) => b.id - a.id).map(o => {
        const kirada = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
        const musait = ((o.kopyalar?.length||0) + 1) - kirada > 0;
        const pri = gunlukFiyat(o, 'primary');
        const sec = gunlukFiyat(o, 'secondary');
        return `${musait ? '✅' : '❌'} *${o.ad}* (${o.platform})\n   🔵 ${fmt(pri)}/gün  🟣 ${fmt(sec)}/gün`;
      }).join('\n');
      await mesajGonder(tel, `🎮 *Oyun Listesi*\n\n${liste}`);
      return;
    }

    // 6 — Tier / Üyelik seviyesi
    if (metin === '6' || metin.includes('tier') || metin.includes('seviyem') || metin.includes('üyeliğim') || metin.includes('uyelik') || metin.includes('seviye') || metin.includes('kaç puan') || metin.includes('indirimim') || metin.includes('puanım')) {
      if (!musteri) {
        await mesajGonder(tel, `Üyelik bilgisi için önce kayıtlı olmanız gerekiyor.\nİşletmecimize ulaşın 🎮`);
        return;
      }
      const tier = getMusteriTierBot(musteri.id, veri);
      await mesajGonder(tel, tierMesajiOlustur(tier, musteriAd));
      return;
    }

    // 5 — Yeni kiralama
    if (metin === '5' || metin.includes('yeni kiralama') || metin.includes('kiralamak istiyorum') || metin.includes('kiralayabilir miyim')) {
      if (!musteri) {
        await mesajGonder(tel, `Kiralama için önce kayıtlı olmanız gerekiyor.\nİşletmecimize ulaşın 🎮`);
        await banaGonder(`🛒 *Kayıtsız Kiralama Talebi*\nWhatsApp: ${tel}\nMesaj: "${metinOrijinal}"`);
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

    // 7 — Yetkili ile görüş
    if (metin === '7' || metin.includes('yetkili') || metin.includes('hocam') ||
        metin.includes('insan') || metin.includes('sizi') || metin.includes('sizinle') ||
        metin.includes('görüşmek') || metin.includes('konuşmak') || metin.includes('aramak') ||
        metin.includes('arayabilir') || metin.includes('yetkiliye') || metin.includes('sahibi')) {
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

    // Anlaşılmayan mesaj — menüye yönlendir
    await mesajGonder(tel,
      `Merhaba ${musteriAd}! 😊\n\nAşağıdaki seçeneklerden birini yazabilirsin:\n\n` +
      `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon`
    );

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
    await mesajGonder(hedef,
      `⏰ *Süre Bugün Bitiyor!*\n\n` +
      `Merhaba! *${o?.ad}* oyununuzun kiralama süresi *bugün* sona eriyor.\n\n` +
      `Güven puanınızda sorun yaşamamak için lütfen:\n\n` +
      `📦 *İade etmek için* → *3* yazın\n` +
      `🔄 *Uzatmak için* → *2* yazın\n\n` +
      `Teşekkürler! 🎮`
    );
    // Direkt uzatma state'ine alma — müşteri seçsin
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
    await mesajGonder(hedef,
      `⚠️ *Gecikmiş İade*\n\nMerhaba!\n*${o?.ad}* *${gecGun} gün* gecikmiş.\nEkstra: *${fmt(gf*gecGun)}*\n\nİade için *3*, uzatmak için *2* yazın 🙏`
    );
    gecikmeOzet.push(`• ${m.soyad||m.ad||m.tel} — ${o?.ad} (${gecGun}g, +${fmt(gf*gecGun)})`);
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

    // Slot müsait — sıradaki ilk kişiyi bul (atla=true olmayanlar)
    const siralar = veri.rezervasyonlar
      .filter(r => r.oyunId === oyunId && r.tip === tip && r.durum === 'bekliyor' && !r.atla)
      .sort((a, b) => (a.sira || a.id) - (b.sira || b.id));

    if (!siralar.length) continue;
    const ilk = siralar[0];

    // Bu kişiye bugün zaten bildirim attık mı?
    const stateKey = `rezerv_bildirim_${ilk.id}`;
    try {
      const s = await db.collection('botState').doc(stateKey).get();
      if (s.exists && s.data().tarih === now) continue;
    } catch(e) {}

    const m = veri.musteriler.find(x => x.id === ilk.musteriId);
    if (!m) continue;
    const hedef = m.whatsappLid || (m.tel ? temizTel(m.tel) + '@c.us' : null);
    if (!hedef) continue;

    const musteriAd = m.ad || m.soyad || m.tel;
    const tipLabel = tip === 'primary' ? '🔵 Primary' : '🟣 Secondary';

    await mesajGonder(hedef,
      `🎉 *Sıran Geldi!*\n\nMerhaba ${musteriAd}!\n\n*${o.ad}* için beklediğin slot artık müsait! ${tipLabel}\n\nKiralama için ödemeyi yapıp dekontu gönder, hemen aktifleştirelim 🚀\n\n💳 IBAN: ${CONFIG.IBAN}\n👤 ${CONFIG.HESAP_ISIM}`
    );

    await banaGonder(`🔔 *Rezerv Bildirimi Gönderildi*\n• ${musteriAd} → ${o.ad} (${tipLabel})`);

    try { await db.collection('botState').doc(stateKey).set({ tarih: now }); } catch(e) {}
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
