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

// ── VERİ OKUMA / YAZMA ──
// Eskiden setVeri() dokümanın tamamını, okunduğu andaki haliyle üzerine yazıyordu: bot veriyi okuduktan
// sonra siteden yapılan değişiklikler (ör. aynı anda girilen kiralama) siliniyordu.
// Artık her getVeri() okunan halin bir kopyasını saklar; setVeri() transaction içinde güncel veriyi okuyup
// sadece botun DEĞİŞTİRDİĞİ kayıtları (id bazında) birleştirerek yazar. Site de aynı yöntemi kullanıyor.
const veriRef = () => db.collection('users').doc(CONFIG.USER_UID).collection('data').doc('psrental');
const okunanHal = new WeakMap(); // veri objesi → okunduğu andaki JSON
const DIZI_ALANLAR = { oyunlar: 'o', musteriler: 'm', kiralamalar: 'k', rezervasyonlar: 'r', ekMaliyetler: 'mal', karaListe: 'kl', ekGelirler: 'eg', kampanyalar: 'kmp' };

async function getVeri() {
  const doc = await veriRef().get();
  if (!doc.exists) return null;
  const data = doc.data();
  okunanHal.set(data, JSON.stringify(data));
  kampanyaOnbellek = Array.isArray(data.kampanyalar) ? data.kampanyalar : [];
  return data;
}

function stable(v) {
  if (v === undefined) return undefined;
  return JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
    ? Object.keys(x).sort().reduce((a, kk) => { a[kk] = x[kk]; return a; }, {}) : x);
}
const kayitAnahtar = x => (x && x.id !== undefined && x.id !== null) ? 'id:' + x.id : 'x:' + stable(x);
function mergeArr(b, l, r) {
  const B = new Map(b.map(x => [kayitAnahtar(x), x]));
  const L = new Map(l.map(x => [kayitAnahtar(x), x]));
  const R = new Map(r.map(x => [kayitAnahtar(x), x]));
  const out = [], seen = new Set(), cakisan = [];
  [...r.map(kayitAnahtar), ...l.map(kayitAnahtar)].forEach(key => {
    if (seen.has(key)) return; seen.add(key);
    const bx = B.get(key), lx = L.get(key), rx = R.get(key);
    if (bx === undefined) {
      if (lx !== undefined && rx !== undefined && stable(lx) !== stable(rx)) { out.push(rx); cakisan.push(lx); }
      else out.push(lx !== undefined ? lx : rx);
      return;
    }
    const v = stable(lx) !== stable(bx) ? lx : rx; // bot değiştirdiyse botunki, değiştirmediyse güncel olan
    if (v !== undefined) out.push(v);
  });
  return { out, cakisan };
}
function merge3(base, local, remote) {
  if (!remote || !base) return local;
  const out = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  keys.delete('nextId');
  for (const k of Object.keys(DIZI_ALANLAR)) {
    if (!keys.has(k)) continue;
    keys.delete(k);
    const res = mergeArr(base[k] || [], local[k] || [], remote[k] || []);
    // Aynı id ile iki tarafta farklı yeni kayıt → sitedekini koru, botunkine yeni id ver
    res.cakisan.forEach(x => {
      const maxId = res.out.reduce((m, y) => Math.max(m, y.id || 0), 0);
      res.out.push({ ...x, id: maxId + 1 });
      console.warn(`⚠️ ${k}: id çakışması (${x.id}) → yeni id ${maxId + 1}`);
    });
    out[k] = res.out;
  }
  keys.forEach(k => {
    const v = stable(local[k]) !== stable(base[k]) ? local[k] : remote[k];
    if (v !== undefined) out[k] = v;
  });
  out.nextId = { ...(remote.nextId || {}), ...(local.nextId || {}) };
  for (const nk of Object.keys(out.nextId)) out.nextId[nk] = Math.max((local.nextId || {})[nk] || 1, (remote.nextId || {})[nk] || 1);
  for (const [k, nk] of Object.entries(DIZI_ALANLAR)) {
    const maxId = (out[k] || []).reduce((m, x) => Math.max(m, typeof x.id === 'number' ? x.id : 0), 0);
    out.nextId[nk] = Math.max(out.nextId[nk] || 1, maxId + 1);
  }
  return out;
}

async function setVeri(data) {
  const baseStr = okunanHal.get(data);
  const yerel = JSON.parse(JSON.stringify(data));
  let yazilan = null;
  await db.runTransaction(async tx => {
    const snap = await tx.get(veriRef());
    const remote = snap.exists ? snap.data() : null;
    yazilan = baseStr ? merge3(JSON.parse(baseStr), yerel, remote) : yerel;
    tx.set(veriRef(), yazilan);
  });
  // Çağıranın elindeki obje de güncel (birleştirilmiş) hale gelsin; aynı obje ile tekrar setVeri
  // çağrılırsa sitenin yaptığı değişiklikleri geri almasın
  const kopya = JSON.parse(JSON.stringify(yazilan));
  Object.keys(data).forEach(k => { delete data[k]; });
  Object.assign(data, kopya);
  okunanHal.set(data, JSON.stringify(yazilan));
}

// ── YARDIMCI ──
// Railway sunucusu UTC çalışır — tarih/saat her zaman İstanbul saatine göre hesaplanır
// (eskiden 00:00-03:00 arası "bugün" dün görünüyordu, bildirim saatleri de 3 saat kaymıştı)
const TZ = 'Europe/Istanbul';
function bugun(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function trSaat(d = new Date()) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d), 10) % 24;
}
function yarinStr() { return tarihEkle(bugun(), 1); }

// Türkçe büyük/küçük harf + noktalama sorunsuz karşılaştırma için metni sadeleştir:
// "İptal", "IPTAL", "iptal.", "İPTAL 🙏" → "iptal" · "Hayır" → "hayir" · "2️⃣" → "2"
// (JS'in toLowerCase'i "İ" harfini "i̇" yapıyordu, bu yüzden "İptal" tanınmıyordu)
function sadeKomut(s) {
  return String(s || '')
    .replace(/İ/g, 'i').replace(/I/g, 'ı')
    .toLocaleLowerCase('tr-TR').replace(/\u0307/g, '')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u')
    .replace(/[^a-z0-9#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const EVET = ['evet', 'e', 'evt', 'tamam', 'onay', 'onayla', 'onayliyorum', 'ok', 'olur', 'evet onayliyorum'];
const HAYIR = ['hayir', 'h', 'yok', 'istemiyorum', 'hayir istemiyorum'];
const IPTAL_KELIMELERI = ['iptal', '#iptal', 'vazgec', 'vazgectim', 'geri', 'iptal et', 'cik', 'menu', 'ana menu', 'menuye don', '0'];
const MENU_METNI = `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon\n*9* - 💰 Bakiye Yükle`;
function telSon10(t) { return String(t || '').replace(/[^0-9]/g, '').replace(/^90/, '').replace(/^0/, '').slice(-10); }
// Site ile aynı hediye mantığı: çıkışı (veya ilk kiralaması) 1 aydan eski oyunlar "eski oyun" sayılır
function eskiOyunMu(oyun, veri) {
  if (!oyun) return false;
  const birAyOnce = tarihEkle(bugun(), -30);
  if (oyun.cikis && oyun.cikis <= bugun()) return oyun.cikis < birAyOnce;
  const ilk = (veri.kiralamalar || []).filter(k => k.oyunId === oyun.id).map(k => k.bas).sort()[0];
  return !!ilk && ilk < birAyOnce;
}
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
// Kiralama tipine göre boş slotu olan hesap: 0 = ana hesap, 1.. = kopyalar (site ile aynı numaralama)
function bosKopyaBul(oyun, tip, veri) {
  if (!oyun) return 0;
  const slotlar = [{ idx: 0, cift: !!oyun.ciftPrimary }];
  (oyun.kopyalar || []).forEach((k, i) => { if (!k.satildi) slotlar.push({ idx: i + 1, cift: !!k.ciftPrimary }); });
  for (const s of slotlar) {
    const kap = tip === 'primary' ? (s.cift ? 2 : 1) : 1;
    const dolu = veri.kiralamalar.filter(k => k.oyunId === oyun.id && k.durum === 'aktif' && k.tip === tip && (k.kopyaIdx || 0) === s.idx).length;
    if (dolu < kap) return s.idx;
  }
  return 0;
}
function doluMu(oyun, tip, veri) {
  const aktif = veri.kiralamalar.filter(k => k.oyunId === oyun.id && k.durum === 'aktif' && k.tip === tip).length;
  return aktif >= slotKapasite(oyun, tip);
}
// Geri kazanım kampanyasıyla tanımlanan, süresi dolmamış ve kullanılmamış kişiye özel indirim
function aktifOzelIndirim(m) {
  const oz = m && m.ozelIndirim;
  if (!oz || oz.kullanildi || !(oz.oran > 0)) return null;
  if (oz.bitis && oz.bitis < bugun()) return null;
  return oz;
}
// Müşterinin bu oyun için bekleme listesindeki (onaylanmış) ön ödemesi
function bekleyenOnOdemeBul(veri, musteriId, oyunId, tip, rezervId) {
  const r = (veri.rezervasyonlar || []).filter(x => x.durum === 'bekliyor' && x.musteriId === musteriId && x.oyunId === oyunId);
  return (rezervId && r.find(x => x.id === rezervId)) || r.find(x => x.tip === tip && x.onOdeme > 0) || r.find(x => x.onOdeme > 0) || r.find(x => x.tip === tip) || r[0] || null;
}
function slotKapasite(oyun, tip) {
  const kopyalar = (oyun?.kopyalar || []).filter(k => !k.satildi);
  return tip === 'primary'
    ? (oyun?.ciftPrimary ? 2 : 1) + kopyalar.reduce((t, k) => t + (k.ciftPrimary ? 2 : 1), 0)
    : 1 + kopyalar.length;
}
// Liste fiyatı (kampanyasız) — gecikme ücreti bununla hesaplanır
function listeFiyat(oyun, tip) {
  oyun = oyun || {};
  return tip === 'primary'
    ? (oyun.gunlukPri || oyun.gunluk || 0)
    : (oyun.gunlukSec || Math.round((oyun.gunlukPri || oyun.gunluk || 0) * 0.7)); // site ile aynı: secondary fiyatı yoksa %70
}
// ── PLANLI KAMPANYALAR (sitede Büyüme → Kampanyalar) ──
// Son okunan verideki kampanyalar; getVeri() her çağrıldığında güncellenir
let kampanyaOnbellek = [];
function kampanyaAktifMi(k, tarih) { tarih = tarih || bugun(); return !k.iptal && k.baslangic <= tarih && tarih <= k.bitis; }
function kampanyaKapsar(k, o, tarih) {
  if (!o) return false;
  const kp = k.kapsam || { tip: 'hepsi' };
  if (kp.tip === 'secili') return (kp.oyunIds || []).includes(o.id);
  if (kp.tip === 'eski') return !!o.cikis && gunFarki(o.cikis, tarih || bugun()) >= (kp.gun || 120);
  if (kp.tip === 'platform') return (o.platform || '').includes(kp.platform || '');
  return true;
}
function oyunKampanyasi(o, tarih) {
  tarih = tarih || bugun();
  return kampanyaOnbellek.filter(k => k.tur === 'indirim' && kampanyaAktifMi(k, tarih) && kampanyaKapsar(k, o, tarih)).sort((a, b) => b.oran - a.oran)[0] || null;
}
function aktifPaketKampanyasi(tarih) {
  return kampanyaOnbellek.filter(k => k.tur === 'paket' && kampanyaAktifMi(k, tarih)).sort((a, b) => b.oran - a.oran)[0] || null;
}
// Müşterinin son 2 gün içinde başlamış başka aktif kiralaması varsa paket indirimi geçerli
function paketUygunMu(veri, musteriId, bas) {
  const p = aktifPaketKampanyasi(bas); if (!p || !musteriId) return null;
  const sinir = tarihEkle(bas || bugun(), -2);
  const diger = (veri.kiralamalar || []).filter(k => k.musteriId === musteriId && k.durum === 'aktif' && k.bas >= sinir);
  return diger.length >= (p.minOyun || 2) - 1 ? p : null;
}
// Müşteriye gösterilen günlük fiyat — aktif fiyat kampanyası varsa indirimli
function gunlukFiyat(oyun, tip) {
  const taban = listeFiyat(oyun, tip);
  const k = oyunKampanyasi(oyun);
  return k ? Math.max(1, Math.round(taban * (1 - k.oran / 100))) : taban;
}
// Listelerde oyun adının yanına kampanya etiketi
function kampEtiket(o) { const k = oyunKampanyasi(o); return k ? ` 🏷️%${k.oran}` : ''; }
// Oyun listelerinin başına aktif kampanya duyurusu
function kampanyaBaslik() {
  const now = bugun();
  const aktif = kampanyaOnbellek.filter(k => kampanyaAktifMi(k, now));
  if (!aktif.length) return '';
  return aktif.map(k => k.tur === 'paket'
    ? `📦 *${k.ad}:* ${k.minOyun || 2} oyunu birlikte kiralayana ikinci oyunda *%${k.oran} indirim* (${fmtTarih(k.bitis)}'e kadar)`
    : `🏷️ *${k.ad}:* işaretli oyunlarda *%${k.oran} indirim* (${fmtTarih(k.bitis)}'e kadar)`).join('\n') + '\n\n';
}
// Kiralamanın verildiği PSN hesabının adı (şifre tutulmaz)
function kiraHesabi(k, veri) {
  const o = (veri.oyunlar || []).find(x => x.id === k.oyunId); if (!o) return '';
  if (k.kopyaIdx > 0) { const kp = (o.kopyalar || [])[k.kopyaIdx - 1]; return (kp && (kp.hesap || kp.not)) || ('Kopya ' + (k.kopyaIdx + 1)); }
  return o.hesap || 'Ana hesap';
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
      // Sadece gerçek para yüklemeleri (erken iade ödülü, iade, bekleme ön ödemesi aktarımı sayılmaz — site ile aynı)
      const odul = b.tip === 'odul' || b.tip === 'iade' || b.tip === 'depozito' || b.tip === 'teminat' || /^Erken iade ödülü|^Silinen kiralama iadesi|^Bekleme|^Teminat/.test(b.aciklama || '');
      if (b.tutar > 0 && !odul && b.tarih >= d3ayStr) toplam += b.tutar;
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
  // 'platinplus' iç anahtar olarak kalır (kayıtlı ayarlar bozulmasın), müşteriye "Elmas" olarak görünür
  if (toplam >= T.platinplus) return { seviye: 'platinplus', emoji: '💎', label: 'Elmas', indirim: ta.platinplusIndirim??20, toplam, sonraki: null, kalanTL: 0, oncelikliRezervHakki: true };
  if (toplam >= T.platin)     return { seviye: 'platin', emoji: '🏆', label: 'Platin', indirim: ta.platinIndirim??15, toplam, sonraki: 'Elmas 💎', kalanTL: T.platinplus - toplam };
  if (toplam >= T.altin)      return { seviye: 'altin',  emoji: '🥇', label: 'Altın',  indirim: ta.altinIndirim??10,  toplam, sonraki: 'Platin 🏆',  kalanTL: T.platin - toplam };
  if (toplam >= T.gumus)      return { seviye: 'gumus',  emoji: '🥈', label: 'Gümüş',  indirim: ta.gumusIndirim??5,   toplam, sonraki: 'Altın 🥇',   kalanTL: T.altin - toplam };
  return                             { seviye: 'bronz',  emoji: '🥉', label: 'Bronz',  indirim: 0, toplam, sonraki: 'Gümüş 🥈', kalanTL: T.gumus - toplam };
}

// Kiralama özeti + ödeme adımı (müşteri gün sayısını yazınca ya da siteden "Bot ile kirala" ile başlatılınca)
async function kiralamaOzetiGonder(tel, musteri, musteriAd, veri, bekleyen, gun, onEk) {
  let ozetOnEk = onEk || '';
        const bas = bugun();
        // Hediye gün hesapla: 10+ günde yeni çıkmış değilse +5, Platin ise yeni oyunda da +5
        const oyunHediye = veri.oyunlar.find(o => o.id === bekleyen.oyunId);
        const yeniOyun = !eskiOyunMu(oyunHediye, veri); // eskiden olmayan bir alana bakıyordu → her oyuna hediye veriliyordu
        const tierHediye = getMusteriTierBot(musteri.id, veri);
        const platinMi = tierHediye.seviye === 'platin' || tierHediye.seviye === 'platinplus';
        const hediye = ((!yeniOyun || platinMi) && gun >= 10) ? 5 : 0;
        const toplamGun = gun + hediye;
        const bit = tarihEkle(bas, toplamGun);
        // Tier indirimini hesapla
        const tierMusteri = getMusteriTierBot(musteri.id, veri);
        const hamUcret = bekleyen.gunluk * gun;
        // Kişiye özel (geri kazanım) indirimi varsa ve üyelik indiriminden yüksekse o uygulanır
        const ozel = aktifOzelIndirim(veri.musteriler.find(m => m.id === musteri.id));
        // Paket kampanyası: 2 gün içinde başlamış başka aktif kiralaması varsa
        const paket = paketUygunMu(veri, musteri.id, bas);
        const ozelKullan = !!ozel && ozel.oran > (tierMusteri.indirim || 0) && !(paket && paket.oran >= ozel.oran);
        const paketKullan = !!paket && paket.oran > (tierMusteri.indirim || 0) && !ozelKullan;
        const indirimOrani = ozelKullan ? ozel.oran : paketKullan ? paket.oran : (tierMusteri.indirim || 0);
        const fiyatKampanya = oyunKampanyasi(oyunHediye, bas);
        const indirimTL = Math.round(hamUcret * indirimOrani / 100);
        const ucret = hamUcret - indirimTL;
        // Bekleme listesinde ön ödeme yaptıysa kiralama tutarından düşülür
        const rezervKayit = bekleyenOnOdemeBul(veri, musteri.id, bekleyen.oyunId, bekleyen.kiraTip, bekleyen.rezervId);
        const onOdeme = (rezervKayit && rezervKayit.onOdeme > 0 && rezervKayit.onOdemeOnaylandi) ? rezervKayit.onOdeme : 0;
        const onOdemeOnaysiz = (rezervKayit && rezervKayit.onOdeme > 0 && !rezervKayit.onOdemeOnaylandi) ? rezervKayit.onOdeme : 0;
        // Geç iade riski yüksekse teminat (gelire yazılmaz; zamanında iadede bakiyeye geçer)
        const tmn = teminatHesapla(veri, musteri.id, oyunHediye, bekleyen.kiraTip);
        const teminat = tmn.tutar;
        const kalan = Math.max(0, ucret + teminat - onOdeme);
        const fazla = Math.max(0, onOdeme - ucret - teminat);
        let ozet = ozetOnEk + `📋 *Kiralama Özeti*\n\n🎮 *${bekleyen.oyunAd}*\n🎯 ${bekleyen.kiraTip}\n📅 ${gun} gün`;
        if (hediye > 0) ozet += platinMi && yeniOyun ? ` *+${hediye} gün hediye 🎁 (${tierHediye.seviye === 'platinplus' ? '💎 Elmas' : '🏆 Platin'} ayrıcalığı)*` : ` *+${hediye} gün hediye 🎁*`;
        ozet += ` (${bas} → ${bit})\n`;
        if (fiyatKampanya) ozet += `🏷️ *${fiyatKampanya.ad}* — günlük fiyata %${fiyatKampanya.oran} kampanya indirimi uygulandı\n`;
        if (indirimOrani > 0) {
          ozet += `💰 Normal fiyat: ${fmt(hamUcret)}\n`;
          ozet += ozelKullan ? `🎁 *Size özel indirim %${indirimOrani}: -${fmt(indirimTL)}*\n`
            : paketKullan ? `📦 *Paket indirimi (${paket.ad}) %${indirimOrani}: -${fmt(indirimTL)}*\n`
            : `${tierMusteri.emoji} *${tierMusteri.label} indirimi %${indirimOrani}: -${fmt(indirimTL)}*\n`;
          ozet += `✅ Ödenecek tutar: *${fmt(ucret)}*\n\n`;
        } else {
          ozet += `💰 Toplam: *${fmt(ucret)}*\n\n`;
        }
        if (teminat > 0) {
          ozet += `🛡️ *İade teminatı: ${fmt(teminat)}*\n` +
            `Oyunu zamanında iade edersen bu tutar *bakiyene eklenir* (sonraki kiralamanda kullanırsın). Geç kalırsan gecikme ücreti bundan düşülür, kalanı yine bakiyene geçer.\n` +
            `➡️ Kira + teminat: *${fmt(ucret + teminat)}*\n\n`;
        }
        const durumOrtak = { gun, hediye, toplamGun, ucret, indirim: indirimTL, bas, bit, kalan, onOdeme, rezervId: rezervKayit?.id || null, ozelIndirimKullan: ozelKullan,
          fiyatKampanyaId: fiyatKampanya?.id || null, paketKampanyaId: paketKullan ? paket.id : null,
          teminat, riskMetin: teminat > 0 ? tmn.risk.metin : '' };
        if (onOdeme > 0) {
          ozet += `💳 Bekleme listesi ön ödemeniz: *-${fmt(onOdeme)}*\n`;
          ozet += kalan > 0 ? `➡️ Kalan ödenecek: *${fmt(kalan)}*\n\n` : `✅ Ön ödemeniz tutarı karşılıyor${fazla > 0 ? ` (fazla *${fmt(fazla)}* bakiyenize aktarılacak)` : ''}\n\n`;
        } else if (onOdemeOnaysiz > 0) {
          ozet += `ℹ️ ${fmt(onOdemeOnaysiz)} ön ödemeniz henüz onaylanmadı; işletmeci onaylayınca hesaba katılır.\n\n`;
        }
        if (onOdeme > 0 && kalan === 0) {
          // Ödenecek bir şey kalmadı → doğrudan işletmeci onayına
          await mesajGonder(tel, ozet + `Kiralamanız işletmeci onayına gönderildi, kısa sürede başlayacak 🙏`);
          bekleyenOnaylar.set(tel, { ...bekleyen, ...durumOrtak, tip: 'yeni_kiralama_bekle', odemeTip: 'onodeme' });
          await banaGonder(
            `💳 *ÖN ÖDEMEYLE KİRALAMA*\n\n👤 *${musteriAd}*\n🎮 *${bekleyen.oyunAd}* (${bekleyen.kiraTip})\n📅 ${gun} gün (${bas} → ${bit})\n` +
            `💵 Tutar: ${fmt(ucret)}${teminat > 0 ? ` + 🛡️ ${fmt(teminat)} teminat` : ''} · Ön ödeme: ${fmt(onOdeme)}${fazla > 0 ? ` · Fazla ${fmt(fazla)} bakiyeye` : ''}\n` +
            (teminat > 0 ? `⚠️ Geç iade geçmişi: ${tmn.risk.metin}\n` : '') + `\n` +
            `Onaylamak için:\n*#onayla ${tel.replace('@c.us','').replace('@lid','')}*`
          );
          return;
        }
        // Bakiye kontrolü (sadece kalan tutar için)
        const mGuncel = veri.musteriler.find(m => m.id === bekleyen.musteriId);
        const mevcutBakiye = mGuncel?.bakiye || 0;
        if (mevcutBakiye >= kalan) {
          ozet += `💰 *Bakiyeniz yeterli!* (${fmt(mevcutBakiye)})\n\n${fmt(kalan)} bakiyenizden ödensin mi?\n*evet* → Bakiyeden öde\n*hayır* → Havale ile öde`;
          await mesajGonder(tel, ozet);
          bekleyenOnaylar.set(tel, { ...bekleyen, ...durumOrtak, tip: 'bakiye_onay' });
        } else {
          if (mevcutBakiye > 0) ozet += `💰 Mevcut bakiyeniz: *${fmt(mevcutBakiye)}*\n`;
          ozet += `*Ödeme Bilgileri:*\nTutar: *${fmt(kalan)}*\nIBAN: \`${CONFIG.IBAN}\`\nHesap Sahibi: ${CONFIG.HESAP_ISIM}\n\nÖdemeyi yaptıktan sonra dekontu buraya gönderin 📎`;
          await mesajGonder(tel, ozet);
          bekleyenOnaylar.set(tel, { ...bekleyen, ...durumOrtak, tip: 'yeni_kiralama_dekont' });
        }
}

// "5 - Yeni kiralama" oyun listesi (bot menüsü ve siteden başlatılan kiralama)
async function kiralamaListesiGonder(tel, musteri, musteriAd, veri, onEk) {
      const bugunStr = bugun();
      // Henüz çıkmamış oyunları kiralama listesinden çıkar
      const tumOyunlar = veri.oyunlar.filter(o => !o.deaktif && (!o.cikis || o.cikis <= bugunStr)).sort((a,b) => b.id - a.id);
      // Çıkacak oyunlar — sıraya girebilirler
      const cikacakOyunlarKira = veri.oyunlar.filter(o => !o.deaktif && o.cikis && o.cikis > bugunStr).sort((a,b) => a.cikis.localeCompare(b.cikis));

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
        liste += `*${i+1}* - ✅ ${o.ad} (${o.platform})${kampEtiket(o)} | ${priLabel}  ${secLabel}\n`;
      });
      // Numaralar tek sırada devam eder: müsait → kirada (sıraya gir) → yakında çıkacak (ön rezervasyon)
      let no = musaitOyunlar.length;
      if (kiradaOyunlar.length > 0) {
        liste += `\n⏳ *Şu an kirada — seçersen sıraya girersin:*\n`;
        kiradaOyunlar.forEach(o => {
          const pri = gunlukFiyat(o, 'primary');
          const sec = gunlukFiyat(o, 'secondary');
          const siradaki = (veri.rezervasyonlar||[]).filter(r => r.oyunId === o.id && r.durum === 'bekliyor').length;
          liste += `*${++no}* - ⏳ ${o.ad} (${o.platform})${kampEtiket(o)} | 🔵${fmt(pri)} 🟣${fmt(sec)}/gün${siradaki > 0 ? ` | 👥 ${siradaki} kişi sırada` : ''}\n`;
        });
      }
      // Yakında çıkacak oyunlar — seçilince ön rezervasyon (sıraya girme) akışına gider
      if (cikacakOyunlarKira.length > 0) {
        liste += `\n🗓 *Yakında çıkıyor — seçersen çıkış günü için yerini ayırtırsın:*\n`;
        cikacakOyunlarKira.forEach(o => {
          const pri = gunlukFiyat(o, 'primary');
          const sec = gunlukFiyat(o, 'secondary');
          const siradaki = (veri.rezervasyonlar||[]).filter(r => r.oyunId === o.id && r.durum === 'bekliyor').length;
          liste += `*${++no}* - 📅 ${o.ad} (${o.platform}) — *${fmtTarih(o.cikis)}* | 🔵${fmt(pri)} 🟣${fmt(sec)}/gün${siradaki > 0 ? ` | 👥 ${siradaki} kişi sırada` : ''}\n`;
        });
      }

      if (!liste) { await mesajGonder(tel, `Şu an müsait oyun bulunmuyor 😔`); return; }
      await mesajGonder(tel, `${onEk || ''}🎮 *Oyun Listesi*\n\n${kampanyaBaslik()}${liste}\nOyunun *numarasını* ya da adını yazın:\n✅ Müsaitse hemen kiralarsınız\n⏳ Kiradaysa sıraya girersiniz\n📅 Yakında çıkacaksa çıkış günü için yerinizi ayırtırsınız 🔔`);
      bekleyenOnaylar.set(tel, { tip: 'kiralama_oyun_bekle', musteriId: musteri.id, musteriAd, musaitOyunlar, kiradaOyunlar, cikacakOyunlar: cikacakOyunlarKira });
      return;
}

// ── ⏰ GEÇ İADE RİSKİ + 🛡️ TEMİNAT (site ile aynı kural) ──
// Son 10 iade: şu an gecikmiş kiralaması var, 2+ geç iade ya da bir kerede 3+ gün gecikme → yüksek risk
function gecRiskBot(veri, musteriId) {
  const now = bugun();
  const ks = (veri.kiralamalar || []).filter(k => k.musteriId === musteriId);
  const aktifGec = ks.filter(k => k.durum === 'aktif' && k.bit < now).length;
  const son = ks.filter(k => k.durum === 'teslim' && k.teslimTarih && k.teslimTarih >= k.bas).sort((a, b) => b.bas.localeCompare(a.bas)).slice(0, 10);
  const gecler = son.filter(k => k.teslimTarih > k.bit);
  const gunler = gecler.map(k => gunFarki(k.bit, k.teslimTarih));
  const gecGun = gunler.reduce((t, x) => t + x, 0), maxGun = gunler.length ? Math.max(...gunler) : 0;
  const seviye = (aktifGec > 0 || gecler.length >= 2 || maxGun >= 3) ? 'yuksek' : gecler.length === 1 ? 'orta' : null;
  const parca = [];
  if (gecler.length) parca.push(`son ${son.length} iadede ${gecler.length} geç iade (toplam ${gecGun} gün)`);
  if (aktifGec) parca.push(`şu an ${aktifGec} gecikmiş kiralaması var`);
  return { seviye, gec: gecler.length, gecGun, aktifGec, metin: parca.join(' · ') };
}
function teminatAyarBot(veri) { const a = (veri.ayarlar && veri.ayarlar.teminat) || {}; return { aktif: a.aktif !== false, gun: Math.min(7, Math.max(1, parseInt(a.gun) || 2)) }; }
function teminatHesapla(veri, musteriId, oyun, tip) {
  const m = (veri.musteriler || []).find(x => x.id === musteriId);
  const ayar = teminatAyarBot(veri);
  const risk = gecRiskBot(veri, musteriId);
  if (!m || m.teminatMuaf || !ayar.aktif || risk.seviye !== 'yuksek') return { tutar: 0, risk };
  return { tutar: Math.round(listeFiyat(oyun, tip) * ayar.gun), risk, gun: ayar.gun };
}

// ── 💎 ELMAS ÜYELİK TEKLİFİ ──
// Sırada beklemek istemeyen müşteriye: bakiye yükleyerek Elmas ol → bekleme listesinde en başa geç
function elmasEsik(veri) { const ta = (veri && veri.tierAyarlar) || {}; return { esik: ta.platinplus ?? 5000, indirim: ta.platinplusIndirim ?? 20 }; }
function elmasMi(musteriId, veri) { return !!musteriId && getMusteriTierBot(musteriId, veri).seviye === 'platinplus'; }
function elmasGereken(musteriId, veri) { return Math.max(0, Math.ceil(elmasEsik(veri).esik - (getMusteriTierBot(musteriId, veri).toplam || 0))); }
function elmasSecenek(musteriId, veri) { return musteriId && !elmasMi(musteriId, veri) ? `\n*3* - 💎 Beklemek istemiyorum, öne geçmek istiyorum` : ''; }
function elmasTanitim(musteriId, veri, oyunAd) {
  const { esik, indirim } = elmasEsik(veri);
  const gereken = elmasGereken(musteriId, veri);
  return `💎 *Elmas Üyelik*\n\n` +
    (oyunAd ? `*${oyunAd}* için sırada beklemek istemiyorsan Elmas ol:\n` : '') +
    `Elmas üyeler bekleme listelerinde *sıranın en başına geçer* — slot boşalınca ilk haber onlara gider.\n\n` +
    `*Avantajlar:*\n` +
    `• ⏫ Tüm bekleme listelerinde *öncelik*\n` +
    `• 🏷️ Tüm kiralamalarda *%${indirim} indirim*\n` +
    `• 🎁 10+ günlük kiralamalarda *5 gün hediye* (yeni çıkan oyunlarda bile)\n\n` +
    `*Nasıl Elmas olunur?*\n` +
    `Son 3 aydaki harcaman + yüklediğin bakiye *${fmt(esik)}* olunca otomatik Elmas olursun.\n` +
    `👉 Senin için gereken: *${fmt(gereken)}* bakiye\n\n` +
    `Yüklediğin bakiye kaybolmaz, kiralamalarında indirimli fiyattan kullanırsın. ` +
    `Yüklenen tutar *3 ay* boyunca üyeliğine sayılır.`;
}
function elmasOdemeBilgisi(gereken) {
  return `💳 *Ödeme Bilgileri*\n` +
    `Tutar: *${fmt(gereken)}* (veya daha fazlası)\n` +
    `IBAN: \`${CONFIG.IBAN}\`\n` +
    `Hesap Sahibi: ${CONFIG.HESAP_ISIM}\n\n` +
    `Açıklamaya *adınızı ve soyadınızı* yazın, dekontu buraya gönderin. Bakiyen yüklenince Elmas olursun ve sıradaysan otomatik olarak en başa geçersin 💎`;
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
    mesaj += `• ⏫ *Bekleme listelerinde öncelik* — sıranın en başına geçersin\n`;
    mesaj += `• ⚡ Öncelikli VIP destek\n`;
    mesaj += `• Tüm oyunlara erişim\n`;
  }

  // Tüm seviyelerin avantajları — dinamik eşiklerle
  mesaj += `\n*📋 Üyelik Seviyeleri:*\n`;
  mesaj += `🥉 *Bronz* — ₺0+\n`;
  mesaj += `🥈 *Gümüş* — ₺${T.gumus.toLocaleString('tr-TR')}+ → %${I.gumus} indirim\n`;
  mesaj += `🥇 *Altın* — ₺${T.altin.toLocaleString('tr-TR')}+ → %${I.altin} indirim\n`;
  mesaj += `🏆 *Platin* — ₺${T.platin.toLocaleString('tr-TR')}+ → %${I.platin} indirim + hediye gün\n`;
  mesaj += `💎 *Elmas* — ₺${T.platinplus.toLocaleString('tr-TR')}+ → %${I.platinplus} indirim + bekleme listesinde öncelik\n\n`;

  if (tier.sonraki) {
    mesaj += `📈 *${tier.sonraki}* için *${fmt(tier.kalanTL)}* daha harca!\n`;
    mesaj += `💎 Bakiye yükleyerek hemen *Elmas* olabilirsin — bilgi için *elmas* yaz\n`;
  } else {
    mesaj += `🏆 En üst seviyedesin, tebrikler!\n`;
  }
  return mesaj;
}

