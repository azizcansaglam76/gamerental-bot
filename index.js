const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrcodeWeb = require('qrcode');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const http = require('http');

// ══════════════════════════════════════════
// YAPILANDIRMA
// ══════════════════════════════════════════
const CONFIG = {
  FIREBASE_PROJECT: 'gamerental-fb121',
  USER_UID: process.env.USER_UID,           // Firebase kullanıcı UID'n
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  BENIM_NUMARAM: process.env.BENIM_NUMARAM, // Botun kendi numarası (90xxx formatında)
};

// ══════════════════════════════════════════
// FIREBASE BAŞLAT
// ══════════════════════════════════════════
// serviceAccountKey.json yerine environment variable'dan oku
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }
} catch(e) {
  console.error('Firebase parse hatasi:', e.message);
  console.error('Uzunluk:', process.env.FIREBASE_SERVICE_ACCOUNT?.length);
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

function formatTel(tel) {
  // Türkiye numaralarını 90xxx@c.us formatına çevir
  const temiz = tel.replace(/[^0-9]/g, '').replace(/^0/, '');
  return '90' + temiz + '@c.us';
}

function formatPara(n) {
  return '₺' + (n || 0).toLocaleString('tr-TR');
}

// ══════════════════════════════════════════
// CLAUDE API — AKILLI CEVAP
// ══════════════════════════════════════════
const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// Müşteri bazlı konuşma geçmişi
const konusmalar = new Map();

async function claudeCevap(musteriAd, mesaj, musteriGecmis, oyunListesi) {
  const history = konusmalar.get(musteriAd) || [];
  
  history.push({ role: 'user', content: mesaj });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: `Sen GameRental adlı PlayStation oyun kiralama işletmesinin WhatsApp asistanısın.
Müşteri adı: ${musteriAd}
Müşterinin kiralama geçmişi: ${musteriGecmis}

=== İŞLETME BİLGİLERİ ===
- Dijital PS4 ve PS5 oyun kiralama hizmeti
- Minimum kiralama süresi: 5 gün
- Ödeme: Havale / EFT
- Teslimat: Dijital hesap paylaşımı ile anında, kargo yok

=== SIKÇA SORULAN SORULAR ===
S: Nasıl çalışıyor?
C: PS hesabı konsolunuza eklenir, oyunu indirip oynarsınız. Süre sonunda hesap kaldırılır.

S: Kaç kişi aynı anda oynayabilir?
C: Primary hesap olarak 1 konsolda sınırsız, secondary olarak aynı anda 1 kişi oynayabilir.

S: PS4 oyununu PS5'te oynayabilir miyim?
C: Evet, PS4 oyunlarının büyük çoğunluğu PS5'te çalışır.

S: Ödemeyi nasıl yapacağım?
C: Havale/EFT ile ödeme yapılıyor. Kiralama onaylandıktan sonra hesap bilgileri paylaşılır.

S: Süre bitmeden iade olur mu?
C: Dijital ürün olduğu için süre bitmeden iade yapılamamaktadır.

S: Hesap güvenli mi?
C: Hesaplar güvenli şekilde paylaşılır, kişisel bilgilerinize erişim olmaz.

S: PS5'te primary hesabı nasıl etkinleştiririm?
C: Hesaba giriş yaptıktan sonra: Ayarlar → Kullanıcı ve Hesaplar → Diğer → Çevrimdışı Oynamayı Etkinleştir → Etkinleştir. Böylece o konsolda tüm oyunları internet olmadan da oynayabilirsiniz.

S: PS5'te primary hesabı iade ederken ne yapmalıyım?
C: Aynı yolu izleyin: Ayarlar → Kullanıcı ve Hesaplar → Diğer → Çevrimdışı Oynamayı Etkinleştir → Devre Dışı Bırak. Sonra hesabı konsoldan silin. Bu adımları atlarsanız bir sonraki müşteriye primary verilemez.

S: Aynı anda birden fazla oyun kiralayabilir miyim?
C: Evet, birden fazla oyun aynı anda kiralanabilir.

S: İndirim var mı?
C: Uzun süreli ve sadık müşterilere özel indirim uygulanabilir, sormaktan çekinmeyin.

=== MEVCUT OYUNLAR ===
${oyunListesi || 'Oyun listesi yüklenemedi'}

=== KURALLAR ===
Kısa ve samimi cevaplar ver. Türkçe yaz. Emoji kullanabilirsin.
Oyun sorarlarsa listeye göre müsait olanları fiyatlarıyla öner.
Emin olmadığın şeyleri "birazdan dönüş yapacağım" diyerek yönet.
Asla uydurma bilgi verme. Cevabın 4-5 cümleyi geçmesin.`,
    messages: history,
  });

  const cevap = response.content[0].text;
  history.push({ role: 'assistant', content: cevap });
  
  // Son 10 mesajı tut (hafıza)
  if (history.length > 20) history.splice(0, 2);
  konusmalar.set(musteriAd, history);
  
  return cevap;
}

