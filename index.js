const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1/projects/shopier-1d17c/databases/(default)/documents';

// 🚀 HAFIZA İÇİ MÜKERRER KİLİT MEKANİZMASI (Race Condition %100 Engeller)
const processingOrdersLock = new Map();

function isOrderLocked(siparisNo) {
  if (!siparisNo) return false;
  const now = Date.now();
  if (processingOrdersLock.has(siparisNo)) {
    const lockTime = processingOrdersLock.get(siparisNo);
    if (now - lockTime < 30000) { // 30 Saniye boyunca kilitle
      return true;
    }
  }
  processingOrdersLock.set(siparisNo, now);
  return false;
}

// Sağlık Kontrolü
app.get('/', (req, res) => {
  res.send('AERO Webhook Backend - CANLI MOD AKTİF 🟢');
});

// API Doğrulama
app.post('/validate-api', (req, res) => {
  return res.json({ success: true, message: 'API doğrulandı 🟢' });
});

// 1. DİNAMİK İŞLETME BİLGİSİ ÇEKME
async function getIsletmeBilgileri(targetId, storeId = '', rawStoreName = '') {
  const searchId = String(targetId || storeId || '').trim();
  if (!searchId || searchId === 'undefined' || searchId === 'null') {
    return {
      isletmeEmail: 'isletme_bilinmeyen@aero.com',
      isletmeAdi: (rawStoreName || 'RESTORAN').toUpperCase(),
      restoranEnlem: 41.6771,
      restoranBoylam: 26.5557
    };
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
            { fieldFilter: { field: { fieldPath: 'trSupplierId' }, op: 'EQUAL', value: { stringValue: String(searchId) } } },
            { fieldFilter: { field: { fieldPath: 'ysRestoranId' }, op: 'EQUAL', value: { stringValue: String(searchId) } } },
            { fieldFilter: { field: { fieldPath: 'storeId' }, op: 'EQUAL', value: { stringValue: String(searchId) } } }
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

  if (!isletmeEmail) {
    isletmeEmail = `isletme_${searchId}@aero.com`;
  }

  return { 
    isletmeEmail, 
    isletmeAdi: (isletmeAdi || rawStoreName || 'RESTORAN').toUpperCase(), 
    restoranEnlem, 
    restoranBoylam 
  };
}

// 🚀 DETERMINISTIC FIRESTORE DOKÜMAN KAYDI (DOKÜMAN ID = SİPARİŞ NO)
async function checkDuplicateAndSave(siparisNo, firestoreDocument) {
  try {
    const safeDocId = String(siparisNo).replace(/[^a-zA-Z0-9_-]/g, '_');
    
    // Doğrudan Doküman Numarasına PATCH (Upsert) yapıyoruz
    const saveRes = await fetch(`${FIRESTORE_BASE_URL}/siparisler/${safeDocId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firestoreDocument)
    });

    if (saveRes.ok) {
      return true;
    } else {
      console.error(`Firestore Kayıt Başarısız (${safeDocId}):`, await saveRes.text());
      return false;
    }
  } catch (e) {
    console.error('Firestore Kayıt Hatası:', e.message);
    return false;
  }
}

// PLATFORMLARA CANLI GERİ BİLDİRİM SERVİSLERİ
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

    if (dLower.includes('iptal') || dLower.includes('unsupplied')) {
      tyStatus = 'UnSupplied';
    } else if (dLower.includes('kabul') || dLower.includes('onay')) {
      tyStatus = 'Picking';
    } else if (dLower.includes('teslim')) {
      tyStatus = 'Delivered';
    } else if (dLower.includes('yolda') || dLower.includes('atandi') || dLower.includes('kurye') || dLower.includes('dagitim')) {
      tyStatus = 'InDelivery';
    } else if (dLower.includes('hazır') || dLower.includes('hazirlan') || dLower.includes('havuz') || dLower.includes('bekliyor')) {
      tyStatus = 'Picking';
    }

    const authHeader = 'Basic ' + Buffer.from(`${apiKeys.trApiKey}:${apiKeys.trApiSecret}`).toString('base64');
    const url = `https://api.tgoapis.com/integrator/order/meal/status`;
    
    await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'x-agentname': 'AEROKuryeSistemi',
        'x-executor-user': 'coskunsezer82@gmail.com'
      },
      body: JSON.stringify({
        supplierId: Number(supplierId),
        orderId: String(orderId),
        status: tyStatus
      })
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

    if (dLower.includes('iptal') || dLower.includes('cancel')) {
      ysStatus = 'cancelled';
    } else if (dLower.includes('kabul') || dLower.includes('onay')) {
      ysStatus = 'accepted';
    } else if (dLower.includes('teslim')) {
      ysStatus = 'delivered';
    } else if (dLower.includes('yolda') || dLower.includes('atandi') || dLower.includes('kurye') || dLower.includes('dagitim')) {
      ysStatus = 'in_delivery';
    } else if (dLower.includes('hazır') || dLower.includes('hazirlan')) {
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

// GELİŞMİŞ VE CANLI UYUMLU ÖDEME TİPİ AYRIŞTIRICI
function parseOdemeTipi(paymentObj, dataRoot = {}) {
  const pObj = paymentObj || {};
  const onDeliv = pObj.onDelivery || {};
  
  const mainType = String(pObj.paymentType || dataRoot.paymentType || dataRoot.paymentMethod || '').toLowerCase().trim();
  const subType = String(onDeliv.paymentType || '').toLowerCase().trim();
  const mealCard = String(pObj.mealCard || '').toLowerCase().trim();

  // Kapıda Ödeme Detayları
  if (mainType.includes('on_delivery') || mainType.includes('door') || mainType.includes('kapida')) {
    if (subType.includes('cash') || subType.includes('nakit')) {
      return 'Kapıda Nakit';
    }
    if (subType.includes('credit') || subType.includes('card') || subType.includes('pos') || subType.includes('kredi')) {
      return 'Kapıda Kredi Kartı';
    }
    return 'Kapıda Nakit';
  }

  // Yemek Kartları (Sodexo, Ticket vb.)
  if (mealCard && mealCard !== 'null' && mealCard !== 'undefined') {
    return `Yemek Kartı (${mealCard.toUpperCase()})`;
  }

  // Nakit / Kredi Kartı Açık Metin
  if (mainType.includes('cash') || mainType.includes('nakit')) return 'Kapıda Nakit';
  if (mainType.includes('credit') || mainType.includes('pos') || mainType.includes('kredi')) return 'Kapıda Kredi Kartı';

  // Varsayılan Online Ödeme
  return 'Online Ödeme';
}

// 2. TRENDYOL CANLI WEBHOOK ROUTE
app.post('/webhook/trendyol', async (req, res) => {
  // 1. TRENDYOL'A ANINDA RESPOND VER (6 DEFA TEKRARLAMASINI ENGELLER!)
  res.status(200).json({ status: 'OK', message: 'Paket alındı.' });

  try {
    const data = req.body;
    const siparisNoStr = String(data.orderNumber || data.orderId || data.id || '');

    if (!siparisNoStr) return;

    // Hafıza İçi Mükerrer Kontrolü (Peş peşe gelen 6 isteği anında süzgeçten geçirir)
    if (isOrderLocked(siparisNoStr)) {
      console.log(`⚠️ Trendyol Sipariş (${siparisNoStr}) peş peşe geldi, hafıza kilidi engelledi 🛑`);
      return;
    }

    console.log(`=== [TRENDYOL CANLI WEBHOOK PAKETİ GELDI: ${siparisNoStr}] ===`);

    // İptal Paketi mi Kontrol Et
    const isCancel = data.packageStatus === 'UnSupplied' || data.status === 'UnSupplied' || data.cancelInfo != null;
    
    if (isCancel) {
      const safeDocId = siparisNoStr.replace(/[^a-zA-Z0-9_-]/g, '_');
      console.log(`🛑 Trendyol Siparişi İPTAL Edildi: ${siparisNoStr}`);
      await fetch(`${FIRESTORE_BASE_URL}/siparisler/${safeDocId}?updateMask.fieldPaths=durum&updateMask.fieldPaths=status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            durum: { stringValue: 'İptal Edildi' },
            status: { stringValue: 'IPTAL' }
          }
        })
      });
      return;
    }

    const targetSupplierId = String(data.supplierId || data.merchantId || data.restaurantId || '');
    const storeId = String(data.storeId || '');

    const rawStoreName = data.storeName || data.sellerName || data.supplierName || '';
    const isletmeInfo = await getIsletmeBilgileri(targetSupplierId, storeId, rawStoreName);
    const nowIso = new Date().toISOString();
    
    const paymentObj = data.payment || {};
    const brutTutar = Number(data.totalPrice || paymentObj.totalPrice || paymentObj.price || 0);

    // İndirim Hesaplayıcı
    let indirimSum = 0;
    if (Array.isArray(data.promotions)) {
      indirimSum = data.promotions.reduce((acc, p) => acc + Number(p.totalSellerAmount || p.amount || 0), 0);
    }
    const netTutarVal = Math.max(0, brutTutar - indirimSum);

    const customerObj = data.customer || {};
    const addrObj = data.address || data.deliveryAddress || data.shipmentAddress || {};
    
    const mAd = String(
      customerObj.firstName 
        ? `${customerObj.firstName} ${customerObj.lastName || ''}`.trim() 
        : (data.musteriAdi || data.customerName || 'Trendyol Müşterisi')
    );
    
    const mTel = String(
      data.callCenterPhone || 
      addrObj.phone || 
      customerObj.phone || 
      data.telefon || 
      '08502220000'
    );
    
    const mPin = String(
      addrObj.pinCode || 
      addrObj.extension || 
      customerObj.pinCode || 
      customerObj.extension || 
      data.orderNumber || 
      ''
    );

    let mAdres = String(
      addrObj.address1 || 
      addrObj.addressText ||
      addrObj.fullAddress || 
      `${addrObj.address1 || ''} ${addrObj.address2 || ''}`.trim() || 
      data.adres || 
      'Adres Belirtilmedi'
    );
    
    if (addrObj.addressDescription) {
      mAdres += ` [Tarif: ${addrObj.addressDescription}]`;
    }
    if (addrObj.district || addrObj.city) {
      mAdres += ` (${addrObj.district || ''} / ${addrObj.city || ''})`;
    }

    const mNot = String(data.customerNote || data.note || addrObj.note || addrObj.notes || data.siparisNotu || '');

    let latVal = Number(addrObj.latitude || addrObj.lat || 0);
    let lngVal = Number(addrObj.longitude || addrObj.lng || 0);
    
    if (latVal === 0) latVal = isletmeInfo.restoranEnlem;
    if (lngVal === 0) lngVal = isletmeInfo.restoranBoylam;

    const odemeYontemi = parseOdemeTipi(paymentObj, data);

    let urunMetni = '';
    const sepetArray = [];
    const rawLines = data.lines || data.packageItems || data.items || data.products || [];

    if (Array.isArray(rawLines) && rawLines.length > 0) {
      urunMetni = rawLines.map(l => {
        const q = Number(l.quantity || l.count || l.adet || 1);
        const pName = l.name || l.productName || l.description || 'Ürün';
        const priceVal = Number(l.price || l.unitSellingPrice || l.unitPrice || 0);

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
        if (Array.isArray(l.modifierProducts) && l.modifierProducts.length > 0) {
          opts = ` (${l.modifierProducts.map(o => o.name || o).join(', ')})`;
        }
        return `• ${q}x ${pName}${opts}`;
      }).join('\n');
    }

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: siparisNoStr },
        sistemFiltresi: { stringValue: 'AERO_WEB_OZEL' },
        
        isletmeEmail: { stringValue: isletmeInfo.isletmeEmail },
        isletmeAdi: { stringValue: isletmeInfo.isletmeAdi },
        marketAdi: { stringValue: isletmeInfo.isletmeAdi },
        supplierId: { stringValue: targetSupplierId },
        storeId: { stringValue: storeId },
        
        kaynak: { stringValue: 'Trendyol' },
        kanal: { stringValue: 'Trendyol' },
        platform: { stringValue: 'TRENDYOL' },

        tutar: { doubleValue: brutTutar },
        toplamTutar: { doubleValue: brutTutar },
        indirimTutari: { doubleValue: indirimSum },
        netTutar: { doubleValue: netTutarVal },

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

    const isSaved = await checkDuplicateAndSave(siparisNoStr, firestoreDocument);
    if (isSaved) {
      console.log(`✅ Trendyol Siparişi Kaydedildi: [${isletmeInfo.isletmeAdi}] - ${mAd} (${brutTutar} TL) [Ödeme: ${odemeYontemi}]`);
    }

  } catch (error) {
    console.error('Trendyol Webhook İşleme Hatası:', error.message);
  }
});

// 3. YEMEKSEPETİ CANLI WEBHOOK
app.post('/webhook/yemeksepeti', async (req, res) => {
  res.status(200).json({ status: 'OK' });

  try {
    const data = req.body;
    const orderObj = data.order || data;
    const siparisNoStr = String(orderObj.code || orderObj.order_code || orderObj.id || '');

    if (!siparisNoStr) return;

    if (isOrderLocked(siparisNoStr)) {
      console.log(`⚠️ Yemeksepeti Sipariş (${siparisNoStr}) peş peşe geldi, hafıza kilidi engelledi 🛑`);
      return;
    }

    console.log(`=== [YEMEKSEPETİ CANLI WEBHOOK PAKETİ GELDI: ${siparisNoStr}] ===`);

    const isCancel = data.status === 'cancelled' || orderObj.status === 'cancelled';
    if (isCancel) {
      const safeDocId = siparisNoStr.replace(/[^a-zA-Z0-9_-]/g, '_');
      console.log(`🛑 Yemeksepeti Siparişi İPTAL Edildi: ${siparisNoStr}`);
      await fetch(`${FIRESTORE_BASE_URL}/siparisler/${safeDocId}?updateMask.fieldPaths=durum&updateMask.fieldPaths=status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            durum: { stringValue: 'İptal Edildi' },
            status: { stringValue: 'IPTAL' }
          }
        })
      });
      return;
    }

    const targetRestaurantId = String(data.vendor_id || data.restaurantId || data.vendorId || orderObj.vendor_id || '');
    const rawStoreName = data.vendorName || data.restaurantName || orderObj.vendor_name || '';
    const isletmeInfo = await getIsletmeBilgileri(targetRestaurantId, '', rawStoreName);
    const nowIso = new Date().toISOString();
    
    const tutarVal = Number(orderObj.price?.grand_total || orderObj.price?.total || data.price?.total || 0);

    const customerObj = orderObj.customer || data.customer || {};
    const delivObj = orderObj.delivery || data.delivery || data.address || {};
    const delivAddr = delivObj.address || delivObj;

    const mAd = String(
      customerObj.first_name 
        ? `${customerObj.first_name} ${customerObj.last_name || ''}`.trim()
        : (customerObj.name || customerObj.firstName || 'Yemeksepeti Müşterisi')
    );
    const mTel = String(customerObj.phone || delivObj.phone || '08508880000');
    const mPin = String(customerObj.extension_code || customerObj.pinCode || '');

    let mAdres = String(
      delivAddr.full_address || 
      delivAddr.fullAddress || 
      `${delivAddr.street || ''} No:${delivAddr.building_number || ''} D:${delivAddr.flat_number || ''}`.trim() || 
      'Adres Belirtilmedi'
    );
    if (delivAddr.district || delivAddr.city) {
      mAdres += ` (${delivAddr.district || ''} / ${delivAddr.city || ''})`;
    }

    const mNot = String(delivObj.instructions || data.notes || customerObj.customerNote || '');

    let latVal = Number(delivAddr.latitude || delivAddr.lat || 0);
    let lngVal = Number(delivAddr.longitude || delivAddr.lng || 0);
    if (latVal === 0) latVal = isletmeInfo.restoranEnlem;
    if (lngVal === 0) lngVal = isletmeInfo.restoranBoylam;

    const odemeYontemi = parseOdemeTipi(orderObj.payment || data.payment || {}, data);

    let urunMetni = '';
    const sepetArray = [];
    const rawItems = orderObj.products || data.items || data.products || [];

    if (Array.isArray(rawItems) && rawItems.length > 0) {
      urunMetni = rawItems.map(i => {
        const q = Number(i.quantity || i.count || 1);
        const pName = i.name || i.productName || 'Ürün';
        const priceVal = Number(i.unit_price || i.price || 0);

        sepetArray.push({
          mapValue: {
            fields: {
              isim: { stringValue: pName },
              adet: { integerValue: String(q) },
              fiyat: { doubleValue: priceVal }
            }
          }
        });

        return `• ${q}x ${pName}`;
      }).join('\n');
    }

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: siparisNoStr },
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

    const isSaved = await checkDuplicateAndSave(siparisNoStr, firestoreDocument);
    if (isSaved) {
      console.log(`✅ Yemeksepeti Siparişi Kaydedildi: [${isletmeInfo.isletmeAdi}] - ${mAd} (${tutarVal} TL) [Ödeme: ${odemeYontemi}]`);
    }

  } catch (error) {
    console.error('Yemeksepeti Webhook Hatası:', error.message);
  }
});

// 4. DURUM GÜNCELLEME VEYA GERİ BİLDİRİM TETİKLEME
app.post('/update-order-status', async (req, res) => {
  try {
    const { siparisId, durum, kanal, isletmeEmail } = req.body;
    if (!siparisId || !durum) {
      return res.status(400).json({ error: 'siparisId ve durum parametreleri zorunludur.' });
    }

    const safeDocId = String(siparisId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const updateBody = {
      fields: {
        durum: { stringValue: durum },
        status: { stringValue: durum }
      }
    };

    await fetch(`${FIRESTORE_BASE_URL}/siparisler/${safeDocId}?updateMask.fieldPaths=durum&updateMask.fieldPaths=status`, {
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`AERO Backend ${PORT} portunda canlı ve tam dinamik modda çalışıyor 🚀`);
});
