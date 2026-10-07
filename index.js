const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1/projects/shopier-1d17c/databases/(default)/documents';

app.get('/', (req, res) => {
  res.send('AERO Webhook Backend Canlıda! 🟢');
});

app.post('/validate-api', (req, res) => {
  return res.json({
    success: true,
    message: 'API bilgileri doğrulandı 🟢'
  });
});

// İşletme Bilgilerini Sorgulama
async function getIsletmeBilgileri(targetId) {
  let isletmeEmail = 'komegena@gmail.com';
  let isletmeAdi = 'KOMEGENA';
  let restoranEnlem = 41.6771;
  let restoranBoylam = 26.5557;

  try {
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
          isletmeEmail = fields.isletmeEmail.stringValue.toLowerCase().trim();
        }
      }
    }
  } catch (err) {
    console.error('İşletme Bilgisi Eşleştirme Hatası:', err.message);
  }

  return { 
    isletmeEmail: isletmeEmail.toLowerCase().trim(), 
    isletmeAdi, 
    restoranEnlem, 
    restoranBoylam 
  };
}

// 1. TRENDYOL WEBHOOK
app.post('/webhook/trendyol', async (req, res) => {
  try {
    const data = req.body;
    console.log('📦 TRENDYOL SİPARİŞİ GELDI:', JSON.stringify(data, null, 2));

    const targetSupplierId = String(data.supplierId || data.merchantId || data.restaurantId || '4455555333');
    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.totalPrice || data.grossAmount || data.tutar || 0);

    const isletmeInfo = await getIsletmeBilgileri(targetSupplierId);

    const mAd = String(data.customer?.firstName ? `${data.customer.firstName} ${data.customer.lastName || ''}` : (data.musteriAdi || 'Müşteri'));
    const mTel = String(data.customer?.phone || data.telefon || data.phone || '');
    const mAdres = String(data.deliveryAddress?.fullAddress || data.deliveryAddress?.addressLine1 || data.adres || data.address || 'Belirtilmedi');

    const latVal = Number(data.deliveryAddress?.latitude || data.latitude || data.lat || 41.6771);
    const lngVal = Number(data.deliveryAddress?.longitude || data.longitude || data.lng || 26.5557);

    let urunMetni = '1x Ürün';
    if (data.lines && Array.isArray(data.lines) && data.lines.length > 0) {
      urunMetni = data.lines.map(l => `${l.quantity || 1}x ${l.productName || l.name || 'Ürün'}${l.notes ? ' ('+l.notes+')' : ''}`).join(', ');
    } else if (data.detay) {
      urunMetni = String(data.detay);
    }

    const finalEmail = String(data.isletmeEmail || isletmeInfo.isletmeEmail).toLowerCase().trim();

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderNumber || data.siparisNo || data.id || 'TR-' + Date.now()) },
        
        isletmeEmail: { stringValue: finalEmail },
        isletmeAdi: { stringValue: isletmeInfo.isletmeAdi },
        marketAdi: { stringValue: isletmeInfo.isletmeAdi },
        supplierId: { stringValue: targetSupplierId },
        restaurantId: { stringValue: targetSupplierId },
        restoranId: { stringValue: targetSupplierId },
        restoranName: { stringValue: isletmeInfo.isletmeAdi },
        
        kaynak: { stringValue: 'Trendyol' },
        kanal: { stringValue: 'Trendyol' },
        platform: { stringValue: 'TRENDYOL' },

        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },
        price: { doubleValue: tutarVal },

        // WEB PANELİNİN ÖNCE YAKALAMASI İÇİN DURUM YENİ (KURYE ÇEKMEDEN)
        durum: { stringValue: 'YENI' },
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

    return res.status(200).json({ status: 'OK', message: 'Sipariş web paneline aktarıldı' });
  } catch (error) {
    console.error('Trendyol Webhook Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// 2. YEMEKSEPETİ WEBHOOK
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
      urunMetni = data.items.map(i => `${i.quantity || 1}x ${i.name || i.productName || 'Ürün'}`).join(', ');
    } else if (data.detay) {
      urunMetni = String(data.detay);
    }

    const finalEmail = String(data.isletmeEmail || isletmeInfo.isletmeEmail).toLowerCase().trim();

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderCode || data.siparisNo || data.id || 'YS-' + Date.now()) },
        
        isletmeEmail: { stringValue: finalEmail },
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

        durum: { stringValue: 'YENI' },
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

    return res.status(200).json({ status: 'OK', message: 'Sipariş web paneline aktarıldı' });
  } catch (error) {
    console.error('Yemeksepeti Webhook Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
