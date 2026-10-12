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

  return { isletmeEmail, isletmeAdi, restoranEnlem, restoranBoylam };
}

// Yardımcı Ödeme Yöntemi Ayrıştırıcı (Nakit / POS / Online)
function parseOdemeTipi(paymentType, isPaid) {
  if (!paymentType) return isPaid ? 'Online Ödeme' : 'Nakit';
  
  const pStr = String(paymentType).toLowerCase();
  if (pStr.includes('cash') || pStr.includes('nakit')) return 'Nakit';
  if (pStr.includes('credit') || pStr.includes('pos') || pStr.includes('kredi')) return 'Kapıda Kredi Kartı';
  if (pStr.includes('online') || pStr.includes('prepaid') || pStr.includes('wallet') || pStr.includes('pay')) return 'Online Ödeme';
  
  return String(paymentType);
}

// =====================================================================
// 2. TRENDYOL KAPSAMLI WEBHOOK
// =====================================================================
app.post('/webhook/trendyol', async (req, res) => {
  try {
    const data = req.body;
    console.log('📦 TRENDYOL ÖZEL SİPARİŞİ GELDİ:', JSON.stringify(data, null, 2));

    const targetSupplierId = String(data.supplierId || data.merchantId || data.restaurantId || '4455555333');
    const isletmeInfo = await getIsletmeBilgileri(targetSupplierId);

    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.totalPrice || data.grossAmount || data.tutar || 0);

    // Kapsamlı Müşteri & Telefon & PIN Ayrıştırma
    const mAd = String(
      data.customer?.firstName 
        ? `${data.customer.firstName} ${data.customer.lastName || ''}`.trim() 
        : (data.musteriAdi || data.customerName || 'Müşteri')
    );
    const mTel = String(data.customer?.phone || data.telefon || data.phone || data.customerPhone || '');
    const mPin = String(data.customer?.pin || data.pinKodu || data.pin || data.extension || '');

    // Kapsamlı Adres & Not
    const addrObj = data.shipmentAddress || data.deliveryAddress || data.address || {};
    const mAdres = String(
      addrObj.fullAddress || 
      addrObj.addressLine1 || 
      `${addrObj.address1 || ''} ${addrObj.address2 || ''}`.trim() || 
      data.adres || 
      'Belirtilmedi'
    );
    
    const mNot = String(data.note || data.customerNote || addrObj.note || data.siparisNotu || '');

    // Kapsamlı GPS / Enlem-Boylam
    const latVal = Number(addrObj.latitude || data.latitude || data.lat || 41.6771);
    const lngVal = Number(addrObj.longitude || data.longitude || data.lng || 26.5557);

    // Ödeme Tipi
    const rawPayment = data.paymentType || data.paymentMethod || data.paymentMode || 'Online';
    const odemeYontemi = parseOdemeTipi(rawPayment, true);

    // Kapsamlı Ürün / Sepet Ayrıştırma
    let urunMetni = '1x Ürün';
    const rawLines = data.lines || data.items || data.products || [];
    if (Array.isArray(rawLines) && rawLines.length > 0) {
      urunMetni = rawLines.map(l => {
        const q = l.quantity || l.count || 1;
        const pName = l.productName || l.name || 'Ürün';
        const n = l.notes || l.note ? ` (Not: ${l.notes || l.note})` : '';
        return `${q}x ${pName}${n}`;
      }).join(', ');
    } else if (data.detay) {
      urunMetni = String(data.detay);
    }

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderNumber || data.siparisNo || data.id || 'TR-' + Date.now()) },
        sistemFiltresi: { stringValue: 'AERO_WEB_OZEL' },
        
        isletmeEmail: { stringValue: isletmeInfo.isletmeEmail },
        isletmeAdi: { stringValue: isletmeInfo.isletmeAdi },
        marketAdi: { stringValue: isletmeInfo.isletmeAdi },
        supplierId: { stringValue: targetSupplierId },
        
        kaynak: { stringValue: 'Trendyol' },
        kanal: { stringValue: 'Trendyol' },
        platform: { stringValue: 'TRENDYOL' },

        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },
        price: { doubleValue: tutarVal },

        durum: { stringValue: 'YENI' },
        status: { stringValue: 'YENI' },
        havuzdaMi: { booleanValue: false },
        kuryeId: { stringValue: '' },

        // MÜŞTERİ BİLGİLERİ (PIN & NOT EKLENDİ)
        musteriAdi: { stringValue: mAd },
        customerName: { stringValue: mAd },
        musteriTelefon: { stringValue: mTel },
        telefon: { stringValue: mTel },
        phone: { stringValue: mTel },
        pinKodu: { stringValue: mPin },
        pin: { stringValue: mPin },
        
        teslimatAdresi: { stringValue: mAdres },
        adres: { stringValue: mAdres },
        address: { stringValue: mAdres },
        not: { stringValue: mNot },
        siparisNotu: { stringValue: mNot },

        // ÖDEME BİLGİSİ
        odemeTipi: { stringValue: odemeYontemi },
        paymentType: { stringValue: odemeYontemi },

        // GPS
        enlem: { doubleValue: latVal },
        boylam: { doubleValue: lngVal },
        konum: { stringValue: `${latVal}, ${lngVal}` },
        restoranEnlem: { doubleValue: isletmeInfo.restoranEnlem },
        restoranBoylam: { doubleValue: isletmeInfo.restoranBoylam },

        // ÜRÜN
        detay: { stringValue: urunMetni },
        urunler: { stringValue: urunMetni },

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

    // Kapsamlı Müşteri & Telefon & PIN
    const mAd = String(data.customer?.name || data.customer?.firstName || data.customerName || data.musteriAdi || 'Müşteri');
    const mTel = String(data.customer?.phone || data.telefon || data.phone || '');
    const mPin = String(data.customer?.pin || data.customer?.extension || data.pinKodu || data.pin || '');

    // Adres & Not
    const deliv = data.delivery || data.address || {};
    const mAdres = String(deliv.address || deliv.fullAddress || data.adres || data.address || 'Belirtilmedi');
    const mNot = String(data.notes || data.customerNote || deliv.note || data.siparisNotu || '');

    // GPS
    const latVal = Number(deliv.location?.lat || deliv.location?.latitude || deliv.latitude || data.latitude || data.lat || 41.6771);
    const lngVal = Number(deliv.location?.lng || deliv.location?.longitude || deliv.longitude || data.longitude || data.lng || 26.5557);

    // Ödeme Tipi
    const rawPayment = data.paymentMethod || data.paymentType || data.paymentMode || 'Online';
    const odemeYontemi = parseOdemeTipi(rawPayment, data.isPaid || true);

    // Ürün Ayrıştırma
    let urunMetni = '1x Ürün';
    const rawItems = data.items || data.products || [];
    if (Array.isArray(rawItems) && rawItems.length > 0) {
      urunMetni = rawItems.map(i => {
        const q = i.quantity || i.count || 1;
        const pName = i.name || i.productName || 'Ürün';
        const n = i.notes || i.note ? ` (Not: ${i.notes || i.note})` : '';
        return `${q}x ${pName}${n}`;
      }).join(', ');
    } else if (data.detay) {
      urunMetni = String(data.detay);
    }

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderCode || data.siparisNo || data.id || 'YS-' + Date.now()) },
        sistemFiltresi: { stringValue: 'AERO_WEB_OZEL' },

        isletmeEmail: { stringValue: isletmeInfo.isletmeEmail },
        isletmeAdi: { stringValue: isletmeInfo.isletmeAdi },
        marketAdi: { stringValue: isletmeInfo.isletmeAdi },
        restaurantId: { stringValue: targetRestaurantId },

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

        // MÜŞTERİ BİLGİLERİ
        musteriAdi: { stringValue: mAd },
        customerName: { stringValue: mAd },
        musteriTelefon: { stringValue: mTel },
        telefon: { stringValue: mTel },
        phone: { stringValue: mTel },
        pinKodu: { stringValue: mPin },
        pin: { stringValue: mPin },
        
        teslimatAdresi: { stringValue: mAdres },
        adres: { stringValue: mAdres },
        address: { stringValue: mAdres },
        not: { stringValue: mNot },
        siparisNotu: { stringValue: mNot },

        // ÖDEME BİLGİSİ
        odemeTipi: { stringValue: odemeYontemi },
        paymentType: { stringValue: odemeYontemi },

        // GPS
        enlem: { doubleValue: latVal },
        boylam: { doubleValue: lngVal },
        konum: { stringValue: `${latVal}, ${lngVal}` },
        restoranEnlem: { doubleValue: isletmeInfo.restoranEnlem },
        restoranBoylam: { doubleValue: isletmeInfo.restoranBoylam },

        // ÜRÜN
        detay: { stringValue: urunMetni },
        urunler: { stringValue: urunMetni },

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