// ── SSS FONKSİYONU ──
function sssKontrol(metin, musteriAd) {
  const ad = musteriAd || 'Müşterimiz';

  // Çalışma saatleri
  if (metin.includes('saat') || metin.includes('calisma') || metin.includes('kacta') ||
      metin.includes('kaca kadar') || metin.includes('acik') || metin.includes('musait')) {
    return `🕐 *Çalışma Saatleri*\n\nMerhaba ${ad}! 😊\n\nBiz 7/24 hizmetinizdeyiz! Gece gündüz her saatte mesaj atabilirsiniz, bot size yardımcı olacaktır.\n\nİşletmecimize ulaşmak istiyorsanız da mesajınızı bırakın, en kısa sürede dönüş yapılır 🙏`;
  }

  // Nasıl kiralıyorum
  if (metin.includes('nasil kirala') || metin.includes('kiralama sureci') || metin.includes('nasil calis') ||
      metin.includes('ne yapacagim') || metin.includes('ne yapmali') || metin.includes('ilk kez')) {
    return `🎮 *Kiralama Süreci*\n\nMerhaba ${ad}! Çok basit:\n\n*1️⃣* Menüden *5* yazarak oyun listesini gör\n*2️⃣* Beğendiğin oyunu ve kaç gün istediğini söyle\n*3️⃣* IBAN bilgisi sana gönderilir, ödemeyi yap\n*4️⃣* Dekontu buraya gönder\n*5️⃣* Hesabına erişim bilgileri iletilir ✅\n\nHerhangi bir adımda takılırsan yardımcı oluruz 😊`;
  }

  // Ödeme yöntemleri
  if (metin.includes('odeme') || metin.includes('iban') || metin.includes('havale') ||
      metin.includes('eft') || metin.includes('para') || metin.includes('nasil ode')) {
    return `💳 *Ödeme Yöntemleri*\n\nŞu an ödeme *banka havalesi / EFT* ile yapılmaktadır.\n\nIBAN bilgisi için *5* yazarak kiralama başlatın, otomatik olarak gönderilecektir.\n\nÖdeme sonrası dekontu bu sohbete iletin, hemen işleme alınır ✅`;
  }

  // İade
  if ((metin.includes('iade') && !metin.includes('nasil')) || metin.includes('teslim') ||
      metin.includes('geri ver') || metin.includes('bitir')) {
    return `📦 *İade Süreci*\n\nMerhaba ${ad}!\n\nİade için menüden *3* yazmanız yeterli 😊\n\nOyunu bitirdiğinizde bildirim gönderirsiniz, hesap erişimi tarafımızdan sonlandırılır.\n\n⚠️ Hesabı kendiniz çıkmayın, iade bildirimi yapmadan çıkış yapmak sorun oluşturabilir.`;
  }

  // Gecikme / geç iade
  if (metin.includes('gecik') || metin.includes('gec kald') || metin.includes('uzatsam') ||
      metin.includes('sure doldu') || metin.includes('surem doldu') || metin.includes('suresi gect')) {
    return `⏰ *Gecikme Politikası*\n\nMerhaba ${ad}!\n\nİlk gecikmede ek ücret uygulanmaz, anlayışla karşılarız 😊\n\nAncak tekrarlayan gecikmelerde müşteri güven skorunuza göre günlük ek ücret uygulanabilir (₺3 → ₺5 → ₺7 şeklinde artan).\n\nSkorunuz düşerse kara listeye alınabilir ve ileriki kiralamalarda ön ödeme şartı getirilebilir.\n\nEn iyisi uzatma gerekirse önceden *2* yazarak bilgi vermek 🙏`;
  }

  // Kara liste
  if (metin.includes('kara liste') || metin.includes('karalist') || metin.includes('yasakli') ||
      metin.includes('engellenm')) {
    return `🚫 *Kara Liste*\n\nKara liste; gecikmeli iade, ödeme sorunları veya hesap ihlali gibi durumlarda uygulanır.\n\nKara listede olan müşterilerimiz yeni kiralama yapamaz.\n\nHerhangi bir sorun yaşadıysanız doğrudan işletmeci ile iletişime geçin, çözüme kavuşturalım 🙏`;
  }

  // Fiyat soru
  if (metin.includes('fiyat') || metin.includes('kac para') || metin.includes('ne kadar') ||
      metin.includes('ucret') || metin.includes('kaca')) {
    return `💰 *Fiyatlar*\n\nMerhaba ${ad}!\n\nFiyatlar oyuna ve kiralama tipine göre değişiyor:\n\n🔵 *Primary* — oyunu ana hesaptan oynarsın, tam deneyim\n🟣 *Secondary* — daha uygun fiyatlı seçenek\n\nGüncel fiyatları görmek için *4* yazarak oyun listesine bakabilirsin 🎮`;
  }

  // Primary / Secondary ne demek
  if (metin.includes('primary ne') || metin.includes('secondary ne') || metin.includes('primary mi') ||
      metin.includes('secondary mi') || metin.includes('fark ne') || metin.includes('fark nedir')) {
    return `🎮 *Primary & Secondary Farkı*\n\n🔵 *Primary (Ana Hesap)*\nOyunu hesabın ana kullanıcısı olarak oynarsın. Tam erişim, çevrimiçi özellikler dahil. Biraz daha pahalı.\n\n🟣 *Secondary (İkinci Kullanıcı)*\nOyunu kendi PS hesabında oynarsın, daha uygun fiyatlı. Çevrimiçi özellikler için PS Plus gerekmeyebilir.\n\nHer ikisi de sorunsuz çalışır, bütçene göre seçebilirsin 😊`;
  }

  return null; // SSS eşleşmedi, Claude'a git
}

// Botun kendi gönderdiği mesajlar — Waha bunları da "fromMe" olarak webhook'a geri gönderiyor.
// Eskiden bot kendi mesajını "işletmeci yazdı" sanıp müşteriyi 8 saat susturuyordu (2/3'e tepki vermeme sebebi).
const botunMesajlari = new Map(); // metin parmak izi / mesaj id → zaman
function parmakIzi(metin) { return String(metin || '').trim().slice(0, 200); }
function botunMesajiMi(msg) {
  if (msg.source === 'api') return true; // Yeni Waha sürümleri API'den gidenleri işaretliyor
  const simdi = Date.now();
  for (const [k, t] of botunMesajlari) if (simdi - t > 5 * 60 * 1000) botunMesajlari.delete(k);
  if (msg.id && (botunMesajlari.has('id:' + msg.id) || botunMesajlari.has('id:' + (msg.id.id || '')))) return true;
  return botunMesajlari.has('txt:' + parmakIzi(msg.body));
}

