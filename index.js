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

// TEST WEBHOOK (Siparişi Firestore REST API ile Doğrudan Kaydeder)
app.post('/webhook/trendyol-test', async (req, res) => {
  try {
    const siparisVerisi = req.body;
    console.log('🟢 YENİ SİPARİŞ ALINDI:', siparisVerisi);

    // Firebase Firestore REST API Uç Noktası
    const firestoreUrl = 'https://firestore.googleapis.com/v1/projects/shopier-1d17c/databases/(default)/documents/siparisler';

    // Firestore REST API Formatına Çevirme
    const firestoreDocument = {
      fields: {
        siparisNo: { stringValue: String(siparisVerisi.siparisNo || 'TEST-' + Date.now()) },
        restoran: { stringValue: String(siparisVerisi.restoran || 'KOMEGENA') },
        tutar: { doubleValue: Number(siparisVerisi.tutar || 0) },
        kaynak: { stringValue: 'Trendyol' },
        durum: { stringValue: 'YENI' },
        tarih: { timestampValue: new Date().toISOString() }
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
      mesaj: 'Sipariş Firebase veritabanına başarıyla kaydedildi! 🟢',
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
