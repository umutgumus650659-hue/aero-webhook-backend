const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1/projects/shopier-1d17c/databases/(default)/documents';

// ============================================================================
// 1. MÜKERRER İSTEK KİLİDİ, EŞZAMANLI İŞLEM KUYRUĞU & UYKU KALKANI
// ============================================================================
const processingOrdersLock = new Map();
const orderExecutionQueues = new Map(); // Aynı siparişin milisaniyelik çakışmalarını sıraya sokar
const LOCK_TTL_MS = 3 * 60 * 1000; // 3 Dakika

setInterval(() => {
  const now = Date.now();
  for (const [key, lockTime] of processingOrdersLock.entries()) {
    if (now - lockTime > LOCK_TTL_MS) processingOrdersLock.delete(key);
  }
}, 10 * 60 * 1000);

function isOrderLocked(lockKey) {
  if (!lockKey) return false;
  const now = Date.now();
  if (processingOrdersLock.has(lockKey) && now - processingOrdersLock.get(lockKey) < LOCK_TTL_MS) {
    return true;
  }
  processingOrdersLock.set(lockKey, now);
  return false;
}

// Aynı sipariş numarasına gelen eşzamanlı istekleri tek tek sıraya sokan Mutex Kalkanı
function runInOrderQueue(siparisNo, taskFn) {
  const key = String(siparisNo);
  const previousTask = orderExecutionQueues.get(key) || Promise.resolve();
  const currentTask = previousTask
    .then(() => taskFn())
    .catch((err) => console.error(`Kuyruk İşlem Hatası (${key}):`, err.message))
    .finally(() => {
      if (orderExecutionQueues.get(key) === currentTask) {
        orderExecutionQueues.delete(key);
      }
    });
  orderExecutionQueues.set(key, currentTask);
  return currentTask;
}

// Render Cold-Start (Uyku Modu) Engelleyici
setInterval(() => {
  const renderUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 10000}`;
  fetch(`${renderUrl}/health-ping`).catch(() => {});
}, 4 * 60 * 1000);

app.get('/health-ping', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('AERO Webhook Backend - CANLI MOD AKTİF 🟢'));
app.post('/validate-api', (req, res) => res.json({ success: true, message: 'API doğrulandı 🟢' }));

// ============================================================================
// 2. FIRESTORE YARDIMCI DÖNÜŞTÜRÜCÜLER & GÜVENLİ MERGE KAYIT
// ============================================================================
const toStr = (val) => ({ stringValue: String(val ?? '') });
const toNum = (val) => ({ doubleValue: Number(val) || 0 });
const toBool = (val) => ({ booleanValue: Boolean(val) });
const toTime = (iso) => ({ timestampValue: iso });

async function getIsletmeBilgileri(targetId, storeId = '', rawStoreName = '') {
  const searchId = String(targetId || storeId || '').trim();
  const fallbackName = String(rawStoreName || '').trim().toUpperCase();

  if (!searchId || searchId === 'undefined' || searchId === 'null') {
    return { isletmeEmail: '', isletmeAdi: fallbackName, restoranEnlem: 0, restoranBoylam: 0 };
  }

  const queryBody = {
    structuredQuery: {
      from: [{ collectionId: 'isletme_entegrasyonlar' }],
      where: {
        compositeFilter: {
          op: 'OR',
          filters: [
            { fieldFilter: { field: { fieldPath: 'trSupplierId' }, op: 'EQUAL', value: toStr(searchId) } },
            { fieldFilter: { field: { fieldPath: 'ysRestoranId' }, op: 'EQUAL', value: toStr(searchId) } },
            { fieldFilter: { field: { fieldPath: 'storeId' }, op: 'EQUAL', value: toStr(searchId) } }
          ]
        }
      },
      limit: 1
    }
  };

  try {
    const res = await fetch(`${FIRESTORE_BASE_URL}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody)
    });

    if (res.ok) {
      const results = await res.json();
      const fields = results?.[0]?.document?.fields;
      if (fields) {
        const email = (fields.isletmeEmail?.stringValue || '').toLowerCase().trim();
        const adi = (fields.isletmeAdi?.stringValue || fields.unvan?.stringValue || fallbackName).toUpperCase();
        const enlem = Number(fields.enlem?.doubleValue || fields.enlem?.integerValue || 0);
        const boylam = Number(fields.boylam?.doubleValue || fields.boylam?.integerValue || 0);
        return { isletmeEmail: email, isletmeAdi: adi, restoranEnlem: enlem, restoranBoylam: boylam };
      }
    }
  } catch (err) {
    console.error('İşletme Firestore sorgu hatası:', err.message);
  }

  return {
    isletmeEmail: `isletme_${searchId}@aero.com`,
    isletmeAdi: fallbackName,
    restoranEnlem: 0,
    restoranBoylam: 0
  };
}

