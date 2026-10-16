const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1/projects/shopier-1d17c/databases/(default)/documents';

// Sağlık Kontrolü
app.get('/', (req, res) => {
  res.send('AERO Webhook Backend - CANLI MOD AKTİF 🟢');
});

// API Doğrulama
app.post('/validate-api', (req, res) => {
  return res.json({ success: true, message: 'API doğrulandı 🟢' });
});

// 1. DİNAMİK İŞLETME BİLGİSİ ÇEKME
async function getIsletmeBilgileri(targetId) {
  if (!targetId || targetId === 'undefined' || targetId === 'null') {
    throw new Error('Tedarikçi / Restoran ID eksik.');
  }

  let isletmeEmail = '';
  let isletmeAdi = '';
  let restoranEnlem = 41.6771;
  let restoranBoylam = 26.5557;

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
        restoranEnlem = Number(fields.enlem.doubleValue || fields.enlem.integerValue || 41.6771);
      }
      if (fields.boylam) {
        restoranBoylam = Number(fields.boylam.doubleValue || fields.boylam.integerValue || 26.5557);
      }
    }
  }

  if (!isletmeEmail) {
    throw new Error(`ID: ${targetId} için eşleşen aktif işletme bulunamadı.`);
  }

  return { isletmeEmail, isletmeAdi: isletmeAdi || 'KOMAGENE', restoranEnlem, restoranBoylam };
}

function parseOdemeTipi(paymentType, isPaid) {
  if (!paymentType) return isPaid ? 'Online Ödeme' : 'Nakit';
  const pStr = String(paymentType).toLowerCase();
  if (pStr.includes('cash') || pStr.includes('nakit')) return 'Nakit';
  if (pStr.includes('credit') || pStr.includes('pos') || pStr.includes('kredi') || pStr.includes('card')) return 'Kapıda Kredi Kartı';
  if (pStr.includes('online') || pStr.includes('prepaid') || pStr.includes('wallet') || pStr.includes('pay') || pStr.includes('yemekkarti')) return 'Online Ödeme';
  return String(paymentType);
}