async function mesajGonder(tel, metin) {
  try {
    const chatId = tel.includes('@') ? tel : tel + '@c.us';
    botunMesajlari.set('txt:' + parmakIzi(metin), Date.now());
    const yanit = await axios.post(`${CONFIG.WAHA_URL}/api/sendText`,
      { session: 'default', chatId, text: metin },
      { headers: CONFIG.WAHA_API_KEY ? { 'X-Api-Key': CONFIG.WAHA_API_KEY } : {} }
    );
    const gidenId = yanit?.data?.id;
    if (gidenId) botunMesajlari.set('id:' + (typeof gidenId === 'object' ? (gidenId._serialized || gidenId.id) : gidenId), Date.now());
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
// Bekleyen işlemler artık zaman aşımına uğrar: eskiden yarım kalan bir işlem (ör. dekont bekleme)
// günlerce kalıyor, müşteri ne yazarsa yazsın aynı mesajı alıyordu.
const STATE_SURESI = {
  varsayilan: 12 * 60 * 60 * 1000,              // 12 saat
  yeni_kiralama_bekle: 3 * 24 * 60 * 60 * 1000,  // işletmeci onayı bekleniyor
  uzatma_isletmeci_bekle: 3 * 24 * 60 * 60 * 1000,
  qr_bekle: 2 * 24 * 60 * 60 * 1000,
  qr_onay_bekle: 2 * 24 * 60 * 60 * 1000,
  bildirim_secim: 2 * 24 * 60 * 60 * 1000,
  iade_cevrimdisi_bekle: 2 * 24 * 60 * 60 * 1000, // primary iade: "çevrimdışı oynamayı kapattınız mı?"
};
// İşletmeci onayı bekleyen işlemler (ödeme yapılmış). Müşteri bu arada başka bir menüye geçerse
// bu kayıt kaybolmasın diye ayrı tutulur — #onayla her iki yerde de arar.
const ONAY_TIPLERI = ['yeni_kiralama_bekle', 'uzatma_isletmeci_bekle', 'qr_onay_bekle'];
const onayBekleyenler = new Map();
class SureliMap extends Map {
  set(k, v) {
    const mevcut = super.get(k);
    if (mevcut && ONAY_TIPLERI.includes(mevcut.tip) && !(v && ONAY_TIPLERI.includes(v.tip)) && !(v && v.tip === 'qr_bekle')) {
      onayBekleyenler.set(k, mevcut); // üzerine yazılmadan önce kenara al
    }
    return super.set(k, v && typeof v === 'object' ? { ...v, _ts: Date.now() } : v);
  }
  get(k) {
    const v = super.get(k);
    if (v && v._ts) {
      const sure = STATE_SURESI[v.tip] || STATE_SURESI.varsayilan;
      if (Date.now() - v._ts > sure) { super.delete(k); return undefined; }
    }
    return v;
  }
  has(k) { return this.get(k) !== undefined; }
}
const bekleyenOnaylar = new SureliMap();
const insanDevraldi = new Map();
const sonMenuGonderilen = new Map(); // Menü spam önleme
const BAKIYE_BILGI = `ℹ️ *Bakiye Hakkında:*
Yüklediğiniz bakiye son 3 aylık harcamanıza eklenir ve üyelik seviyenizi etkiler. 3 ay sonunda bu tutar harcama hesabından düşer, ancak bakiyeniz hesabınızda kalmaya devam eder — yalnızca üyelik seviyeniz güncel harcamalarınıza göre yeniden hesaplanır.`;
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

🏆 *Platin üyeler* bu avantajı *yeni çıkan oyunlarda bile* kullanabilir
💎 *Elmas üyeler* de aynı şekilde tüm oyunlarda hediye günden yararlanır

━━━━━━━━━━━━━━━━━━━━━
🏅 *Üyelik Avantajları*

Ne kadar çok kiralama yaparsanız o kadar çok kazanırsınız!

🥉 Bronz → Standart fiyat
🥈 Gümüş (₺750+) → %5 indirim
🥇 Altın (₺1.500+) → %10 indirim
🏆 Platin (₺3.000+) → %15 indirim + yeni oyunlarda da hediye gün
💎 Elmas (₺5.000+) → %20 indirim + bekleme listesinde öncelik + tüm oyunlarda hediye gün

━━━━━━━━━━━━━━━━━━━━━
Şimdi kaydınızı oluşturalım 😊
*Adınızı* yazar mısınız?`; // tel -> timestamp
const INSAN_SURESI = 8 * 60 * 60 * 1000; // 8 saat (pratik olarak kalıcı)
const sonMesajGonderilenLid = new Map(); // numara9 -> lid (botun son mesaj gönderdiği müşteri LID'i)
let benimLid = process.env.BENIM_LID || null;
// İlk mesajda otomatik öğren


// Dosya/fotoğraf beklenen adımlarda müşteri yazı yazarsa aynı uyarı her mesajda tekrar gitmesin:
// en fazla 3 dakikada bir hatırlat, arada yazılanlar normal akışa (menü/SSS) düşsün.
const sonHatirlatma = new Map();
function hatirlatmaZamaniMi(tel, dk = 3) {
  const t = sonHatirlatma.get(tel) || 0;
  if (Date.now() - t < dk * 60 * 1000) return false;
  sonHatirlatma.set(tel, Date.now());
  return true;
}
// Adımda geçersiz cevap: en fazla 2 kez tekrar sorar, 3.'de işlemi iptal edip menüyü gösterir
// (eskiden müşteri ne yazarsa yazsın aynı uyarı sonsuza kadar tekrar ediyordu)
async function gecersizCevap(tel, mesaj) {
  const b = bekleyenOnaylar.get(tel);
  const deneme = ((b && b._hata) || 0) + 1;
  if (!b || deneme >= 3) {
    bekleyenOnaylar.delete(tel);
    await mesajGonder(tel, `🤔 Anlayamadım, bu işlemi iptal ettim.\n\nBaşka ne yapmak istersiniz?\n\n${MENU_METNI}`);
    return;
  }
  bekleyenOnaylar.set(tel, { ...b, _hata: deneme });
  await mesajGonder(tel, mesaj + `\n\n_(Vazgeçmek için *iptal* yazabilirsiniz)_`);
}
const menuSecimiMi = m => /^[1-9]$/.test(m) || ['merhaba', 'selam', 'menu', 'ana menu'].includes(m);

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

// Aynı kişiden art arda gelen mesajlar sırayla işlenir (eskiden paralel işleniyor, durum karışıp
// aynı mesaj iki kez gidebiliyordu)
const sohbetKuyrugu = new Map();
function kuyrugaEkle(anahtar, is) {
  const onceki = sohbetKuyrugu.get(anahtar) || Promise.resolve();
  const yeni = onceki.then(is, is).finally(() => { if (sohbetKuyrugu.get(anahtar) === yeni) sohbetKuyrugu.delete(anahtar); });
  sohbetKuyrugu.set(anahtar, yeni);
  return yeni;
}
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const event = req.body || {};
  const p = event.payload || {};
  const anahtar = (p.fromMe ? p.to : p.from) || 'genel';
  kuyrugaEkle(anahtar, () => webhookIsle(event));
});

// İşletmecinin müşteriye elle yazdığı mesaj botu susturur. AMA mesajda 🤖 varsa veya
// "2 / 3 yazın" şeklinde menü seçeneği veriyorsa (ör. siteden gönderilen süre doluyor bildirimi)
// bot susturulmaz ve müşterinin 2/3 cevabını bot karşılar.
function botaDevredenMesajMi(body) {
  if (/🤖/.test(body)) return true;
  const sade = sadeKomut(body);
  const kelimeler = new Set(sade.split(' '));
  return kelimeler.has('2') && kelimeler.has('3') && sade.includes('yaz');
}
async function musteriBulChat(veri, chatId) {
  const sade = String(chatId || '').replace(/[^0-9]/g, '');
  return veri.musteriler.find(m => m.whatsappLid && m.whatsappLid === chatId)
    || veri.musteriler.find(m => (m.whatsappLid || '').replace(/[^0-9]/g, '') === sade && sade.length > 5)
    || (chatId.includes('@lid') ? null : veri.musteriler.find(m => telSon10(m.tel).length === 10 && telSon10(m.tel) === telSon10(sade)));
}
async function bildirimDurumuKur(chatId) {
  try {
    const veri = await getVeri(); if (!veri) return;
    const m = await musteriBulChat(veri, chatId);
    if (!m) return;
    const aktif = veri.kiralamalar.filter(k => k.musteriId === m.id && k.durum === 'aktif').sort((a, b) => a.bit.localeCompare(b.bit));
    if (!aktif.length) return;
    const k = aktif[0];
    const o = veri.oyunlar.find(x => x.id === k.oyunId);
    bekleyenSet(m, { tip: 'bildirim_secim', kiraId: k.id, musteriId: m.id, gunluk: gunlukFiyat(o || {}, k.tip) });
    // Bu müşteri için önceki susturmaları kaldır
    const anahtarlar = [chatId, m.whatsappLid, temizTel(m.tel || '') + '@c.us'].filter(Boolean);
    for (const [key] of insanDevraldi) {
      if (anahtarlar.includes(key) || key.replace(/[^0-9]/g, '').endsWith(telSon10(m.tel).slice(-9) || '_yok_')) insanDevraldi.delete(key);
    }
    console.log(`🤖 İşletmeci bildirimi → bot devrede: ${chatId} (kira #${k.id})`);
  } catch (e) { console.error('bildirimDurumuKur hatası:', e.message); }
}

async function webhookIsle(event) {
  try {
    const msg = event.payload;
    if (!msg) return;

    // Giden mesaj (fromMe) — message.any VEYA message event'inden yakala
    const fromMeEvent = (event.event === 'message.any' || event.event === 'message') && msg.fromMe && msg.to;
    if (fromMeEvent) {
      const body = (msg.body || '').trim();
      if (botunMesajiMi(msg)) return; // botun kendi gönderdiği mesaj — kimseyi susturma
      console.log(`📤 fromMe event: ${event.event} | to: ${msg.to} | body: "${body.slice(0,30)}"`);
      const benim9 = (CONFIG.BENIM_NUMARAM || '').replace(/[^0-9]/g,'').slice(-9);
      const kendimeMi = (benim9 && msg.to.replace(/[^0-9]/g,'').endsWith(benim9)) || msg.to === benimLid || msg.to === process.env.BENIM_LID;
      if (kendimeMi) return; // kendi sohbetime yazdığım komutlar
      if (botaDevredenMesajMi(body)) { await bildirimDurumuKur(msg.to); return; }
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
    const metin = sadeKomut(msg.body); // Türkçe harf/büyük harf/noktalama bağımsız (İptal = iptal = IPTAL)
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

      // #ozet — sabah özetini şimdi gönder
      if (metin === '#ozet' || metin === '#özet') {
        try { await banaGonder(sabahOzetiMetni(await getVeri())); }
        catch (e) { await banaGonder('❌ Özet hazırlanamadı: ' + e.message); }
        return;
      }

      // #durum — bot durumu ozeti
      if (metin === '#durum') {
        try {
          const veriDurum = await getVeri();
          const bugunStr = bugun();
          const yarinStr2 = yarinStr();
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
          const elmasOnce = elmasMi(mBakiye.id, veriBakiye);
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
          if (!elmasOnce && elmasMi(mBakiye.id, veriBakiye)) {
            const siralar = (veriBakiye.rezervasyonlar || []).filter(r => r.musteriId === mBakiye.id && r.durum === 'bekliyor');
            const oyunlar = siralar.map(r => (veriBakiye.oyunlar.find(o => o.id === r.oyunId) || {}).ad).filter(Boolean);
            if (hedefBakiye) await mesajGonder(hedefBakiye,
              `💎 *Tebrikler, artık Elmas üyesin!*\n\n` +
              `• ⏫ Bekleme listelerinde önceliklisin\n• 🏷️ Kiralamalarda *%${elmasEsik(veriBakiye).indirim} indirim*\n• 🎁 10+ günde 5 gün hediye\n` +
              (oyunlar.length ? `\n✅ Şu sıralarda en başa geçtin: *${[...new Set(oyunlar)].join(', ')}*\nSlot boşalınca ilk haber sana gelecek 🔔` : ''));
            await banaGonder(`💎 ${mBakiye.ad || ''} ${mBakiye.soyad || ''} artık *Elmas* üye${oyunlar.length ? ` — sıralarda en başa geçti (${[...new Set(oyunlar)].join(', ')})` : ''}`);
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
          if (!veriKara.nextId) veriKara.nextId = {};
          const klId = Math.max(veriKara.nextId.kl || 1, ...veriKara.karaListe.map(k => (k.id || 0) + 1));
          veriKara.nextId.kl = klId + 1;
          veriKara.karaListe.push({ id: klId, musteriId: mKara.id, sebep, tarih: bugun() });
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
      if (metin.startsWith('#karaac') || metin.startsWith('#kara ac') || metin.startsWith('#kara ac')) {
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
          const qrTipi = v => v && (v.tip === 'qr_bekle' || v.tip === 'qr_onay_bekle');
          const qrKeys = [hedefKey, '90'+sade+'@c.us', sade+'@c.us'];
          let bekleyenT = null, qrKey = null, qrKaynak = null;
          for (const kaynak of [bekleyenOnaylar, onayBekleyenler]) {
            for (const k of qrKeys) { const v = kaynak.get(k); if (qrTipi(v)) { bekleyenT = v; qrKey = k; qrKaynak = kaynak; break; } }
            if (bekleyenT) break;
          }
          const oyunAd = bekleyenT?.oyunAd || '?';
          // Müşteriye bildirim
          await mesajGonder(hedefKey,
            `✅ *Giriş Sağlandı!*\n\n` +
            `🎮 *${oyunAd}* hesabına başarıyla giriş yapıldı.\n\n` +
            `İyi oyunlar! 🎮🎉\n\n` +
            `Süreniz bittiğinde veya uzatmak istediğinizde menüden işlem yapabilirsiniz.`
          );
          if (qrKaynak) qrKaynak.delete(qrKey);
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
        let hedefKaynak = null; // hangi map'te bulundu
        const onayTipiMi = v => v && (v.tip === 'yeni_kiralama_bekle' || v.tip === 'uzatma_isletmeci_bekle');
        const kaynaklar = [bekleyenOnaylar, onayBekleyenler];
        // Numara '90' ile veya '90'sız yazılabilir — iki biçimi de dene
        araKeys.push('90' + hedefSade + '@c.us', hedefSade + '@c.us');
        for (const kaynak of kaynaklar) {
          for (const k of araKeys) {
            const v = kaynak.get(k);
            if (onayTipiMi(v)) { hedefKey = k; hedefBekleyen = v; hedefKaynak = kaynak; break; }
          }
          if (hedefBekleyen) break;
        }

        // 2) Bulunamazsa tüm bekleyenler arasında müşteri telefonu ile eşleştir (LID ile yazan müşteriler)
        if (!hedefBekleyen) {
          const veriAra = await getVeri();
          for (const kaynak of kaynaklar) {
            for (const [key, val] of kaynak.entries()) {
              if (!onayTipiMi(val)) continue;
              const mId = val.musteriId || veriAra.kiralamalar.find(x => x.id === val.kiraId)?.musteriId;
              const m = veriAra.musteriler.find(x => x.id === mId);
              if (!m) continue;
              if (telSon10(m.tel) === telSon10(hedefSade)) { hedefKey = key; hedefBekleyen = val; hedefKaynak = kaynak; break; }
            }
            if (hedefBekleyen) break;
          }
        }
        const onayKaydiniSil = () => { if (hedefKaynak) hedefKaynak.delete(hedefKey); onayBekleyenler.delete(hedefKey); };

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
          // Boş slotu olan kopyaya ata (eskiden hep ana hesaba yazılıyordu, kopyalı oyunlarda çakışma oluyordu)
          const kopyaIdx = bosKopyaBul(veri2.oyunlar.find(o => o.id === hedefBekleyen.oyunId), hedefBekleyen.kiraTip, veri2);
          veri2.kiralamalar.push({
            id: yeniId, oyunId: hedefBekleyen.oyunId, musteriId: hedefBekleyen.musteriId,
            tip: hedefBekleyen.kiraTip, bas, bit,
            ucret: (hedefBekleyen.ucret + (hedefBekleyen.indirim||0)), indirim: (hedefBekleyen.indirim||0), net: hedefBekleyen.ucret,
            onOdeme: hedefBekleyen.ucret, hediyeGun, notlar: 'Bot ile eklendi', durum: 'aktif',
            kopyaIdx, odemeTip: hedefBekleyen.odemeTip || 'havale', // bakiye ile ödenenler tier'da çift sayılmasın
            ...(hedefBekleyen.onOdeme > 0 ? { rezervOnOdeme: hedefBekleyen.onOdeme, rezervId: hedefBekleyen.rezervId } : {}),
            ...(hedefBekleyen.fiyatKampanyaId ? { fiyatKampanyaId: hedefBekleyen.fiyatKampanyaId } : {}),
            ...(hedefBekleyen.paketKampanyaId ? { paketKampanyaId: hedefBekleyen.paketKampanyaId } : {}),
            ...(hedefBekleyen.teminat > 0 ? { teminat: hedefBekleyen.teminat, teminatDurum: 'tutuluyor' } : {}),
          });
          // Özel indirim kullanıldıysa işaretle (kampanya sonucunda "geri döndü" olarak sayılır)
          if (hedefBekleyen.ozelIndirimKullan) {
            const mOz = veri2.musteriler.find(m => m.id === hedefBekleyen.musteriId);
            if (mOz && mOz.ozelIndirim) { mOz.ozelIndirim.kullanildi = true; mOz.ozelIndirim.kiraId = yeniId; }
            const yk = veri2.kiralamalar.find(k => k.id === yeniId);
            if (yk && mOz?.ozelIndirim?.kampanyaId) yk.kampanyaId = mOz.ozelIndirim.kampanyaId;
          }
          // Bekleme listesi kaydını "kiralandı" yap (eskiden bot ile kiralayanlar listede "bekliyor" olarak kalıyordu)
          let fazlaOnOdeme = 0;
          (veri2.rezervasyonlar || []).forEach(r => {
            if (r.durum !== 'bekliyor' || r.musteriId !== hedefBekleyen.musteriId || r.oyunId !== hedefBekleyen.oyunId) return;
            const kullanilan = r.id === hedefBekleyen.rezervId && hedefBekleyen.onOdeme > 0;
            if (r.onOdeme > 0 && !kullanilan) return; // başka bir ön ödemeli kayıt — dokunma
            r.durum = 'kiralandi'; r.kiraId = yeniId; r.kiralamaTarih = bugun();
            if (kullanilan) fazlaOnOdeme = Math.max(0, r.onOdeme - hedefBekleyen.ucret - (hedefBekleyen.teminat || 0));
          });
          if (fazlaOnOdeme > 0) {
            const mF = veri2.musteriler.find(m => m.id === hedefBekleyen.musteriId);
            if (mF) {
              mF.bakiye = (mF.bakiye || 0) + fazlaOnOdeme;
              if (!mF.bakiyeGecmis) mF.bakiyeGecmis = [];
              mF.bakiyeGecmis.push({ tarih: bugun(), tutar: fazlaOnOdeme, aciklama: `Bekleme ön ödemesi fazlası — ${hedefBekleyen.oyunAd}`, tip: 'depozito' });
            }
          }
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
          onayKaydiniSil();
          // Tier kontrolü — SONRA
          const tierSonrasi = getMusteriTierBot(hedefBekleyen.musteriId, veri2);
          const tierAtladi = tierOncesi.seviye !== tierSonrasi.seviye;
          // Sıra ve yeni oyun kontrolü
          const siradaVarOnay = (veri2.rezervasyonlar||[]).some(r => r.oyunId === hedefBekleyen.oyunId && r.tip === hedefBekleyen.kiraTip && r.durum === 'bekliyor');
          const oyunCikisOnay = veri2.oyunlar.find(o => o.id === hedefBekleyen.oyunId)?.cikis;
          const birAyOnceOnay = new Date(); birAyOnceOnay.setMonth(birAyOnceOnay.getMonth() - 1);
          const yeniOyunOnay = oyunCikisOnay && new Date(oyunCikisOnay) > birAyOnceOnay;

          let onayMesaj = `✅ *Ödemeniz onaylandı!*\n\n🎮 *${hedefBekleyen.oyunAd}*\n📅 ${bas} → ${bit}`;
          if (hediyeGun > 0) onayMesaj += ` 🎁 *(+${hediyeGun} gün hediye)*`;
          onayMesaj += `\n💰 ${fmt(hedefBekleyen.ucret)}`;
          if (hedefBekleyen.onOdeme > 0) onayMesaj += ` (${fmt(Math.min(hedefBekleyen.onOdeme, hedefBekleyen.ucret))} ön ödemenizden karşılandı)`;
          if (fazlaOnOdeme > 0) onayMesaj += `\n💳 Fazla ön ödeme *${fmt(fazlaOnOdeme)}* bakiyenize aktarıldı`;
          if (hedefBekleyen.teminat > 0) onayMesaj += `\n🛡️ *${fmt(hedefBekleyen.teminat)}* teminatınız tutuluyor — *${fmtTarih(bit)}* tarihinde iade edersen bakiyene eklenir`;
          onayMesaj += `\n\n`;
          if (siradaVarOnay) {
            onayMesaj += `⚠️ *Bu oyun için sıra mevcut!*\nUzatma hakkınız yalnızca *1 kez* kullanılabilir.\n\n`;
          }
          if (yeniOyunOnay && siradaVarOnay) {
            onayMesaj += `💡 *Erken İade Ödülü:* Oyunu erken iade ederseniz kalan sürenizin ücretinin *%10'u* bakiyenize yüklenir 🎁\n\n`;
          }
          onayMesaj += `📲 *Hesaba giriş için:*\n` +
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
          const yeniKiraHesap = kiraHesabi(veri2.kiralamalar.find(k => k.id === yeniId) || {}, veri2);
          await banaGonder(`✅ Kiralama eklendi!\n🎮 ${hedefBekleyen.oyunAd}\n👤 ${hedefBekleyen.musteriAd}\n📅 ${bas} → ${bit}${hediyeGun > 0 ? ` (+${hediyeGun} gün hediye)` : ''}${yeniKiraHesap ? `\n🔑 Hesap: *${yeniKiraHesap}*` : ''}\n\n📲 QR bekleniyor — müşteri gönderince sana iletilecek.\nGiriş sonrası: *#tamam ${hedefKey.replace('@c.us','').replace('@lid','')}*`);
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
            onayKaydiniSil();
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

    if (!musteri && !isLid) {
      const sade = tel.replace('@c.us','').replace(/^90/,'').replace(/^0/,'');
      // Son 10 hane birebir eşleşmeli (eskiden kısa/hatalı kayıtlı numaralar yanlış müşteriyle eşleşebiliyordu)
      const sade10 = telSon10(sade);
      musteri = sade10.length === 10 ? veri.musteriler.find(m => telSon10(m.tel).length === 10 && telSon10(m.tel) === sade10) : null;
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

    // ── KARA LİSTE KONTROLÜ ── (artık telefonla bulunan müşteriler için de çalışır)
    if (musteri && (veri.karaListe||[]).some(k => k.musteriId === musteri.id)) {
      const sonKara = sonMenuGonderilen.get('kara_' + tel) || 0;
      if (Date.now() - sonKara > 24 * 60 * 60 * 1000) {
        sonMenuGonderilen.set('kara_' + tel, Date.now());
        await mesajGonder(tel, `🚫 Hesabınız askıya alınmıştır.\nDetay için işletmecimizle iletişime geçin.`);
      }
      return;
    }

    const musteriAd = musteri ? ((musteri.ad||'') + ' ' + (musteri.soyad||'')).trim() || musteri.tel || 'Müşteri' : 'Misafir';
    const aktifKiralar = musteri ? veri.kiralamalar.filter(k => k.musteriId === musteri.id && k.durum === 'aktif') : [];
    const aktifKira = aktifKiralar[0] || null;


    // Durum başka bir anahtarla (LID ↔ telefon) kaydedildiyse bu sohbete taşı
    // (bildirim telefona gidip müşteri LID'den cevap verince 2/3 tanınmıyordu)
    if (musteri && !bekleyenOnaylar.has(tel)) {
      const alternatifler = [musteri.whatsappLid, musteri.tel ? temizTel(musteri.tel) + '@c.us' : null].filter(k => k && k !== tel);
      for (const k of alternatifler) {
        const v = bekleyenOnaylar.get(k);
        if (v) { bekleyenOnaylar.set(tel, v); bekleyenOnaylar.delete(k); break; }
      }
    }

    // ── GENEL İPTAL — herhangi bir adımda "iptal / vazgeç / geri / menü / 0" yazılırsa menüye dön ──
    const bekleyenKontrol = bekleyenOnaylar.get(tel);
    if (bekleyenKontrol && IPTAL_KELIMELERI.includes(metin)) {
      if (ONAY_TIPLERI.includes(bekleyenKontrol.tip)) {
        // Ödeme yapılmış, işletmeci onayı bekleniyor — kaydı silme, sadece bilgi ver
        await mesajGonder(tel, `⏳ Ödemeniz işletmeci onayı bekliyor, kaydınız duruyor.\n\nBu işlemi iptal etmek isterseniz *7* yazarak yetkiliyle görüşebilirsiniz.\n\n${MENU_METNI}`);
        return;
      }
      bekleyenOnaylar.delete(tel);
      if (!musteri) {
        await mesajGonder(tel, `İptal edildi 😊 Tekrar başlamak için herhangi bir mesaj yazabilirsiniz.`);
        return;
      }
      await mesajGonder(tel, `İptal edildi 😊\n\n👋 *${musteriAd}*, başka bir şey yapabilir miyim?\n\n${MENU_METNI}`);
      return;
    }

    // ── TELEFON BEKLEME ──
    const bekleyen = bekleyenOnaylar.get(tel);
    if (bekleyen?.tip === 'telefon_bekle') {
      const numara = metinOrijinal.replace(/[^0-9]/g,'').replace(/^90/,'').replace(/^0/,'');
      if (numara.length >= 10) {
        const bulunan = veri.musteriler.find(m => telSon10(m.tel).length === 10 && telSon10(m.tel) === numara.slice(-10));
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
        // LID ile yazan müşteride sohbet numarası telefon değildir — #bakiye için kayıtlı telefonu kullan
        const bTel = telSon10((veri.musteriler || []).find(m => m.id === bekleyen.musteriId)?.tel) || tel.replace(/[^0-9]/g,'').slice(-10);
        await banaGonder(
          `💰 *Bakiye Yükleme Talebi*\n\n` +
          `👤 ${sBakiye}\n` +
          `📱 ${bTel}\n` +
          (bekleyen.elmas ? `💎 *Elmas olmak için* (gereken: ${fmt(bekleyen.gereken)}${bekleyen.oyunAd ? ` · sırada: ${bekleyen.oyunAd}` : ''})\n` : '') +
          `\nYüklemek için: *#bakiye ${bTel} [tutar]*`
        );
        await mesajGonder(tel,
          `✅ Dekontunuz alındı! Kısa sürede bakiyenize yüklenecektir 🙏\n\n` +
          `İşlem tamamlandığında bildirim alacaksınız.`
        );
        bekleyenOnaylar.delete(tel);
        return;
      } else if (!menuSecimiMi(metin) && hatirlatmaZamaniMi(tel)) {
        await mesajGonder(tel,
          `📸 Lütfen havale dekontunu fotoğraf veya PDF olarak gönderin.\n\n❌ Vazgeçmek için *iptal* yazın.`
        );
        return;
      }
      // menü seçimi veya başka bir soru → normal akışa devam
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
            chatId: (CONFIG.BENIM_NUMARAM || '').includes('@') ? CONFIG.BENIM_NUMARAM : temizTel(CONFIG.BENIM_NUMARAM || '') + '@c.us',
            caption: `QR — ${bekleyen.musteriAd} / ${bekleyen.oyunAd}`,
            file: msg.media?.url ? { mimetype: msg.media?.mimetype || 'image/jpeg', url: msg.media.url } : { mimetype: msg.media?.mimetype || 'image/jpeg', data: msg.media?.data || '' }
          }, { headers: { 'X-Api-Key': CONFIG.WAHA_API_KEY } });
        } catch(e) { console.log('QR görsel iletme hatası:', e.message); }
        await mesajGonder(tel, `📸 QR kodunuz alındı! Giriş işlemi tamamlanınca bildirim alacaksınız 🙏`);
        bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'qr_onay_bekle' });
        return;
      } else if (!menuSecimiMi(metin) && hatirlatmaZamaniMi(tel)) {
        await mesajGonder(tel,
          `📲 *QR Bekleniyor*\n\n` +
          `PlayStation'ınızda:\n` +
          `*1.* Ayarlar → Kullanıcılar ve Hesaplar\n` +
          `*2.* Diğer → QR Koduyla Oturum Aç\n` +
          `*3.* Açılan QR ekranının fotoğrafını gönderin 📸\n\n` +
          `Sorun yaşıyorsanız *7* yazarak yetkiliye ulaşabilirsiniz.`
        );
        return;
      }
      // Menü seçimi / soru → normal akış (QR beklemesi silinmez, işletmeci #tamam ile kapatır)
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
        const { musaitOyunlar, kiradaOyunlar = [], cikacakOyunlar = [] } = bekleyen;
        let secilen = null;
        let secilenKirada = false;
        let secilenCikacak = false;
        const sayi = parseInt(metin);
        if (!isNaN(sayi) && sayi >= 1 && sayi <= musaitOyunlar.length) {
          secilen = musaitOyunlar[sayi - 1];
        } else if (!isNaN(sayi) && sayi >= 1 && sayi <= (musaitOyunlar.length + (kiradaOyunlar||[]).length)) {
          secilenKirada = true;
          secilen = (kiradaOyunlar||[])[sayi - musaitOyunlar.length - 1];
        } else if (!isNaN(sayi) && sayi >= 1 && sayi <= (musaitOyunlar.length + kiradaOyunlar.length + cikacakOyunlar.length)) {
          secilenCikacak = true;
          secilen = cikacakOyunlar[sayi - musaitOyunlar.length - kiradaOyunlar.length - 1];
        } else {
          secilen = metin.length >= 2 ? musaitOyunlar.find(o => sadeKomut(o.ad).includes(metin)) : null;
        }
        // Müsait değil ama kirada olanlar arasında var mı?
        if (!secilen) {
          secilenKirada = true;
          secilen = metin.length >= 2 ? kiradaOyunlar.find(o => sadeKomut(o.ad).includes(metin)) : null;
        }
        // Yakında çıkacaklar arasında var mı?
        if (!secilen) {
          secilenKirada = false; secilenCikacak = true;
          secilen = metin.length >= 2 ? cikacakOyunlar.find(o => sadeKomut(o.ad).includes(metin)) : null;
        }
        if (!secilen) { await gecersizCevap(tel, `Oyun bulunamadı. Listeden numara veya isim yazın.`); return; }

        // Henüz çıkmamış oyun seçildi → ön rezervasyon (8 menüsüyle aynı akış)
        if (secilenCikacak) {
          const siradaki = (veri.rezervasyonlar||[]).filter(r => r.oyunId === secilen.id && r.durum === 'bekliyor').length;
          const pri = gunlukFiyat(secilen, 'primary');
          const sec = gunlukFiyat(secilen, 'secondary');
          await mesajGonder(tel,
            `🗓 *${secilen.ad}*\n📅 Çıkış tarihi: *${fmtTarih(secilen.cikis)}*\n` +
            `${siradaki > 0 ? `👥 Şu an ${siradaki} kişi sırada\n` : '🥇 Henüz sırada kimse yok — ilk sen ol!\n'}\n` +
            `Oyun çıkınca sıra sana geldiğinde haber veririz 🔔\nHangi slot için yer ayırtmak istersin?\n\n` +
            `*1* - 🔵 Primary (${fmt(pri)}/gün)\n*2* - 🟣 Secondary (${fmt(sec)}/gün)${siradaki > 0 ? elmasSecenek(musteri.id, veri) : ''}\n*iptal* - Vazgeç`
          );
          bekleyenOnaylar.set(tel, { tip: 'on_rezerv_tip_bekle', musteriId: musteri.id, oyunId: secilen.id, oyunAd: secilen.ad, musteriAd });
          return;
        }

        // Kirada oyun seçildi → sıraya gir seçeneği sun
        if (secilenKirada) {
          const siradaki = (veri.rezervasyonlar||[]).filter(r => r.oyunId === secilen.id && r.durum === 'bekliyor').length;
          const pri = gunlukFiyat(secilen, 'primary');
          const sec = gunlukFiyat(secilen, 'secondary');
          await mesajGonder(tel,
            `⏳ *${secilen.ad}* şu an kirada.\n\n` +
            `${siradaki > 0 ? `👥 Sırada ${siradaki} kişi var.\n\n` : ''}` +
            `🔵 Primary: ${fmt(pri)}/gün\n🟣 Secondary: ${fmt(sec)}/gün\n\n` +
            `Sıraya girmek ister misiniz? Slot açılınca size haber verilir 🔔\n\n*1* - 🔵 Primary sıraya gir\n*2* - 🟣 Secondary sıraya gir${elmasSecenek(musteri.id, veri)}\n*iptal* - Vazgeç`
          );
          bekleyenOnaylar.set(tel, { tip: 'rezerv_tip_bekle', musteriId: musteri.id, musteriAd, oyunId: secilen.id, oyunAd: secilen.ad });
          return;
        }

        const pri = gunlukFiyat(secilen, 'primary');
        const sec = gunlukFiyat(secilen, 'secondary');
        const aktif2 = veri.kiralamalar.filter(k => k.oyunId === secilen.id && k.durum === 'aktif');
        const priDolu = doluMu(secilen, 'primary', veri);   // kopyalar da sayılır
        const secDolu = doluMu(secilen, 'secondary', veri);
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
          secilen = metin.length >= 2 ? cikacakOyunlar.find(o => sadeKomut(o.ad).includes(metin)) : null;
        }
        if (!secilen) {
          await gecersizCevap(tel, `Oyun bulunamadı. Lütfen listeden bir numara yazın.`);
          return;
        }
        const pri = gunlukFiyat(secilen, 'primary');
        const sec = gunlukFiyat(secilen, 'secondary');
        const siradaki8 = (veri.rezervasyonlar||[]).filter(r => r.oyunId === secilen.id && r.durum === 'bekliyor').length;
        await mesajGonder(tel,
          `🎮 *${secilen.ad}*\n📅 Çıkış tarihi: ${fmtTarih(secilen.cikis)}${siradaki8 > 0 ? `\n👥 Şu an ${siradaki8} kişi sırada` : ''}\n\nHangi slot için yer ayırtmak istiyorsunuz?\n\n*1* - 🔵 Primary (${fmt(pri)}/gün)\n*2* - 🟣 Secondary (${fmt(sec)}/gün)${siradaki8 > 0 ? elmasSecenek(bekleyen.musteriId, veri) : ''}`
        );
        bekleyenOnaylar.set(tel, { tip: 'on_rezerv_tip_bekle', musteriId: bekleyen.musteriId, oyunId: secilen.id, oyunAd: secilen.ad, musteriAd });
        return;
      }

      // Ön rezervasyon — tip seçimi
      if (bekleyen.tip === 'on_rezerv_tip_bekle') {
        if ((metin === '3' || metin.includes('elmas')) && !elmasMi(bekleyen.musteriId, veri)) {
          bekleyenOnaylar.set(tel, { ...bekleyen, elmasIstiyor: true });
          await mesajGonder(tel, elmasTanitim(bekleyen.musteriId, veri, bekleyen.oyunAd) +
            `\n\n━━━━━━━━━━━━━━━\nÖnce seni sıraya ekleyelim — Elmas olunca otomatik olarak en başa geçersin.\nHangi slot?\n\n*1* - 🔵 Primary\n*2* - 🟣 Secondary\n*iptal* - Vazgeç`);
          return;
        }
        let kiraTip = null;
        if (metin.includes('primary') || metin === '1') kiraTip = 'primary';
        else if (metin.includes('secondary') || metin === '2') kiraTip = 'secondary';
        if (!kiraTip) { await gecersizCevap(tel, `*1* - 🔵 Primary\n*2* - 🟣 Secondary`); return; }

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
          if (bekleyen.elmasIstiyor) {
            const gerekenE = elmasGereken(bekleyen.musteriId, veri2);
            await mesajGonder(tel, elmasOdemeBilgisi(gerekenE));
            bekleyenOnaylar.set(tel, { tip: 'bakiye_yukle_dekont', musteriId: bekleyen.musteriId, musteriAd: bekleyen.musteriAd, elmas: true, gereken: gerekenE, oyunAd: bekleyen.oyunAd });
          }
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
        await banaGonder(`🗓 *Ön Rezervasyon (Bot)*\n👤 ${bekleyen.musteriAd}\n🎮 ${bekleyen.oyunAd} (${tipLabel})\n📅 Çıkış: ${o?.cikis||'?'}\n📍 Sıra: ${siradakiSayi + 1}${bekleyen.elmasIstiyor ? '\n💎 Elmas olmak istiyor — ödeme bilgisi gönderildi' : ''}`);

        if (bekleyen.elmasIstiyor) {
          const gerekenE = elmasGereken(bekleyen.musteriId, veri2);
          await mesajGonder(tel, elmasOdemeBilgisi(gerekenE));
          bekleyenOnaylar.set(tel, { tip: 'bakiye_yukle_dekont', musteriId: bekleyen.musteriId, musteriAd: bekleyen.musteriAd, elmas: true, gereken: gerekenE, oyunAd: bekleyen.oyunAd });
        } else if (siradakiSayi > 0 && !elmasMi(bekleyen.musteriId, veri2)) {
          await mesajGonder(tel, `💎 Önünde ${siradakiSayi} kişi var. Beklemeden öne geçmek istersen *elmas* yaz.`);
        }
        return;
      }

      if (bekleyen.tip === 'rezerv_tip_bekle') {
        if ((metin === '3' || metin.includes('elmas')) && !elmasMi(bekleyen.musteriId, veri)) {
          bekleyenOnaylar.set(tel, { ...bekleyen, elmasIstiyor: true });
          await mesajGonder(tel, elmasTanitim(bekleyen.musteriId, veri, bekleyen.oyunAd) +
            `\n\n━━━━━━━━━━━━━━━\nÖnce seni sıraya ekleyelim — Elmas olunca otomatik olarak en başa geçersin.\nHangi slot?\n\n*1* - 🔵 Primary\n*2* - 🟣 Secondary\n*iptal* - Vazgeç`);
          return;
        }
        let kiraTip = null;
        if (metin.includes('primary') || metin === '1') kiraTip = 'primary';
        else if (metin.includes('secondary') || metin === '2') kiraTip = 'secondary';
        if (!kiraTip) { await gecersizCevap(tel, `*1* - 🔵 Primary\n*2* - 🟣 Secondary`); return; }

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
          if (bekleyen.elmasIstiyor) {
            const gerekenE = elmasGereken(bekleyen.musteriId, veri2);
            await mesajGonder(tel, elmasOdemeBilgisi(gerekenE));
            bekleyenOnaylar.set(tel, { tip: 'bakiye_yukle_dekont', musteriId: bekleyen.musteriId, musteriAd: bekleyen.musteriAd, elmas: true, gereken: gerekenE, oyunAd: bekleyen.oyunAd });
          }
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
        await banaGonder(`🔔 *Yeni Rezervasyon (Bot)*\n👤 ${bekleyen.musteriAd}\n🎮 ${bekleyen.oyunAd} (${tipLabel})\n📍 Sıra: ${siradakiSayi + 1}${bekleyen.elmasIstiyor ? '\n💎 Elmas olmak istiyor — ödeme bilgisi gönderildi' : ''}`);

        if (bekleyen.elmasIstiyor) {
          const gerekenE = elmasGereken(bekleyen.musteriId, veri2);
          await mesajGonder(tel, elmasOdemeBilgisi(gerekenE));
          bekleyenOnaylar.set(tel, { tip: 'bakiye_yukle_dekont', musteriId: bekleyen.musteriId, musteriAd: bekleyen.musteriAd, elmas: true, gereken: gerekenE, oyunAd: bekleyen.oyunAd });
        } else if (siradakiSayi > 0 && !elmasMi(bekleyen.musteriId, veri2)) {
          await mesajGonder(tel, `💎 Önünde ${siradakiSayi} kişi var. Beklemeden öne geçmek istersen *elmas* yaz.`);
        }
        return;
      }

      if (bekleyen.tip === 'kiralama_tip_bekle') {
        let kiraTip = null;
        if (metin.includes('primary') || metin === '1') kiraTip = 'primary';
        else if (metin.includes('secondary') || metin === '2') kiraTip = 'secondary';
        if (!kiraTip) { await gecersizCevap(tel, `*1* - 🔵 Primary\n*2* - 🟣 Secondary`); return; }
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
        if (isNaN(gun) || gun < 5) { await gecersizCevap(tel, `Minimum 5 gün. Kaç gün?`); return; }
        await kiralamaOzetiGonder(tel, musteri, musteriAd, veri, bekleyen, gun);
        return;
      }

      // Yeni kiralama — dekont bekleniyor
      // Bakiyeden ödeme onayı
      if (bekleyen.tip === 'bakiye_onay') {
        if (EVET.includes(metin)) {
          const mBakiyeOde = veri.musteriler.find(m => m.id === bekleyen.musteriId);
          if (!mBakiyeOde) { await mesajGonder(tel, 'Bir hata oluştu, tekrar deneyin.'); return; }
          const odenecek = bekleyen.kalan ?? bekleyen.ucret; // bekleme ön ödemesi düşülmüş tutar
          if ((mBakiyeOde.bakiye||0) < odenecek) {
            await mesajGonder(tel, `❌ Bakiyeniz yetersiz (${fmt(mBakiyeOde.bakiye||0)}). Havale ile ödeme yapın:\n💳 ${CONFIG.IBAN}\n👤 ${CONFIG.HESAP_ISIM}`);
            bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'yeni_kiralama_dekont' });
            return;
          }
          // Bakiyeden düş
          mBakiyeOde.bakiye = (mBakiyeOde.bakiye||0) - odenecek;
          if (!mBakiyeOde.bakiyeGecmis) mBakiyeOde.bakiyeGecmis = [];
          mBakiyeOde.bakiyeGecmis.push({ tarih: bugun(), tutar: -odenecek, aciklama: `${bekleyen.oyunAd} kiralaması` });
          await setVeri(veri);
          // Direkt onayla — dekont yok
          bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'yeni_kiralama_bekle', odemeTip: 'bakiye' });
          await banaGonder(`💰 *Bakiyeden Ödeme*\n👤 ${bekleyen.musteriAd}\n🎮 ${bekleyen.oyunAd}\n💰 ${fmt(odenecek)} bakiyeden düşüldü${bekleyen.onOdeme > 0 ? ` (+ ${fmt(bekleyen.onOdeme)} bekleme ön ödemesi)` : ''}${bekleyen.teminat > 0 ? `\n🛡️ ${fmt(bekleyen.teminat)} teminat dahil — ${bekleyen.riskMetin}` : ''}\n\n#onayla ${tel.replace(/[^0-9]/g,'').slice(-10)}`);
          await mesajGonder(tel, `✅ *Bakiyenizden ${fmt(odenecek)} düşüldü!*\n\nKalan bakiye: *${fmt(mBakiyeOde.bakiye)}*\n\nKiralamanız işleme alındı, kısa sürede onaylanacak 🙏`);
        } else if (HAYIR.includes(metin)) {
          bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'yeni_kiralama_dekont' });
          await mesajGonder(tel, `Ödemeyi yaptıktan sonra dekontu gönderin 📸\n\n💵 Tutar: *${fmt(bekleyen.kalan ?? bekleyen.ucret)}*\n💳 IBAN: ${CONFIG.IBAN}\n👤 ${CONFIG.HESAP_ISIM}`);
        } else {
          await gecersizCevap(tel, `Bakiyenizden ödensin mi?\n*evet* → Bakiyeden öde\n*hayır* → Havale ile öde`);
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
            `💵 Tutar: *${fmt(bekleyen.ucret)}*` + (bekleyen.onOdeme > 0 ? ` (ön ödeme ${fmt(bekleyen.onOdeme)} düşüldü → havale: *${fmt(bekleyen.kalan)}*)` : '') + `\n` +
            (bekleyen.teminat > 0 ? `🛡️ Teminat: *${fmt(bekleyen.teminat)}* (havale tutarına dahil: *${fmt(bekleyen.kalan)}*)\n⚠️ Geç iade geçmişi: ${bekleyen.riskMetin}\n` : '') + `\n` +
            `Onaylamak için:\n*#onayla ${tel.replace('@c.us','').replace('@lid','')}*`
          );
          return;
        } else if (!menuSecimiMi(metin) && hatirlatmaZamaniMi(tel)) {
          await mesajGonder(tel, `Lütfen ödeme dekontunu *fotoğraf veya PDF* olarak gönderin 📎\n\n❌ Vazgeçmek için *iptal* yazın.`);
          return;
        }
        // menü seçimi / soru → normal akışa devam
      }

      // Uzatma — gün girişi
      if (bekleyen.tip === 'uzatma_gun_bekle') {
        const gun = parseInt(metin);
        if (isNaN(gun) || gun < 1) { await gecersizCevap(tel, `Kaç gün uzatmak istiyorsunuz? (sayı yazın)`); return; }
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
          const uzKira = veri.kiralamalar.find(k => k.id === bekleyen.kiraId);
          const oyun = veri.oyunlar.find(o => o.id === uzKira?.oyunId); // eskiden kira id'si ile oyun aranıyordu → yanlış oyun adı
          await banaGonder(
            `💰 *UZATMA DEKONTU!*\n\n👤 *${musteriAd}*\n🎮 ${oyun?.ad||'?'}\n📅 ${bekleyen.gun} gün\n💵 ${fmt(bekleyen.ucret)}\n\n` +
            `Onaylamak için:\n*#onayla ${tel.replace('@c.us','').replace('@lid','')}*`
          );
          return;
        } else if (!menuSecimiMi(metin) && hatirlatmaZamaniMi(tel)) {
          await mesajGonder(tel, `Lütfen dekontu *fotoğraf veya PDF* olarak gönderin 📎\n\n❌ Vazgeçmek için *iptal* yazın.`);
          return;
        }
      }

      // İade — onay bekleniyor
      // Tavsiye seçimi — iade sonrası
      if (bekleyen.tip === 'tavsiye_secim') {
        const oneriler = bekleyen.oneriler || [];
        const sayi = parseInt(metin);
        let secilen = (!isNaN(sayi) && String(sayi) === metin && sayi >= 1 && sayi <= oneriler.length) ? oneriler[sayi - 1] : null;
        if (!secilen && metin.length > 2) {
          // Oyun adıyla arama (eskiden tanımsız değişkenler yüzünden burada hata oluşup bot hiç cevap vermiyordu)
          const bulunanlar = veri.oyunlar.filter(o => !o.deaktif && (!o.cikis || o.cikis <= bugun())).filter(o =>
            sadeKomut(o.ad).includes(metin) ||
            metin.split(' ').some(k => k.length > 2 && sadeKomut(o.ad).includes(k))
          );
          if (bulunanlar.length === 1) {
            secilen = bulunanlar[0];
          } else if (bulunanlar.length > 1) {
            const liste5 = bulunanlar.slice(0, 5);
            await mesajGonder(tel, `🔍 Şunları mı demek istediniz?\n\n${liste5.map((o,i)=>`*${i+1}* ${o.ad}`).join('\n')}\n\nNumarasını yazın.`);
            bekleyenOnaylar.set(tel, { ...bekleyen, oneriler: liste5 });
            return;
          }
        }
        if (!secilen) {
          // Önerilerle ilgisiz bir şey yazdı → durumu bırak, normal akış (menü/SSS) cevaplasın
          bekleyenOnaylar.delete(tel);
        } else {
          const priDolu = doluMu(secilen, 'primary', veri);
          const secDolu = doluMu(secilen, 'secondary', veri);
          if (priDolu && secDolu) {
            await mesajGonder(tel, `⏳ *${secilen.ad}* şu an kirada.\n\nSıraya girmek ister misiniz? Slot açılınca size haber verilir 🔔\n\n*1* - 🔵 Primary sıraya gir\n*2* - 🟣 Secondary sıraya gir${elmasSecenek(musteri.id, veri)}\n*iptal* - Vazgeç`);
            bekleyenOnaylar.set(tel, { tip: 'rezerv_tip_bekle', musteriId: musteri.id, musteriAd, oyunId: secilen.id, oyunAd: secilen.ad });
            return;
          }
          const pri = gunlukFiyat(secilen, 'primary');
          const sec = gunlukFiyat(secilen, 'secondary');
          await mesajGonder(tel,
            `🎮 *${secilen.ad}* (${secilen.platform})\n\nHangi tip kiralamak istiyorsunuz?\n\n` +
            (priDolu ? '' : `*1* - 🔵 Primary (${fmt(pri)}/gün)\n`) +
            (secDolu ? '' : `*2* - 🟣 Secondary (${fmt(sec)}/gün)`)
          );
          bekleyenOnaylar.set(tel, { tip: 'kiralama_tip_bekle', musteriId: musteri.id, musteriAd, oyunId: secilen.id, oyunAd: secilen.ad, priDolu, secDolu });
          return;
        }
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
            return `*${i+1}* ${musait?'✅':'⏳'} *${o.ad}* (${o.platform})${kampEtiket(o)}\n   🔵 ${fmt(pri)}/gün  🟣 ${fmt(sec)}/gün`;
          }).join('\n\n');
          await mesajGonder(tel, `🎮 *Oyun Listesi (A-Z)*\n\n${kampanyaBaslik()}${liste}\n\n✅ Müsait  ⏳ Kirada`);
          bekleyenOnaylar.set(tel, { ...bekleyen, oyunIds: tumO.map(o=>o.id) });
          return;
        }
        // Oyun adıyla arama
        if (metin.length > 1) {
          const aramaMetin = metin;
          const tumO = veri.oyunlar.filter(o => !o.deaktif);
          const bulunanlar = tumO.filter(o =>
            sadeKomut(o.ad).includes(aramaMetin) ||
            aramaMetin.split(' ').some(k => k.length > 2 && sadeKomut(o.ad).includes(k))
          );
          if (bulunanlar.length === 1) {
            const o = bulunanlar[0];
            const kirada = veri.kiralamalar.filter(k => k.oyunId === o.id && k.durum === 'aktif').length;
            const musait = ((o.kopyalar?.length||0)+1) - kirada > 0;
            const pri = gunlukFiyat(o, 'primary');
            const sec = gunlukFiyat(o, 'secondary');
            await mesajGonder(tel,
              `🎮 *${o.ad}* (${o.platform})\n\n` +
              `${musait ? '✅ Müsait' : '⏳ Şu an kirada'}${kampEtiket(o) ? ` · 🏷️ *%${oyunKampanyasi(o).oran} kampanya*` : ''}\n` +
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
          await gecersizCevap(tel, `Lütfen listeden bir numara yazın (1-${kiralar.length})`);
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
          await gecersizCevap(tel, `Lütfen listeden bir numara yazın (1-${kiralar.length})`);
          return;
        }
        const secilenKiraId = kiralar[sayi - 1];
        const secilenKira = veri.kiralamalar.find(k => k.id === secilenKiraId);
        const o = veri.oyunlar.find(x => x.id === secilenKira?.oyunId);
        await mesajGonder(tel, `📦 *${o?.ad}* oyununu iade etmek istiyorsunuz.\n\n*evet* yazarak onaylayın.`);
        bekleyenOnaylar.set(tel, { tip: 'iade_onay', kiraId: secilenKiraId, musteriId: musteri?.id });
        return;
      }

      // Bildirim sonrası seçim (bugün/yarın biten)
      if (bekleyen.tip === 'bildirim_secim') {
        const kiraId = bekleyen.kiraId;
        const gf = bekleyen.gunluk;
        const bKira = veri.kiralamalar.find(k => k.id === kiraId);
        if (!bKira || bKira.durum !== 'aktif') {
          // Kiralama bu arada siteden iade/silindi → eski bildirim durumunu bırak, normal akış
          bekleyenOnaylar.delete(tel);
        } else if (metin === '3' || metin.includes('iade')) {
          // İade
          const iadeKira = veri.kiralamalar.find(k => k.id === kiraId);
          const oyunIade = iadeKira ? veri.oyunlar.find(o => o.id === iadeKira.oyunId) : null;
          bekleyenOnaylar.set(tel, { tip: 'iade_onay', kiraId, musteriId: musteri?.id });
          await mesajGonder(tel,
            `📦 *İade Onayı*\n\n` +
            `*${oyunIade?.ad || 'Oyun'}* için iade işlemini onaylıyor musunuz?\n\n` +
            `*evet* yazarak onaylayın.`
          );
          return;
        } else if (metin === '2' || metin.includes('uzat')) {
          // Uzatma — sıra varsa 1 uzatma sınırı (ana menüdeki kuralla aynı)
          const oB = veri.oyunlar.find(o => o.id === bKira.oyunId);
          const siradaVarB = (veri.rezervasyonlar||[]).some(r => r.oyunId === bKira.oyunId && r.tip === bKira.tip && r.durum === 'bekliyor');
          if (siradaVarB && (bKira.uzatmaSayisi || (bKira.uzatmalar||[]).length) >= 1) {
            bekleyenOnaylar.delete(tel);
            await mesajGonder(tel, `⚠️ *Uzatma Hakkınız Doldu*\n\n*${oB?.ad||'Oyun'}* için sıra mevcut olduğundan yalnızca 1 kez uzatma yapılabilir.\n\nİade için *3* yazabilirsiniz 🙏`);
            return;
          }
          bekleyenOnaylar.set(tel, { tip: 'uzatma_gun_bekle', kiraId, musteriId: bKira.musteriId, gunluk: gf || gunlukFiyat(oB || {}, bKira.tip) });
          await mesajGonder(tel, `🔄 *Süre Uzatma*\n\n🎮 *${oB?.ad||''}*\n📅 Bitiş: ${fmtTarih(bKira.bit)}\n💰 Günlük: ${fmt(gf || gunlukFiyat(oB || {}, bKira.tip))}\n\nKaç gün uzatmak istiyorsunuz?`);
          return;
        } else {
          // 2/3 dışında bir şey yazdı → aynı uyarıyı tekrar etmek yerine normal akışa bırak
          bekleyenOnaylar.delete(tel);
        }
      }

      // ⭐ İade sonrası puan
      if (bekleyen.tip === 'puan_bekle') {
        const p = puanCoz(metin, metinOrijinal);
        const gec = ['gec', 'gecelim', 'pas', 'sonra', 'hayir', 'istemiyorum'].includes(metin);
        if (p || gec) {
          const vP = await getVeri();
          const kP = vP.kiralamalar.find(x => x.id === bekleyen.kiraId);
          const oP = vP.oyunlar.find(o => o.id === bekleyen.oyunId);
          if (p && kP) { kP.puan = p; kP.puanTarih = bugun(); await setVeri(vP); }
          if (p && p <= 2) {
            bekleyenOnaylar.set(tel, { ...bekleyen, tip: 'puan_yorum_bekle', puan: p });
            await mesajGonder(tel, `Üzgünüz 🙏 Neyi beğenmediğini kısaca yazar mısın? Bir sonraki seçimini ona göre öneririz.\n\n_Geçmek için *geç* yaz_`);
            await banaGonder(`⭐ *Düşük puan: ${p}/5*\n👤 ${bekleyen.musteriAd || musteriAd}\n🎮 ${bekleyen.oyunAd}\n(Yorum bekleniyor)`);
            return;
          }
          bekleyenOnaylar.delete(tel);
          await mesajGonder(tel, p ? `${'⭐'.repeat(p)} Teşekkürler! Puanın kaydedildi 🙏` : `Tamam 👍`);
          if (kP) await iadeSonrasiTavsiye(tel, musteri, musteriAd, vP, kP, oP, p);
          return;
        }
        // Başka bir şey yazdı → soruyu bırak, mesaj normal akışta işlensin
        bekleyenOnaylar.delete(tel);
      }
      if (bekleyen.tip === 'puan_yorum_bekle') {
        bekleyenOnaylar.delete(tel);
        const menuMu = /^[1-9]$/.test(metin) || ['merhaba', 'selam', 'menu', 'ana menu'].includes(metin);
        if (!menuMu) { // menü seçtiyse yorum yazmamış sayılır → mesaj normal akışta işlenir
          const vY = await getVeri();
          const kY = vY.kiralamalar.find(x => x.id === bekleyen.kiraId);
          const oY = vY.oyunlar.find(o => o.id === bekleyen.oyunId);
          const gec = ['gec', 'gecelim', 'pas', 'sonra', 'hayir', 'yok'].includes(metin);
          if (!gec && metinOrijinal && !medya) {
            if (kY) { kY.puanYorum = metinOrijinal.slice(0, 300); await setVeri(vY); }
            await banaGonder(`💬 *Puan yorumu* (${bekleyen.puan}/5)\n👤 ${bekleyen.musteriAd || musteriAd}\n🎮 ${bekleyen.oyunAd}\n"${metinOrijinal.slice(0, 300)}"`);
            await mesajGonder(tel, `Teşekkürler, iletildi 🙏`);
          } else {
            await mesajGonder(tel, `Tamam 👍`);
          }
          if (kY) await iadeSonrasiTavsiye(tel, musteri, musteriAd, vY, kY, oY, bekleyen.puan);
          return;
        }
      }

      // Primary iade sonrası: "Çevrimdışı Oynama'yı kapattınız mı?"
      if (bekleyen.tip === 'iade_cevrimdisi_bekle') {
        const evetMi = EVET.includes(metin) || ['biraktim', 'kapattim', 'yaptim', 'tamamdir', 'tamamladim', 'evet biraktim', 'evet kapattim'].includes(metin);
        if (evetMi) {
          bekleyenOnaylar.delete(tel);
          const vC = await getVeri();
          const kC = vC.kiralamalar.find(x => x.id === bekleyen.kiraId);
          if (kC) {
            if (!kC.kapanis) kC.kapanis = { gerekli: true, tarih: bugun(), adimlar: {}, tamam: false, kaynak: 'bot' };
            kC.kapanis.musteriCevrimdisi = true;
            kC.kapanis.musteriCevrimdisiTarih = bugun();
            const adim = cevrimdisiAdimi(vC);
            if (adim) kC.kapanis.adimlar = { ...(kC.kapanis.adimlar || {}), [adim]: true };
            await setVeri(vC);
          }
          await mesajGonder(tel, `✅ Teşekkürler! Hesabı artık konsolunuzdan silebilirsiniz 🙏`);
          await banaGonder(`✅ *Çevrimdışı Oynama kapatıldı*\n👤 ${bekleyen.musteriAd || musteriAd}\n🎮 ${bekleyen.oyunAd}${kC ? `\n🔑 Hesap: *${kiraHesabi(kC, vC)}*` : ''}\n\nMüşteri onayladı — şifreyi değiştirip tüm cihazlardan çıkış yapabilirsin 🔒`);
          if (kC) await puanSor(tel, musteri, musteriAd, kC, vC.oyunlar.find(o => o.id === kC.oyunId));
          return;
        }
        if (HAYIR.includes(metin) || ['henuz degil', 'henuz', 'yapmadim', 'kapatmadim', 'bilmiyorum', 'nasil', 'nasil yapilir'].includes(metin)) {
          const deneme = (bekleyen.deneme || 0) + 1;
          bekleyenOnaylar.set(tel, { ...bekleyen, deneme });
          await mesajGonder(tel, CEVRIMDISI_ADIM + `\n\nTamamlayınca *evet* yazmanız yeterli 🙏`);
          if (deneme === 1) await banaGonder(`⚠️ *Çevrimdışı Oynama henüz kapatılmadı*\n👤 ${bekleyen.musteriAd || musteriAd}\n🎮 ${bekleyen.oyunAd}\n\nMüşteri "henüz değil" dedi, adımlar tekrar gönderildi. Onaylayana kadar şifreyi değiştirme.`);
          return;
        }
        // Başka bir şey yazdı → soruyu bırak, mesaj normal akışta işlensin (ör. 7 → yetkili)
        bekleyenOnaylar.delete(tel);
      }

      if (bekleyen.tip === 'iade_onay') {
        if (EVET.includes(metin)) {
          // Taze veri çek — stale veri sorunu önle
          const veriIade = await getVeri();
          // musteriId bekleyen'dan veya musteri'den al
          const iadeMusteriId = bekleyen.musteriId || musteri?.id;
          const aktifKiralar = veriIade.kiralamalar.filter(k => k.musteriId === iadeMusteriId && k.durum === 'aktif');
          const iadeKira = bekleyen.kiraId
            ? veriIade.kiralamalar.find(k => k.id == bekleyen.kiraId)
            : aktifKiralar[0];
          if (iadeKira) {
            iadeKira.durum = 'teslim';
            iadeKira.teslimTarih = bugun();
            // Hesap kapanış kontrol listesi — sitede Dashboard'da "Kapatılmamış hesaplar" olarak görünür
            iadeKira.kapanis = { gerekli: true, tarih: bugun(), adimlar: {}, tamam: false, kaynak: 'bot' };
            // Oyun durumunu güncelle
            const oyunIade = veriIade.oyunlar.find(o => o.id === iadeKira.oyunId);
            // Teminat: geç kaldıysa gecikme ücreti düşülür, kalanı bakiyeye
            let tmnSonuc = null;
            if (iadeKira.teminat > 0 && iadeKira.teminatDurum === 'tutuluyor') {
              const gecG = Math.max(0, gunFarki(iadeKira.bit, bugun()));
              const ucretG = gecG > 0 ? Math.round(listeFiyat(oyunIade, iadeKira.tip) * gecG) : 0;
              const kesinti = Math.min(iadeKira.teminat, ucretG);
              const iadeT = iadeKira.teminat - kesinti;
              if (kesinti > 0) {
                iadeKira.gecikmeUcreti = (iadeKira.gecikmeUcreti || 0) + kesinti;
                iadeKira.ucret = (iadeKira.ucret || 0) + kesinti;
                iadeKira.net = (iadeKira.net || 0) + kesinti;
              }
              const mT = veriIade.musteriler.find(m => m.id === iadeKira.musteriId);
              if (iadeT > 0 && mT) {
                mT.bakiye = (mT.bakiye || 0) + iadeT;
                if (!mT.bakiyeGecmis) mT.bakiyeGecmis = [];
                mT.bakiyeGecmis.push({ tarih: bugun(), tutar: iadeT, aciklama: `Teminat iadesi — ${oyunIade?.ad || 'Oyun'}`, tip: 'teminat' });
              }
              iadeKira.teminatDurum = kesinti > 0 ? 'kesildi' : 'iade'; iadeKira.teminatIade = iadeT; iadeKira.teminatKesinti = kesinti;
              tmnSonuc = { gecG, kesinti, iadeT, eksik: Math.max(0, ucretG - kesinti), bakiye: mT?.bakiye || 0 };
            }
            if (oyunIade) {
              const halaKirada = veriIade.kiralamalar.some(k => k.id !== iadeKira.id && k.oyunId === iadeKira.oyunId && k.durum === 'aktif');
              if (!halaKirada) oyunIade.durum = 'mevcut';
            }
            // Erken iade ödülü kontrolü
            const bugunIade = bugun();
            const bitTarih = iadeKira.bit;
            const oyunCikisIade = veriIade.oyunlar.find(o => o.id === iadeKira.oyunId)?.cikis;
            const birAyOnceIade = new Date(); birAyOnceIade.setMonth(birAyOnceIade.getMonth() - 1);
            const yeniOyunIade = oyunCikisIade && new Date(oyunCikisIade) > birAyOnceIade;
            const siradaVarIade = (veriIade.rezervasyonlar||[]).some(r => r.oyunId === iadeKira.oyunId && r.tip === iadeKira.tip && r.durum === 'bekliyor');
            const erkenIade = bugunIade < bitTarih;

            let erkenIadeOdul = 0;
            if (erkenIade && yeniOyunIade && siradaVarIade) {
              // Kalan gün sayısı
              const kalanGun = Math.round((new Date(bitTarih) - new Date(bugunIade)) / 86400000);
              const gunlukUcret = iadeKira.net / (iadeKira.uzatmaSayisi ? iadeKira.gun || 1 : (Math.round((new Date(bitTarih) - new Date(iadeKira.bas)) / 86400000) || 1));
              erkenIadeOdul = Math.round(kalanGun * gunlukUcret * 0.1);
              if (erkenIadeOdul > 0) {
                // Müşteriye bakiye ekle
                const mIade = veriIade.musteriler.find(m => m.id === iadeMusteriId);
                if (mIade) {
                  mIade.bakiye = (mIade.bakiye || 0) + erkenIadeOdul;
                  if (!mIade.bakiyeGecmis) mIade.bakiyeGecmis = [];
                  mIade.bakiyeGecmis.push({ tarih: bugunIade, tutar: erkenIadeOdul, aciklama: `Erken iade ödülü — ${veriIade.oyunlar.find(o=>o.id===iadeKira.oyunId)?.ad||'Oyun'}` });
                }
              }
            }

            bekleyenOnaylar.delete(tel);
            await setVeri(veriIade);
            const oyun = veriIade.oyunlar.find(o => o.id === iadeKira.oyunId);
            // Tipe göre hesap silme hatırlatması
            let iadeMesaj = `✅ İade bildiriminiz alındı! *${oyun?.ad}* için teşekkürler 🎮\n\n`;
            if (tmnSonuc) {
              iadeMesaj += tmnSonuc.kesinti > 0
                ? `🛡️ ${tmnSonuc.gecG} gün gecikme ücreti (*${fmt(tmnSonuc.kesinti)}*) teminattan düşüldü${tmnSonuc.iadeT > 0 ? `, kalan *${fmt(tmnSonuc.iadeT)}* bakiyene eklendi` : ''}.\n\n`
                : `🛡️ Zamanında iade ettin 👏 *${fmt(tmnSonuc.iadeT)}* teminatın bakiyene eklendi (bakiye: *${fmt(tmnSonuc.bakiye)}*).\n\n`;
            }
            if (erkenIadeOdul > 0) {
              iadeMesaj += `🎁 *Erken İade Ödülü!*\nKalan süreniz için *${fmt(erkenIadeOdul)}* bakiyenize yüklendi 💰\n\n`;
            }
            if (iadeKira.tip === 'primary') {
              iadeMesaj += CEVRIMDISI_ADIM + `\n\n❓ *Çevrimdışı Oynama'yı devre dışı bıraktınız mı?*\n*evet* → Bıraktım\n*hayır* → Henüz değil`;
            } else {
              iadeMesaj += `⚠️ *Önemli Hatırlatma:*\nLütfen hesabı konsolunuzdan silmeyi unutmayın 🙏`;
            }
            await mesajGonder(tel, iadeMesaj);
            await banaGonder(`📦 *İADE BİLDİRİMİ*\n\n👤 ${musteriAd}\n🎮 ${oyun?.ad}\n🎯 ${iadeKira.tip}\n🔑 Hesap: *${kiraHesabi(iadeKira, veriIade)}*${tmnSonuc ? `\n🛡️ Teminat: ${tmnSonuc.kesinti > 0 ? `${fmt(tmnSonuc.kesinti)} gecikmeye kesildi, ` : ''}${fmt(tmnSonuc.iadeT)} bakiyeye geçti${tmnSonuc.eksik > 0 ? ` · ⚠️ ${fmt(tmnSonuc.eksik)} gecikme ücreti teminatı aştı` : ''}` : ''}\n\n${iadeKira.tip === 'primary' ? '⏳ Müşteriye "Çevrimdışı Oynama\'yı kapattınız mı?" diye soruldu — cevabı sana iletilecek. Onaylamadan şifreyi değiştirme.\n\n' : ''}🔒 Şifreyi değiştirip tüm cihazlardan çıkış yapmayı unutma — sitede kontrol listesi Dashboard'da seni bekliyor.`);

            if (iadeKira.tip === 'primary') {
              // Primary: müşteriye "Çevrimdışı Oynama'yı kapattınız mı?" sorusu soruldu — cevap bekleniyor
              bekleyenOnaylar.set(tel, { tip: 'iade_cevrimdisi_bekle', kiraId: iadeKira.id, musteriId: iadeMusteriId, musteriAd, oyunAd: oyun?.ad || '', deneme: 0 });
            } else {
              await puanSor(tel, musteri, musteriAd, iadeKira, oyun);
            }
            return; // aşağıdaki silme, yeni kurulan soru / öneri durumunu silmesin
          }
        } else if (HAYIR.includes(metin) || metin === 'iptal') {
          bekleyenOnaylar.delete(tel);
          await mesajGonder(tel,
            `İptal edildi 😊\n\n👋 *${musteriAd}*, başka bir şey yapabilir miyim?\n\n` +
            `*1* - 📋 Durum & Kurallar\n*2* - 🔄 Süre uzat\n*3* - 📦 İade\n*4* - 🎮 Oyun listesi\n*5* - 🛒 Yeni kiralama\n*6* - 🏅 Üyelik seviyem\n*7* - 👤 Yetkili ile görüş\n*8* - 🗓 Çıkacak Oyunlar / Ön Rezervasyon\n*9* - 💰 Bakiye Yükle`
          );
          return;
        } else {
          await gecersizCevap(tel, `İade için *evet*, iptal için *hayır* yazın.`);
          return;
        }
        bekleyenOnaylar.delete(tel);
        return;
      }
    }

    // ── ANA MENÜ ──
    if (['merhaba','selam','menu','hi','basla','baslat','hey','ana menu','menuye don'].includes(metin)) {
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
        const link = await durumLinki(musteri);
        if (link) txt += `\n\n🔗 *Tüm detaylar (kalan süre, sıra, üyelik):*\n${link}`;
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
          `Yeni kiralama için *5* yazın 🎮` +
          await (async () => { const l = musteri ? await durumLinki(musteri) : null; return l ? `\n\n🔗 Sıra ve üyelik durumunuz: ${l}` : ''; })()
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
        // Sıra ve uzatma limiti kontrolü
        const siradaVarUzat = (veri.rezervasyonlar||[]).some(r => r.oyunId === aktifKira.oyunId && r.tip === aktifKira.tip && r.durum === 'bekliyor');
        const uzatmaSayisi = aktifKira.uzatmaSayisi || 0;
        if (siradaVarUzat && uzatmaSayisi >= 1) {
          await mesajGonder(tel, `⚠️ *Uzatma Hakkınız Doldu*\n\n*${o?.ad}* için sıra mevcut olduğundan yalnızca 1 kez uzatma yapabilirsiniz.\n\nSüre dolunca iade etmeniz gerekmektedir 🙏`);
          return;
        }
        let uzatMesaj = `🔄 *Süre Uzatma*\n\n🎮 *${o?.ad}*\n📅 Bitiş: ${aktifKira.bit}\n💰 Günlük: ${fmt(gf)}`;
        if (siradaVarUzat) uzatMesaj += `\n\n⚠️ Bu oyun için sıra var — yalnızca *1 kez* uzatabilirsiniz.`;
        uzatMesaj += `\n\nKaç gün uzatmak istiyorsunuz?`;
        await mesajGonder(tel, uzatMesaj);
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
        bekleyenOnaylar.set(tel, { tip: 'iade_onay', kiraId: aktifKira.id, musteriId: musteri?.id });
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
    if (metin === '4' || metin === 'oyunlar' || metin.includes('musait') || metin.includes('musait') || metin.includes('liste')) {
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
          return `*${i+1}* ${musait?'✅':'⏳'} *${o.ad}* (${o.platform})${kampEtiket(o)}\n   🔵 ${fmt(pri)}/gün  🟣 ${fmt(sec)}/gün`;
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
    if (metin === '6' || metin.includes('tier') || metin.includes('seviyem') || metin.includes('uyeligim') || metin.includes('uyelik') || metin.includes('seviye') || metin.includes('kac puan') || metin.includes('indirimim') || metin.includes('puanim')) {
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
      await kiralamaListesiGonder(tel, musteri, musteriAd, veri);
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
    if (metin === '8' || metin.includes('cikacak') || metin.includes('on rezerv') || metin.includes('on rezerv') || metin.includes('cikacak oyun')) {
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
    // 💎 Elmas üyelik bilgisi + ödeme
    if (metin === 'elmas' || metin.startsWith('elmas ') || metin.includes('elmas ol') || metin.includes('elmas uye')) {
      if (elmasMi(musteri.id, veri)) {
        await mesajGonder(tel, `💎 Zaten *Elmas* üyesin! Bekleme listelerinde önceliklisin, kiralamalarda *%${elmasEsik(veri).indirim} indirim* alıyorsun 🎉`);
        return;
      }
      const gerekenE = elmasGereken(musteri.id, veri);
      await mesajGonder(tel, elmasTanitim(musteri.id, veri) + `\n\n` + elmasOdemeBilgisi(gerekenE) + `\n\n❌ Vazgeçmek için *iptal* yazın.`);
      bekleyenOnaylar.set(tel, { tip: 'bakiye_yukle_dekont', musteriId: musteri.id, musteriAd, elmas: true, gereken: gerekenE });
      return;
    }

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
    // Not: "hocam", "sizi", "insan" gibi günlük kelimeler kaldırıldı — "hocam merhaba" yazan müşteri botu 8 saat susturuyordu
    if (metin === '7' || metin.includes('yetkili') || metin.includes('insanla gorus') || metin.includes('canli destek') ||
        metin.includes('sizinle gorus') || metin.includes('gorusmek istiyorum') || metin.includes('konusmak istiyorum') ||
        metin.includes('beni arar') || metin.includes('arayabilir misiniz') || metin.includes('isletme sahibi')) {
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
    if (metin === 'iptal' || metin === '#iptal' || metin === 'vazgec' || metin === 'vazgec') {
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
}

// ── ZAMANLANMIŞ ──
// Bildirim "gönderildi" kayıtları Firestore'da tutulur: eskiden hafızadaydı, Railway yeniden başlayınca
// aynı gün ikinci kez bildirim gidebiliyor ya da (1 saatlik bekleme yüzünden) o günün bildirimi hiç gitmiyordu
async function bildirimGittiMi(key) {
  if (bildirimGonderildi.get(key)) return true;
  try { const d = await db.collection('botState').doc(key).get(); if (d.exists) { bildirimGonderildi.set(key, true); return true; } } catch (e) {}
  return false;
}
async function bildirimGittiIsaretle(key) {
  bildirimGonderildi.set(key, true);
  try { await db.collection('botState').doc(key).set({ tarih: bugun(), zaman: new Date().toISOString() }); } catch (e) {}
}

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
    if (await bildirimGittiMi(yarinKey)) continue;
    const musteriAdi = ((m.ad||'') + ' ' + (m.soyad||'')).trim() || 'Değerli Müşteri';
    await mesajGonder(hedef, `🔔 *Hatırlatıcı*\n\nMerhaba *${musteriAdi}*!\n*${o?.ad}* oyununuz *yarın* bitiyor.\n\n📦 *İade etmek için* → *3* yazın\n🔄 *Uzatmak için* → *2* yazın 🎮`);
    await bildirimGittiIsaretle(yarinKey);
    bekleyenSet(m, { tip: 'bildirim_secim', kiraId: parseInt(k.id), musteriId: m.id, gunluk: gf });
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
    if (await bildirimGittiMi(bugunKey)) continue;
    const musteriAdiBugun = ((m.ad||'') + ' ' + (m.soyad||'')).trim() || 'Değerli Müşteri';
    await mesajGonder(hedef,
      `⏰ *Süre Bugün Bitiyor!*\n\n` +
      `Merhaba *${musteriAdiBugun}*! *${o?.ad}* oyununuzun kiralama süresi *bugün* sona eriyor.\n\n` +
      `Güven puanınızda sorun yaşamamak için lütfen:\n\n` +
      `📦 *İade etmek için* → *3* yazın\n` +
      `🔄 *Uzatmak için* → *2* yazın\n\n` +
      `Teşekkürler! 🎮`
    );
    await bildirimGittiIsaretle(bugunKey);
    bekleyenSet(m, { tip: 'bildirim_secim', kiraId: parseInt(k.id), musteriId: m.id, gunluk: gf });
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
      `⚠️ *Gecikmiş İade*\n\nMerhaba *${musteriAdiG}*!\n\n*${o?.ad}* oyununuzun iade süresi *${gecGun} gün* geçti.\n💰 Gecikme ücreti: *${fmt(listeFiyat(o, k.tip)*gecGun)}*\n\n📦 İade için → *3* yazın\n🔄 Uzatmak için → *2* yazın\n\nLütfen en kısa sürede işlem yapın 🙏`
    );
    bekleyenSet(m, { tip: 'bildirim_secim', kiraId: parseInt(k.id), musteriId: m.id, gunluk: gf });
    gecikmeOzet.push(`• ${musteriAdiG} — ${o?.ad} (${gecGun}g, +${fmt(listeFiyat(o, k.tip)*gecGun)})`);
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
    const maxSlot = slotKapasite(o, tip); // kopyalar da dahil (eskiden sadece ana hesap sayılıyordu)
    if (aktifSayisi >= maxSlot) continue; // slot dolu, geç

    // Slot müsait — sıradaki ilk kişiyi bul
    // Elmas üyeler sıranın başına geçer
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
    // Kaç slot boşsa sıradaki o kadar kişiye haber ver (eskiden sadece ilk kişiye gidiyordu —
    // ör. çıkış günü 3 slot boşken günde 1 kişi bilgilendiriliyordu)
    const bosSlotSayisi = maxSlot - aktifSayisi;
    for (const ilk of siralar.slice(0, bosSlotSayisi)) {
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

    const oncelikMesaji = oncelikli ? `\n\n💎 *Elmas Ayrıcalığı:* Sıra önceliğiniz sayesinde ilk bildirim size gönderildi!` : '';
    const gf = gunlukFiyat(o, tip);
    const onOdemeBilgi = ilk.onOdeme > 0
      ? (ilk.onOdemeOnaylandi ? `\n\n💳 Daha önce ödediğiniz *${fmt(ilk.onOdeme)}* kiralama tutarından düşülecek.` : `\n\n💳 ${fmt(ilk.onOdeme)} ön ödemeniz onaylanınca tutardan düşülecek.`)
      : '';
    // Eskiden "ödemeyi yapıp dekontu gönder" deniyordu ama tutar belli değildi ve bot dekontu beklemiyordu.
    // Artık doğrudan gün sorulur; cevapla birlikte özet + kalan tutar + IBAN gönderilir.
    await mesajGonder(hedef,
      `🎉 *Sıran Geldi!*\n\nMerhaba ${musteriAd}!\n\n*${o.ad}* için beklediğin slot artık müsait! ${tipLabel}${oncelikMesaji}\n💰 Günlük: ${fmt(gf)}${onOdemeBilgi}\n\n*Kaç gün kiralamak istersiniz?* (Min. 5 gün)\n\n_Vazgeçtiyseniz *iptal* yazabilirsiniz._`
    );
    bekleyenSet(m, { tip: 'kiralama_gun_bekle', musteriId: m.id, musteriAd: ((m.ad||'') + ' ' + (m.soyad||'')).trim() || musteriAd, oyunId: o.id, oyunAd: o.ad, kiraTip: tip, gunluk: gf, rezervId: ilk.id });

    await banaGonder(`🔔 *Rezerv Bildirimi Gönderildi*\n• ${musteriAd} → ${o.ad} (${tipLabel})${oncelikli ? '\n💎 Elmas öncelikli bildirim!' : ''}`);

    // Bildirim tarihini rezervasyona kaydet
    ilk.sonBildirimTarih = now;
    await setVeri(veri);
    await new Promise(r => setTimeout(r, 1000));
    }
  }
}


// ── ZAMANLAYICI (İstanbul saati) ──
// Eskiden sunucu saati (UTC) kullanılıyordu: "15" aslında İstanbul'da 18:00'di, gecikme uyarıları gece 03:00'te
// gidebiliyordu. Restart sonrası 1 saat bekleme yüzünden o günün bildirimleri bazen hiç gitmiyordu.
// Artık her 15 dakikada kontrol edilir; "gönderildi" bilgisi Firestore'da tutulduğu için tekrar gitmez.
const SAAT = {
  bitisBildirimi: 18,       // bugün/yarın biten hatırlatmaları (eski davranışla aynı: 18:00)
  gecikmeBaslangic: 11,     // gecikme uyarıları 11:00'den sonra, günde 1 kez
  rezervBaslangic: 9, rezervBitis: 21,
};
let _zamanlayiciCalisiyor = false;
// ── ⭐ İADE SONRASI PUAN ──
function oyunPuanOrt(veri, oyunId) {
  const p = (veri.kiralamalar || []).filter(k => k.oyunId === oyunId && k.puan >= 1 && k.puan <= 5);
  return p.length ? { ort: p.reduce((t, k) => t + k.puan, 0) / p.length, n: p.length } : null;
}
// Öneri skoru çarpanı: müşteri iade ettiği oyunu beğendiyse aynı tür öne çıkar, beğenmediyse geri düşer;
// diğer müşterilerin puanı yüksek oyunlar biraz öne çıkar
function puanCarpani(veri, aday, iadeOyun, puan) {
  let c = 1;
  const ayniTur = aday.tur && iadeOyun && aday.tur === iadeOyun.tur && aday.tur !== 'Diğer';
  if (ayniTur && puan >= 4) c *= 1.6;
  if (ayniTur && puan && puan <= 2) c *= 0.4;
  const o = oyunPuanOrt(veri, aday.id);
  if (o && o.n >= 3) c *= 0.5 + o.ort / 5;
  return c;
}
// Metinden 1-5 puanı çıkar ("5", "4/5", "5 puan", "⭐⭐⭐⭐")
function puanCoz(metin, metinOrijinal) {
  const yildiz = ((metinOrijinal || '').match(/⭐|★/g) || []).length;
  if (yildiz >= 1 && yildiz <= 5 && !/\d/.test(metinOrijinal)) return yildiz;
  const m = (metin || '').trim();
  if (m.length > 12) return null;
  const r = m.match(/^([1-5])(?:\s*\/?\s*5|\s*puan|\s*yildiz|\s*verdim)?$/); // sadeKomut '/' işaretini boşluğa çevirir: '4/5' → '4 5'
  return r ? parseInt(r[1]) : null;
}
async function puanSor(tel, musteri, musteriAd, kira, oyun, onEk) {
  await new Promise(r => setTimeout(r, 1500));
  await mesajGonder(tel, (onEk || '') +
    `⭐ *${oyun?.ad || 'Oyun'}* nasıldı?\n\n1'den 5'e bir puan verir misin?\n\n` +
    `*5* 😍 Çok beğendim\n*4* 🙂 Beğendim\n*3* 😐 İdare eder\n*2* 🙁 Pek değil\n*1* 😞 Hiç beğenmedim\n\n_Geçmek için *geç* yaz_`);
  bekleyenOnaylar.set(tel, { tip: 'puan_bekle', kiraId: kira.id, musteriId: musteri.id, musteriAd, oyunId: kira.oyunId, oyunAd: oyun?.ad || '' });
}

// İade sonrası "Sana özel öneriler" mesajı (müşterinin geçmişine göre)
async function iadeSonrasiTavsiye(tel, musteri, musteriAd, veriIade, iadeKira, oyun, puan) {
  const veri = veriIade;
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
                skor: ((colSkor.get(o.id)||0)*3 + (popSkor.has(o.id)?popSkor.get(o.id).size:0)) * puanCarpani(veri, o, oyun, puan)
              }))
              .filter(s => s.skor > 0)
              .sort((a, b) => b.skor - a.skor)
              .slice(0, 3)
              .map(s => s.oyun);

              // Skor yoksa popülerliğe göre fallback
              const oneriler = musaitOneriler.length > 0 ? musaitOneriler :
                veri.oyunlar.filter(o => !o.deaktif && (!o.cikis||o.cikis<=bugun()) && o.id !== iadeKira.oyunId && !kiraliOyunIds.has(o.id))
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
                  tavsiyeMesaj += `*${i+1}* - 🎮 ${o.ad} (${o.platform})${kampEtiket(o)}\n   ${durum} | 🔵${fmt(pri)} 🟣${fmt(sec)}/gün\n\n`;
                });
                tavsiyeMesaj += `Hemen kiralamak için numara yaz 👆\nVeya *menü* yaz 😊`;
                await mesajGonder(tel, tavsiyeMesaj);
                bekleyenOnaylar.set(tel, { tip: 'tavsiye_secim', musteriId: musteri.id, musteriAd, oneriler });
              }
  } catch(e) { console.error('Tavsiye hatası:', e.message); }
}

