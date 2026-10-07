const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1/projects/shopier-1d17c/databases/(default)/documents';

// Ana Sayfa Sağlık Kontrolü
app.get('/', (req, res) => {
  res.send('AERO Webhook Backend - ÖZEL WEB KÖPRÜSÜ AKTİF! 🟢');
});

// API Doğrulama
app.post('/validate-api', (req, res) => {
  return res.json({ success: true, message: 'API bilgileri doğrulandı 🟢' });
});

// =====================================================================
// 1. DİNAMİK İŞLETME BİLGİSİ ÇEKME (REAL & TEST UYUMLU)
// =====================================================================
async function getIsletmeBilgileri(targetId) {
  // Test için varsayılan (fallback) değerler
  let isletmeEmail = 'komegena@gmail.com';
  let isletmeAdi = 'KOMEGENA';
  let restoranEnlem = 41.6771;
  let restoranBoylam = 26.5557;

  try {
    // REAL İŞLEM: Firestore'da bu ID'ye (API Key sahibine) ait restoran var mı?
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
        // Eğer veritabanında gerçek/test eşleşmesi bulursa, e-postayı dinamik al
        if (fields.isletmeEmail && fields.isletmeEmail.stringValue) {
          isletmeEmail = fields.isletmeEmail.stringValue.toLowerCase().trim();
        }
      }
    }
  } catch (err) {
    console.error('İşletme Bilgisi Eşleştirme Hatası:', err.message);
  }

  return { isletmeEmail, isletmeAdi, restoranEnlem, restoranBoylam };
}


// =====================================================================
// 2. TRENDYOL KAPSAMLI WEBHOOK
// =====================================================================
app.post('/webhook/trendyol', async (req, res) => {
  try {
    const data = req.body;
    console.log('📦 TRENDYOL ÖZEL SİPARİŞİ GELDI:', JSON.stringify(data, null, 2));

    const targetSupplierId = String(data.supplierId || data.merchantId || data.restaurantId || '4455555333');
    const isletmeInfo = await getIsletmeBilgileri(targetSupplierId);

    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.totalPrice || data.grossAmount || data.tutar || 0);

    // Kapsamlı Müşteri Ayrıştırma
    const mAd = String(data.customer?.firstName ? `${data.customer.firstName} ${data.customer.lastName || ''}` : (data.musteriAdi || 'Müşteri'));
    const mTel = String(data.customer?.phone || data.telefon || data.phone || '');
    const mAdres = String(data.deliveryAddress?.fullAddress || data.deliveryAddress?.addressLine1 || data.adres || data.address || 'Belirtilmedi');
    const latVal = Number(data.deliveryAddress?.latitude || data.latitude || data.lat || 41.6771);
    const lngVal = Number(data.deliveryAddress?.longitude || data.longitude || data.lng || 26.5557);

    // Kapsamlı Ürün Ayrıştırma
    let urunMetni = '1x Ürün';
    if (data.lines && Array.isArray(data.lines) && data.lines.length > 0) {
      urunMetni = data.lines.map(l => `${l.quantity || 1}x ${l.productName || l.name || 'Ürün'}${l.notes ? ' (Not: '+l.notes+')' : ''}`).join(', ');
    } else if (data.detay) {
      urunMetni = String(data.detay);
    }

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderNumber || data.siparisNo || data.id || 'TR-' + Date.now()) },
        
        // --- 🎯 BİZE ÖZEL KÖPRÜ İSMİ (Main.dart Sadece Bunu Çekecek) ---
        sistemFiltresi: { stringValue: 'AERO_WEB_OZEL' },
        
        // EŞLEŞEN REAL VEYA TEST İŞLETME BİLGİSİ
        isletmeEmail: { stringValue: isletmeInfo.isletmeEmail },
        isletmeAdi: { stringValue: isletmeInfo.isletmeAdi },
        marketAdi: { stringValue: isletmeInfo.isletmeAdi },
        supplierId: { stringValue: targetSupplierId },
        
        // KANAL VE PLATFORM
        kaynak: { stringValue: 'Trendyol' },
        kanal: { stringValue: 'Trendyol' },
        platform: { stringValue: 'TRENDYOL' },

        // FİYAT
        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },
        price: { doubleValue: tutarVal },

        // KURYE UYGULAMASI GÖRMESİN DİYE GÜVENLİK ALANLARI
        durum: { stringValue: 'YENI' },
        status: { stringValue: 'YENI' },
        havuzdaMi: { booleanValue: false },
        kuryeId: { stringValue: '' },

        // KAPSAMLI MÜŞTERİ VERİSİ
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
        restoranEnlem: { doubleValue: isletmeInfo.restoranEnlem },
        restoranBoylam: { doubleValue: isletmeInfo.restoranBoylam },

        // ÜRÜN
        detay: { stringValue: urunMetni },
        urunler: { stringValue: urunMetni },
        urunDetay: { stringValue: urunMetni },

        tarih: { timestampValue: nowIso },
        createdAt: { timestampValue: nowIso }
      }
    };

    await fetch(`${FIRESTORE_BASE_URL}/siparisler`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firestoreDocument)
    });

    return res.status(200).json({ status: 'OK', message: 'Trendyol Özel Köprü Başarılı' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});