// 2. TRENDYOL CANLI WEBHOOK
app.post('/webhook/trendyol', async (req, res) => {
  try {
    const data = req.body;
    const targetSupplierId = String(data.supplierId || data.merchantId || data.restaurantId || '');

    if (!targetSupplierId) {
      return res.status(400).json({ error: 'supplierId eksik.' });
    }

    const isletmeInfo = await getIsletmeBilgileri(targetSupplierId);
    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.totalPrice || data.grossAmount || data.settlementAmount || data.tutar || 0);

    const customerObj = data.customer || {};
    const mAd = String(
      customerObj.firstName 
        ? `${customerObj.firstName} ${customerObj.lastName || ''}`.trim() 
        : (data.musteriAdi || data.customerName || 'Trendyol Müşterisi')
    );
    const mTel = String(customerObj.phone || data.telefon || data.phone || data.customerPhone || '08502220000');
    const mPin = String(customerObj.pin || data.pinKodu || data.pin || customerObj.extension || '');

    const addrObj = data.shipmentAddress || data.deliveryAddress || data.address || {};
    let mAdres = String(
      addrObj.fullAddress || 
      addrObj.addressLine1 || 
      `${addrObj.address1 || ''} ${addrObj.address2 || ''}`.trim() || 
      data.adres || 
      'Adres Belirtilmedi'
    );
    if (addrObj.district || addrObj.city) {
      mAdres += ` (${addrObj.district || ''} / ${addrObj.city || ''})`.trim();
    }

    const mNot = String(data.note || data.customerNote || addrObj.note || data.siparisNotu || '');

    let latVal = Number(addrObj.latitude || data.latitude || data.lat || 0);
    let lngVal = Number(addrObj.longitude || data.longitude || data.lng || 0);
    if (latVal === 0) latVal = isletmeInfo.restoranEnlem;
    if (lngVal === 0) lngVal = isletmeInfo.restoranBoylam;

    const rawPayment = data.paymentType || data.paymentMethod || data.paymentMode || 'Online';
    const odemeYontemi = parseOdemeTipi(rawPayment, true);

    let urunMetni = '';
    const sepetArray = [];
    const rawLines = data.lines || data.items || data.products || [];

    if (Array.isArray(rawLines) && rawLines.length > 0) {
      urunMetni = rawLines.map(l => {
        const q = Number(l.quantity || l.count || 1);
        const pName = l.productName || l.name || 'Ürün';
        const priceVal = Number(l.price || l.unitPrice || tutarVal / rawLines.length || 0);

        // Kurye uygulamasının beklediği "sepet" dizisi oluşturuluyor
        sepetArray.push({
          mapValue: {
            fields: {
              isim: { stringValue: pName },
              adet: { integerValue: String(q) },
              fiyat: { doubleValue: priceVal }
            }
          }
        });

        let opts = '';
        if (Array.isArray(l.options) && l.options.length > 0) {
          opts = ` (${l.options.map(o => o.name || o).join(', ')})`;
        }
        const n = l.notes || l.note ? ` [Not: ${l.notes || l.note}]` : '';
        return `• ${q}x ${pName}${opts}${n}`;
      }).join('\n');
    } else {
      urunMetni = String(data.detay || '• 1x Sipariş Ürünü');
      sepetArray.push({
        mapValue: {
          fields: {
            isim: { stringValue: 'Sipariş Ürünü' },
            adet: { integerValue: "1" },
            fiyat: { doubleValue: tutarVal }
          }
        }
      });
    }

    // TELEFON SİPARİŞİ İLE %100 BİREBİR AYNI VERİ ŞEMASI (SCHEMA)
    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderNumber || data.siparisNo || data.id || 'TR-' + Date.now()) },
        sistemFiltresi: { stringValue: 'AERO_WEB_OZEL' },
        
        isletmeEmail: { stringValue: isletmeInfo.isletmeEmail },
        isletmeAdi: { stringValue: isletmeInfo.isletmeAdi.toUpperCase() },
        marketAdi: { stringValue: isletmeInfo.isletmeAdi.toUpperCase() },
        supplierId: { stringValue: targetSupplierId },
        
        kaynak: { stringValue: 'Trendyol' },
        kanal: { stringValue: 'Trendyol' },
        platform: { stringValue: 'TRENDYOL' },

        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },

        // Kurye uygulamasını çökmekten kurtaran kritik "sepet" dizisi
        sepet: { arrayValue: { values: sepetArray } },

        // Telefon siparişi durum standardı
        durum: { stringValue: 'YENI' },
        status: { stringValue: 'YENI' },
        isHazir: { booleanValue: false },
        isWebArsiv: { booleanValue: false },
        havuzdaMi: { booleanValue: false },
        kuryeId: { stringValue: '' },
        kuryeAdi: { stringValue: '' },

        musteriAdi: { stringValue: mAd },
        customerName: { stringValue: mAd },
        musteriTelefon: { stringValue: mTel },
        musteriTel: { stringValue: mTel },
        telefon: { stringValue: mTel },
        phone: { stringValue: mTel },
        pinKodu: { stringValue: mPin },
        pin: { stringValue: mPin },
        
        teslimatAdresi: { stringValue: mAdres },
        adres: { stringValue: mAdres },
        address: { stringValue: mAdres },
        not: { stringValue: mNot },
        siparisNotu: { stringValue: mNot },

        odemeTipi: { stringValue: odemeYontemi },
        paymentType: { stringValue: odemeYontemi },

        enlem: { doubleValue: latVal },
        boylam: { doubleValue: lngVal },
        konum: { stringValue: `${latVal}, ${lngVal}` },
        restoranEnlem: { doubleValue: isletmeInfo.restoranEnlem },
        restoranBoylam: { doubleValue: isletmeInfo.restoranBoylam },

        detay: { stringValue: urunMetni },
        sepetDetay: { stringValue: urunMetni },
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

    return res.status(200).json({ status: 'OK' });
  } catch (error) {
    console.error('Trendyol Webhook Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// 3. YEMEKSEPETİ CANLI WEBHOOK
app.post('/webhook/yemeksepeti', async (req, res) => {
  try {
    const data = req.body;
    const targetRestaurantId = String(data.restaurantId || data.vendorId || data.supplierId || '');

    if (!targetRestaurantId) {
      return res.status(400).json({ error: 'restaurantId eksik.' });
    }

    const isletmeInfo = await getIsletmeBilgileri(targetRestaurantId);
    const nowIso = new Date().toISOString();
    const tutarVal = Number(data.price?.total || data.totalAmount || data.totalPrice || data.tutar || 0);

    const customerObj = data.customer || {};
    const mAd = String(customerObj.name || customerObj.firstName || data.customerName || data.musteriAdi || 'Yemeksepeti Müşterisi');
    const mTel = String(customerObj.phone || data.delivery?.phone || data.telefon || data.phone || '');
    const mPin = String(customerObj.pin || customerObj.extension || data.pinKodu || data.pin || '');

    const deliv = data.delivery || data.address || {};
    let mAdres = String(deliv.address || deliv.fullAddress || data.adres || data.address || 'Adres Belirtilmedi');
    if (deliv.district || deliv.city) {
      mAdres += ` (${deliv.district || ''} / ${deliv.city || ''})`.trim();
    }

    const mNot = String(data.notes || data.customerNote || deliv.note || data.siparisNotu || '');

    let latVal = Number(deliv.location?.lat || deliv.location?.latitude || deliv.latitude || data.latitude || data.lat || 0);
    let lngVal = Number(deliv.location?.lng || deliv.location?.longitude || deliv.longitude || data.longitude || data.lng || 0);
    if (latVal === 0) latVal = isletmeInfo.restoranEnlem;
    if (lngVal === 0) lngVal = isletmeInfo.restoranBoylam;

    const rawPayment = data.paymentMethod || data.paymentType || data.paymentMode || 'Online';
    const odemeYontemi = parseOdemeTipi(rawPayment, data.isPaid !== false);

    let urunMetni = '';
    const sepetArray = [];
    const rawItems = data.items || data.products || [];

    if (Array.isArray(rawItems) && rawItems.length > 0) {
      urunMetni = rawItems.map(i => {
        const q = Number(i.quantity || i.count || 1);
        const pName = i.name || i.productName || 'Ürün';
        const priceVal = Number(i.price || i.unitPrice || tutarVal / rawItems.length || 0);

        // Kurye uygulamasının beklediği "sepet" dizisi oluşturuluyor
        sepetArray.push({
          mapValue: {
            fields: {
              isim: { stringValue: pName },
              adet: { integerValue: String(q) },
              fiyat: { doubleValue: priceVal }
            }
          }
        });

        let opts = '';
        if (Array.isArray(i.options) && i.options.length > 0) {
          opts = ` (${i.options.map(o => o.name || o).join(', ')})`;
        } else if (Array.isArray(i.selectedToppings) && i.selectedToppings.length > 0) {
          opts = ` (${i.selectedToppings.map(t => t.name || t).join(', ')})`;
        }
        const n = i.notes || i.note ? ` [Not: ${i.notes || i.note}]` : '';
        return `• ${q}x ${pName}${opts}${n}`;
      }).join('\n');
    } else {
      urunMetni = String(data.detay || '• 1x Sipariş Ürünü');
      sepetArray.push({
        mapValue: {
          fields: {
            isim: { stringValue: 'Sipariş Ürünü' },
            adet: { integerValue: "1" },
            fiyat: { doubleValue: tutarVal }
          }
        }
      });
    }

    // TELEFON SİPARİŞİ İLE %100 BİREBİR AYNI VERİ ŞEMASI (SCHEMA)
    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderCode || data.siparisNo || data.id || 'YS-' + Date.now()) },
        sistemFiltresi: { stringValue: 'AERO_WEB_OZEL' },

        isletmeEmail: { stringValue: isletmeInfo.isletmeEmail },
        isletmeAdi: { stringValue: isletmeInfo.isletmeAdi.toUpperCase() },
        marketAdi: { stringValue: isletmeInfo.isletmeAdi.toUpperCase() },
        restaurantId: { stringValue: targetRestaurantId },

        kaynak: { stringValue: 'Yemeksepeti' },
        kanal: { stringValue: 'Yemeksepeti' },
        platform: { stringValue: 'YEMEKSEPETI' },

        tutar: { doubleValue: tutarVal },
        toplamTutar: { doubleValue: tutarVal },

        // Kurye uygulamasını çökmekten kurtaran kritik "sepet" dizisi
        sepet: { arrayValue: { values: sepetArray } },

        // Telefon siparişi durum standardı
        durum: { stringValue: 'YENI' },
        status: { stringValue: 'YENI' },
        isHazir: { booleanValue: false },
        isWebArsiv: { booleanValue: false },
        havuzdaMi: { booleanValue: false },
        kuryeId: { stringValue: '' },
        kuryeAdi: { stringValue: '' },

        musteriAdi: { stringValue: mAd },
        customerName: { stringValue: mAd },
        musteriTelefon: { stringValue: mTel },
        musteriTel: { stringValue: mTel },
        telefon: { stringValue: mTel },
        phone: { stringValue: mTel },
        pinKodu: { stringValue: mPin },
        pin: { stringValue: mPin },
        
        teslimatAdresi: { stringValue: mAdres },
        adres: { stringValue: mAdres },
        address: { stringValue: mAdres },
        not: { stringValue: mNot },
        siparisNotu: { stringValue: mNot },

        odemeTipi: { stringValue: odemeYontemi },
        paymentType: { stringValue: odemeYontemi },

        enlem: { doubleValue: latVal },
        boylam: { doubleValue: lngVal },
        konum: { stringValue: `${latVal}, ${lngVal}` },
        restoranEnlem: { doubleValue: isletmeInfo.restoranEnlem },
        restoranBoylam: { doubleValue: isletmeInfo.restoranBoylam },

        detay: { stringValue: urunMetni },
        sepetDetay: { stringValue: urunMetni },
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

    return res.status(200).json({ status: 'OK' });
  } catch (error) {
    console.error('Yemeksepeti Webhook Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// 4. DURUM GÜNCELLEME
app.post('/update-order-status', async (req, res) => {
  try {
    const { siparisId, durum } = req.body;
    if (!siparisId || !durum) {
      return res.status(400).json({ error: 'siparisId ve durum parametreleri zorunludur.' });
    }

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

    return res.json({ success: true });
  } catch (error) {
    console.error('Durum Güncelleme Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AERO Backend ${PORT} portunda canlı modda çalışıyor.`);
});