// Primary iadede müşteriye gönderilen çevrimdışı oynama talimatı
const CEVRIMDISI_ADIM = `⚠️ *Önemli:* Lütfen konsolunuzdan şu adımı uygulayın:\n\n*Ayarlar → Kullanıcılar ve Hesaplar → Diğer → Çevrimdışı Oynama → Devre Dışı Bırak*\n\nBu adımı tamamladıktan sonra hesabı konsolunuzdan silebilirsiniz 🙏`;
const KAPANIS_VARSAYILAN_PRI = ['Müşteri konsolda "Çevrimdışı Oynama"yı kapattı', 'Hesap şifresi değiştirildi', 'Tüm cihazlardan çıkış yapıldı'];
// Sitedeki kontrol listesinde "çevrimdışı" geçen adım (müşteri onaylayınca otomatik işaretlenir)
function cevrimdisiAdimi(veri) {
  const l = veri && veri.ayarlar && veri.ayarlar.kapanisAdimlari && veri.ayarlar.kapanisAdimlari.primary;
  const adimlar = Array.isArray(l) && l.length ? l : KAPANIS_VARSAYILAN_PRI;
  return adimlar.find(a => sadeKomut(a).includes('cevrimdisi')) || null;
}

// ══════════════════════════════════════════
// ☀️ SABAH ÖZETİ — her sabah işletmeciye tek mesaj (ayar: sitede Ayarlar → Sabah Özeti)
// ══════════════════════════════════════════
function sabahOzetiMetni(veri) {
  const now = bugun(), dun = tarihEkle(now, -1), yarin = yarinStr(), ay = now.slice(0, 7);
  const ks = veri.kiralamalar || [];
  const isim = id => { const m = (veri.musteriler || []).find(x => x.id === id); return m ? (((m.ad || '') + ' ' + (m.soyad || '')).trim() || m.tel || '?') : '?'; };
  const oyunAd = id => (veri.oyunlar || []).find(x => x.id === id)?.ad || '?';
  const uzToplam = k => (k.uzatmalar || []).reduce((t, u) => t + (u.ucret || 0), 0);
  // Dün: yeni kiralamalar (uzatmalar hariç) + dün yapılan uzatmalar + ek gelirler
  const dunYeni = ks.filter(k => k.bas === dun);
  const dunUzatma = ks.flatMap(k => (k.uzatmalar || []).filter(u => u.tarih === dun));
  const dunEk = (veri.ekGelirler || []).filter(g => g.tarih === dun);
  const dunGelir = dunYeni.reduce((t, k) => t + (k.net || 0) - uzToplam(k), 0) + dunUzatma.reduce((t, u) => t + (u.ucret || 0), 0) + dunEk.reduce((t, g) => t + (g.tutar || 0), 0);
  const ayGelir = ks.filter(k => (k.bas || '').startsWith(ay)).reduce((t, k) => t + (k.net || 0), 0) + (veri.ekGelirler || []).filter(g => (g.tarih || '').startsWith(ay)).reduce((t, g) => t + (g.tutar || 0), 0);
  const aktif = ks.filter(k => k.durum === 'aktif');
  const bugunBiten = aktif.filter(k => k.bit === now);
  const yarinBiten = aktif.filter(k => k.bit === yarin);
  const geciken = aktif.filter(k => k.bit < now).sort((a, b) => a.bit.localeCompare(b.bit));
  // Onay bekleyen işlemler (bellekteki bekleyenler — bot yeniden başlarsa sıfırlanır)
  const onaylar = new Map();
  for (const kaynak of [bekleyenOnaylar, onayBekleyenler]) {
    for (const [key, v] of kaynak.entries()) {
      if (!v || !ONAY_TIPLERI.includes(v.tip)) continue;
      if (kaynak === bekleyenOnaylar && !kaynak.get(key)) continue; // süresi dolmuş
      const no = String(key).replace('@c.us', '').replace('@lid', '');
      if (onaylar.has(no)) continue;
      const etiket = v.tip === 'qr_onay_bekle' ? `QR girişi · *#tamam ${no}*` : `${v.tip === 'uzatma_isletmeci_bekle' ? 'Uzatma' : 'Kiralama'} · *#onayla ${no}*`;
      onaylar.set(no, `• ${v.musteriAd || isim(v.musteriId)} — ${v.oyunAd || ''} (${etiket})`);
    }
  }
  const onOdemeOnaysiz = (veri.rezervasyonlar || []).filter(r => r.durum === 'bekliyor' && r.onOdeme > 0 && !r.onOdemeOnaylandi);
  const kapanis = ks.filter(k => k.durum === 'teslim' && k.kapanis && k.kapanis.gerekli && !k.kapanis.tamam);
  const bugunCikan = (veri.oyunlar || []).filter(o => o.cikis === now);
  const kampanyalar = (veri.kampanyalar || []).filter(k => kampanyaAktifMi(k, now));
  const bitenKampanya = (veri.kampanyalar || []).filter(k => !k.iptal && k.bitis === now);

  let t = `☀️ *Günaydın! Sabah Özeti* — ${fmtTarih(now)}\n\n`;
  t += `💰 Dün: *${fmt(dunGelir)}* (${dunYeni.length} yeni kiralama${dunUzatma.length ? `, ${dunUzatma.length} uzatma` : ''})\n`;
  t += `📈 Bu ay: *${fmt(ayGelir)}* · 🎮 Kirada: ${aktif.length}\n`;
  t += `\n⏰ *Bugün biten (${bugunBiten.length})*`;
  t += bugunBiten.length ? '\n' + bugunBiten.slice(0, 10).map(k => `• ${isim(k.musteriId)} — ${oyunAd(k.oyunId)} (${k.tip})`).join('\n') + (bugunBiten.length > 10 ? `\n• ...+${bugunBiten.length - 10}` : '') : ' — yok';
  t += `\n🔔 Yarın biten: ${yarinBiten.length}`;
  if (geciken.length) t += `\n\n⚠️ *Geciken (${geciken.length})*\n` + geciken.slice(0, 8).map(k => `• ${isim(k.musteriId)} — ${oyunAd(k.oyunId)} (${gunFarki(k.bit, now)}g)`).join('\n') + (geciken.length > 8 ? `\n• ...+${geciken.length - 8}` : '');
  if (onaylar.size) t += `\n\n🧾 *Onay bekleyen (${onaylar.size})*\n` + [...onaylar.values()].slice(0, 10).join('\n');
  if (onOdemeOnaysiz.length) t += `\n\n💳 Onaylanmamış bekleme listesi ön ödemesi: *${onOdemeOnaysiz.length}* (sitede Bekleme Listesi'nden onayla)`;
  if (kapanis.length) t += `\n\n🔒 *Kapatılmamış hesap: ${kapanis.length}*\n` + kapanis.slice(0, 6).map(k => `• ${oyunAd(k.oyunId)} — 🔑 ${kiraHesabi(k, veri)} (iade ${fmtTarih(k.teslimTarih)})${k.tip === 'primary' && k.kapanis.kaynak === 'bot' ? (k.kapanis.musteriCevrimdisi ? ' · müşteri çevrimdışını kapattı ✓' : ' · ⚠️ müşteri çevrimdışını kapattığını onaylamadı') : ''}`).join('\n');
  const dunPuan = ks.filter(k => k.puan && k.puanTarih === dun);
  if (dunPuan.length) t += `\n\n⭐ *Dün gelen puanlar (${dunPuan.length})* — ort. ${(dunPuan.reduce((a, k) => a + k.puan, 0) / dunPuan.length).toFixed(1)}\n` + dunPuan.slice(0, 6).map(k => `• ${oyunAd(k.oyunId)}: ${k.puan}/5${k.puanYorum ? ` — "${k.puanYorum.slice(0, 60)}"` : ''}`).join('\n');
  if (bugunCikan.length) t += `\n\n🚀 *Bugün çıkan:* ` + bugunCikan.map(o => `${o.ad} (${(veri.rezervasyonlar || []).filter(r => r.oyunId === o.id && r.durum === 'bekliyor').length} kişi sırada)`).join(', ');
  if (kampanyalar.length) t += `\n\n🏷️ *Aktif kampanya:* ` + kampanyalar.map(k => `${k.ad} %${k.oran} (${fmtTarih(k.bitis)}'e kadar)`).join(', ');
  if (bitenKampanya.length) t += `\n⏳ Bugün son günü: ` + bitenKampanya.map(k => k.ad).join(', ');
  return t;
}
async function sabahOzetiKontrol() {
  const veri = await getVeri(); if (!veri) return;
  const ayar = (veri.ayarlar && veri.ayarlar.sabahOzeti) || {};
  if (ayar.aktif === false) return;
  const saat = Number.isFinite(+ayar.saat) ? +ayar.saat : 10;
  if (trSaat() < saat || trSaat() >= 22) return;
  const key = `sabah_${bugun()}`;
  if (await bildirimGittiMi(key)) return;
  await bildirimGittiIsaretle(key); // önce işaretle — hata olursa da tekrar tekrar göndermesin
  await banaGonder(sabahOzetiMetni(veri));
}

