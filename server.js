const express = require('express');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Sunucu Ayarları
const PORT = process.env.PORT || 3000;
const server = express().listen(PORT, () => console.log(`Listening on ${PORT}`));

// WebSocket Sunucusunu Başlat
const wss = new WebSocketServer({ server });

// Gemini API Hazırlığı
// API Key yoksa hata vermesin diye kontrol ekledik
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
    console.error("HATA: GEMINI_API_KEY bulunamadı! Heroku Config Vars ayarlarını kontrol et.");
}
const genAI = new GoogleGenerativeAI(API_KEY);

// MODEL SEÇİMİ: En stabil ve hızlı model "gemini-1.5-flash" tır.
// "gemini-3" şu an public API'de olmadığı için 404 hatası veriyor.
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

wss.on('connection', (ws) => {
    console.log('Yeni bir istemci bağlandı.');
    
    // --- NABIZ SİSTEMİ (Heartbeat) ---
    // Heroku bağlantıyı kesmesin diye her 30 saniyede bir "ping" atarız.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    
    ws.on('message', async (message) => {
        try {
            // Gelen mesajı oku
            const rawMessage = message.toString();
            
            // Eğer boş mesajsa işlem yapma
            if (!rawMessage) return;

            const data = JSON.parse(rawMessage);
            const userPrompt = data.prompt;

            console.log("Kullanıcıdan gelen:", userPrompt);

            // Yapay Zekaya Gönder
            const result = await model.generateContent(userPrompt);
            const response = await result.response;
            const text = response.text();

            console.log("AI Cevabı:", text.substring(0, 50) + "..."); // Log kirliliği olmasın diye kısalttık

            // Cevabı İstemciye Gönder
            ws.send(JSON.stringify({ status: 'success', reply: text }));

        } catch (error) {
            console.error("AI Hatası:", error.message);
            // Hata detayını istemciye de gönderelim ki ekranda görelim
            ws.send(JSON.stringify({ 
                status: 'error', 
                reply: "AI Hatası: " + error.message 
            }));
        }
    });

    ws.on('close', () => console.log('İstemci ayrıldı.'));
});

// --- BAĞLANTIYI CANLI TUTMA (Keep-Alive) ---
// Her 30 saniyede bir kontrol et, cevap vermeyenleri kapat, canlılara ping at.
const interval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', function close() {
  clearInterval(interval);
});
