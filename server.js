const express = require('express');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;
const server = express().listen(PORT, () => console.log(`Listening on ${PORT}`));
const wss = new WebSocketServer({ server });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

// 📊 YENİ: 3, 7 VE 30 GÜNLÜK DETAYLI RAPOR ÇEKİCİ
async function getComprehensiveReports() {
    try {
        let reportData = "--- V-QMS TESİS RAPORLARI ---\n";
        
        // Son 3 Gün
        const [gun3] = await pool.query("SELECT * FROM uretim_verimlilik WHERE tarih >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)");
        reportData += `\n[SON 3 GÜN ÜRETİM]: Toplam ${gun3.length} kayıt.\n` + JSON.stringify(gun3);
        
        // Son 7 Gün Kalite
        const [kalite7] = await pool.query("SELECT * FROM reports WHERE report_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)");
        reportData += `\n[SON 7 GÜN KALİTE]: Toplam ${kalite7.length} kayıt.\n` + JSON.stringify(kalite7);
        
        // Son 30 Gün Özet
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

            // 🧹 SOHBETİ KALICI SİLME KORUMASI
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

            // 🤵 KULLANICI ADINI VE CİNSİYETİNİ (Hitap İçin) ÇEKME
                        // 🤵 KULLANICI ADINI VE CİNSİYETİNİ ÇEKME (VERİTABANINA TAM UYUMLU SÜRÜM)
            let userName = "Değerli Kullanıcımız";
            try {
                // Senin veritabanındaki 'full_name' sütununu çekiyoruz
                const [userRows] = await pool.query("SELECT full_name FROM users WHERE id = ?", [userId]);
                if (userRows.length > 0 && userRows[0].full_name) {
                    userName = userRows[0].full_name; // Direkt "Vedat Tunç" olarak alır
                }
            } catch (nameError) {
                console.log("İsim sütunu hatası, sunucu çökmesi engellendi: ", nameError.message);
            }
            
            // 🧠 DİNAMİK V-CORE BEYNİ (Google Search + İsim + Çoklu Resim Kuralı)
            const dynamicModel = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                systemInstruction: `Senin adın V-CORE. Vedat Tunç tarafından geliştirilen, V-QMS meyve paketleme tesisinin resmi Yapay Zeka Asistanısın. 
Şu an konuştuğun kullanıcının adı: ${userName}. İsmine bakarak cinsiyetini tahmin et ve ona sürekli 'Bey', 'Hanım' veya çok samimi durumlarda 'Reis' diye hitap et. 
Eğer kullanıcı sana birden fazla resim atarsa, hepsini birbiriyle kıyaslayarak toplu bir karar ver.
Gerektiğinde internetten arama yapabilirsin. Gerekli durumlarda açıklamanı desteklemek için internetten bulduğun resimleri ![Resim Adı](Resim_URLsi) markdown formatıyla mesaja ekle.`,
                tools: [{ googleSearch: {} }] // 🌐 GOOGLE SEARCH ENTEGRASYONU
            });
            
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
            if (data.imagesBase64 && data.imagesBase64.length > 0) {
                imgDataToSave = data.imagesBase64[0]; 
            } else if (imageBase64) {
                imgDataToSave = imageBase64;
            }
            
            await pool.query("INSERT INTO chat_messages (session_id, sender, message, image_data) VALUES (?, 'user', ?, ?)", [activeSessionId, prompt, imgDataToSave]);

            let history = await getChatHistory(activeSessionId);

            // 🚀 BİRLEŞTİRİLMİŞ AKILLI SORGULAMA (Çoklu Resim + Raporlar + Sohbet)
            let geminiParts = [];
            
            // Eğer rapor veya veri soruyorsa gizlice raporları mesaja ekle
            if (prompt.toLowerCase().includes("rapor") || prompt.toLowerCase().includes("üretim") || prompt.toLowerCase().includes("kalite") || prompt.toLowerCase().includes("performans")) {
                const reports = await getComprehensiveReports();
                geminiParts.push(`Aşağıdaki fabrika verilerini kullanarak sorumu yanıtla:\n${reports}\n\nSoru: ${prompt}`);
            } else {
                geminiParts.push(prompt);
            }

            // Resimler varsa onları da pakete ekle (Toplu işleme)
            if (data.imagesBase64 && data.imagesBase64.length > 0) {
                for (const mediaStr of data.imagesBase64) {
                    const matches = mediaStr.match(/^data:(.+);base64,(.+)$/);
                    if (matches && matches.length === 3) {
                        geminiParts.push({ inlineData: { data: matches[2], mimeType: matches[1] } });
                    }
                }
            }

            const chat = dynamicModel.startChat({ history: history });
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