// Mevcut sipariş dokümanını kuyruk kilidi altında okur; boş/eksik gelen hiçbir alan gerçek veriyi ezmez.
async function saveOrMergeOrder(siparisNo, incomingFields) {
  return runInOrderQueue(siparisNo, async () => {
    try {
      const safeDocId = String(siparisNo).replace(/[^a-zA-Z0-9_-]/g, '_');
      const docUrl = `${FIRESTORE_BASE_URL}/siparisler/${safeDocId}`;

      let existingFields = null;
      const existingRes = await fetch(docUrl);
      if (existingRes.ok) {
        const existingDoc = await existingRes.json();
        existingFields = existingDoc?.fields || null;
      }

      const finalFields = existingFields ? { ...existingFields } : {};

      for (const [key, valObj] of Object.entries(incomingFields)) {
        if (!valObj) continue;

        if ('stringValue' in valObj) {
          const strVal = valObj.stringValue.trim();
          const isGeneric = ['RESTORAN', 'Trendyol Müşterisi', 'Yemeksepeti Müşterisi', 'Adres Belirtilmedi'].includes(strVal);
          if (strVal !== '' && !(isGeneric && existingFields?.[key]?.stringValue)) {
            finalFields[key] = valObj;
          } else if (!existingFields) {
            finalFields[key] = valObj;
          }
        } else if ('doubleValue' in valObj) {
          if (valObj.doubleValue !== 0 || !existingFields?.[key]?.doubleValue) {
            finalFields[key] = valObj;
          }
        } else if ('arrayValue' in valObj) {
          const hasItems = (valObj.arrayValue?.values?.length || 0) > 0;
          if (hasItems || !existingFields?.[key]?.arrayValue?.values?.length) {
            finalFields[key] = valObj;
          }
        } else {
          if (!existingFields || !(key in existingFields)) {
            finalFields[key] = valObj;
          }
        }
      }

      // Operasyonel durum, kurye ataması ve isHazir bayrağını kesinlikle koru
      if (existingFields) {
        const exKurye = existingFields.kuryeId?.stringValue || '';
        const exDurum = existingFields.durum?.stringValue || '';
        const exHazir = existingFields.isHazir?.booleanValue === true;

        if (exHazir) finalFields.isHazir = toBool(true);
        if (existingFields.havuzdaMi?.booleanValue === true) finalFields.havuzdaMi = toBool(true);
        if (existingFields.isWebArsiv?.booleanValue === true) finalFields.isWebArsiv = toBool(true);

        if ((exKurye && exKurye !== 'yok') || (exDurum && exDurum.toUpperCase() !== 'YENI')) {
          if (existingFields.kuryeId) finalFields.kuryeId = existingFields.kuryeId;
          if (existingFields.kuryeAdi) finalFields.kuryeAdi = existingFields.kuryeAdi;
          if (existingFields.durum) finalFields.durum = existingFields.durum;
          if (existingFields.status) finalFields.status = existingFields.status;
        }
        if (existingFields.tarih) finalFields.tarih = existingFields.tarih;
        if (existingFields.createdAt) finalFields.createdAt = existingFields.createdAt;
      }

      const saveRes = await fetch(docUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: finalFields })
      });

      if (!saveRes.ok) {
        console.error(`Firestore Yazma Hatası (${safeDocId}):`, await saveRes.text());
        return false;
      }
      return true;
    } catch (e) {
      console.error('saveOrMergeOrder Hatası:', e.message);
      return false;
    }
  });
}