async function zamanlayici() {
  if (_zamanlayiciCalisiyor) return;
  _zamanlayiciCalisiyor = true;
  try {
    const saat = trSaat();
    try { await sabahOzetiKontrol(); } catch (e) { console.error('Sabah özeti hatası:', e.message); }
    if (saat >= SAAT.bitisBildirimi && saat < 22) {
      await yarinBitenKontrol();
      await bugunBitenKontrol();
    }
    if (saat >= SAAT.gecikmeBaslangic && saat < 22) await gecikmeKontrol();
    if (saat >= SAAT.rezervBaslangic && saat < SAAT.rezervBitis) await rezervSiraKontrol();
  } catch (e) {
    console.error('Zamanlayıcı hatası:', e.message);
  }
  _zamanlayiciCalisiyor = false;
}
setInterval(zamanlayici, 15 * 60 * 1000);
setTimeout(zamanlayici, 2 * 60 * 1000); // açılıştan 2 dk sonra ilk kontrol

// ══════════════════════════════════════════
// 🤖 SİTEDEN "BOT HATIRLATSIN" — tek veya toplu
// ══════════════════════════════════════════
function hatirlatmaMesaji(k, m, o) {
  const ad = ((m.ad || '') + ' ' + (m.soyad || '')).trim() || 'Değerli Müşterimiz';
  const now = bugun();
  const gf = gunlukFiyat(o || {}, k.tip);
  const secenek = `📦 *İade etmek için* → *3* yazın\n🔄 *Uzatmak için* → *2* yazın`;
  if (k.bit < now) {
    const gec = gunFarki(k.bit, now);
    return { tur: 'gecikme', metin: `⚠️ *Gecikmiş İade*\n\nMerhaba *${ad}*!\n\n*${o?.ad || 'Oyun'}* oyununuzun iade süresi *${gec} gün* geçti.\n💰 Gecikme ücreti: *${fmt(listeFiyat(o, k.tip) * gec)}*\n\n${secenek}\n\nLütfen en kısa sürede işlem yapın 🙏` };
  }
  if (k.bit === now) return { tur: 'bugun', metin: `⏰ *Süre Bugün Bitiyor!*\n\nMerhaba *${ad}*! *${o?.ad || 'Oyun'}* oyununuzun kiralama süresi *bugün* sona eriyor.\n\n${secenek}\n\nTeşekkürler! 🎮` };
  if (k.bit === yarinStr()) return { tur: 'yarin', metin: `🔔 *Hatırlatıcı*\n\nMerhaba *${ad}*!\n*${o?.ad || 'Oyun'}* oyununuz *yarın* bitiyor.\n\n${secenek} 🎮` };
  const kalan = gunFarki(now, k.bit);
  return { tur: 'genel', metin: `🔔 *Hatırlatıcı*\n\nMerhaba *${ad}*!\n*${o?.ad || 'Oyun'}* kiralamanızın bitmesine *${kalan} gün* kaldı (${fmtTarih(k.bit)}).\n\n${secenek} 🎮` };
}