// =====================================================================
// 3. YEMEKSEPETİ KAPSAMLI WEBHOOK
// =====================================================================
app.post('/webhook/yemeksepeti', async (req, res) => {
  try {
    const data = req.body;
    console.log('🍔 YEMEKSEPETİ ÖZEL SİPARİŞİ GELDİ:', JSON.stringify(data, null, 2));

    const targetRestaurantId = String(data.restaurantId || data.vendorId || data.supplierId || '4455555333');
    const isletmeInfo = await getIsletmeBilgileri(targetRestaurantId);

    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.price?.total || data.totalAmount || data.totalPrice || data.tutar || 0);

    // Kapsamlı Müşteri Ayrıştırma
    const mAd = String(data.customer?.name || data.customer?.firstName || data.customerName || data.musteriAdi || 'Müşteri');
    const mTel = String(data.customer?.phone || data.telefon || data.phone || '');
    const mAdres = String(data.delivery?.address || data.adres || data.address || 'Belirtilmedi');
    const latVal = Number(data.delivery?.location?.lat || data.delivery?.latitude || data.latitude || data.lat || 41.6771);
    const lngVal = Number(data.delivery?.location?.lng || data.delivery?.longitude || data.longitude || data.lng || 26.5557);

    // Kapsamlı Ürün Ayrıştırma
    let urunMetni = '1x Ürün';
    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
      urunMetni = data.items.map(i => `${i.quantity || 1}x ${i.name || i.productName || 'Ürün'}${i.notes ? ' (Not: '+i.notes+')' : ''}`).join(', ');
    } else if (data.detay) {
      urunMetni = String(data.detay);
    }

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderCode || data.siparisNo || data.id || 'YS-' + Date.now()) },
        
        // --- 🎯 BİZE ÖZEL KÖPRÜ İSMİ (Main.dart Sadece Bunu Çekecek) ---
        sistemFiltresi: { stringValue: 'AERO_WEB_OZEL' },

        // EŞLEŞEN REAL VEYA TEST İŞLETME BİLGİSİ
        isletmeEmail: { stringValue: isletmeInfo.isletmeEmail },
        isletmeAdi: { stringValue: isletmeInfo.isletmeAdi },
        marketAdi: { stringValue: isletmeInfo.isletmeAdi },
        restaurantId: { stringValue: targetRestaurantId },

        // KANAL VE PLATFORM
        kaynak: { stringValue: 'Yemeksepeti' },
        kanal: { stringValue: 'Yemeksepeti' },
        platform: { stringValue: 'YEMEKSEPETI' },

        // FİYAT
        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },
        price: { doubleValue: tutarVal },

        // KURYE UYGULAMASI GÖRMESİN DİYE
        durum: { stringValue: 'YENI' },
        status: { stringValue: 'YENI' },
        havuzdaMi: { booleanValue: false },
        kuryeId: { stringValue: '' },

        // KAPSAMLI MÜŞTERİ VERİSİ
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
        restoranEnlem: { doubleValue: isletmeInfo.restoranEnlem },
        restoranBoylam: { doubleValue: isletmeInfo.restoranBoylam },

        // ÜRÜN
        detay: { stringValue: urunMetni },
        urunler: { stringValue: urunMetni },
        urunDetay: { stringValue: urunMetni },

        tarih: { timestampValue: nowIso },
        createdAt: { timestampValue: nowIso }
      }
    };

    await fetch(`${FIRESTORE_BASE_URL}/siparisler`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firestoreDocument)
    });

    return res.status(200).json({ status: 'OK', message: 'Yemeksepeti Özel Köprü Başarılı' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda özel köprü moduyla çalışıyor.`);
});