function parseOdemeTipi(paymentObj = {}, dataRoot = {}) {
  const onDeliv = paymentObj.onDelivery || {};
  const mainType = String(paymentObj.paymentType || dataRoot.paymentType || dataRoot.paymentMethod || '').toLowerCase();
  const subType = String(onDeliv.paymentType || paymentObj.subPaymentType || '').toLowerCase();
  const mealCard = String(paymentObj.mealCard || paymentObj.mealCardType || '').trim();

  if (mealCard && mealCard.toLowerCase() !== 'null' && mealCard.toLowerCase() !== 'undefined') {
    return `Yemek Kartı (${mealCard.toUpperCase()})`;
  }
  if (mainType.includes('on_delivery') || mainType.includes('door') || mainType.includes('kapida')) {
    if (subType.includes('credit') || subType.includes('card') || subType.includes('pos') || subType.includes('kredi')) {
      return 'Kapıda Kredi Kartı';
    }
    if (subType.includes('meal') || subType.includes('multinet') || subType.includes('sodexo') || subType.includes('ticket')) {
      return 'Kapıda Yemek Kartı';
    }
    return 'Kapıda Nakit';
  }
  if (mainType.includes('cash') || mainType.includes('nakit')) return 'Kapıda Nakit';
  if (mainType.includes('credit') || mainType.includes('pos') || mainType.includes('kredi')) return 'Kapıda Kredi Kartı';

  return 'Online Ödeme';
}

