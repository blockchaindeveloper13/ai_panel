const express = require('express');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;
const server = express().listen(PORT, () => console.log(`Listening on ${PORT}`));
const wss = new WebSocketServer({ server });

// Gemini API (En yüksek kapasiteli model)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Veritabanı Bağlantısı
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// --- SINIRSIZ VERİ ÇEKME FONKSİYONU ---
async function getAllFactoryData() {
    try {
        let contextData = "";

        // 1. TÜM KALİTE RAPORLARI (LIMIT YOK)
        // Sadece çok eski ve gereksiz sütunları almayalım ki analiz şaşmasın ama tüm satırları alıyoruz.
        const [reports] = await pool.query("SELECT report_date, customer, product, box_type, net_kg, decision, manual_minor, manual_major, note FROM reports ORDER BY report_date DESC");
        contextData += "TÜM KALİTE RAPORLARI GEÇMİŞİ:\n" + JSON.stringify(reports) + "\n\n";

        // 2. TÜM ÜRETİM VERİLERİ (LIMIT YOK)
        try {
            const [uretim] = await pool.query("SELECT * FROM uretim_ana ORDER BY tarih DESC");
            if(uretim.length > 0) {
                contextData += "TÜM ÜRETİM GİRİŞLERİ:\n" + JSON.stringify(uretim) + "\n\n";
            }
        } catch(e) {}

        // 3. TÜM SEVKİYATLAR (LIMIT YOK)
        try {
            const [sevk] = await pool.query("SELECT * FROM sevk_ana ORDER BY sevk_tarihi DESC");
            if(sevk.length > 0) {
                contextData += "TÜM SEVKİYAT LİSTESİ:\n" + JSON.stringify(sevk) + "\n\n";
            }
        } catch(e) {}

        // 4. GÜNLÜK RAPORLAR (LIMIT YOK)
        try {
             // Eğer gunluk_rapor tablosu varsa onu da çek
             const [gunluk] = await pool.query("SELECT * FROM daily_reports ORDER BY report_date DESC");
             if(gunluk.length > 0) {
                 contextData += "TÜM GÜNLÜK RAPORLAR:\n" + JSON.stringify(gunluk) + "\n\n";
             }
        } catch(e) {}

        return contextData;
    } catch (error) {
        return "Veri çekme hatası: " + error.message;
    }
}

// Başlık Oluşturma
async function updateChatTitle(sessionId, userMessage) {
    try {
        if(!userMessage || userMessage.startsWith("data:")) return;
        const titleResult = await model.generateContent(`Bu mesaja 3 kelimelik başlık bul: "${userMessage}"`);
        const title = titleResult.response.text().trim();
        await pool.query("UPDATE chat_sessions SET title = ? WHERE id = ?", [title, sessionId]);
    } catch (e) { console.log("Başlık hatası:", e); }
}

wss.on('connection', (ws) => {
    console.log('İstemci bağlandı');
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const { prompt, mode, imageBase64, sessionId } = data;
            let aiReply = "";

            // --- GÖRSEL MODU ---
            if (mode === 'vision' && imageBase64) {
                const cleanBase64 = imageBase64.split(',')[1];
                const imagePart = { inlineData: { data: cleanBase64, mimeType: "image/jpeg" } };
                const result = await model.generateContent([prompt || "Bu resimde ne görüyorsun?", imagePart]);
                aiReply = result.response.text();
                
                if(sessionId) await pool.query("INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'user', ?)", [sessionId, "[Resim]: " + prompt]);
            }
            
            // --- VERİ MADENCİLİĞİ MODU (FULL ERİŞİM) ---
            else if (mode === 'data') {
                // Tüm veriyi çek
                const factoryData = await getAllFactoryData();
                
                // Yapay Zekaya Talimat
                const systemInstruction = `
                    Sen V-QMS Fabrika Yönetim Sisteminin yapay zeka beynisin.
                    Aşağıda fabrikanın TÜM veritabanı kayıtları (Raporlar, Üretim, Sevkiyat) bulunmaktadır.
                    
                    VERİ SETİ:
                    ${factoryData}
                    
                    GÖREVİN:
                    Kullanıcının sorusunu bu BÜTÜN veriyi analiz ederek cevapla.
                    Trendleri, toplamları, hataları gör.
                    Kullanıcı Sorusu: "${prompt}"
                `;
                
                const result = await model.generateContent(systemInstruction);
                aiReply = result.response.text();
                
                if(sessionId) await pool.query("INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'user', ?)", [sessionId, prompt]);
            }

            // --- NORMAL SOHBET ---
            else {
                if(sessionId) {
                     await pool.query("INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'user', ?)", [sessionId, prompt]);
                     const [c] = await pool.query("SELECT COUNT(*) as c FROM chat_messages WHERE session_id = ?", [sessionId]);
                     if(c[0].c <= 1) updateChatTitle(sessionId, prompt);
                }
                const result = await model.generateContent(prompt);
                aiReply = result.response.text();
            }

            // AI Cevabını Kaydet
            if(sessionId && aiReply) {
                await pool.query("INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'ai', ?)", [sessionId, aiReply]);
            }

            ws.send(JSON.stringify({ status: 'success', reply: aiReply }));

        } catch (error) {
            console.error("Hata:", error);
            ws.send(JSON.stringify({ status: 'error', reply: "Hata: " + error.message }));
        }
    });
});

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
