const express = require('express');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;
const server = express().listen(PORT, () => console.log(`Listening on ${PORT}`));
const wss = new WebSocketServer({ server });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// --- GEÇMİŞİ HATIRLAMA FONKSİYONU ---
async function getChatHistory(sessionId) {
    try {
        // Son 10 mesajı çek (Çok eskiye gidip beyni yormayalım)
        const [rows] = await pool.query("SELECT sender, message FROM chat_messages WHERE session_id = ? ORDER BY id ASC LIMIT 20", [sessionId]);
        
        // Gemini formatına çevir
        return rows.map(row => ({
            role: row.sender === 'user' ? 'user' : 'model',
            parts: [{ text: row.message }]
        }));
    } catch (error) {
        return [];
    }
}

// --- VERİ MADENCİLİĞİ ---
async function getAllFactoryData() {
    try {
        let contextData = "";
        const [reports] = await pool.query("SELECT report_date, customer, product, decision, note FROM reports ORDER BY id DESC LIMIT 10");
        contextData += "SON KALİTE RAPORLARI:\n" + JSON.stringify(reports) + "\n\n";
        
        // Varsa üretim ve sevkiyatı da ekle...
        return contextData;
    } catch (e) { return "Veri yok."; }
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

            // 1. MESAJI VE RESMİ KAYDET (ÖNCE KAYIT!)
            if(sessionId) {
                // Base64 varsa onu da kaydet, yoksa NULL
                const imgDataToSave = imageBase64 ? imageBase64 : null;
                // Resim gönderildiyse mesaja not düşelim
                const msgText = imageBase64 ? "[Görsel]: " + prompt : prompt;
                
                await pool.query(
                    "INSERT INTO chat_messages (session_id, sender, message, image_data) VALUES (?, 'user', ?, ?)", 
                    [sessionId, msgText, imgDataToSave]
                );
            }

            // 2. HAFIZAYI YÜKLE
            let history = [];
            if(sessionId && mode === 'text') {
                history = await getChatHistory(sessionId);
            }

            // --- SENARYO A: GÖRSEL ANALİZ ---
            if (mode === 'vision' && imageBase64) {
                const cleanBase64 = imageBase64.split(',')[1];
                const imagePart = { inlineData: { data: cleanBase64, mimeType: "image/jpeg" } };
                
                // Görselde hafıza (History) şu an teknik olarak zor, o yüzden tek seferlik soruyoruz
                const result = await model.generateContent([prompt || "Bu resimde ne görüyorsun?", imagePart]);
                aiReply = result.response.text();
            }
            
            // --- SENARYO B: VERİ MADENCİLİĞİ ---
            else if (mode === 'data') {
                const factoryData = await getAllFactoryData();
                const chat = model.startChat({ history: [] }); // Veri modunda geçmişe gerek yok, veriye odaklansın
                const msg = `Fabrika Verileri:\n${factoryData}\n\nSoru: ${prompt}`;
                const result = await chat.sendMessage(msg);
                aiReply = result.response.text();
            }

            // --- SENARYO C: SOHBET (HAFIZALI) ---
            else {
                // Sohbet geçmişiyle birlikte oturumu başlat
                const chat = model.startChat({
                    history: history,
                    generationConfig: { maxOutputTokens: 1000 }
                });

                const result = await chat.sendMessage(prompt);
                aiReply = result.response.text();
            }

            // 3. AI CEVABINI KAYDET
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
  wss.clients.forEach((ws) => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000);
                    
