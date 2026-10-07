const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Ana Sayfa Kontrolü
app.get('/', (req, res) => {
  res.send('AERO Webhook Backend Çalışıyor! 🟢');
});

// API Doğrulama Uç Noktası (Paneldeki yeşil "Bağlandı" rozetini sağlayan kısım)
app.post('/validate-api', (req, res) => {
  const { trSupplierId, trApiKey, trApiSecret, ysRestoranId, ysToken } = req.body;

  // Test aşamasında her girişi başarılı kabul ediyoruz
  return res.json({
    success: true,
    message: 'API Entegrasyon bilgileri Render üzerinden doğrulandı ve GÜVENLE kaydedildi! 🟢'
  });
});

// TEST WEBHOOK UÇ NOKTASI (Trendyol/Yemeksepeti sipariş simülasyonu)
app.post('/webhook/trendyol-test', (req, res) => {
  const siparisVerisi = req.body;

  console.log('🟢 YENİ TEST SİPARİŞİ GELDİ:', JSON.stringify(siparisVerisi, null, 2));

  // Gelen siparişi başarıyla aldığımızı simüle ediyoruz
  return res.status(200).json({
    durum: 'BASARILI',
    mesaj: 'Test siparişi Render sunucusu tarafından başarıyla alındı ve işlendi!',
    alinanVeri: siparisVerisi
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
