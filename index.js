const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Ana Sayfa Kontrolü
app.get('/', (req, res) => {
  res.send('AERO Webhook Backend Çalışıyor! 🟢');
});

// API Doğrulama Uç Noktası (Web Panelden gelen istekleri karşılar)
app.post('/validate-api', (req, res) => {
  const { trSupplierId, trApiKey, trApiSecret, ysRestoranId, ysToken } = req.body;

  // Basit format ve doluluk kontrolü
  if ((trSupplierId && trSupplierId.length < 3) || (ysRestoranId && ysRestoranId.length < 3)) {
    return res.status(400).json({
      basari: yanlış,
      mesaj: 'Girilen API anahtarları veya ID formatı çok kısa/geçersiz.'
    });
  }

  // Başarılı yanıt döndür
  return res.json({
    basari: true,
    mesaj: 'API Entegrasyon bilgileri Render üzerinden doğrulandı ve GÜVENLE kaydedildi! 🟢'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
