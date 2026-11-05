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
async function getIsletmeBilgileri(targetId, rawStoreName = '') {
  if (!targetId || targetId === 'undefined' || targetId === 'null') {
    throw new Error('Tedarikçi / Restoran ID eksik.');
  }

  let isletmeEmail = '';
  let isletmeAdi = rawStoreName || '';
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

  try {
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
  } catch (err) {
    console.error('İşletme bilgisi Firestore okuma uyarısı:', err.message);
  }

  // Eğer Firestore'da henüz email yoksa varsayılan dinamik sistem e-postası atar
  if (!isletmeEmail) {
    isletmeEmail = `isletme_${targetId}@aero.com`;
  }

  return { 
    isletmeEmail, 
    isletmeAdi: (isletmeAdi || rawStoreName || 'RESTORAN').toUpperCase(), 
    restoranEnlem, 
    restoranBoylam 
  };
}

// ----------------------------------------------------
// PLATFORMLARA CANLI GERİ BİLDİRİM GÖNDERME SERVİSLERİ
// ----------------------------------------------------

async function getIsletmeEntegrasyonByEmail(email) {
  if (!email) return null;
  try {
    const response = await fetch(`${FIRESTORE_BASE_URL}/isletme_entegrasyonlar/${email.toLowerCase().trim()}`);
    if (response.ok) {
      const doc = await response.json();
      if (doc && doc.fields) {
        const fields = doc.fields;
        return {
          trSupplierId: fields.trSupplierId?.stringValue || '',
          trApiKey: fields.trApiKey?.stringValue || '',
          trApiSecret: fields.trApiSecret?.stringValue || '',
          ysRestoranId: fields.ysRestoranId?.stringValue || '',
          ysToken: fields.ysToken?.stringValue || ''
        };
      }
    }
  } catch (e) {
    console.error('Entegrasyon anahtarı okuma hatası:', e.message);
  }
  return null;
}

// Trendyol GO Canlı Status Güncelleme
async function sendTrendyolStatusUpdate(supplierId, orderId, durum, apiKeys) {
  try {
    let tyStatus = 'Picking';
    const dLower = String(durum).toLowerCase().trim();

    if (dLower.includes('teslim')) {
      tyStatus = 'Delivered';
    } else if (dLower.includes('yolda') || dLower.includes('atandi') || dLower.includes('kurye') || dLower.includes('dagitim')) {
      tyStatus = 'InDelivery';
    } else if (dLower.includes('hazır') || dLower.includes('hazirlan') || dLower.includes('havuz') || dLower.includes('bekliyor')) {
      tyStatus = 'Picking';
    }

    const authHeader = 'Basic ' + Buffer.from(`${apiKeys.trApiKey}:${apiKeys.trApiSecret}`).toString('base64');
    const url = `https://api.trendyol.com/sapigw/suppliers/${supplierId}/orders/${orderId}/status`;
    
    await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'User-Agent': `${supplierId} - SelfIntegration`
      },
      body: JSON.stringify({ status: tyStatus })
    });
    console.log(`Trendyol Sipariş (${orderId}) [Web Durumu: "${durum}"] -> Trendyol API: ${tyStatus} 🟢`);
  } catch (e) {
    console.error('Trendyol Status Bildirim Hatası:', e.message);
  }
}