// ============================================================================
// 3. TRENDYOL GO CANLI WEBHOOK (TAM KAPSAYICI REAL FORMAT)
// ============================================================================
app.post('/webhook/trendyol', async (req, res) => {
  res.status(200).json({ status: 'OK' });

  try {
    const data = req.body || {};
    const siparisNo = String(data.orderNumber || data.packageNumber || data.shipmentPackageId || data.orderId || data.id || '').trim();
    if (!siparisNo) return;

    const statusStr = String(data.packageStatus || data.status || 'CREATED').trim();
    const lockKey = `TY_${siparisNo}_${statusStr}`;
    if (isOrderLocked(lockKey)) return;

    console.log(`=== [TRENDYOL WEBHOOK: ${siparisNo} | Statü: ${statusStr}] ===`);

    if (['UnSupplied', 'Cancelled', 'Canceled'].includes(statusStr) || data.cancelInfo != null) {
      await runInOrderQueue(siparisNo, async () => {
        const safeDocId = siparisNo.replace(/[^a-zA-Z0-9_-]/g, '_');
        await fetch(`${FIRESTORE_BASE_URL}/siparisler/${safeDocId}?updateMask.fieldPaths=durum&updateMask.fieldPaths=status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { durum: toStr('İptal Edildi'), status: toStr('IPTAL') } })
        });
      });
      return;
    }

    const supplierId = String(data.supplierId || data.merchantId || data.restaurantId || '').trim();
    const storeId = String(data.storeId || '').trim();
    const rawStoreName = data.storeName || data.sellerName || data.supplierName || '';
    const isletme = await getIsletmeBilgileri(supplierId, storeId, rawStoreName);

    const paymentObj = data.payment || {};
    const brutTutar = Number(data.totalPrice || data.grossAmount || paymentObj.totalPrice || paymentObj.price || 0);
    const indirimSum = Array.isArray(data.promotions)
      ? data.promotions.reduce((acc, p) => acc + Number(p.totalSellerAmount || p.sellerAmount || p.amount || 0), 0)
      : Number(data.totalDiscount || 0);
    const netTutar = Math.max(0, brutTutar - indirimSum);

    const customer = data.customer || {};
    const addr = data.address || data.deliveryAddress || data.shipmentAddress || {};

    const mAd = customer.firstName
      ? `${customer.firstName} ${customer.lastName || ''}`.trim()
      : String(customer.fullName || data.customerName || data.musteriAdi || '').trim();

    const mTel = String(
      data.callCenterPhone || addr.callCenterPhone || addr.phone || customer.phone || data.phone || ''
    ).trim();

    const mPin = String(
      addr.pinCode || addr.extension || customer.pinCode || customer.extension || data.pinCode || ''
    ).trim();

    let mAdres = String(
      addr.fullAddress || addr.addressText ||
      [addr.address1, addr.address2].filter(Boolean).join(' ') ||
      [addr.street, addr.buildingNumber ? `No:${addr.buildingNumber}` : '', addr.doorNumber ? `D:${addr.doorNumber}` : ''].filter(Boolean).join(' ') ||
      ''
    ).trim();

    if (addr.addressDescription || addr.direction) {
      mAdres += ` [Tarif: ${addr.addressDescription || addr.direction}]`;
    }
    const bolge = [addr.neighborhood, addr.district, addr.city].filter(Boolean).join(' / ');
    if (bolge) mAdres += ` (${bolge})`;

    const mNot = String(data.customerNote || data.note || addr.note || addr.notes || '').trim();

    const lat = Number(addr.latitude || addr.lat || 0) || isletme.restoranEnlem;
    const lng = Number(addr.longitude || addr.lng || 0) || isletme.restoranBoylam;
    const odemeTipi = parseOdemeTipi(paymentObj, data);

    const rawLines = data.lines || data.packageItems || data.items || data.products || [];
    const sepetArray = [];
    const urunSatirlari = [];

    if (Array.isArray(rawLines)) {
      for (const item of rawLines) {
        const adet = Number(item.quantity || item.count || item.adet || 1);
        const isim = String(item.name || item.productName || item.title || 'Ürün').trim();
        const fiyat = Number(item.price || item.unitSellingPrice || item.unitPrice || 0);

        const modifiers = [];
        if (Array.isArray(item.modifierProducts)) {
          item.modifierProducts.forEach(m => modifiers.push(m.name || m.title || m));
        }
        if (Array.isArray(item.extraIngredients)) {
          item.extraIngredients.forEach(e => modifiers.push(`+${e.name || e}`));
        }
        if (Array.isArray(item.removedIngredients)) {
          item.removedIngredients.forEach(r => modifiers.push(`-${r.name || r}`));
        }

        const optMetni = modifiers.filter(Boolean).length > 0 ? ` (${modifiers.filter(Boolean).join(', ')})` : '';
        const tamUrunAdi = `${isim}${optMetni}`;

        sepetArray.push({
          mapValue: {
            fields: {
              isim: toStr(tamUrunAdi),
              adet: { integerValue: String(adet) },
              fiyat: toNum(fiyat)
            }
          }
        });
        urunSatirlari.push(`• ${adet}x ${tamUrunAdi}`);
      }
    }

    const urunMetni = urunSatirlari.join('\n');
    const nowIso = new Date().toISOString();

    const fields = {
      siparisNo: toStr(siparisNo),
      sistemFiltresi: toStr('AERO_WEB_OZEL'),
      isletmeEmail: toStr(isletme.isletmeEmail),
      isletmeAdi: toStr(isletme.isletmeAdi || 'RESTORAN'),
      marketAdi: toStr(isletme.isletmeAdi || 'RESTORAN'),
      supplierId: toStr(supplierId),
      storeId: toStr(storeId),
      kaynak: toStr('Trendyol'),
      kanal: toStr('Trendyol'),
      platform: toStr('TRENDYOL'),
      tutar: toNum(brutTutar),
      toplamTutar: toNum(brutTutar),
      indirimTutari: toNum(indirimSum),
      netTutar: toNum(netTutar),
      sepet: { arrayValue: { values: sepetArray } },
      durum: toStr('YENI'),
      status: toStr('YENI'),
      isHazir: toBool(false),
      isWebArsiv: toBool(false),
      havuzdaMi: toBool(false),
      kuryeId: toStr(''),
      kuryeAdi: toStr(''),
      musteriAdi: toStr(mAd || 'Trendyol Müşterisi'),
      customerName: toStr(mAd || 'Trendyol Müşterisi'),
      musteriTelefon: toStr(mTel),
      musteriTel: toStr(mTel),
      telefon: toStr(mTel),
      phone: toStr(mTel),
      pinKodu: toStr(mPin),
      pin: toStr(mPin),
      teslimatAdresi: toStr(mAdres || 'Adres Belirtilmedi'),
      adres: toStr(mAdres || 'Adres Belirtilmedi'),
      address: toStr(mAdres || 'Adres Belirtilmedi'),
      not: toStr(mNot),
      siparisNotu: toStr(mNot),
      odemeTipi: toStr(odemeTipi),
      paymentType: toStr(odemeTipi),
      enlem: toNum(lat),
      boylam: toNum(lng),
      konum: toStr(lat && lng ? `${lat}, ${lng}` : ''),
      restoranEnlem: toNum(isletme.restoranEnlem),
      restoranBoylam: toNum(isletme.restoranBoylam),
      detay: toStr(urunMetni),
      sepetDetay: toStr(urunMetni),
      urunler: toStr(urunMetni),
      tarih: toTime(nowIso),
      createdAt: toTime(nowIso)
    };

    const ok = await saveOrMergeOrder(siparisNo, fields);
    if (ok) console.log(`✅ Trendyol Siparişi İşlendi: ${siparisNo}`);
  } catch (error) {
    console.error('Trendyol Webhook Hatası:', error.message);
  }
});

// ============================================================================
// 4. YEMEKSEPETİ CANLI WEBHOOK (TAM KAPSAYICI REAL FORMAT)
// ============================================================================
app.post('/webhook/yemeksepeti', async (req, res) => {
  res.status(200).json({ status: 'OK' });

  try {
    const data = req.body || {};
    const order = data.order || data;
    const siparisNo = String(order.code || order.order_code || order.shortCode || order.id || '').trim();
    if (!siparisNo) return;

    const statusStr = String(data.status || order.status || 'CREATED').trim();
    const lockKey = `YS_${siparisNo}_${statusStr}`;
    if (isOrderLocked(lockKey)) return;

    console.log(`=== [YEMEKSEPETİ WEBHOOK: ${siparisNo} | Statü: ${statusStr}] ===`);

    if (['cancelled', 'canceled', 'rejected'].includes(statusStr.toLowerCase())) {
      await runInOrderQueue(siparisNo, async () => {
        const safeDocId = siparisNo.replace(/[^a-zA-Z0-9_-]/g, '_');
        await fetch(`${FIRESTORE_BASE_URL}/siparisler/${safeDocId}?updateMask.fieldPaths=durum&updateMask.fieldPaths=status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { durum: toStr('İptal Edildi'), status: toStr('IPTAL') } })
        });
      });
      return;
    }

    const vendorId = String(data.vendor_id || data.vendorId || data.restaurantId || order.vendor_id || order.vendor?.id || '').trim();
    const rawStoreName = data.vendorName || data.restaurantName || order.vendor_name || order.vendor?.name || '';
    const isletme = await getIsletmeBilgileri(vendorId, '', rawStoreName);

    const priceObj = order.price || data.price || {};
    const brutTutar = Number(priceObj.grand_total || priceObj.total || priceObj.pay_restaurant || 0);
    const indirimSum = Number(priceObj.discount_amount || priceObj.total_discount || 0);
    const netTutar = Math.max(0, brutTutar - indirimSum);

    const customer = order.customer || data.customer || {};
    const deliv = order.delivery || data.delivery || {};
    const addr = deliv.address || data.address || {};

    const mAd = customer.first_name
      ? `${customer.first_name} ${customer.last_name || ''}`.trim()
      : String(customer.name || customer.firstName || '').trim();

    const mTel = String(customer.phone || customer.mobile_phone || deliv.phone || '').trim();
    const mPin = String(customer.extension_code || customer.pinCode || deliv.pin_code || '').trim();

    let mAdres = String(
      addr.full_address || addr.fullAddress ||
      [
        addr.street,
        addr.building_number ? `No:${addr.building_number}` : '',
        addr.floor ? `Kat:${addr.floor}` : '',
        addr.flat_number ? `D:${addr.flat_number}` : ''
      ].filter(Boolean).join(' ') ||
      ''
    ).trim();

    if (addr.delivery_instructions || addr.instructions) {
      mAdres += ` [Tarif: ${addr.delivery_instructions || addr.instructions}]`;
    }
    const bolge = [addr.neighborhood, addr.district, addr.city].filter(Boolean).join(' / ');
    if (bolge) mAdres += ` (${bolge})`;

    const mNot = String(deliv.instructions || order.comments?.customer_comment || data.notes || customer.customerNote || '').trim();

    const lat = Number(addr.latitude || addr.lat || 0) || isletme.restoranEnlem;
    const lng = Number(addr.longitude || addr.lng || 0) || isletme.restoranBoylam;
    const odemeTipi = parseOdemeTipi(order.payment || data.payment || {}, order);

    const rawItems = order.products || order.items || data.products || data.items || [];
    const sepetArray = [];
    const urunSatirlari = [];

    if (Array.isArray(rawItems)) {
      for (const item of rawItems) {
        const adet = Number(item.quantity || item.count || 1);
        const isim = String(item.name || item.productName || 'Ürün').trim();
        const fiyat = Number(item.unit_price || item.paid_price || item.price || 0);

        const toppings = [];
        const rawToppings = item.selected_toppings || item.toppings || item.options || [];
        if (Array.isArray(rawToppings)) {
          rawToppings.forEach(t => toppings.push(t.name || t.title || t));
        }

        const optMetni = toppings.filter(Boolean).length > 0 ? ` (${toppings.filter(Boolean).join(', ')})` : '';
        const tamUrunAdi = `${isim}${optMetni}`;

        sepetArray.push({
          mapValue: {
            fields: {
              isim: toStr(tamUrunAdi),
              adet: { integerValue: String(adet) },
              fiyat: toNum(fiyat)
            }
          }
        });
        urunSatirlari.push(`• ${adet}x ${tamUrunAdi}`);
      }
    }

    const urunMetni = urunSatirlari.join('\n');
    const nowIso = new Date().toISOString();

    const fields = {
      siparisNo: toStr(siparisNo),
      sistemFiltresi: toStr('AERO_WEB_OZEL'),
      isletmeEmail: toStr(isletme.isletmeEmail),
      isletmeAdi: toStr(isletme.isletmeAdi || 'RESTORAN'),
      marketAdi: toStr(isletme.isletmeAdi || 'RESTORAN'),
      restaurantId: toStr(vendorId),
      kaynak: toStr('Yemeksepeti'),
      kanal: toStr('Yemeksepeti'),
      platform: toStr('YEMEKSEPETI'),
      tutar: toNum(brutTutar),
      toplamTutar: toNum(brutTutar),
      indirimTutari: toNum(indirimSum),
      netTutar: toNum(netTutar),
      sepet: { arrayValue: { values: sepetArray } },
      durum: toStr('YENI'),
      status: toStr('YENI'),
      isHazir: toBool(false),
      isWebArsiv: toBool(false),
      havuzdaMi: toBool(false),
      kuryeId: toStr(''),
      kuryeAdi: toStr(''),
      musteriAdi: toStr(mAd || 'Yemeksepeti Müşterisi'),
      customerName: toStr(mAd || 'Yemeksepeti Müşterisi'),
      musteriTelefon: toStr(mTel),
      musteriTel: toStr(mTel),
      telefon: toStr(mTel),
      phone: toStr(mTel),
      pinKodu: toStr(mPin),
      pin: toStr(mPin),
      teslimatAdresi: toStr(mAdres || 'Adres Belirtilmedi'),
      adres: toStr(mAdres || 'Adres Belirtilmedi'),
      address: toStr(mAdres || 'Adres Belirtilmedi'),
      not: toStr(mNot),
      siparisNotu: toStr(mNot),
      odemeTipi: toStr(odemeTipi),
      paymentType: toStr(odemeTipi),
      enlem: toNum(lat),
      boylam: toNum(lng),
      konum: toStr(lat && lng ? `${lat}, ${lng}` : ''),
      restoranEnlem: toNum(isletme.restoranEnlem),
      restoranBoylam: toNum(isletme.restoranBoylam),
      detay: toStr(urunMetni),
      sepetDetay: toStr(urunMetni),
      urunler: toStr(urunMetni),
      tarih: toTime(nowIso),
      createdAt: toTime(nowIso)
    };

    const ok = await saveOrMergeOrder(siparisNo, fields);
    if (ok) console.log(`✅ Yemeksepeti Siparişi İşlendi: ${siparisNo}`);
  } catch (error) {
    console.error('Yemeksepeti Webhook Hatası:', error.message);
  }
});

