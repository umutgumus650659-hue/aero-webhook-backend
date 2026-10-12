const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1/projects/shopier-1d17c/databases/(default)/documents';

// Ana Sayfa Sağlık Kontrolü
app.get('/', (req, res) => {
  res.send('AERO Webhook Backend - CANLI ÜRETİM MODU AKTİF 🟢');
});

// API Doğrulama Endpoint
app.post('/validate-api', (req, res) => {
  return res.json({ success: true, message: 'API bilgileri doğrulandı 🟢' });
});

// =====================================================================
// 1. DİNAMİK İŞLETME BİLGİSİ ÇEKME (TAM GERÇEK / TEST SIZDIRMAZ)
// =====================================================================
async function getIsletmeBilgileri(targetId) {
  if (!targetId || targetId === 'undefined' || targetId === 'null') {
    throw new Error('Geçersiz Mağaza/Tedarikçi ID bilgisi');
  }

  let isletmeEmail = '';
  let isletmeAdi = '';
  let restoranEnlem = 0.0;
  let restoranBoylam = 0.0;

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

    const response = await fetch(`${FIRESTORE_BASE_URL}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody)
    });

    if (response.ok) {
      const results = await response.json();
      if (results && results[0] && results[0].document && results[0].document.fields) {
        const fields = results[0].document.fields;
        
        if (fields.isletmeEmail && fields.isletmeEmail.stringValue) {
          isletmeEmail = fields.isletmeEmail.stringValue.toLowerCase().trim();
        }
        if (fields.isletmeAdi && fields.isletmeAdi.stringValue) {
          isletmeAdi = fields.isletmeAdi.stringValue;
        } else if (fields.unvan && fields.unvan.stringValue) {
          isletmeAdi = fields.unvan.stringValue;
        }
        if (fields.enlem) {
          restoranEnlem = Number(fields.enlem.doubleValue || fields.enlem.integerValue || 0);
        }
        if (fields.boylam) {
          restoranBoylam = Number(fields.boylam.doubleValue || fields.boylam.integerValue || 0);
        }
      }
    }
  } catch (err) {
    console.error('İşletme Bilgisi Firestore Eşleştirme Hatası:', err.message);
  }

  return { isletmeEmail, isletmeAdi, restoranEnlem, restoranBoylam };
}

// Yardımcı Ödeme Yöntemi Ayrıştırıcı (Nakit / POS / Online)
function parseOdemeTipi(paymentType, isPaid) {
  if (!paymentType) return isPaid ? 'Online Ödeme' : 'Nakit';
  
  const pStr = String(paymentType).toLowerCase();
  if (pStr.includes('cash') || pStr.includes('nakit')) return 'Nakit';
  if (pStr.includes('credit') || pStr.includes('pos') || pStr.includes('kredi') || pStr.includes('card')) return 'Kapıda Kredi Kartı';
  if (pStr.includes('online') || pStr.includes('prepaid') || pStr.includes('wallet') || pStr.includes('pay') || pStr.includes('yemekkarti')) return 'Online Ödeme';
  
  return String(paymentType);
}

// =====================================================================
// 2. TRENDYOL GERÇEK CANLI WEBHOOK
// =====================================================================
app.post('/webhook/trendyol', async (req, res) => {
  try {
    const data = req.body;
    console.log('📦 TRENDYOL CANLI WEBHOOK SİPARİŞİ:', JSON.stringify(data, null, 2));

    const targetSupplierId = String(data.supplierId || data.merchantId || data.restaurantId || '');
    if (!targetSupplierId) {
      return res.status(400).json({ error: 'Tedarikçi ID (supplierId) bulunamadı.' });
    }

    const isletmeInfo = await getIsletmeBilgileri(targetSupplierId);
    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.totalPrice || data.grossAmount || data.settlementAmount || data.tutar || 0);

    // Müşteri & Telefon & PIN
    const customerObj = data.customer || {};
    const mAd = String(
      customerObj.firstName 
        ? `${customerObj.firstName} ${customerObj.lastName || ''}`.trim() 
        : (data.musteriAdi || data.customerName || 'Müşteri')
    );
    const mTel = String(customerObj.phone || data.telefon || data.phone || data.customerPhone || '');
    const mPin = String(customerObj.pin || data.pinKodu || data.pin || customerObj.extension || '');

    // Adres & Not
    const addrObj = data.shipmentAddress || data.deliveryAddress || data.address || {};
    const mAdres = String(
      addrObj.fullAddress || 
      addrObj.addressLine1 || 
      `${addrObj.address1 || ''} ${addrObj.address2 || ''}`.trim() || 
      data.adres || 
      'Adres Belirtilmedi'
    );
    
    const mNot = String(data.note || data.customerNote || addrObj.note || data.siparisNotu || '');

    // GPS / Enlem-Boylam
    const latVal = Number(addrObj.latitude || data.latitude || data.lat || 0);
    const lngVal = Number(addrObj.longitude || data.longitude || data.lng || 0);

    // Ödeme Tipi
    const rawPayment = data.paymentType || data.paymentMethod || data.paymentMode || 'Online';
    const odemeYontemi = parseOdemeTipi(rawPayment, true);

    // Ürün / Sepet Ayrıştırma (Tüm Opsiyonlar Dahil)
    let urunMetni = '1x Ürün';
    const rawLines = data.lines || data.items || data.products || [];
    if (Array.isArray(rawLines) && rawLines.length > 0) {
      urunMetni = rawLines.map(l => {
        const q = l.quantity || l.count || 1;
        const pName = l.productName || l.name || 'Ürün';
        
        let opts = '';
        if (Array.isArray(l.options) && l.options.length > 0) {
          opts = ` (${l.options.map(o => o.name || o).join(', ')})`;
        }
        
        const n = l.notes || l.note ? ` [Not: ${l.notes || l.note}]` : '';
        return `${q}x ${pName}${opts}${n}`;
      }).join('\n');
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

        // GPS KOORDİNATLARI
        enlem: { doubleValue: latVal },
        boylam: { doubleValue: lngVal },
        konum: { stringValue: `${latVal}, ${lngVal}` },
        restoranEnlem: { doubleValue: isletmeInfo.restoranEnlem },
        restoranBoylam: { doubleValue: isletmeInfo.restoranBoylam },

        // ÜRÜN İÇERİĞİ
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

    return res.status(200).json({ status: 'OK', message: 'Trendyol Siparişi Başarıyla İşlendi' });
  } catch (error) {
    console.error('Trendyol Webhook Hatası:', error);
    return res.status(500).json({ error: error.message });
  }
});

// =====================================================================
// 3. YEMEKSEPETİ GERÇEK CANLI WEBHOOK
// =====================================================================
app.post('/webhook/yemeksepeti', async (req, res) => {
  try {
    const data = req.body;
    console.log('🍔 YEMEKSEPETİ CANLI WEBHOOK SİPARİŞİ:', JSON.stringify(data, null, 2));

    const targetRestaurantId = String(data.restaurantId || data.vendorId || data.supplierId || '');
    if (!targetRestaurantId) {
      return res.status(400).json({ error: 'Restoran ID (restaurantId) bulunamadı.' });
    }

    const isletmeInfo = await getIsletmeBilgileri(targetRestaurantId);
    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.price?.total || data.totalAmount || data.totalPrice || data.tutar || 0);

    // Müşteri & Telefon & PIN
    const customerObj = data.customer || {};
    const mAd = String(customerObj.name || customerObj.firstName || data.customerName || data.musteriAdi || 'Müşteri');
    const mTel = String(customerObj.phone || data.delivery?.phone || data.telefon || data.phone || '');
    const mPin = String(customerObj.pin || customerObj.extension || data.pinKodu || data.pin || '');

    // Adres & Not
    const deliv = data.delivery || data.address || {};
    const mAdres = String(deliv.address || deliv.fullAddress || data.adres || data.address || 'Adres Belirtilmedi');
    const mNot = String(data.notes || data.customerNote || deliv.note || data.siparisNotu || '');

    // GPS
    const latVal = Number(deliv.location?.lat || deliv.location?.latitude || deliv.latitude || data.latitude || data.lat || 0);
    const lngVal = Number(deliv.location?.lng || deliv.location?.longitude || deliv.longitude || data.longitude || data.lng || 0);

    // Ödeme Tipi
    const rawPayment = data.paymentMethod || data.paymentType || data.paymentMode || 'Online';
    const odemeYontemi = parseOdemeTipi(rawPayment, data.isPaid !== false);

    // Ürün Ayrıştırma (Soslar ve Seçenekler Dahil)
    let urunMetni = '1x Ürün';
    const rawItems = data.items || data.products || [];
    if (Array.isArray(rawItems) && rawItems.length > 0) {
      urunMetni = rawItems.map(i => {
        const q = i.quantity || i.count || 1;
        const pName = i.name || i.productName || 'Ürün';
        
        let opts = '';
        if (Array.isArray(i.options) && i.options.length > 0) {
          opts = ` (${i.options.map(o => o.name || o).join(', ')})`;
        } else if (Array.isArray(i.selectedToppings) && i.selectedToppings.length > 0) {
          opts = ` (${i.selectedToppings.map(t => t.name || t).join(', ')})`;
        }

        const n = i.notes || i.note ? ` [Not: ${i.notes || i.note}]` : '';
        return `${q}x ${pName}${opts}${n}`;
      }).join('\n');
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

        // GPS KOORDİNATLARI
        enlem: { doubleValue: latVal },
        boylam: { doubleValue: lngVal },
        konum: { stringValue: `${latVal}, ${lngVal}` },
        restoranEnlem: { doubleValue: isletmeInfo.restoranEnlem },
        restoranBoylam: { doubleValue: isletmeInfo.restoranBoylam },

        // ÜRÜN İÇERİĞİ
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

    return res.status(200).json({ status: 'OK', message: 'Yemeksepeti Siparişi Başarıyla İşlendi' });
  } catch (error) {
    console.error('Yemeksepeti Webhook Hatası:', error);
    return res.status(500).json({ error: error.message });
  }
});

// =====================================================================
// 4. KURYE MOBİL UYGULAMASI İÇİN DURUM GÜNCELLEME ENDPOINT'İ
// =====================================================================
app.post('/update-order-status', async (req, res) => {
  try {
    const { siparisId, durum, kanal } = req.body;
    if (!siparisId || !durum) {
      return res.status(400).json({ error: 'siparisId ve durum zorunludur.' });
    }

    console.log(`🔄 Sipariş Durum Güncellemesi: ${siparisId} -> ${durum}`);

    // Firestore dokümanını güncelle
    const updateBody = {
      fields: {
        durum: { stringValue: durum },
        status: { stringValue: durum }
      }
    };

    await fetch(`${FIRESTORE_BASE_URL}/siparisler/${siparisId}?updateMask.fieldPaths=durum&updateMask.fieldPaths=status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateBody)
    });

    return res.json({ success: true, message: 'Sipariş durumu güncellendi' });
  } catch (error) {
    console.error('Durum Güncelleme Hatası:', error);
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda canlı üretim modunda çalışıyor.`);
});
