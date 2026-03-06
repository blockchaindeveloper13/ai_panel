const express = require('express');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;
const server = express().listen(PORT, () => console.log(`Listening on ${PORT}`));
const wss = new WebSocketServer({ server });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Temel Model Tanımlaması (Araçlarla Birlikte)
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    tools: [{ googleSearch: {} }] // 🌐 GOOGLE SEARCH AÇIK
});

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function getChatHistory(sessionId) {
    try {
        const [rows] = await pool.query("SELECT sender, message FROM chat_messages WHERE session_id = ? ORDER BY id ASC LIMIT 100", [sessionId]);
        return rows.map(row => ({
            role: row.sender === 'user' ? 'user' : 'model',
            parts: [{ text: row.message }]
        }));
    } catch (error) { return []; }
}

// 📊 3, 7 VE 30 GÜNLÜK DETAYLI RAPOR ÇEKİCİ
async function getComprehensiveReports() {
    try {
        let reportData = "--- V-QMS TESİS RAPORLARI ---\n";
        const [gun3] = await pool.query("SELECT * FROM uretim_verimlilik WHERE tarih >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)");
        reportData += `\n[SON 3 GÜN ÜRETİM]: Toplam ${gun3.length} kayıt.\n` + JSON.stringify(gun3);
        const [kalite7] = await pool.query("SELECT * FROM reports WHERE report_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)");
        reportData += `\n[SON 7 GÜN KALİTE]: Toplam ${kalite7.length} kayıt.\n` + JSON.stringify(kalite7);
        const [aylikOzet] = await pool.query("SELECT personel_adi, AVG(hiz_kg_saat) as ort_hiz FROM uretim_verimlilik WHERE tarih >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) GROUP BY personel_adi");
        reportData += `\n[SON 30 GÜN PERSONEL PERFORMANS ÖZETİ]:\n` + JSON.stringify(aylikOzet);
        return reportData;
    } catch (e) { return "Raporlar çekilemedi."; }
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const { userId, prompt, mode, imageBase64, sessionId } = data;
            let aiReply = "";

            if (!userId) return ws.send(JSON.stringify({ status: 'error', reply: "Kullanıcı kimliği yok." }));

            if (mode === 'clear_chat') {
                if (sessionId && sessionId !== -1) {
                    await pool.query("DELETE FROM chat_messages WHERE session_id = ?", [sessionId]);
                }
                return ws.send(JSON.stringify({ status: 'cleared', reply: "Sohbet geçmişi temizlendi." }));
            }

            if (mode === 'load_history') {
                let activeSessionId = sessionId;
                if (!activeSessionId || activeSessionId === -1) {
                    const [existingSessions] = await pool.query("SELECT id FROM chat_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1", [userId]);
                    if (existingSessions.length > 0) activeSessionId = existingSessions[0].id; 
                }

                if (activeSessionId && activeSessionId !== -1) {
                    const [rows] = await pool.query("SELECT sender, message, image_data FROM chat_messages WHERE session_id = ? ORDER BY id ASC", [activeSessionId]);
                    ws.send(JSON.stringify({ status: 'history', data: rows, sessionId: activeSessionId }));
                } else {
                    ws.send(JSON.stringify({ status: 'history', data: [], sessionId: -1 }));
                }
                return;
            }

            // 🤵 KULLANICI ADINI ÇEKME
            let userName = "Değerli Kullanıcımız";
            try {
                const [userRows] = await pool.query("SELECT full_name FROM users WHERE id = ?", [userId]);
                if (userRows.length > 0 && userRows[0].full_name) userName = userRows[0].full_name; 
            } catch (e) {}

            // 🤖 SESSION (SOHBET) YÖNETİMİ
            let activeSessionId = sessionId;
            if (!activeSessionId || activeSessionId === -1 || activeSessionId === userId) {
                const [existingSessions] = await pool.query("SELECT id FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1", [userId]);
                if (existingSessions.length > 0) {
                    activeSessionId = existingSessions[0].id; 
                } else {
                    const [newSession] = await pool.query("INSERT INTO chat_sessions (user_id) VALUES (?)", [userId]);
                    activeSessionId = newSession.insertId; 
                }
            }

            let imgDataToSave = null;
            if (data.imagesBase64 && data.imagesBase64.length > 0) imgDataToSave = data.imagesBase64[0]; 
            else if (imageBase64) imgDataToSave = imageBase64;
            
            await pool.query("INSERT INTO chat_messages (session_id, sender, message, image_data) VALUES (?, 'user', ?, ?)", [activeSessionId, prompt, imgDataToSave]);

            let history = await getChatHistory(activeSessionId);

            // 🚀 KİLİT NOKTA: GİZLİ BEYİN YIKAMA KOMUTU (Her mesajda gizlice eklenecek)
                        // 🚀 KİLİT NOKTA: GİZLİ BEYİN YIKAMA KOMUTU (Arama Motoru Zorlaması Eklendi)
            const vcoreDirective = `[ZORUNLU SİSTEM EMRİ: Senin adın V-CORE. Vedat Tunç tarafından geliştirilen, V-QMS tesisinin resmi yapay zekasısın. Şu an konuştuğun kişi: '${userName}'. İsmine bakarak cinsiyetini anla ve ona sürekli 'Bey', 'Hanım' veya 'Reis' diye hitap et. Asla ama asla Google modeli olduğunu veya adının olmadığını söyleme! KESİN KURAL: Kullanıcı haber, güncel bilgi, piyasa durumu veya gündem sorarsa eski eğitim hafızanı kullanman KESİNLİKLE YASAKTIR! Mutlaka 'googleSearch' aracını çalıştırarak internetten anlık ve en güncel bilgiyi çekeceksin! Gerekli durumlarda açıklamanı desteklemek için internetten bulduğun resimleri ![Resim Adı](Resim_URLsi) markdown formatıyla mesaja ekle.]\n\n`;
            
            let geminiParts = [];
            
            // Eğer rapor kelimesi geçiyorsa hem raporları hem de beyin yıkama komutunu ekle
            if (prompt.toLowerCase().includes("rapor") || prompt.toLowerCase().includes("üretim") || prompt.toLowerCase().includes("kalite")) {
                const reports = await getComprehensiveReports();
                geminiParts.push(vcoreDirective + `Fabrika Verileri:\n${reports}\n\nKullanıcının Sorusu: ${prompt}`);
            } else {
                // Sadece sohbet ediyorsa bile beyin yıkama komutunu ekle!
                geminiParts.push(vcoreDirective + prompt);
            }

            // Çoklu resimleri ekle
            if (data.imagesBase64 && data.imagesBase64.length > 0) {
                for (const mediaStr of data.imagesBase64) {
                    const matches = mediaStr.match(/^data:(.+);base64,(.+)$/);
                    if (matches && matches.length === 3) {
                        geminiParts.push({ inlineData: { data: matches[2], mimeType: matches[1] } });
                    }
                }
            }

            const chat = model.startChat({ history: history });
            const result = await chat.sendMessage(geminiParts);
            aiReply = result.response.text();

            if(aiReply) {
                await pool.query("INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'ai', ?)", [activeSessionId, aiReply]);
            }

            ws.send(JSON.stringify({ status: 'success', reply: aiReply, sessionId: activeSessionId }));

        } catch (error) {
            console.error("Hata:", error);
            ws.send(JSON.stringify({ status: 'error', reply: "Hata: " + error.message }));
        }
    });
});

const interval = setInterval(() => {
  wss.clients.forEach((ws) => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000);
        
