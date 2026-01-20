const express = require('express');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Sunucu Ayarları
const PORT = process.env.PORT || 3000;
const server = express().listen(PORT, () => console.log(`Listening on ${PORT}`));

// WebSocket Sunucusunu Başlat
const wss = new WebSocketServer({ server });

// Gemini API Hazırlığı (Heroku'dan Key'i çekecek)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

wss.on('connection', (ws) => {
    console.log('Yeni bir istemci bağlandı.');

    ws.on('message', async (message) => {
        try {
            // Gelen mesajı JSON'a çevir
            const data = JSON.parse(message);
            const userPrompt = data.prompt;
            const mode = data.mode; // 'text' veya 'vision'

            // Model Seçimi
            let model;
            let result;

            if (mode === 'text') {
                // Sadece Metin Modu
                model = genAI.getGenerativeModel({ model: "gemini-pro" });
                result = await model.generateContent(userPrompt);
            } else if (mode === 'vision') {
                // Görsel Modu (İleride burayı detaylandıracağız, şimdilik metin cevabı verelim)
                // Gemini Vision için base64 resim verisi lazım, şimdilik metin olarak karşılıyoruz.
                model = genAI.getGenerativeModel({ model: "gemini-pro" }); 
                result = await model.generateContent("Görsel analizi şu an bakımda: " + userPrompt); 
            }

            const response = await result.response;
            const text = response.text();

            // Cevabı İstemciye Gönder
            ws.send(JSON.stringify({ status: 'success', reply: text }));

        } catch (error) {
            console.error("AI Hatası:", error);
            ws.send(JSON.stringify({ status: 'error', reply: "Yapay zeka şu an meşgul veya bir hata oluştu." }));
        }
    });

    ws.on('close', () => console.log('İstemci ayrıldı.'));
});

