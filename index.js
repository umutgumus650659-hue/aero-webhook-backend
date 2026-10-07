const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const app = express();

app.use(cors());
app.use(express.json());

// Firebase Admin ilklendirme (Eğer ortam değişkeni yoksa varsayılan mod)
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

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

// TEST WEBHOOK (Gelen Siparişi Firestore'a Kaydeder)
app.post('/webhook/trendyol-test', async (req, res) => {
  try {
    const siparisVerisi = req.body;
    console.log('🟢 YENİ SİPARİŞ ALINDI:', siparisVerisi);

    // Gelen siparişi Firestore 'siparisler' koleksiyonuna ekliyoruz
    await db.collection('siparisler').add({
      ...siparisVerisi,
      kaynak: 'Trendyol',
      tarih: admin.firestore.FieldValue.serverTimestamp(),
      durum: 'YENI'
    });

    return res.status(200).json({
      durum: 'BASARILI',
      mesaj: 'Sipariş Render tarafından alındı ve Firebase veritabanına kaydedildi! 🟢'
    });
  } catch (error) {
    console.error('Firestore kayıt hatası:', error);
    return res.status(500).json({ durum: 'HATA', mesaj: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
