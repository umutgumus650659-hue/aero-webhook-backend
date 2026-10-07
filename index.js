const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1/projects/shopier-1d17c/databases/(default)/documents/siparisler';

// Ana Sayfa Sağlık Kontrolü
app.get('/', (req, res) => {
  res.send('AERO Webhook Backend Canlıda ve Web Modunda! 🟢');
});

// API Doğrulama
app.post('/validate-api', (req, res) => {
  return res.json({
    success: true,
    message: 'API bilgileri başarıyla doğrulandı! 🟢'
  });
});

// 1. TRENDYOL WEBHOOK (Sadece Web Paneli Odaklı)
app.post('/webhook/trendyol', async (req, res) => {
  try {
    const data = req.body;
    console.log('📦 TRENDYOL SİPARİŞİ GELDI:', JSON.stringify(data, null, 2));

    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.totalPrice || data.grossAmount || data.tutar || 0);

    // Müşteri Bilgileri
    const mAd = String(data.customer?.firstName ? `${data.customer.firstName} ${data.customer.lastName || ''}` : (data.musteriAdi || 'Müşteri'));
    const mTel = String(data.customer?.phone || data.telefon || data.phone || '');
    const mAdres = String(data.deliveryAddress?.fullAddress || data.deliveryAddress?.addressLine1 || data.adres || data.address || 'Belirtilmedi');

    // GPS Koordinatları
    const latVal = Number(data.deliveryAddress?.latitude || data.latitude || data.lat || 41.6771);
    const lngVal = Number(data.deliveryAddress?.longitude || data.longitude || data.lng || 26.5557);

    // Ürün Detayları Ayrıştırma
    let urunMetni = '1x Ürün';
    if (data.lines && Array.isArray(data.lines) && data.lines.length > 0) {
      urunMetni = data.lines.map(l => {
        const adet = l.quantity || 1;
        const isim = l.productName || l.name || 'Ürün';
        const not = l.notes ? ` (${l.notes})` : '';
        return `${adet}x ${isim}${not}`;
      }).join(', ');
    } else if (data.detay) {
      urunMetni = String(data.detay);
    }

    // Web Paneli E-posta Eşleşmesi (Komegena Test Hesabı)
    const isletmeEmailVal = String(data.isletmeEmail || 'komegena@gmail.com').toLowerCase().trim();
    const restoranAdiVal = String(data.storeName || data.restoran || data.isletmeAdi || 'KOMEGENA');

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderNumber || data.siparisNo || data.id || 'TR-' + Date.now()) },
        
        // WEB PANELİNİN BEKLEDİĞİ ALANLAR
        isletmeEmail: { stringValue: isletmeEmailVal },
        isletmeAdi: { stringValue: restoranAdiVal },
        marketAdi: { stringValue: restoranAdiVal },
        
        // KANAL VE KAYNAK
        kaynak: { stringValue: 'Trendyol' },
        kanal: { stringValue: 'Trendyol' },
        platform: { stringValue: 'TRENDYOL' },

        // FİYAT
        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },
        price: { doubleValue: tutarVal },

        // SADECE WEBE DÜŞMESİ İÇİN (Kurye Tetiklemesi Yok)
        durum: { stringValue: 'YENI' },
        status: { stringValue: 'YENI' },
        havuzdaMi: { booleanValue: false },
        kuryeId: { stringValue: '' },

        // MÜŞTERİ VE ADRES
        musteriAdi: { stringValue: mAd },
        customerName: { stringValue: mAd },
        musteriTelefon: { stringValue: mTel },
        telefon: { stringValue: mTel },
        phone: { stringValue: mTel },
        teslimatAdresi: { stringValue: mAdres },
        adres: { stringValue: mAdres },
        address: { stringValue: mAdres },

        // GPS
        enlem: { doubleValue: latVal },
        boylam: { doubleValue: lngVal },
        konum: { stringValue: `${latVal}, ${lngVal}` },

        // ÜRÜN İÇERİĞİ
        detay: { stringValue: urunMetni },
        urunler: { stringValue: urunMetni },
        urunDetay: { stringValue: urunMetni },

        // ZAMAN
        tarih: { timestampValue: nowIso },
        createdAt: { timestampValue: nowIso }
      }
    };

    const response = await fetch(FIRESTORE_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firestoreDocument)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Firestore REST hatası: ${errText}`);
    }

    return res.status(200).json({ status: 'OK', message: 'Trendyol siparişi web paneline aktarıldı' });
  } catch (error) {
    console.error('Trendyol Webhook Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// 2. YEMEKSEPETİ WEBHOOK (Sadece Web Paneli Odaklı)
app.post('/webhook/yemeksepeti', async (req, res) => {
  try {
    const data = req.body;
    console.log('🍔 YEMEKSEPETİ SİPARİŞİ GELDİ:', JSON.stringify(data, null, 2));

    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.price?.total || data.totalAmount || data.totalPrice || data.tutar || 0);

    // Müşteri Bilgileri
    const mAd = String(data.customer?.name || data.customerName || data.musteriAdi || 'Müşteri');
    const mTel = String(data.customer?.phone || data.telefon || data.phone || '');
    const mAdres = String(data.delivery?.address || data.adres || data.address || 'Belirtilmedi');

    // GPS Koordinatları
    const latVal = Number(data.delivery?.location?.lat || data.delivery?.latitude || data.latitude || data.lat || 41.6771);
    const lngVal = Number(data.delivery?.location?.lng || data.delivery?.longitude || data.longitude || data.lng || 26.5557);

    // Ürün Detayları Ayrıştırma
    let urunMetni = '1x Ürün';
    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
      urunMetni = data.items.map(i => {
        const adet = i.quantity || 1;
        const isim = i.name || i.productName || 'Ürün';
        return `${adet}x ${isim}`;
      }).join(', ');
    } else if (data.detay) {
      urunMetni = String(data.detay);
    }

    // Web Paneli E-posta Eşleşmesi
    const isletmeEmailVal = String(data.isletmeEmail || 'komegena@gmail.com').toLowerCase().trim();
    const restoranAdiVal = String(data.vendorName || data.restoran || data.isletmeAdi || 'KOMEGENA');

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderCode || data.siparisNo || data.id || 'YS-' + Date.now()) },
        
        // WEB PANELİNİN BEKLEDİĞİ ALANLAR
        isletmeEmail: { stringValue: isletmeEmailVal },
        isletmeAdi: { stringValue: restoranAdiVal },
        marketAdi: { stringValue: restoranAdiVal },

        // KANAL VE KAYNAK
        kaynak: { stringValue: 'Yemeksepeti' },
        kanal: { stringValue: 'Yemeksepeti' },
        platform: { stringValue: 'YEMEKSEPETI' },

        // FİYAT
        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },
        price: { doubleValue: tutarVal },

        // SADECE WEBE DÜŞMESİ İÇİN
        durum: { stringValue: 'YENI' },
        status: { stringValue: 'YENI' },
        havuzdaMi: { booleanValue: false },
        kuryeId: { stringValue: '' },

        // MÜŞTERİ VE ADRES
        musteriAdi: { stringValue: mAd },
        customerName: { stringValue: mAd },
        musteriTelefon: { stringValue: mTel },
        telefon: { stringValue: mTel },
        phone: { stringValue: mTel },
        teslimatAdresi: { stringValue: mAdres },
        adres: { stringValue: mAdres },
        address: { stringValue: mAdres },

        // GPS
        enlem: { doubleValue: latVal },
        boylam: { doubleValue: lngVal },
        konum: { stringValue: `${latVal}, ${lngVal}` },

        // ÜRÜN İÇERİĞİ
        detay: { stringValue: urunMetni },
        urunler: { stringValue: urunMetni },
        urunDetay: { stringValue: urunMetni },

        // ZAMAN
        tarih: { timestampValue: nowIso },
        createdAt: { timestampValue: nowIso }
      }
    };

    const response = await fetch(FIRESTORE_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firestoreDocument)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Firestore REST hatası: ${errText}`);
    }

    return res.status(200).json({ status: 'OK', message: 'Yemeksepeti siparişi web paneline aktarıldı' });
  } catch (error) {
    console.error('Yemeksepeti Webhook Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
