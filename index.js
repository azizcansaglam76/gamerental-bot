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
const INSAN_SURESI = 30 * 60 * 1000;
let benimLid = null;

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
    if (event.event !== 'message') return;
    const msg = event.payload;
    if (!msg) return;

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
    const benimTelSade = (CONFIG.BENIM_NUMARAM || '').replace(/[^0-9]/g,'');
    const telNumara = tel.replace('@c.us','').replace('@lid','').replace(/[^0-9]/g,'');
    const benimMesajim = msg.fromMe || telNumara === benimTelSade || tel === benimLid;

    // LID'i kaydet
    if (benimMesajim && !benimLid) { benimLid = tel; console.log(`📱 Benim LID: ${benimLid}`); }

    if (benimMesajim) {
      if (metinOrijinal.startsWith('#')) {
        // # komutu — aşağıda işle
      } else {
        // Normal mesaj — müşteriye yazdıysam botu sustur
        const hedef = msg.to || msg.from;
        if (hedef && !benimMesajim) insanDevraldi.set(hedef, Date.now());
        // fromMe ise msg.to müşterinin numarası
        if (msg.fromMe && msg.to) {
          insanDevraldi.set(msg.to, Date.now());
          console.log(`👤 İşletmeci yazdı → bot susturuldu: ${msg.to}`);
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
          const bas = bugun();
          const bit = tarihEkle(bas, hedefBekleyen.gun);
          // Tier kontrolü — ÖNCE (kiralama eklenmeden)
          const tierOncesi = getMusteriTierBot(hedefBekleyen.musteriId, veri2);
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
          // Tier kontrolü — SONRA
          const tierSonrasi = getMusteriTierBot(hedefBekleyen.musteriId, veri2);
          const tierAtladi = tierOncesi.seviye !== tierSonrasi.seviye;
          let onayMesaj = `✅ *Ödemeniz onaylandı!*\n\n🎮 *${hedefBekleyen.oyunAd}*\n📅 ${bas} → ${bit}\n💰 ${fmt(hedefBekleyen.ucret)}\n\nHesap bilgileri için işletmecimiz kısa sürede sizinle iletişime geçecek 🙏`;
          if (tierAtladi) {
            onayMesaj += `\n\n🎉 *Tebrikler!* ${tierOncesi.emoji} ${tierOncesi.label} → ${tierSonrasi.emoji} *${tierSonrasi.label}* seviyesine yükseldin!`;
            if (tierSonrasi.indirim > 0) onayMesaj += `\n✨ Artık *%${tierSonrasi.indirim} indirim* hakkın var!`;
          }
          await mesajGonder(hedefKey, onayMesaj);
          if (tierAtladi) {
            await banaGonder(`🏅 *Tier Değişimi*\n👤 ${hedefBekleyen.musteriAd}\n${tierOncesi.emoji} ${tierOncesi.label} → ${tierSonrasi.emoji} ${tierSonrasi.label}`);
          }
          await banaGonder(`✅ Kiralama eklendi!\n🎮 ${hedefBekleyen.oyunAd}\n👤 ${hedefBekleyen.musteriAd}\n📅 ${bas} → ${bit}\n\n⚠️ Hesabı paylaşmayı unutma!`);
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

    // ── GENEL İPTAL — herhangi bir state'deyken "iptal" yazarsa menüye dön ──
    const bekleyenKontrol = bekleyenOnaylar.get(tel);
    if (bekleyenKontrol && (metin === 'iptal' || metin === 'vazgeç' || metin === 'vazgec' || metin === 'geri')) {
      bekleyenOnaylar.delete(tel);
      await mesajGonder(tel,
        `İptal edildi 😊\n\n👋 *${musteriAd}*, başka bir şey yapabilir miyim?\n\n` +
        `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş`
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
            `✅ Merhaba *${(bulunan.ad||bulunan.soyad||'').trim()}*!\n\n*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama`
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
          `✅ *${bekleyen.oyunAd}* için sıraya girdiniz!\n\n${tipLabel}\n📍 Sıra numaranız: ${siradakiSayi + 1}\n\nSlot açılınca size otomatik bildirim gönderilir 🔔`
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
          bekleyenOnaylar.delete(tel);
          await mesajGonder(tel,
            `İptal edildi 😊\n\n👋 *${musteriAd}*, başka bir şey yapabilir miyim?\n\n` +
            `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş`
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
        `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n\nVeya sorunuzu yazın!`
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
      const tumOyunlar = veri.oyunlar.filter(o => !o.deaktif);

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
      await banaGonder(`🔔 *Yetkili Talebi*\n\n👤 ${musteriAd}\n📞 ${tel}\n💬 "${metinOrijinal}"\n\nMüşteri seninle görüşmek istiyor!`);
      insanDevraldi.set(tel, Date.now());
      return;
    }

    // Anlaşılmayan mesaj — menüye yönlendir
    await mesajGonder(tel,
      `Merhaba ${musteriAd}! 😊\n\nAşağıdaki seçeneklerden birini yazabilirsin:\n\n` +
      `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş`
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
  // Restart'tan sonra 60 dakika geçmediyse hiç çalışma
  if (Date.now() - _ilkBaslangic < 60 * 60 * 1000) {
    console.log('⏳ Zamanlayıcı bekleme modunda (restart sonrası)');
    return;
  }
  const saat = new Date().getHours();
  if (saat === 15) await yarinBitenKontrol();
  await gecikmeKontrol();
  await rezervSiraKontrol();
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