// ══════════════════════════════════════════
// WHATSAPP CLIENT
// ══════════════════════════════════════════
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ],
    headless: true,
  }
});

client.on('qr', async (qr) => {
  console.log('\n📱 QR KODU TARA — Tarayıcıdan aç!\n');
  qrcode.generate(qr, { small: true });
  try {
    qrDataUrl = await qrcodeWeb.toDataURL(qr, { width: 300, margin: 2 });
    console.log('🌐 QR için tarayıcıda aç: Railway servisinin public URL\'ini kullan');
  } catch(e) { console.error('QR web hatası:', e.message); }
});

client.on('ready', () => {
  console.log('✅ WhatsApp botu hazır!');
  botReady = true;
  qrDataUrl = null;
  zamanlanmisKontroller();
});

// ══════════════════════════════════════════
// GELEN MESAJ İŞLEME
// ══════════════════════════════════════════
// İşletmeci devraldı listesi — {tel: timestamp}
const insanDevraldi = new Map();
const INSAN_SURESI = 30 * 60 * 1000; // 30 dakika

// İşletmeci müşteriye cevap yazınca botu o konuşmada sustur
client.on('message_create', async (msg) => {
  if (!msg.fromMe || msg.to.includes('@g.us')) return;
  insanDevraldi.set(msg.to, Date.now());
  console.log(`👤 İşletmeci devraldı: ${msg.to} (30 dk bot susacak)`);
});