// ============================================================================
// 5. DURUM GÜNCELLEME & PLATFORM GERİ BİLDİRİMLERİ
// ============================================================================
async function getIsletmeEntegrasyonByEmail(email) {
  if (!email) return null;
  try {
    const res = await fetch(`${FIRESTORE_BASE_URL}/isletme_entegrasyonlar/${email.toLowerCase().trim()}`);
    if (res.ok) {
      const doc = await res.json();
      const f = doc?.fields;
      if (f) {
        return {
          trSupplierId: f.trSupplierId?.stringValue || '',
          trApiKey: f.trApiKey?.stringValue || '',
          trApiSecret: f.trApiSecret?.stringValue || '',
          ysRestoranId: f.ysRestoranId?.stringValue || '',
          ysToken: f.ysToken?.stringValue || ''
        };
      }
    }
  } catch (e) {
    console.error('Entegrasyon okuma hatası:', e.message);
  }
  return null;
}

async function sendTrendyolStatusUpdate(supplierId, orderId, durum, apiKeys) {
  try {
    const dLower = String(durum).toLowerCase().trim();
    let tyStatus = 'Picking';
    if (dLower.includes('iptal') || dLower.includes('unsupplied')) tyStatus = 'UnSupplied';
    else if (dLower.includes('teslim')) tyStatus = 'Delivered';
    else if (dLower.includes('yolda') || dLower.includes('atandi') || dLower.includes('kurye') || dLower.includes('dagitim')) tyStatus = 'InDelivery';

    const authHeader = 'Basic ' + Buffer.from(`${apiKeys.trApiKey}:${apiKeys.trApiSecret}`).toString('base64');
    await fetch('https://api.tgoapis.com/integrator/order/meal/status', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'x-agentname': 'AEROKuryeSistemi',
        'x-executor-user': 'coskunsezer82@gmail.com'
      },
      body: JSON.stringify({ supplierId: Number(supplierId), orderId: String(orderId), status: tyStatus })
    });
  } catch (e) {
    console.error('Trendyol Status Bildirim Hatası:', e.message);
  }
}

