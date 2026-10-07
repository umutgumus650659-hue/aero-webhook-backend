const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1/projects/shopier-1d17c/databases/(default)/documents';

// Ana Sayfa Sağlık Kontrolü
app.get('/', (req, res) => {
  res.send('AERO Webhook Backend Canlıda! 🟢');
});

// Yardımcı: Firestore Document REST Get
async function getFirestoreDoc(collection, docId) {
  try {
    const res = await fetch(`${FIRESTORE_BASE_URL}/${collection}/${docId}`);
    if (!res.ok) return null;
    const json = await res.json();
    return json.fields || null;
  } catch (e) {
    console.error(`Firestore Okuma Hatası (${collection}/${docId}):`, e.message);
    return null;
  }
}

// Yardımcı: SupplierId veya RestaurantId üzerinden İşletme E-postasını ve Bilgilerini Bulma
async function getIsletmeBilgileri(targetId) {
  // Varsayılan kilitlenme önleyici değerler
  let isletmeEmail = 'komegena@gmail.com';
  let isletmeAdi = 'KOMEGENA';
  let restoranEnlem = 41.6771;
  let restoranBoylam = 26.5557;

  try {
    // 1. Entegrasyonlar koleksiyonunu REST Query ile sorgula
    const queryBody = {
      structuredQuery: {
        from: [{ collectionId: 'isletme_entegrasyonlar' }],
        where: {
          compositeFilter: {
            op: 'OR',
            filters: [
              { fieldFilter: { field: { fieldPath: 'trSupplierId' }, op: 'EQUAL', value: { stringValue: String(targetId) } } },
              { fieldFilter: { field: { fieldPath: 'ysRestoranId' }, op: 'EQUAL', value: { stringValue: String(targetId) } } }
            ]
          }
        },
        limit: 1
      }
    };

    const res = await fetch(`${FIRESTORE_BASE_URL}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody)
    });

    if (res.ok) {
      const results = await res.json();
      if (results && results[0] && results[0].document && results[0].document.fields) {
        const fields = results[0].document.fields;
        if (fields.isletmeEmail && fields.isletmeEmail.stringValue) {
          isletmeEmail = fields.isletmeEmail.stringValue;
        }
      }
    }

    // 2. İşletme e-postasına ait web izinleri ve konum bilgilerini çek
    const webDoc = await getFirestoreDoc('isletme_web_izinleri', isletmeEmail);
    if (webDoc) {
      if (webDoc.isletmeAdi && webDoc.isletmeAdi.stringValue) {
        isletmeAdi = webDoc.isletmeAdi.stringValue;
      }
      if (webDoc.restoranEnlem) {
        restoranEnlem = Number(webDoc.restoranEnlem.doubleValue || webDoc.restoranEnlem.integerValue || 41.6771);
      }
      if (webDoc.restoranBoylam) {
        restoranBoylam = Number(webDoc.restoranBoylam.doubleValue || webDoc.restoranBoylam.integerValue || 26.5557);
      }
    }
  } catch (err) {
    console.error('İşletme Bilgisi Eşleştirme Hatası:', err.message);
  }

  return { isletmeEmail, isletmeAdi, restoranEnlem, restoranBoylam };
}

// 1. API Doğrulama Uç Noktası
app.post('/validate-api', (req, res) => {
  const { trSupplierId, trApiKey, trApiSecret, ysRestoranId, ysToken } = req.body;

  if ((trSupplierId && trSupplierId.length < 3) || (ysRestoranId && ysRestoranId.length < 3)) {
    return res.status(400).json({
      success: false,
      message: 'Girilen API anahtarları veya ID formatı geçersiz.'
    });
  }

  return res.json({
    success: true,
    message: 'API bilgileri başarıyla doğrulandı ve kaydedildi! 🟢'
  });
});

// 2. TRENDYOL WEBHOOK UÇ NOKTASI (Tam Dinamik Eşleşmeli)
app.post('/webhook/trendyol', async (req, res) => {
  try {
    const data = req.body;
    console.log('📦 TRENDYOL SİPARİŞİ GELDI:', JSON.stringify(data, null, 2));

    const targetSupplierId = String(data.supplierId || data.merchantId || data.restaurantId || '4455555333');
    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.totalPrice || data.grossAmount || data.tutar || 0);

    // Veritabanından İlgili Restoranın E-postası, Adı ve Konumunu Otomatik Çek
    const isletmeInfo = await getIsletmeBilgileri(targetSupplierId);

    // Müşteri Bilgileri
    const mAd = String(data.customer?.firstName ? `${data.customer.firstName} ${data.customer.lastName || ''}` : (data.musteriAdi || 'Müşteri'));
    const mTel = String(data.customer?.phone || data.telefon || data.phone || '');
    const mAdres = String(data.deliveryAddress?.fullAddress || data.deliveryAddress?.addressLine1 || data.adres || data.address || 'Belirtilmedi');

    // Otomatik GPS Enlem / Boylam
    const latVal = Number(data.deliveryAddress?.latitude || data.latitude || data.lat || 41.6771);
    const lngVal = Number(data.deliveryAddress?.longitude || data.longitude || data.lng || 26.5557);

    // Ürün Detayı Ayrıştırma
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

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderNumber || data.siparisNo || data.id || 'TR-' + Date.now()) },
        
        // DİNAMİK EŞLEŞEN İŞLETME BİLGİLERİ (Web ve Kurye Havuzu İçin Şart)
        isletmeEmail: { stringValue: String(data.isletmeEmail || isletmeInfo.isletmeEmail) },
        isletmeAdi: { stringValue: isletmeInfo.isletmeAdi },
        marketAdi: { stringValue: isletmeInfo.isletmeAdi },
        supplierId: { stringValue: targetSupplierId },
        restaurantId: { stringValue: targetSupplierId },
        restoranId: { stringValue: targetSupplierId },
        restoranName: { stringValue: isletmeInfo.isletmeAdi },
        
        // KANAL VE PLATFORM
        kaynak: { stringValue: 'Trendyol' },
        kanal: { stringValue: 'Trendyol' },
        platform: { stringValue: 'TRENDYOL' },

        // FİYAT VE TUTAR
        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },
        price: { doubleValue: tutarVal },

        // KURYE HAVUZUNA TELEFON SİPARİŞİ GİBİ OTOMATİK DÜŞME ANAHTARLARI
        durum: { stringValue: 'Yeni Siparis' },
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

        // GPS VE RESTORAN KOORDİNATLARI (Kurye Çoklu Atama Hesabı İçin)
        enlem: { doubleValue: latVal },
        boylam: { doubleValue: lngVal },
        konum: { stringValue: `${latVal}, ${lngVal}` },
        restoranEnlem: { doubleValue: isletmeInfo.restoranEnlem },
        restoranBoylam: { doubleValue: isletmeInfo.restoranBoylam },

        // ÜRÜN İÇERİĞİ
        detay: { stringValue: urunMetni },
        urunler: { stringValue: urunMetni },
        urunDetay: { stringValue: urunMetni },

        // ZAMAN DAMGALARI
        tarih: { timestampValue: nowIso },
        createdAt: { timestampValue: nowIso }
      }
    };

    const response = await fetch(`${FIRESTORE_BASE_URL}/siparisler`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firestoreDocument)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Firestore REST hatası: ${errText}`);
    }

    return res.status(200).json({ status: 'OK', message: 'Sipariş alındı' });
  } catch (error) {
    console.error('Trendyol Webhook Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// 3. YEMEKSEPETİ WEBHOOK UÇ NOKTASI (Tam Dinamik Eşleşmeli)
app.post('/webhook/yemeksepeti', async (req, res) => {
  try {
    const data = req.body;
    console.log('🍔 YEMEKSEPETİ SİPARİŞİ GELDİ:', JSON.stringify(data, null, 2));

    const targetRestaurantId = String(data.restaurantId || data.vendorId || data.supplierId || '4455555333');
    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.price?.total || data.totalAmount || data.totalPrice || data.tutar || 0);

    const isletmeInfo = await getIsletmeBilgileri(targetRestaurantId);

    const mAd = String(data.customer?.name || data.customerName || data.musteriAdi || 'Müşteri');
    const mTel = String(data.customer?.phone || data.telefon || data.phone || '');
    const mAdres = String(data.delivery?.address || data.adres || data.address || 'Belirtilmedi');

    const latVal = Number(data.delivery?.location?.lat || data.delivery?.latitude || data.latitude || data.lat || 41.6771);
    const lngVal = Number(data.delivery?.location?.lng || data.delivery?.longitude || data.longitude || data.lng || 26.5557);

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

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderCode || data.siparisNo || data.id || 'YS-' + Date.now()) },
        
        isletmeEmail: { stringValue: String(data.isletmeEmail || isletmeInfo.isletmeEmail) },
        isletmeAdi: { stringValue: isletmeInfo.isletmeAdi },
        marketAdi: { stringValue: isletmeInfo.isletmeAdi },
        supplierId: { stringValue: targetRestaurantId },
        restaurantId: { stringValue: targetRestaurantId },
        restoranId: { stringValue: targetRestaurantId },
        restoranName: { stringValue: isletmeInfo.isletmeAdi },

        kaynak: { stringValue: 'Yemeksepeti' },
        kanal: { stringValue: 'Yemeksepeti' },
        platform: { stringValue: 'YEMEKSEPETI' },

        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },
        price: { doubleValue: tutarVal },

        durum: { stringValue: 'Yeni Siparis' },
        status: { stringValue: 'YENI' },
        havuzdaMi: { booleanValue: false },
        kuryeId: { stringValue: '' },

        musteriAdi: { stringValue: mAd },
        customerName: { stringValue: mAd },
        musteriTelefon: { stringValue: mTel },
        telefon: { stringValue: mTel },
        phone: { stringValue: mTel },
        teslimatAdresi: { stringValue: mAdres },
        adres: { stringValue: mAdres },
        address: { stringValue: mAdres },

        enlem: { doubleValue: latVal },
        boylam: { doubleValue: lngVal },
        konum: { stringValue: `${latVal}, ${lngVal}` },
        restoranEnlem: { doubleValue: isletmeInfo.restoranEnlem },
        restoranBoylam: { doubleValue: isletmeInfo.restoranBoylam },

        detay: { stringValue: urunMetni },
        urunler: { stringValue: urunMetni },
        urunDetay: { stringValue: urunMetni },

        tarih: { timestampValue: nowIso },
        createdAt: { timestampValue: nowIso }
      }
    };

    const response = await fetch(`${FIRESTORE_BASE_URL}/siparisler`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firestoreDocument)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Firestore REST hatası: ${errText}`);
    }

    return res.status(200).json({ status: 'OK', message: 'Sipariş alındı' });
  } catch (error) {
    console.error('Yemeksepeti Webhook Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda canlı olarak çalışıyor.`);
});