client.on('message', async (msg) => {
  // Grup mesajlarını atla
  if (msg.from.includes('@g.us')) return;
  // Kendi mesajlarımızı atla
  if (msg.fromMe) return;

  // İşletmeci bu konuşmayı devraldı mı?
  const devralmaZamani = insanDevraldi.get(msg.from);
  if (devralmaZamani && Date.now() - devralmaZamani < INSAN_SURESI) {
    console.log(`👤 Bot susturuldu (işletmeci aktif): ${msg.from}`);
    return;
  } else if (devralmaZamani) {
    insanDevraldi.delete(msg.from); // Süre doldu, bot tekrar aktif
  }

  const tel = msg.from.replace('@c.us', '').replace(/^90/, '0');
  const metin = msg.body.trim().toLowerCase();
  const veri = await getVeri();
  if (!veri) return;

  // Müşteriyi bul
  const musteri = veri.musteriler.find(m =>
    m.tel && m.tel.replace(/[^0-9]/g, '') === tel.replace(/[^0-9]/g, '')
  );

  const musteriAd = musteri ? `${musteri.ad} ${musteri.soyad}`.trim() : 'Müşteri';

  // Aktif kiralamayı bul
  const aktifKira = musteri
    ? veri.kiralamalar.find(k => k.musteriId === musteri.id && k.durum === 'aktif')
    : null;

  // ── KOMUT TANIMLAMA ──────────────────────
  
  // "evet" → uzatma veya iade onayı
  if (['evet', 'e', 'tamam', 'ok', 'olur'].includes(metin)) {
    const bekleyen = bekleyenOnaylar.get(msg.from);
    if (bekleyen) {
      await bekleyenOnaylar.get(msg.from).onay(veri);
      bekleyenOnaylar.delete(msg.from);
      return;
    }
  }

  // "hayır" → iptal
  if (['hayır', 'hayir', 'h', 'iptal'].includes(metin)) {
    if (bekleyenOnaylar.has(msg.from)) {
      bekleyenOnaylar.delete(msg.from);
      await msg.reply('Anlaşıldı, iptal edildi. Başka bir şey için yazabilirsiniz 👍');
      return;
    }
  }

  // "menü" veya "yardım"
  if (['menü', 'menu', 'yardım', 'yardim', 'merhaba', 'selam', 'hi', 'hello'].includes(metin)) {
    await msg.reply(menuMesaji(musteriAd, aktifKira));
    return;
  }

  // "1" → kiralama durumum
  if (metin === '1') {
    if (!musteri) { await msg.reply('Sisteme kayıtlı numaranız bulunamadı. Lütfen bizimle iletişime geçin.'); return; }
    await msg.reply(kiralamaDurumuMesaji(musteri, aktifKira, veri));
    return;
  }

  // "2" → uzatma talebi
  if (metin === '2') {
    if (!aktifKira) { await msg.reply('Şu an aktif bir kiralamanız bulunmuyor. 🎮'); return; }
    const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
    const gunluk = aktifKira.tip === 'primary' ? (oyun?.gunluk || 0) : Math.round((oyun?.gunluk || 0) * 0.7);
    await msg.reply(
      `🔄 *Kiralama Uzatma*\n\n` +
      `Oyun: ${oyun?.ad || '?'}\n` +
      `Mevcut bitiş: ${aktifKira.bit}\n` +
      `Günlük ücret: ${formatPara(gunluk)}\n\n` +
      `Kaç gün uzatmak istiyorsunuz? (Örn: *3*)`
    );
    bekleyenOnaylar.set(msg.from, { tip: 'uzatma_gun_bekle', kiraId: aktifKira.id, gunluk });
    return;
  }

  // "3" → iade bildirimi
  if (metin === '3') {
    if (!aktifKira) { await msg.reply('Şu an aktif bir kiralamanız bulunmuyor. 🎮'); return; }
    const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
    await msg.reply(
      `📦 *İade Bildirimi*\n\n` +
      `${oyun?.ad || '?'} oyununu iade etmek istiyorsunuz.\n\n` +
      `Onaylıyor musunuz? (*evet* / *hayır*)`
    );
    bekleyenOnaylar.set(msg.from, {
      tip: 'iade_onay',
      kiraId: aktifKira.id,
      onay: async (v) => {
        const k = v.kiralamalar.find(x => x.id === aktifKira.id);
        if (k) { k.durum = 'teslim'; k.teslimTarih = bugun(); }
        await setVeri(v);
        await msg.reply(`✅ İade kaydedildi! Teşekkürler ${musteriAd}. Tekrar görüşmek üzere 👋`);
      }
    });
    return;
  }

  // Sayı geldi → uzatma gün sayısı olabilir
  if (!isNaN(metin) && parseInt(metin) > 0) {
    const bekleyen = bekleyenOnaylar.get(msg.from);
    if (bekleyen && bekleyen.tip === 'uzatma_gun_bekle') {
      const gun = parseInt(metin);
      const ucret = bekleyen.gunluk * gun;
      await msg.reply(
        `${gun} gün uzatma için tutar: *${formatPara(ucret)}*\n\n` +
        `Onaylıyor musunuz? (*evet* / *hayır*)`
      );
      bekleyenOnaylar.set(msg.from, {
        tip: 'uzatma_onay',
        kiraId: bekleyen.kiraId,
        gun, ucret,
        onay: async (v) => {
          const k = v.kiralamalar.find(x => x.id === bekleyen.kiraId);
          if (k) {
            const yeniBit = new Date(k.bit + 'T12:00:00');
            yeniBit.setDate(yeniBit.getDate() + gun);
            k.bit = yeniBit.toISOString().split('T')[0];
            k.ucret = (k.ucret || 0) + ucret;
            k.net = (k.net || 0) + ucret;
            if (!k.uzatmalar) k.uzatmalar = [];
            k.uzatmalar.push({ gun, ucret, tarih: bugun() });
          }
          await setVeri(v);
          await msg.reply(`✅ ${gun} gün uzatıldı! Yeni bitiş tarihi: *${k?.bit}*\nEkstra ücret: *${formatPara(ucret)}* 🎮`);
        }
      });
      return;
    }
  }

  // ── HİÇBİR KOMUT EŞLEŞMEDI → CLAUDE ──
  const gecmisOzet = musteri
    ? `${veri.kiralamalar.filter(k => k.musteriId === musteri.id).length} kiralama, ${aktifKira ? 'aktif kiralama var (bitiş: ' + aktifKira.bit + ')' : 'aktif kiralama yok'}`
    : 'Kayıtlı müşteri değil';

  // Oyun listesi — müsait ve kiradaki oyunlar
  const oyunListesi = veri.oyunlar.map(o => {
    const kopya = (o.kopyalar || []).length || 1;
    const kirada = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
    const musait = kopya - kirada;
    return `${o.ad} (${o.platform||'PS'}, günlük ₺${o.gunluk}, ${musait > 0 ? musait + ' adet müsait' : 'kirada'})`;
  }).join('\n');

  try {
    const cevap = await claudeCevap(musteriAd, msg.body, gecmisOzet, oyunListesi);
    await msg.reply(cevap);
  } catch (e) {
    console.error('Claude API hatası:', e.message);
    await msg.reply('Şu an cevap vermekte güçlük çekiyorum, birazdan tekrar dener misiniz? 🙏');
    // İşletmeciye bildirim gönder
    if (CONFIG.BENIM_NUMARAM) {
      const benimTel = CONFIG.BENIM_NUMARAM + '@c.us';
      try {
        await client.sendMessage(benimTel,
          `⚠️ *Bot Hatası*\n\n` +
          `Müşteri: *${musteriAd}*\n` +
          `Mesaj: "${msg.body}"\n` +
          `Hata: ${e.message}\n\n` +
          `Manuel cevap gerekebilir!`
        );
      } catch(e2) { console.error('Bildirim gönderilemedi:', e2.message); }
    }
  }
});

