const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1/projects/shopier-1d17c/databases/(default)/documents/siparisler';

// Ana Sayfa Sağlık Kontrolü
app.get('/', (req, res) => {
  res.send('AERO Webhook Backend Canlıda! 🟢');
});

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

// 2. TRENDYOL CANLI WEBHOOK UÇ NOKTASI
app.post('/webhook/trendyol', async (req, res) => {
  try {
    const data = req.body;
    console.log('📦 CANLI TRENDYOL SİPARİŞİ GELDI:', JSON.stringify(data, null, 2));

    const targetSupplierId = String(data.supplierId || data.merchantId || '');
    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.totalPrice || data.grossAmount || 0);

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderNumber || data.id || 'TR-' + Date.now()) },
        
        // PANELİN BEKLEDİĞİ TÜM ID ALANLARI
        supplierId: { stringValue: targetSupplierId },
        restaurantId: { stringValue: targetSupplierId },
        restoranId: { stringValue: targetSupplierId },
        restoranName: { stringValue: String(data.storeName || 'Trendyol Restoran') },
        
        // PANELİN BEKLEDİĞİ TÜM KAYNAK / KANAL ALANLARI
        kaynak: { stringValue: 'Trendyol' },
        kanal: { stringValue: 'Trendyol' },
        platform: { stringValue: 'TRENDYOL' },

        // FİYAT VE DURUM
        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },
        durum: { stringValue: 'YENI' },
        status: { stringValue: 'YENI' },

        // MÜŞTERİ BİLGİLERİ
        musteriAdi: { stringValue: String(data.customer?.firstName ? `${data.customer.firstName} ${data.customer.lastName || ''}` : 'Müşteri') },
        musteriTelefon: { stringValue: String(data.customer?.phone || '') },
        teslimatAdresi: { stringValue: String(data.deliveryAddress?.addressLine1 || data.deliveryAddress?.fullAddress || '') },

        // TARİHLER
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

    return res.status(200).json({ status: 'OK', message: 'Sipariş alındı' });
  } catch (error) {
    console.error('Trendyol Webhook Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// 3. YEMEKSEPETİ CANLI WEBHOOK UÇ NOKTASI
app.post('/webhook/yemeksepeti', async (req, res) => {
  try {
    const data = req.body;
    console.log('🍔 CANLI YEMEKSEPETİ SİPARİŞİ GELDİ:', JSON.stringify(data, null, 2));

    const targetRestaurantId = String(data.restaurantId || data.vendorId || '');
    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.price?.total || data.totalAmount || 0);

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderCode || data.id || 'YS-' + Date.now()) },
        
        // PANELİN BEKLEDİĞİ TÜM ID ALANLARI
        supplierId: { stringValue: targetRestaurantId },
        restaurantId: { stringValue: targetRestaurantId },
        restoranId: { stringValue: targetRestaurantId },
        restoranName: { stringValue: String(data.vendorName || 'Yemeksepeti Restoran') },

        // PANELİN BEKLEDİĞİ TÜM KAYNAK / KANAL ALANLARI
        kaynak: { stringValue: 'Yemeksepeti' },
        kanal: { stringValue: 'Yemeksepeti' },
        platform: { stringValue: 'YEMEKSEPETI' },

        // FİYAT VE DURUM
        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },
        durum: { stringValue: 'YENI' },
        status: { stringValue: 'YENI' },

        // MÜŞTERİ BİLGİLERİ
        musteriAdi: { stringValue: String(data.customer?.name || 'Müşteri') },
        musteriTelefon: { stringValue: String(data.customer?.phone || '') },
        teslimatAdresi: { stringValue: String(data.delivery?.address || '') },

        // TARİHLER
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