// ══════════════════════════════════════════
// 🤖 SİTEDEN KİRALAMA BAŞLAT — bot müşteriye yazar, müşteri öder, işletmeci #onayla der
// Gövde: { musteriId, oyunId?, tip?, gun? }
// ══════════════════════════════════════════
app.post('/api/kiralama-baslat', async (req, res) => {
  if (!(await apiYetkiliMi(req.body))) return res.status(401).json({ hata: 'Yetkisiz' });
  try {
    const veri = await getVeri();
    const musteriId = Number(req.body.musteriId);
    const m = veri.musteriler.find(x => x.id === musteriId);
    if (!m) return res.status(404).json({ hata: 'Müşteri bulunamadı' });
    const hedef = m.whatsappLid || (m.tel ? temizTel(m.tel) + '@c.us' : null);
    if (!hedef) return res.status(400).json({ hata: 'Müşterinin telefonu yok' });
    const musteriAd = ((m.ad || '') + ' ' + (m.soyad || '')).trim() || m.tel || 'Müşteri';
    const ilkAd = (m.ad || m.soyad || '').trim();
    const onEk = `👋 Merhaba${ilkAd ? ' *' + ilkAd + '*' : ''}! Kiralamanı buradan hızlıca tamamlayabilirsin 🎮\n\n`;
    // Bu müşteri için önceki "insan devraldı" susturmasını kaldır — işletmeci botun devreye girmesini istedi
    const anahtarlar = [hedef, m.whatsappLid, m.tel ? temizTel(m.tel) + '@c.us' : null].filter(Boolean);
    for (const [key] of insanDevraldi) {
      if (anahtarlar.includes(key) || (m.tel && key.replace(/[^0-9]/g, '').endsWith(telSon10(m.tel).slice(-9)))) insanDevraldi.delete(key);
    }
    const oyunId = Number(req.body.oyunId) || null;
    if (!oyunId) {
      await kiralamaListesiGonder(hedef, m, musteriAd, veri, onEk);
      if (m.tel && m.whatsappLid) { const v = bekleyenOnaylar.get(hedef); if (v) bekleyenOnaylar.set(temizTel(m.tel) + '@c.us', v); }
      return res.json({ ok: true, adim: 'liste' });
    }
    const o = veri.oyunlar.find(x => x.id === oyunId);
    if (!o) return res.status(404).json({ hata: 'Oyun bulunamadı' });
    if (o.cikis && o.cikis > bugun()) return res.status(400).json({ hata: 'Oyun henüz çıkmadı' });
    const priDolu = doluMu(o, 'primary', veri), secDolu = doluMu(o, 'secondary', veri);
    let tip = req.body.tip === 'primary' || req.body.tip === 'secondary' ? req.body.tip : null;
    if (tip && (tip === 'primary' ? priDolu : secDolu)) return res.status(409).json({ hata: `${tip === 'primary' ? 'Primary' : 'Secondary'} slotu dolu` });
    if (!tip && priDolu && secDolu) return res.status(409).json({ hata: 'Oyunun boş slotu yok' });
    const temel = { musteriId: m.id, musteriAd, oyunId: o.id, oyunAd: o.ad, kaynak: 'site' };
    if (!tip) {
      const pri = gunlukFiyat(o, 'primary'), sec = gunlukFiyat(o, 'secondary');
      let tipSecim = '';
      if (!priDolu) tipSecim += `*1* - 🔵 Primary: ${fmt(pri)}/gün\n`;
      if (!secDolu) tipSecim += `*2* - 🟣 Secondary: ${fmt(sec)}/gün\n`;
      await mesajGonder(hedef, onEk + `🎮 *${o.ad}*${kampEtiket(o)}\n\nHangi tipi tercih edersiniz?\n${tipSecim}`);
      bekleyenSet(m, { ...temel, tip: 'kiralama_tip_bekle', priDolu, secDolu });
      return res.json({ ok: true, adim: 'tip' });
    }
    const gf = gunlukFiyat(o, tip);
    const gun = parseInt(req.body.gun);
    const durum = { ...temel, tip: 'kiralama_gun_bekle', kiraTip: tip, gunluk: gf };
    if (!gun || gun < 1) {
      await mesajGonder(hedef, onEk + `🎮 *${o.ad}* — ${tip === 'primary' ? '🔵 Primary' : '🟣 Secondary'}\n💰 Günlük: ${fmt(gf)}\n\nKaç gün kiralamak istiyorsunuz? (Min. 5 gün)`);
      bekleyenSet(m, durum);
      return res.json({ ok: true, adim: 'gun' });
    }
    await kiralamaOzetiGonder(hedef, m, musteriAd, veri, durum, gun, onEk);
    // Durum LID ile kaydedildiyse telefon anahtarına da kopyala (müşteri hangi kimlikle yazarsa yazsın bulunsun)
    const v = bekleyenOnaylar.get(hedef);
    if (v && m.tel && m.whatsappLid) bekleyenOnaylar.set(temizTel(m.tel) + '@c.us', v);
    await banaGonder(`🤖 *Siteden kiralama başlatıldı*\n👤 ${musteriAd}\n🎮 ${o.ad} (${tip}) · ${gun} gün\nMüşteriye ödeme bilgisi gönderildi; dekont gelince onaya düşecek.`);
    return res.json({ ok: true, adim: 'ozet' });
  } catch (e) {
    console.error('kiralama-baslat:', e.message);
    return res.status(500).json({ hata: e.message });
  }
});