// ══════════════════════════════════════════
// ONAY BEKLEYENLERİ (state machine)
// ══════════════════════════════════════════
const bekleyenOnaylar = new Map();

// ══════════════════════════════════════════
// MESAJ ŞABLONLARı
// ══════════════════════════════════════════
function menuMesaji(ad, aktifKira) {
  return (
    `👋 Merhaba *${ad}*!\n\n` +
    `GameRental'a hoş geldiniz. Size nasıl yardımcı olabiliriz?\n\n` +
    `*1* - 📋 Kiralama durumum\n` +
    `*2* - 🔄 Süre uzat\n` +
    `*3* - 📦 İade bildirimi\n\n` +
    `Veya dilediğiniz soruyu yazın, size yardımcı olalım 🎮`
  );
}

function kiralamaDurumuMesaji(musteri, aktifKira, veri) {
  if (!aktifKira) {
    return `📋 *${musteri.ad}* — aktif kiralama bulunmuyor.\n\nYeni kiralama için bize ulaşabilirsiniz! 🎮`;
  }
  const oyun = veri.oyunlar.find(o => o.id === aktifKira.oyunId);
  const now = bugun();
  const gecGun = aktifKira.bit < now ? gunFarki(aktifKira.bit, now) : 0;
  const kalanGun = aktifKira.bit >= now ? gunFarki(now, aktifKira.bit) : 0;

  return (
    `📋 *Kiralama Durumunuz*\n\n` +
    `🎮 Oyun: *${oyun?.ad || '?'}*\n` +
    `📅 Başlangıç: ${aktifKira.bas}\n` +
    `📅 Bitiş: ${aktifKira.bit}\n` +
    (gecGun > 0
      ? `⚠️ *${gecGun} gün gecikmiş!*\n`
      : `✅ *${kalanGun} gün kaldı*\n`) +
    `💰 Ücret: ${formatPara(aktifKira.ucret)}\n\n` +
    `Uzatmak için *2* yazabilirsiniz.`
  );
}

// ══════════════════════════════════════════
// ZAMANLANMIŞ KONTROLLER
// ══════════════════════════════════════════
function zamanlanmisKontroller() {
  // Her sabah 09:00 → yarın bitenler
  cron.schedule('0 9 * * *', async () => {
    console.log('⏰ Sabah kontrolü başlıyor...');
    await yarinBitenKontrol();
  }, { timezone: 'Europe/Istanbul' });

  // Her saat → gecikmiş iadeler
  cron.schedule('0 * * * *', async () => {
    await gecikmeKontrol();
  }, { timezone: 'Europe/Istanbul' });

  console.log('⏰ Zamanlanmış kontroller aktif');
}

