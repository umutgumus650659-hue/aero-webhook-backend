const express = require("express");
const admin = require("firebase-admin");

// Firebase Admin SDK başlatılıyor (Firestore veritabanı için)
admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(express.json());

// 1. Yemeksepeti Sipariş Webhook Noktası
app.post("/yemeksepetiWebhook", async (req, res) => {
  try {
    const data = req.body;
    console.log("Yemeksepeti'nden gelen ham veri:", data);

    const siparisVerisi = {
      marketAdi: data.restaurantName || "Yemeksepeti Restoran",
      musteriAdi: data.customerName || "Müşteri",
      adres: data.deliveryAddress || "Adres belirtilmemiş",
      telefon: data.customerPhone || "",
      sepet: data.items || [],
      toplamTutar: data.totalAmount || 0,
      durum: "Yeni Siparis",
      kuryeId: "",
      kaynak: "Yemeksepeti",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("siparisler").add(siparisVerisi);
    return res.status(200).json({ success: true, orderId: docRef.id });
  } catch (error) {
    console.error("Yemeksepeti webhook hatası:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Trendyol Yemek Sipariş Webhook Noktası
app.post("/trendyolWebhook", async (req, res) => {
  try {
    const data = req.body;
    console.log("Trendyol'dan gelen ham veri:", data);

    const siparisVerisi = {
      marketAdi: data.supplierName || "Trendyol Restoran",
      musteriAdi: data.customer?.firstName ? `${data.customer.firstName} ${data.customer.lastName}` : "Müşteri",
      adres: data.shipmentAddress?.address1 || "Adres belirtilmemiş",
      telefon: data.customer?.phone || "",
      sepet: data.lines || [],
      toplamTutar: data.totalPrice || 0,
      durum: "Yeni Siparis",
      kuryeId: "",
      kaynak: "Trendyol",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("siparisler").add(siparisVerisi);
    return res.status(200).json({ success: true, orderId: docRef.id });
  } catch (error) {
    console.error("Trendyol webhook hatası:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Render'ın vereceği porta göre sunucuyu ayakta tutuyoruz
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AERO Webhook sunucusu ${PORT} portunda çalışıyor...`);
});