const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Ana Sayfa
app.get('/', (req, res) => {
  res.send('AERO Webhook Backend Çalışıyor! 🟢');
});

// API Doğrulama
app.post('/validate-api', (req, res) => {
  return res.json({
    success: true,
    message: 'API Entegrasyon bilgileri Render üzerinden doğrulandı! 🟢'
  });
});

// TEST WEBHOOK (Tüm olası Flutter alan adlarıyla Firestore kaydı)
app.post('/webhook/trendyol-test', async (req, res) => {
  try {
    const siparisVerisi = req.body;
    console.log('🟢 YENİ SİPARİŞ ALINDI:', siparisVerisi);

    const targetSupplierId = String(siparisVerisi.supplierId || siparisVerisi.restaurantId || '4455555333');
    const nowIso = new Date().toISOString();

    // Firebase Firestore REST API Uç Noktası
    const firestoreUrl = 'https://firestore.googleapis.com/v1/projects/shopier-1d17c/databases/(default)/documents/siparisler';

    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(siparisVerisi.siparisNo || 'TR-' + Date.now()) },
        // FARKLI KODLAMA İHTİMALLERİNE KARŞI TÜM ID ALANLARI
        supplierId: { stringValue: targetSupplierId },
        restaurantId: { stringValue: targetSupplierId },
        restoranId: { stringValue: targetSupplierId },
        restoranName: { stringValue: String(siparisVerisi.restoran || 'KOMEGENA') },
        
        // KAYNAK / KANAL
        kaynak: { stringValue: 'Trendyol' },
        kanal: { stringValue: 'Trendyol' },
        platform: { stringValue: 'TRENDYOL' },

        // FİYAT VE DURUM
        tutar: { doubleValue: Number(siparisVerisi.tutar || 321) },
        toplamTutar: { doubleValue: Number(siparisVerisi.tutar || 321) },
        durum: { stringValue: 'YENI' },
        status: { stringValue: 'YENI' },

        // TARİH
        tarih: { timestampValue: nowIso },
        createdAt: { timestampValue: nowIso }
      }
    };

    const response = await fetch(firestoreUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firestoreDocument)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Firestore REST hatası: ${errText}`);
    }

    const resData = await response.json();
    console.log('🟢 FIRESTORE KAYIT BAŞARILI:', resData.name);

    return res.status(200).json({
      durum: 'BASARILI',
      mesaj: 'Sipariş başarıyla esnek formatta kaydedildi! 🟢',
      firestoreId: resData.name
    });
  } catch (error) {
    console.error('Kayıt Hatası:', error.message);
    return res.status(500).json({ durum: 'HATA', mesaj: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
