const express = require('express');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;
const server = express().listen(PORT, () => console.log(`Listening on ${PORT}`));
const wss = new WebSocketServer({ server });

// Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Görsel ve Metin için en hızlı model
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Veritabanı Bağlantı Havuzu
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// --- YARDIMCI FONKSİYONLAR ---

// 1. Veri Madenciliği: Son raporları çeker
async function getFactoryData() {
    try {
        // reports tablosundan son 5 raporu çekiyoruz
        const [rows] = await pool.query("SELECT * FROM reports ORDER BY report_date DESC LIMIT 5");
        return JSON.stringify(rows);
    } catch (error) {
        return "Veritabanı hatası: " + error.message;
    }
}

// 2. Başlık Oluşturma: İlk mesajsa sohbet başlığını belirler
async function updateChatTitle(sessionId, userMessage) {
    try {
        const titleResult = await model.generateContent(`Bu mesaja 3-4 kelimelik çok kısa bir başlık bul (tırnak işareti kullanma): "${userMessage}"`);
        const title = titleResult.response.text().trim();
        await pool.query("UPDATE chat_sessions SET title = ? WHERE id = ?", [title, sessionId]);
    } catch (e) { console.log("Başlık hatası:", e); }
}

wss.on('connection', (ws) => {
    console.log('İstemci bağlandı');
    
    // Heartbeat (Bağlantı kopmaması için)
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            /* Gelen Veri Yapısı:
               { 
                 prompt: "Mesaj", 
                 mode: "text" | "data" | "vision", 
                 imageBase64: "...", 
                 sessionId: 123 
               }
            */
            const { prompt, mode, imageBase64, sessionId } = data;
            let aiReply = "";

            // --- DURUM 1: METİN SOHBETİ ---
            if (mode === 'text') {
                // Mesajı Kaydet
                if(sessionId) {
                     await pool.query("INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'user', ?)", [sessionId, prompt]);
                     // İlk mesajsa başlık güncelle
                     const [count] = await pool.query("SELECT COUNT(*) as c FROM chat_messages WHERE session_id = ?", [sessionId]);
                     if(count[0].c <= 1) updateChatTitle(sessionId, prompt);
                }

                // AI Cevaplasın
                const result = await model.generateContent(prompt);
                aiReply = result.response.text();
            } 
            
            // --- DURUM 2: VERİ MADENCİLİĞİ (SQL Okuma) ---
            else if (mode === 'data') {
                const factoryData = await getFactoryData();
                const systemInstruction = `Sen bu fabrikanın veritabanına erişimi olan uzman bir asistansın. İşte son raporlar (JSON formatında): ${factoryData}. \nKullanıcının sorusu: "${prompt}". \nBu verilere dayanarak kısa ve net bir analiz yap.`;
                
                const result = await model.generateContent(systemInstruction);
                aiReply = result.response.text();
            }

            // --- DURUM 3: GÖRSEL ANALİZ (Vision) ---
            else if (mode === 'vision' && imageBase64) {
                // Base64 temizliği (data:image... kısmını at)
                const cleanBase64 = imageBase64.split(',')[1];
                
                const imagePart = {
                    inlineData: {
                        data: cleanBase64,
                        mimeType: "image/jpeg"
                    }
                };

                // Resmi ve soruyu birlikte gönder
                const result = await model.generateContent([prompt, imagePart]);
                aiReply = result.response.text();
                
                // Görsel sorgusunu DB'ye kaydet
                if(sessionId) {
                    await pool.query("INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'user', ?)", [sessionId, "[GÖRSEL ANALİZ]: " + prompt]);
                }
            }

            // AI Cevabını DB'ye kaydet
            if(sessionId && aiReply) {
                await pool.query("INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'ai', ?)", [sessionId, aiReply]);
            }

            // Cevabı Gönder
            ws.send(JSON.stringify({ status: 'success', reply: aiReply }));

        } catch (error) {
            console.error("Hata:", error);
            ws.send(JSON.stringify({ status: 'error', reply: "Sistem Hatası: " + error.message }));
        }
    });
});

// Keep-Alive Döngüsü
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