// ⭐ Siteden iade alınınca: bot müşteriye puan sorusu gönderir. Gövde: { kiraId }
app.post('/api/puan-iste', async (req, res) => {
  if (!(await apiYetkiliMi(req.body))) return res.status(401).json({ hata: 'Yetkisiz' });
  try {
    const veri = await getVeri();
    const k = veri.kiralamalar.find(x => x.id === Number(req.body.kiraId));
    if (!k) return res.status(404).json({ hata: 'Kiralama bulunamadı' });
    if (k.durum !== 'teslim') return res.json({ ok: false, atlandi: 'iade edilmemiş' });
    if (k.puan) return res.json({ ok: false, atlandi: 'zaten puanlanmış' });
    const m = veri.musteriler.find(x => x.id === k.musteriId);
    const hedef = m && (m.whatsappLid || (m.tel ? temizTel(m.tel) + '@c.us' : null));
    if (!hedef) return res.json({ ok: false, atlandi: 'telefon yok' });
    const mevcut = bekleyenOnaylar.get(hedef) || (m.tel && bekleyenOnaylar.get(temizTel(m.tel) + '@c.us'));
    if (mevcut && !['bildirim_secim', 'tavsiye_secim'].includes(mevcut.tip)) return res.json({ ok: false, atlandi: 'müşterinin yarım işlemi var' });
    // Cevabı bot karşılasın — bu müşteri için "insan devraldı" susturmasını kaldır
    const anahtarlar = [hedef, m.whatsappLid, m.tel ? temizTel(m.tel) + '@c.us' : null].filter(Boolean);
    for (const [key] of insanDevraldi) {
      if (anahtarlar.includes(key) || (m.tel && key.replace(/[^0-9]/g, '').endsWith(telSon10(m.tel).slice(-9)))) insanDevraldi.delete(key);
    }
    const o = veri.oyunlar.find(x => x.id === k.oyunId);
    const musteriAd = ((m.ad || '') + ' ' + (m.soyad || '')).trim() || m.tel || 'Müşteri';
    res.json({ ok: true });
    await puanSor(hedef, m, musteriAd, k, o, `👋 Merhaba${m.ad ? ' *' + m.ad.trim() + '*' : ''}! *${o?.ad || 'Oyun'}* iadeni aldık, teşekkürler 🎮\n\n`);
    const v = bekleyenOnaylar.get(hedef);
    if (v && m.tel && m.whatsappLid) bekleyenOnaylar.set(temizTel(m.tel) + '@c.us', v);
  } catch (e) {
    console.error('puan-iste:', e.message);
    if (!res.headersSent) res.status(500).json({ hata: e.message });
  }
});