async function sendYemeksepetiStatusUpdate(restaurantId, orderCode, durum, apiKeys) {
  try {
    const dLower = String(durum).toLowerCase().trim();
    let ysStatus = 'in_preparation';
    if (dLower.includes('iptal') || dLower.includes('cancel')) ysStatus = 'cancelled';
    else if (dLower.includes('kabul') || dLower.includes('onay')) ysStatus = 'accepted';
    else if (dLower.includes('teslim')) ysStatus = 'delivered';
    else if (dLower.includes('yolda') || dLower.includes('atandi') || dLower.includes('kurye') || dLower.includes('dagitim')) ysStatus = 'in_delivery';

    await fetch(`https://connect.deliveryhero.com/api/v1/vendors/${restaurantId}/orders/${orderCode}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKeys.ysToken}` },
      body: JSON.stringify({ status: ysStatus })
    });
  } catch (e) {
    console.error('Yemeksepeti Status Bildirim Hatası:', e.message);
  }
}

app.post('/update-order-status', async (req, res) => {
  try {
    const { siparisId, durum, kanal, isletmeEmail } = req.body;
    if (!siparisId || !durum) {
      return res.status(400).json({ error: 'siparisId ve durum parametreleri zorunludur.' });
    }

    const safeDocId = String(siparisId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const isHazir = durum.toLowerCase().includes('hazır') || durum.toLowerCase().includes('hazirlan');

    let updateUrl = `${FIRESTORE_BASE_URL}/siparisler/${safeDocId}?updateMask.fieldPaths=durum&updateMask.fieldPaths=status`;
    const fields = { durum: toStr(durum), status: toStr(durum) };

    if (isHazir) {
      updateUrl += '&updateMask.fieldPaths=isHazir';
      fields.isHazir = toBool(true);
    }

    await fetch(updateUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
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
      }).catch(() => {});
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
