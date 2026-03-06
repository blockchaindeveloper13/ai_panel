const express = require('express');
const { WebSocketServer } = require('ws');
// 🚀 YENİ KÜTÜPHANE İÇERİ AKTARILDI
const { GoogleGenAI } = require("@google/genai"); 
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;
const server = express().listen(PORT, () => console.log(`Listening on ${PORT}`));
const wss = new WebSocketServer({ server });

// 🚀 YENİ MOTOR BAŞLATILDI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
        let activeSessionId = -1;
        try {
            const data = JSON.parse(message);
            const { userId, prompt, mode, imageBase64, sessionId, sourceLang, targetLang } = data;
            activeSessionId = sessionId; 
            let aiReply = "";

            if (!userId) return ws.send(JSON.stringify({ status: 'error', reply: "Kullanıcı kimliği yok." }));

            if (mode === 'clear_chat') {
                if (sessionId && sessionId !== -1) {
                    await pool.query("DELETE FROM chat_messages WHERE session_id = ?", [sessionId]);
                }
                return ws.send(JSON.stringify({ status: 'cleared', reply: "Sohbet geçmişi temizlendi." }));
            }

            if (mode === 'load_history') {
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

            let userName = "Değerli Kullanıcımız";
            try {
                const [userRows] = await pool.query("SELECT full_name FROM users WHERE id = ?", [userId]);
                if (userRows.length > 0 && userRows[0].full_name) userName = userRows[0].full_name; 
            } catch (e) {}

            // ÇEVİRMEN MODU (YENİ SİSTEME UYARLANDI)
            if (mode === 'translate') {
                const kaynak = sourceLang || "Otomatik";
                const hedef = targetLang || "İngilizce"; 
                const response = await ai.models.generateContent({
                    model: 'gemini-3.1-flash-lite-preview',
                    contents: `Çevrilecek Metin:\n${prompt}`,
                    config: {
                        systemInstruction: `Sen yeminli tercümansın. '${kaynak}' dilinden '${hedef}' diline çevir. Sadece çeviriyi ver.`
                    }
                });
                return ws.send(JSON.stringify({ status: 'success', reply: response.text }));
            }

            // PERFORMANS MODU (Değişmedi, veritabanı işlemi)
            if (mode === 'performance') {
                const gunSayisi = parseInt(data.days) || 3;
                const sqlQuery = `SELECT personel_adi, ROUND(AVG(gunluk_hiz)) as genel_hiz FROM (SELECT personel_adi, tarih, AVG(hiz_kg_saat) as gunluk_hiz FROM uretim_verimlilik WHERE tarih IN (SELECT tarih FROM (SELECT DISTINCT tarih FROM uretim_verimlilik ORDER BY tarih DESC LIMIT ${gunSayisi}) as son_tarihler) AND personel_adi NOT IN ('Sevgi Sert', 'Dilara sert', 'Dilara Sert') GROUP BY personel_adi, tarih) as gunluk_tablo GROUP BY personel_adi ORDER BY genel_hiz DESC`;
                const [rows] = await pool.query(sqlQuery);
                return ws.send(JSON.stringify({ status: 'success', type: 'performance_data', data: rows }));
            }

            if (!activeSessionId || activeSessionId === -1 || activeSessionId === userId) {
                const [existingSessions] = await pool.query("SELECT id FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1", [userId]);
                if (existingSessions.length > 0) activeSessionId = existingSessions[0].id; 
                else {
                    const [newSession] = await pool.query("INSERT INTO chat_sessions (user_id) VALUES (?)", [userId]);
                    activeSessionId = newSession.insertId; 
                }
            }

            let imgDataToSave = null;
            if (data.imagesBase64 && data.imagesBase64.length > 0) imgDataToSave = data.imagesBase64[0]; 
            else if (imageBase64) imgDataToSave = imageBase64;
            
            await pool.query("INSERT INTO chat_messages (session_id, sender, message, image_data) VALUES (?, 'user', ?, ?)", [activeSessionId, prompt, imgDataToSave]);

            let history = await getChatHistory(activeSessionId);
            const now = new Date();
            const currentTime = now.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

            const vcoreDirective = `[ZORUNLU SİSTEM EMRİ: Senin adın V-CORE. Vedat Tunç tarafından geliştirilen, V-QMS tesisinin resmi yapay zekasısın. Şu an konuştuğun kişi: '${userName}'. Ona sürekli 'Bey', 'Hanım' veya 'Reis' diye hitap et. Asla Google modeli olduğunu söyleme! 
⏳ ŞU ANKİ GERÇEK ZAMAN: ${currentTime}. Senin için şu anki gün ve saat budur.
⚠️ KESİN KURAL: Eğer kullanıcı fiyat, altın, tarih, hava durumu, maç skoru, güncel haber veya piyasa verisi sorarsa KESİNLİKLE kendi hafızanı KULLANMA! 'googleSearch' aracını kullanarak internetten bilgi çek!]`;

            // YENİ KÜTÜPHANE İÇİN PAKET HAZIRLIĞI
            let currentMessageParts = [];
            if (prompt.toLowerCase().includes("rapor") || prompt.toLowerCase().includes("üretim") || prompt.toLowerCase().includes("kalite")) {
                const reports = await getComprehensiveReports();
                currentMessageParts.push({ text: `Fabrika Verileri:\n${reports}\n\nKullanıcının Sorusu: ${prompt}` });
            } else {
                currentMessageParts.push({ text: prompt });
            }

            if (data.imagesBase64 && data.imagesBase64.length > 0) {
                for (const mediaStr of data.imagesBase64) {
                    const matches = mediaStr.match(/^data:(.+);base64,(.+)$/);
                    if (matches && matches.length === 3) {
                        currentMessageParts.push({ inlineData: { data: matches[2], mimeType: matches[1] } });
                    }
                }
            }

            // GEÇMİŞİ VE YENİ MESAJI BİRLEŞTİR
            let contents = history.map(h => ({ role: h.role, parts: h.parts }));
            contents.push({ role: 'user', parts: currentMessageParts });

            // 🚀 GEMINI 3.1 FLASH-LITE ATEŞLEMESİ
            const response = await ai.models.generateContent({
                model: 'gemini-3.1-flash-lite-preview',
                contents: contents,
                config: {
                    systemInstruction: vcoreDirective,
                    tools: [{ googleSearch: {} }] // 🌐 GOOGLE SEARCH AÇIK
                }
            });

            aiReply = response.text;

            // 🌐 KAYNAKÇA (ALINTI) MOTORU
            const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
            if (groundingMetadata && groundingMetadata.groundingChunks) {
                aiReply += "\n\n🌐 **V-CORE Kaynaklar:**\n";
                groundingMetadata.groundingChunks.forEach((chunk) => {
                    if (chunk.web && chunk.web.uri) {
                        aiReply += `* [${chunk.web.title}](${chunk.web.uri})\n`;
                    }
                });
            }

            if(aiReply) {
                await pool.query("INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'ai', ?)", [activeSessionId, aiReply]);
            }

            ws.send(JSON.stringify({ status: 'success', reply: aiReply, sessionId: activeSessionId }));

        } catch (error) {
            console.error("Hata:", error);
            ws.send(JSON.stringify({ 
                status: 'success', 
                reply: `⚠️ V-CORE 3.1 Sistem Hatası: ${error.message}`, 
                sessionId: activeSessionId 
            }));
        }
    });
});

const interval = setInterval(() => {
  wss.clients.forEach((ws) => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000);
                            