app.post('/api/hatirlat', async (req, res) => {
  if (!(await apiYetkiliMi(req.body))) return res.status(401).json({ hata: 'Yetkisiz' });
  const ids = Array.isArray(req.body.kiraIds) ? req.body.kiraIds.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ hata: 'kiraIds gerekli' });
  let veri;
  try { veri = await getVeri(); } catch (e) { return res.status(500).json({ hata: e.message }); }
  const sonuc = [];
  for (const id of ids) {
    const k = veri.kiralamalar.find(x => x.id === id);
    const m = k && veri.musteriler.find(x => x.id === k.musteriId);
    const hedef = m && (m.whatsappLid || (m.tel ? temizTel(m.tel) + '@c.us' : null));
    if (!k || k.durum !== 'aktif') sonuc.push({ id, ok: false, hata: 'Aktif kiralama değil' });
    else if (!hedef) sonuc.push({ id, ok: false, hata: 'Telefon yok' });
    else sonuc.push({ id, ok: true, k, m, hedef });
  }
  const gonderilecek = sonuc.filter(x => x.ok);
  res.json({ ok: true, toplam: gonderilecek.length, atlanan: sonuc.filter(x => !x.ok).map(x => ({ id: x.id, hata: x.hata })) });
  // Arka planda, mesajlar arası 1.5 sn (WhatsApp spam koruması)
  for (const x of gonderilecek) {
    try {
      const o = veri.oyunlar.find(y => y.id === x.k.oyunId);
      const { tur, metin } = hatirlatmaMesaji(x.k, x.m, o);
      await mesajGonder(x.hedef, metin);
      bekleyenSet(x.m, { tip: 'bildirim_secim', kiraId: x.k.id, musteriId: x.m.id, gunluk: gunlukFiyat(o || {}, x.k.tip) });
      // Aynı gün zamanlayıcı tekrar göndermesin
      if (tur === 'bugun') await bildirimGittiIsaretle(`bugun_${x.k.id}_${bugun()}`);
      if (tur === 'yarin') await bildirimGittiIsaretle(`yarin_${x.k.id}_${yarinStr()}`);
      if (tur === 'gecikme') { try { await db.collection('botState').doc(`uyari_${x.k.id}`).set({ tarih: bugun() }); } catch (e) {} }
    } catch (e) { console.error('Hatırlatma hatası:', e.message); }
    await new Promise(r => setTimeout(r, 1500));
  }
  if (gonderilecek.length > 1) await banaGonder(`🤖 Siteden toplu hatırlatma gönderildi: ${gonderilecek.length} müşteri`);
});

// ══════════════════════════════════════════
// 🔗 MÜŞTERİ DURUM SAYFASI — /d/<token>
// Müşteriye özel, tahmin edilemeyen link. Sadece o müşterinin kendi bilgileri görünür.
// ══════════════════════════════════════════
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://gamerental-bot-production.up.railway.app').replace(/\/+$/, '');
function yeniToken() { return require('crypto').randomBytes(12).toString('base64url'); }
async function durumLinki(musteri) {
  try {
    if (!musteri) return null;
    if (!musteri.durumToken) {
      const veri = await getVeri();
      const m = veri.musteriler.find(x => x.id === musteri.id);
      if (!m) return null;
      if (!m.durumToken) { m.durumToken = yeniToken(); await setVeri(veri); }
      musteri.durumToken = m.durumToken;
    }
    return `${PUBLIC_URL}/d/${musteri.durumToken}`;
  } catch (e) { console.error('durumLinki hatası:', e.message); return null; }
}
function htmlEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function siraNumarasi(veri, r) {
  const liste = (veri.rezervasyonlar || []).filter(x => x.oyunId === r.oyunId && x.tip === r.tip && x.durum === 'bekliyor')
    .sort((a, b) => {
      const pa = getMusteriTierBot(a.musteriId, veri).seviye === 'platinplus' ? 0 : 1;
      const pb = getMusteriTierBot(b.musteriId, veri).seviye === 'platinplus' ? 0 : 1;
      if (pa !== pb) return pa - pb;
      if (!!a.atla !== !!b.atla) return a.atla ? 1 : -1;
      return (a.sira || a.id) - (b.sira || b.id);
    });
  return { no: liste.findIndex(x => x.id === r.id) + 1, toplam: liste.length };
}

const durumIstekleri = new Map(); // basit hız sınırı: IP başına dakikada 30 istek
app.get('/d/:token', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.ip || '';
  const simdi = Date.now();
  const kayit = (durumIstekleri.get(ip) || []).filter(t => simdi - t < 60000);
  kayit.push(simdi); durumIstekleri.set(ip, kayit);
  if (kayit.length > 30) return res.status(429).send('Çok fazla istek, biraz sonra tekrar deneyin.');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  try {
    const token = String(req.params.token || '');
    const veri = token.length >= 12 ? await getVeri() : null;
    const m = veri && veri.musteriler.find(x => x.durumToken && x.durumToken === token);
    if (!m) return res.status(404).send(durumSayfasi('Bulunamadı', `<div class="kart"><p>Bu bağlantı geçersiz veya yenilenmiş. Güncel bağlantı için WhatsApp'tan <b>1</b> yazabilirsiniz.</p></div>`));
    const now = bugun();
    const ad = ((m.ad || '') + ' ' + (m.soyad || '')).trim() || 'Müşterimiz';
    const aktif = veri.kiralamalar.filter(k => k.musteriId === m.id && k.durum === 'aktif').sort((a, b) => a.bit.localeCompare(b.bit));
    const gecmis = veri.kiralamalar.filter(k => k.musteriId === m.id && k.durum !== 'aktif').sort((a, b) => (b.bas || '').localeCompare(a.bas || '')).slice(0, 5);
    const bekleme = (veri.rezervasyonlar || []).filter(r => r.musteriId === m.id && r.durum === 'bekliyor');
    const tier = getMusteriTierBot(m.id, veri);
    const oyunAd = id => htmlEsc(veri.oyunlar.find(o => o.id === id)?.ad || 'Oyun');
    let h = `<div class="ust"><div class="selam">Merhaba ${htmlEsc(ad)} 👋</div><div class="tarih">${fmtTarih(now)} itibarıyla</div></div>`;
    // Aktif kiralamalar
    h += `<div class="kart"><h2>🎮 Aktif Kiralamalar</h2>`;
    if (!aktif.length) h += `<p class="soluk">Şu an aktif kiralamanız yok. Yeni kiralama için WhatsApp'tan <b>5</b> yazabilirsiniz.</p>`;
    aktif.forEach(k => {
      const kalan = gunFarki(now, k.bit);
      const toplam = Math.max(1, gunFarki(k.bas, k.bit) + 1);
      const gecen = Math.min(toplam, Math.max(0, gunFarki(k.bas, now) + 1));
      const yuzde = Math.round(gecen / toplam * 100);
      const durum = kalan < 0 ? `<span class="rozet kirmizi">${-kalan} gün gecikti</span>` : kalan === 0 ? `<span class="rozet turuncu">Bugün bitiyor</span>` : kalan === 1 ? `<span class="rozet turuncu">Yarın bitiyor</span>` : `<span class="rozet yesil">${kalan} gün kaldı</span>`;
      h += `<div class="satir"><div class="satir-ust"><b>${oyunAd(k.oyunId)}</b> <span class="tip">${k.tip === 'primary' ? 'Primary' : 'Secondary'}</span></div>
        <div class="satir-alt">${fmtTarih(k.bas)} → <b>${fmtTarih(k.bit)}</b> ${durum}</div>
        <div class="bar"><div style="width:${yuzde}%;background:${kalan < 0 ? '#ef4444' : kalan <= 1 ? '#f59e0b' : '#10b981'}"></div></div></div>`;
    });
    if (aktif.length) h += `<p class="ipucu">Uzatmak için WhatsApp'tan <b>2</b>, iade için <b>3</b> yazın.</p>`;
    h += `</div>`;
    // Bekleme listesi
    if (bekleme.length) {
      h += `<div class="kart"><h2>⏳ Bekleme Listesi</h2>`;
      bekleme.forEach(r => {
        const s = siraNumarasi(veri, r);
        const o = veri.oyunlar.find(x => x.id === r.oyunId);
        const cikmadi = o?.cikis && o.cikis > now;
        h += `<div class="satir"><div class="satir-ust"><b>${oyunAd(r.oyunId)}</b> <span class="tip">${r.tip === 'primary' ? 'Primary' : 'Secondary'}</span></div>
          <div class="satir-alt">${cikmadi ? `Çıkış: ${fmtTarih(o.cikis)} · ` : ''}Sıranız: <b>${s.no}</b> / ${s.toplam}${r.onOdeme > 0 ? ` · Ön ödeme: ${fmt(r.onOdeme)}${r.onOdemeOnaylandi ? ' ✓' : ' (onay bekliyor)'}` : ''}</div></div>`;
      });
      h += `<p class="ipucu">Sıranız geldiğinde WhatsApp'tan otomatik bildirim alırsınız.</p></div>`;
    }
    // Üyelik
    const ta = veri.tierAyarlar || {};
    const esikler = [{ ad: 'Gümüş', t: ta.gumus ?? 750 }, { ad: 'Altın', t: ta.altin ?? 1500 }, { ad: 'Platin', t: ta.platin ?? 3000 }, { ad: 'Elmas', t: ta.platinplus ?? 5000 }];
    const sonraki = esikler.find(e => tier.toplam < e.t);
    const onceki = [...esikler].reverse().find(e => tier.toplam >= e.t);
    const ilerleme = sonraki ? Math.round((tier.toplam - (onceki ? onceki.t : 0)) / (sonraki.t - (onceki ? onceki.t : 0)) * 100) : 100;
    h += `<div class="kart"><h2>🏅 Üyelik</h2><div class="tier">${tier.emoji} <b>${htmlEsc(tier.label)}</b>${tier.indirim ? ` · <span class="yesil-y">%${tier.indirim} indirim</span>` : ''}</div>
      <div class="satir-alt">Son 3 ay harcama: <b>${fmt(tier.toplam)}</b></div>
      <div class="bar"><div style="width:${Math.max(3, ilerleme)}%;background:#8b5cf6"></div></div>
      <div class="satir-alt">${sonraki ? `<b>${sonraki.ad}</b> seviyesine <b>${fmt(sonraki.t - tier.toplam)}</b> kaldı` : 'En üst seviyedesiniz 🏆'}</div>
      ${(m.bakiye || 0) > 0 ? `<div class="satir-alt" style="margin-top:8px">💰 Bakiyeniz: <b>${fmt(m.bakiye)}</b></div>` : ''}
      ${aktifOzelIndirim(m) ? `<div class="satir-alt" style="margin-top:8px;color:#fbbf24">🎁 Size özel <b>%${m.ozelIndirim.oran} indirim</b>${m.ozelIndirim.bitis ? ` — ${fmtTarih(m.ozelIndirim.bitis)} tarihine kadar` : ''}</div>` : ''}</div>`;
    // Geçmiş
    if (gecmis.length) {
      h += `<div class="kart"><h2>📜 Son Kiralamalar</h2>`;
      gecmis.forEach(k => { h += `<div class="gecmis"><span>${oyunAd(k.oyunId)}</span><span class="soluk">${fmtTarih(k.bas)} → ${fmtTarih(k.teslimTarih || k.bit)}</span></div>`; });
      h += `</div>`;
    }
    res.send(durumSayfasi('Kiralama Durumum', h));
  } catch (e) {
    console.error('Durum sayfası hatası:', e.message);
    res.status(500).send(durumSayfasi('Hata', `<div class="kart"><p>Şu an bilgiler yüklenemedi, lütfen biraz sonra tekrar deneyin.</p></div>`));
  }
});
function durumSayfasi(baslik, govde) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${htmlEsc(baslik)} · GameRental</title>
<style>
:root{--bg:#0b0b12;--kart:#161622;--kenar:#262636;--yazi:#f1f1f6;--soluk:#9a9ab0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--yazi);font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.45}
.kap{max-width:520px;margin:0 auto;padding:18px 16px 40px}.logo{font-weight:800;font-size:18px;margin-bottom:14px}.logo span{color:#00c6ff}
.ust{margin-bottom:14px}.selam{font-size:20px;font-weight:700}.tarih{color:var(--soluk);font-size:13px}
.kart{background:var(--kart);border:1px solid var(--kenar);border-radius:14px;padding:14px 16px;margin-bottom:12px}
h2{font-size:15px;margin:0 0 10px}.satir{padding:10px 0;border-top:1px solid var(--kenar)}.satir:first-of-type{border-top:none;padding-top:0}
.satir-ust{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.satir-alt{color:var(--soluk);font-size:13px;margin-top:4px}
.tip{font-size:11px;padding:2px 8px;border-radius:99px;background:#1f2a44;color:#7cc4ff}
.rozet{font-size:12px;padding:2px 8px;border-radius:99px;margin-left:4px;font-weight:600}.yesil{background:#0f3d2e;color:#34d399}.turuncu{background:#422c0b;color:#fbbf24}.kirmizi{background:#45151a;color:#f87171}
.bar{height:6px;background:#262636;border-radius:99px;overflow:hidden;margin-top:8px}.bar div{height:100%;border-radius:99px}
.ipucu{font-size:13px;color:var(--soluk);margin:10px 0 0}.soluk{color:var(--soluk)}.tier{font-size:17px;margin-bottom:4px}.yesil-y{color:#34d399}
.gecmis{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid var(--kenar);font-size:14px}.gecmis:first-of-type{border-top:none}
.alt{color:var(--soluk);font-size:12px;text-align:center;margin-top:18px}
</style></head><body><div class="kap"><div class="logo">🎮 Game<span>Rental</span></div>${govde}<div class="alt">Bu sayfa size özeldir, başkalarıyla paylaşmayın.</div></div></body></html>`;
}

// ── API YETKİLENDİRME ──
// Site artık Firebase giriş token'ını (idToken) da gönderiyor: token doğrulanırsa ve senin hesabınsa geçer.
// Ya da Railway'de BOT_API_KEY tanımlarsan o anahtar geçerli olur. Eskiden 'admin' anahtarı herkese açıktı.
async function apiYetkiliMi(body) {
  const { apiKey, idToken } = body || {};
  if (idToken) {
    try {
      const t = await admin.auth().verifyIdToken(idToken);
      if (t.uid === CONFIG.USER_UID) return true;
    } catch (e) { console.warn('idToken doğrulanamadı:', e.message); }
  }
  const gecerli = process.env.BOT_API_KEY || CONFIG.WAHA_API_KEY;
  return !!(gecerli && apiKey && apiKey === gecerli);
}

// ── TOPLU DUYURU API ──
// Site buraya POST atar: { mesaj, alicilar: [{tel, ad}], apiKey }
app.post('/api/duyuru-onay', async (req, res) => {
  const { tel, ad } = req.body || {};
  if (!(await apiYetkiliMi(req.body))) return res.status(401).json({ hata: 'Yetkisiz' });
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
  const { mesaj, alicilar } = req.body || {};
  if (!(await apiYetkiliMi(req.body))) {
    return res.status(401).json({ hata: 'Yetkisiz' });
  }
  // Her alıcıya ayrı metin gönderilebilir (kisi.metin) — lansman / geri kazanım mesajları kişiye özel
  if ((!mesaj && !(alicilar || []).some(k => k.metin)) || !Array.isArray(alicilar) || alicilar.length === 0) {
    return res.status(400).json({ hata: 'mesaj ve alicilar zorunlu' });
  }
  if (alicilar.length > 100) return res.status(400).json({ hata: 'Tek seferde en fazla 100 kişi' });
  const aralik = Math.min(10000, Math.max(2000, parseInt(req.body.aralikMs) || 2000));
  const baslik = String(req.body.baslik || 'Toplu duyuru').slice(0, 60);

  res.json({ durum: 'basliyor', toplam: alicilar.length });

  // Arka planda gönder — mesajlar arasında bekleme (WhatsApp spam koruması)
  let basarili = 0, basarisiz = 0;
  for (const kisi of alicilar) {
    const hedef = kisi.chatId && String(kisi.chatId).includes('@') ? String(kisi.chatId) : temizTel(String(kisi.tel || ''));
    if (!hedef.includes('@') && hedef.length < 10) { basarisiz++; continue; }
    const kisiMesaj = String(kisi.metin || mesaj).replace(/\{isim\}/g, kisi.ad || 'Değerli Müşterimiz');
    await mesajGonder(hedef, kisiMesaj);
    basarili++;
    await new Promise(r => setTimeout(r, aralik));
  }

  const ozet = `📣 ${baslik} tamamlandı\n✅ ${basarili} başarılı\n❌ ${basarisiz} başarısız`;
  console.log(ozet);
  await banaGonder(ozet);
});

app.get('/', (req, res) => res.send('🎮 GameRental Bot çalışıyor!'));
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Port ${CONFIG.PORT} hazır`);
});