// Yemeksepeti Canlı Status Güncelleme
async function sendYemeksepetiStatusUpdate(restaurantId, orderCode, durum, apiKeys) {
  try {
    let ysStatus = 'in_preparation';
    const dLower = String(durum).toLowerCase().trim();

    if (dLower.includes('teslim')) {
      ysStatus = 'delivered';
    } else if (dLower.includes('yolda') || dLower.includes('atandi') || dLower.includes('kurye') || dLower.includes('dagitim')) {
      ysStatus = 'in_delivery';
    } else if (dLower.includes('hazır') || dLower.includes('hazirlan') || dLower.includes('havuz') || dLower.includes('bekliyor')) {
      ysStatus = 'in_preparation';
    }

    const url = `https://connect.deliveryhero.com/api/v1/vendors/${restaurantId}/orders/${orderCode}/status`;
    
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKeys.ysToken}`
      },
      body: JSON.stringify({ status: ysStatus })
    });
    console.log(`Yemeksepeti Sipariş (${orderCode}) [Web Durumu: "${durum}"] -> Yemeksepeti API: ${ysStatus} 🟢`);
  } catch (e) {
    console.error('Yemeksepeti Status Bildirim Hatası:', e.message);
  }
}

// Gelişmiş Ödeme Tipi Ayrıştırıcı
function parseOdemeTipi(paymentType, paymentMethod, isPaid) {
  const pStr = String(paymentType || paymentMethod || '').toLowerCase();
  if (pStr.includes('cash') || pStr.includes('nakit')) return 'Nakit';
  if (pStr.includes('credit') || pStr.includes('pos') || pStr.includes('kredi') || pStr.includes('card')) return 'Kapıda Kredi Kartı';
  if (pStr.includes('online') || pStr.includes('prepaid') || pStr.includes('wallet') || pStr.includes('pay') || pStr.includes('yemekkarti')) return 'Online Ödeme';
  return isPaid !== false ? 'Online Ödeme' : 'Nakit';
}

// 2. TRENDYOL CANLI WEBHOOK (EKSİKSİZ VE DİNAMİK)
app.post('/webhook/trendyol', async (req, res) => {
  console.log('=== [TRENDYOL CANLI WEBHOOK PAKETİ GELDI] ===');
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const data = req.body;
    const targetSupplierId = String(data.supplierId || data.merchantId || data.restaurantId || data.storeId || '');

    if (!targetSupplierId) {
      return res.status(200).json({ status: 'OK', message: 'supplierId bulunamadı ancak istek kabul edildi.' });
    }

    // Dinamik Restoran Adı
    const rawStoreName = data.storeName || data.sellerName || data.supplierName || '';
    const isletmeInfo = await getIsletmeBilgileri(targetSupplierId, rawStoreName);
    const nowIso = new Date().toISOString();
    
    // Tutar Ayrıştırma
    const paymentObj = data.payment || {};
    const tutarVal = Number(
      paymentObj.totalPrice || 
      paymentObj.price || 
      data.totalPrice || 
      data.grossAmount || 
      data.totalAmount ||
      data.settlementAmount || 
      0
    );

    // Müşteri Bilgileri
    const customerObj = data.customer || {};
    const mAd = String(
      customerObj.firstName 
        ? `${customerObj.firstName} ${customerObj.lastName || ''}`.trim() 
        : (data.musteriAdi || data.customerName || 'Trendyol Müşterisi')
    );
    const mTel = String(customerObj.phone || data.deliveryAddress?.phone || data.telefon || data.phone || '08502220000');
    
    // PIN Kodu
    const mPin = String(customerObj.pinCode || customerObj.pin || customerObj.extension || data.deliveryAddress?.extension || data.pinKodu || '');

    // Adres Ayrıştırma
    const addrObj = data.deliveryAddress || data.shipmentAddress || data.address || {};
    let mAdres = String(
      addrObj.addressText ||
      addrObj.fullAddress || 
      addrObj.addressLine1 || 
      `${addrObj.address1 || ''} ${addrObj.address2 || ''}`.trim() || 
      data.adres || 
      'Adres Belirtilmedi'
    );
    if (addrObj.district || addrObj.city) {
      mAdres += ` (${addrObj.district || ''} / ${addrObj.city || ''})`.trim();
    }

    const mNot = String(data.note || data.customerNote || addrObj.note || addrObj.notes || data.siparisNotu || '');

    // Enlem - Boylam Yakalama
    let latVal = Number(addrObj.latitude || addrObj.lat || data.latitude || data.lat || 0);
    let lngVal = Number(addrObj.longitude || addrObj.lng || data.longitude || data.lng || 0);
    if (latVal === 0) latVal = isletmeInfo.restoranEnlem;
    if (lngVal === 0) lngVal = isletmeInfo.restoranBoylam;

    // Ödeme Tipi
    const odemeYontemi = parseOdemeTipi(paymentObj.paymentType, data.paymentMethod, true);

    // Ürün Ayrıştırma
    let urunMetni = '';
    const sepetArray = [];
    const rawLines = data.packageItems || data.lines || data.items || data.products || [];

    if (Array.isArray(rawLines) && rawLines.length > 0) {
      urunMetni = rawLines.map(l => {
        const q = Number(l.quantity || l.count || l.adet || 1);
        const pName = l.productName || l.name || l.isim || 'Ürün';
        const priceVal = Number(l.price || l.unitPrice || l.fiyat || (tutarVal > 0 ? tutarVal / rawLines.length : 0));

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
          opts = ` (${l.options.map(o => (typeof o === 'object' ? (o.optionName || o.name || o.value || o) : o)).join(', ')})`;
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

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(data.orderId || data.orderNumber || data.siparisNo || data.id || 'TR-' + Date.now()) },
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

        sepet: { arrayValue: { values: sepetArray } },

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

    console.log(`✅ Trendyol Siparişi Kaydedildi: [${isletmeInfo.isletmeAdi}] - ${mAd} (${tutarVal} TL)`);
    return res.status(200).json({ status: 'OK' });
  } catch (error) {
    console.error('Trendyol Webhook Hatası:', error.message);
    return res.status(200).json({ status: 'OK', error: error.message });
  }
});

// 3. YEMEKSEPETİ CANLI WEBHOOK (EKSİKSİZ VE DİNAMİK)
app.post('/webhook/yemeksepeti', async (req, res) => {
  console.log('=== [YEMEKSEPETİ CANLI WEBHOOK PAKETİ GELDI] ===');
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const data = req.body;
    const orderObj = data.order || data;
    
    const targetRestaurantId = String(data.vendor_id || data.restaurantId || data.vendorId || data.supplierId || orderObj.vendor_id || '');

    if (!targetRestaurantId) {
      return res.status(200).json({ status: 'OK', message: 'vendor_id bulunamadı.' });
    }

    const rawStoreName = data.vendorName || data.restaurantName || orderObj.vendor_name || '';
    const isletmeInfo = await getIsletmeBilgileri(targetRestaurantId, rawStoreName);
    const nowIso = new Date().toISOString();
    
    const tutarVal = Number(
      orderObj.price?.grand_total || 
      orderObj.price?.total ||
      data.price?.total || 
      data.totalAmount || 
      data.totalPrice || 
      0
    );

    const customerObj = orderObj.customer || data.customer || {};
    const mAd = String(
      customerObj.first_name 
        ? `${customerObj.first_name} ${customerObj.last_name || ''}`.trim()
        : (customerObj.name || customerObj.firstName || data.customerName || 'Yemeksepeti Müşterisi')
    );
    const mTel = String(customerObj.phone || data.delivery?.phone || data.telefon || '08508880000');
    const mPin = String(customerObj.extension_code || customerObj.pinCode || customerObj.pin || '');

    const delivObj = orderObj.delivery || data.delivery || data.address || {};
    const delivAddr = delivObj.address || delivObj;
    
    let mAdres = String(
      delivAddr.full_address || 
      delivAddr.fullAddress || 
      delivAddr.address || 
      `${delivAddr.street || ''} No:${delivAddr.building_number || ''} D:${delivAddr.flat_number || ''}`.trim() || 
      'Adres Belirtilmedi'
    );
    if (delivAddr.district || delivAddr.city) {
      mAdres += ` (${delivAddr.district || ''} / ${delivAddr.city || ''})`.trim();
    }

    const mNot = String(delivObj.instructions || data.notes || data.customerNote || delivAddr.note || '');

    let latVal = Number(delivAddr.latitude || delivAddr.lat || delivObj.location?.lat || 0);
    let lngVal = Number(delivAddr.longitude || delivAddr.lng || delivObj.location?.lng || 0);
    if (latVal === 0) latVal = isletmeInfo.restoranEnlem;
    if (lngVal === 0) lngVal = isletmeInfo.restoranBoylam;

    const rawPayment = orderObj.payment?.type || data.paymentMethod || data.paymentType;
    const odemeYontemi = parseOdemeTipi(rawPayment, null, data.isPaid !== false);

    let urunMetni = '';
    const sepetArray = [];
    const rawItems = orderObj.products || data.items || data.products || [];

    if (Array.isArray(rawItems) && rawItems.length > 0) {
      urunMetni = rawItems.map(i => {
        const q = Number(i.quantity || i.count || i.adet || 1);
        const pName = i.name || i.productName || 'Ürün';
        const priceVal = Number(i.unit_price || i.price || i.unitPrice || (tutarVal > 0 ? tutarVal / rawItems.length : 0));

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
        const selectedOpts = i.selected_options || i.options || i.selectedToppings;
        if (Array.isArray(selectedOpts) && selectedOpts.length > 0) {
          opts = ` (${selectedOpts.map(o => (typeof o === 'object' ? (o.value || o.name || o) : o)).join(', ')})`;
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

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(orderObj.code || orderObj.id || data.orderCode || data.siparisNo || 'YS-' + Date.now()) },
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

        sepet: { arrayValue: { values: sepetArray } },

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

    console.log(`✅ Yemeksepeti Siparişi Kaydedildi: [${isletmeInfo.isletmeAdi}] - ${mAd} (${tutarVal} TL)`);
    return res.status(200).json({ status: 'OK' });
  } catch (error) {
    console.error('Yemeksepeti Webhook Hatası:', error.message);
    return res.status(200).json({ status: 'OK', error: error.message });
  }
});

// 4. DURUM GÜNCELLEME VEYA GERİ BİLDİRİM TETİKLEME
app.post('/update-order-status', async (req, res) => {
  try {
    const { siparisId, durum, kanal, isletmeEmail } = req.body;
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

    if (isletmeEmail && kanal) {
      getIsletmeEntegrasyonByEmail(isletmeEmail).then(apiKeys => {
        if (!apiKeys) return;

        const kLower = String(kanal).toLowerCase();
        if (kLower.includes('trendyol') && apiKeys.trSupplierId && apiKeys.trApiKey) {
          sendTrendyolStatusUpdate(apiKeys.trSupplierId, siparisId, durum, apiKeys);
        } else if (kLower.includes('yemeksepeti') && apiKeys.ysRestoranId && apiKeys.ysToken) {
          sendYemeksepetiStatusUpdate(apiKeys.ysRestoranId, siparisId, durum, apiKeys);
        }
      }).catch(err => console.error('Geri bildirim hazırlık hatası:', err.message));
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Durum Güncelleme Hatası:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AERO Backend ${PORT} portunda canlı ve tam dinamik modda çalışıyor.`);
});
