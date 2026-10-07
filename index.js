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

// 2. TRENDYOL WEBHOOK UÇ NOKTASI (Canlı + Kurye Havuzu + Otomatik GPS)
app.post('/webhook/trendyol', async (req, res) => {
  try {
    const data = req.body;
    console.log('📦 TRENDYOL SİPARİŞİ GELDI:', JSON.stringify(data, null, 2));

    const targetSupplierId = String(data.supplierId || data.merchantId || data.restaurantId || '4455555333');
    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.totalPrice || data.grossAmount || data.tutar || 0);

    // Müşteri Kimlik & Telefon (Gizli Yönlendirme Numaraları Dahil)
    const mAd = String(data.customer?.firstName ? `${data.customer.firstName} ${data.customer.lastName || ''}` : (data.musteriAdi || 'Müşteri'));
    const mTel = String(data.customer?.phone || data.telefon || data.phone || '');

    // Açık Teslimat Adresi
    const mAdres = String(data.deliveryAddress?.fullAddress || data.deliveryAddress?.addressLine1 || data.adres || data.address || 'Belirtilmedi');

    // Otomatik Enlem / Boylam Ayrıştırma (GPS)
    const latVal = Number(data.deliveryAddress?.latitude || data.latitude || data.lat || 41.6771);
    const lngVal = Number(data.deliveryAddress?.longitude || data.longitude || data.lng || 26.5557);

    // Ürün İçeriği ve Detay Metni Oluşturma
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

    // İşletme e-postası (Varsayılan veya gelen veri)
    const isletmeEmailVal = String(data.isletmeEmail || 'komegena@gmail.com');
    const restoranAdiVal = String(data.storeName || data.restoran || data.isletmeAdi || 'KOMEGENA');

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderNumber || data.siparisNo || data.id || 'TR-' + Date.now()) },
        
        // İŞLETME VE RESTORAN BİLGİLERİ (Kurye ve Web Süzgeci İçin)
        isletmeEmail: { stringValue: isletmeEmailVal },
        isletmeAdi: { stringValue: restoranAdiVal },
        marketAdi: { stringValue: restoranAdiVal },
        supplierId: { stringValue: targetSupplierId },
        restaurantId: { stringValue: targetSupplierId },
        restoranId: { stringValue: targetSupplierId },
        restoranName: { stringValue: restoranAdiVal },
        
        // KANAL VE PLATFORM
        kaynak: { stringValue: 'Trendyol' },
        kanal: { stringValue: 'Trendyol' },
        platform: { stringValue: 'TRENDYOL' },

        // FİYAT VE TUTAR
        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },
        price: { doubleValue: tutarVal },

        // KURYE HAVUZUNA OTOMATİK DÜŞME ANAHTARLARI (Telefon Siparişi İle Birebir Aynı)
        durum: { stringValue: 'Yeni Siparis' },
        status: { stringValue: 'YENI' },
        havuzdaMi: { booleanValue: false },
        kuryeId: { stringValue: '' },

        // MÜŞTERİ BİLGİLERİ (Çift Yönlü İsimlendirme)
        musteriAdi: { stringValue: mAd },
        customerName: { stringValue: mAd },
        musteriTelefon: { stringValue: mTel },
        telefon: { stringValue: mTel },
        phone: { stringValue: mTel },

        // ADRES BİLGİLERİ
        teslimatAdresi: { stringValue: mAdres },
        adres: { stringValue: mAdres },
        address: { stringValue: mAdres },

        // OTOMATİK GPS ENLEM / BOYLAM (Kurye Haritası İçin)
        enlem: { doubleValue: latVal },
        boylam: { doubleValue: lngVal },
        konum: { stringValue: `${latVal}, ${lngVal}` },
        restoranEnlem: { doubleValue: 41.6771 },
        restoranBoylam: { doubleValue: 26.5557 },

        // ÜRÜN İÇERİĞİ VE DETAYLAR
        detay: { stringValue: urunMetni },
        urunler: { stringValue: urunMetni },
        urunDetay: { stringValue: urunMetni },

        // ZAMAN DAMGALARI
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

    return res.status(200).json({ status: 'OK', message: 'Sipariş başarıyla alındı ve kurye havuzuna aktarıldı' });
  } catch (error) {
    console.error('Trendyol Webhook Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// 3. YEMEKSEPETİ WEBHOOK UÇ NOKTASI (Canlı + Kurye Havuzu + Otomatik GPS)
app.post('/webhook/yemeksepeti', async (req, res) => {
  try {
    const data = req.body;
    console.log('🍔 YEMEKSEPETİ SİPARİŞİ GELDİ:', JSON.stringify(data, null, 2));

    const targetRestaurantId = String(data.restaurantId || data.vendorId || data.supplierId || '4455555333');
    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.price?.total || data.totalAmount || data.totalPrice || data.tutar || 0);

    // Müşteri Kimlik & Telefon
    const mAd = String(data.customer?.name || data.customerName || data.musteriAdi || 'Müşteri');
    const mTel = String(data.customer?.phone || data.telefon || data.phone || '');

    // Açık Teslimat Adresi
    const mAdres = String(data.delivery?.address || data.adres || data.address || 'Belirtilmedi');

    // Otomatik Enlem / Boylam Ayrıştırma (GPS)
    const latVal = Number(data.delivery?.location?.lat || data.delivery?.latitude || data.latitude || data.lat || 41.6771);
    const lngVal = Number(data.delivery?.location?.lng || data.delivery?.longitude || data.longitude || data.lng || 26.5557);

    // Ürün İçeriği ve Detay Metni Oluşturma
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

    const isletmeEmailVal = String(data.isletmeEmail || 'komegena@gmail.com');
    const restoranAdiVal = String(data.vendorName || data.restoran || data.isletmeAdi || 'KOMEGENA');

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderCode || data.siparisNo || data.id || 'YS-' + Date.now()) },
        
        // İŞLETME VE RESTORAN BİLGİLERİ
        isletmeEmail: { stringValue: isletmeEmailVal },
        isletmeAdi: { stringValue: restoranAdiVal },
        marketAdi: { stringValue: restoranAdiVal },
        supplierId: { stringValue: targetRestaurantId },
        restaurantId: { stringValue: targetRestaurantId },
        restoranId: { stringValue: targetRestaurantId },
        restoranName: { stringValue: restoranAdiVal },

        // KANAL VE PLATFORM
        kaynak: { stringValue: 'Yemeksepeti' },
        kanal: { stringValue: 'Yemeksepeti' },
        platform: { stringValue: 'YEMEKSEPETI' },

        // FİYAT VE TUTAR
        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },
        price: { doubleValue: tutarVal },

        // KURYE HAVUZUNA OTOMATİK DÜŞME ANAHTARLARI
        durum: { stringValue: 'Yeni Siparis' },
        status: { stringValue: 'YENI' },
        havuzdaMi: { booleanValue: false },
        kuryeId: { stringValue: '' },

        // MÜŞTERİ BİLGİLERİ
        musteriAdi: { stringValue: mAd },
        customerName: { stringValue: mAd },
        musteriTelefon: { stringValue: mTel },
        telefon: { stringValue: mTel },
        phone: { stringValue: mTel },

        // ADRES BİLGİLERİ
        teslimatAdresi: { stringValue: mAdres },
        adres: { stringValue: mAdres },
        address: { stringValue: mAdres },

        // OTOMATİK GPS ENLEM / BOYLAM
        enlem: { doubleValue: latVal },
        boylam: { doubleValue: lngVal },
        konum: { stringValue: `${latVal}, ${lngVal}` },
        restoranEnlem: { doubleValue: 41.6771 },
        restoranBoylam: { doubleValue: 26.5557 },

        // ÜRÜN İÇERİĞİ VE DETAYLAR
        detay: { stringValue: urunMetni },
        urunler: { stringValue: urunMetni },
        urunDetay: { stringValue: urunMetni },

        // ZAMAN DAMGALARI
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

    return res.status(200).json({ status: 'OK', message: 'Sipariş başarıyla alındı ve kurye havuzuna aktarıldı' });
  } catch (error) {
    console.error('Yemeksepeti Webhook Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda canlı olarak çalışıyor.`);
});