async function yarinBitenKontrol() {
  const veri = await getVeri();
  if (!veri) return;
  const yarin = yarinStr();

  const yarinBiten = veri.kiralamalar.filter(k =>
    k.durum === 'aktif' && k.bit === yarin
  );

  for (const kira of yarinBiten) {
    const musteri = veri.musteriler.find(m => m.id === kira.musteriId);
    const oyun = veri.oyunlar.find(o => o.id === kira.oyunId);
    if (!musteri?.tel) continue;

    const tel = formatTel(musteri.tel);
    const gunluk = kira.tip === 'primary' ? (oyun?.gunluk || 0) : Math.round((oyun?.gunluk || 0) * 0.7);

    await client.sendMessage(tel,
      `🔔 *Kiralama Hatırlatıcısı*\n\n` +
      `Merhaba *${musteri.ad}*!\n\n` +
      `*${oyun?.ad || '?'}* oyununuzun kiralama süresi *yarın* doluyor.\n\n` +
      `Uzatmak ister misiniz? (*evet* yazabilir veya gün sayısını belirtebilirsiniz)\n\n` +
      `İade için *3* yazabilirsiniz. 🎮`
    );

    // Uzatma onayı bekle
    bekleyenOnaylar.set(tel, { tip: 'uzatma_gun_bekle', kiraId: kira.id, gunluk });

    console.log(`📨 Hatırlatma gönderildi: ${musteri.ad}`);
    await bekle(1000); // Spam önleme
  }
}

async function gecikmeKontrol() {
  const veri = await getVeri();
  if (!veri) return;
  const now = bugun();

  const gecikmiş = veri.kiralamalar.filter(k =>
    k.durum === 'aktif' && k.bit < now
  );

  for (const kira of gecikmiş) {
    // Aynı gün tekrar mesaj gönderme
    const sonUyariKey = `uyari_${kira.id}`;
    const sonUyari = await db.collection('botState').doc(sonUyariKey).get();
    if (sonUyari.exists && sonUyari.data().tarih === now) continue;

    const musteri = veri.musteriler.find(m => m.id === kira.musteriId);
    const oyun = veri.oyunlar.find(o => o.id === kira.oyunId);
    if (!musteri?.tel) continue;

    const gecGun = gunFarki(kira.bit, now);
    const gunluk = kira.tip === 'primary' ? (oyun?.gunluk || 0) : Math.round((oyun?.gunluk || 0) * 0.7);
    const ekstra = gunluk * gecGun;

    const tel = formatTel(musteri.tel);

    await client.sendMessage(tel,
      `⚠️ *Gecikmiş İade Uyarısı*\n\n` +
      `Merhaba *${musteri.ad}*!\n\n` +
      `*${oyun?.ad || '?'}* oyununuzun iade tarihi *${gecGun} gün* geçti.\n` +
      `Ekstra ücret: *${formatPara(ekstra)}*\n\n` +
      `İade bildirmek için *3* yazabilirsiniz.\n` +
      `Uzatmak için ise gün sayısını yazabilirsiniz. 🙏`
    );

    // Bugün uyarı gönderildi olarak işaretle
    await db.collection('botState').doc(sonUyariKey).set({ tarih: now });

    console.log(`🚨 Gecikme uyarısı gönderildi: ${musteri.ad}`);
    await bekle(1000);
  }
}

function bekle(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════
// WEB SUNUCUSU — QR KOD GÖRÜNTÜLEME
// ══════════════════════════════════════════
let qrDataUrl = null;
let botReady = false;

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (botReady) {
    res.end('<html><body style="background:#111;color:#0f0;font-family:sans-serif;text-align:center;padding:50px"><h1>✅ Bot Aktif!</h1><p>WhatsApp bağlantısı kuruldu, bot çalışıyor.</p></body></html>');
  } else if (qrDataUrl) {
    res.end(`<html><body style="background:#111;color:white;font-family:sans-serif;text-align:center;padding:30px">
      <h2>📱 WhatsApp QR Kodu</h2>
      <p>WhatsApp Business → Bağlı Cihazlar → Cihaz Ekle → Bu kodu tara</p>
      <img src="${qrDataUrl}" style="width:300px;height:300px;border:10px solid white;border-radius:10px">
      <p style="color:#aaa;font-size:12px">QR kod 60 saniyede yenilenir, sayfa yenile</p>
    </body></html>`);
  } else {
    res.end('<html><body style="background:#111;color:white;font-family:sans-serif;text-align:center;padding:50px"><h2>⏳ Bot başlatılıyor...</h2><p>Birkaç saniye bekleyin ve sayfayı yenileyin.</p></body></html>');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Web sunucusu: http://localhost:${PORT}`));

// ══════════════════════════════════════════
// BAŞLAT
// ══════════════════════════════════════════
console.log('🚀 GameRental WhatsApp Bot başlatılıyor...');
client.initialize();
