const express = require('express');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;
const server = express().listen(PORT, () => console.log(`Listening on ${PORT}`));
const wss = new WebSocketServer({ server });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 🚀 ADIM 1: V-CORE KİMLİĞİ VE SAMİMİYETİ BEYNE KAZINDI
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    systemInstruction: "Senin adın V-CORE. Vedat Tunç tarafından geliştirilen, V-QMS (Vedat Quality Manager System) meyve paketleme tesisinin resmi Yapay Zeka Asistanısın. Görevin tesisteki verimliliği artırmak, raporları analiz etmek ve kullanıcıya en samimi, içten, zeki bir dille yardımcı olmaktır. Gerektiğinde 'Reis' gibi samimi hitaplar kullanabilirsin. Asla genel bir Google dil modeli olduğunu söyleme. Karakterinden asla çıkma ve her zaman bağlamı hatırla."
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

// --- ADIM 2: HAFIZA LİMİTİ ARTIRILDI (20 -> 100) ---
async function getChatHistory(sessionId) {
    try {
        const [rows] = await pool.query("SELECT sender, message FROM chat_messages WHERE session_id = ? ORDER BY id ASC LIMIT 100", [sessionId]);
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
            const { userId, prompt, mode, imageBase64, sessionId, sourceLang, targetLang } = data;
            let aiReply = "";

            // 🛡️ GÜVENLİK DUVARI
            if (!userId) {
                return ws.send(JSON.stringify({ status: 'error', reply: "Bağlantı reddedildi: Kullanıcı kimliği yok." }));
            }

            // 🚀 ADIM 3: GEÇMİŞİ YÜKLERKEN RESİMLERİ (image_data) DE ÇEKİYORUZ
            if (mode === 'load_history') {
                let activeSessionId = sessionId;

                if (!activeSessionId || activeSessionId === -1) {
                    const [existingSessions] = await pool.query(
                        "SELECT id FROM chat_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1",
                        [userId]
                    );
                    if (existingSessions.length > 0) {
                        activeSessionId = existingSessions[0].id; 
                    }
                }

                if (activeSessionId && activeSessionId !== -1) {
                    // DİKKAT: image_data sütunu sorguya eklendi!
                    const [rows] = await pool.query(
                        "SELECT sender, message, image_data FROM chat_messages WHERE session_id = ? ORDER BY id ASC", 
                        [activeSessionId]
                    );
                    ws.send(JSON.stringify({ status: 'history', data: rows, sessionId: activeSessionId }));
                } else {
                    ws.send(JSON.stringify({ status: 'history', data: [], sessionId: -1 }));
                }
                return;
            }

            // --- SOHBETİ TEMİZLEME KOMUTU ---
            if (mode === 'clear_chat') {
                if (sessionId && sessionId !== -1) {
                    await pool.query("DELETE FROM chat_messages WHERE session_id = ?", [sessionId]);
                }
                ws.send(JSON.stringify({ status: 'cleared', reply: "Sohbet geçmişi temizlendi." }));
                return;
            }
            
            const [userRows] = await pool.query("SELECT role FROM users WHERE id = ?", [userId]);
            if (userRows.length === 0 || userRows[0].role.toUpperCase() !== 'ADMIN'){
                return ws.send(JSON.stringify({ 
                    status: 'error', 
                    reply: "Yetki Reddedildi: V-CORE özelliklerine sadece Yöneticiler (ADMİN) erişebilir." 
                }));
            }

            // 🌐 ÇEVİRMEN MODU 
            if (mode === 'translate') {
                const kaynakDil = sourceLang || "Otomatik Algıla";
                const hedefDil = targetLang || "İngilizce"; 
                const systemInstruction = `Sen sadece profesyonel bir yeminli tercümansın. Sana verilen metni '${kaynakDil}' dilinden '${hedefDil}' diline çevir. Asla sohbet etme, açıklama yapma, soru sorma veya ekstra bilgi verme. Sadece çevrilmiş metni ver.`;
                const translatePrompt = `${systemInstruction}\n\nÇevrilecek Metin:\n${prompt}`;
                const result = await model.generateContent(translatePrompt);
                aiReply = result.response.text();
                return ws.send(JSON.stringify({ status: 'success', reply: aiReply }));
            }
            
            // 🏆 PERFORMANS MODU
            if (mode === 'performance') {
                const gunSayisi = parseInt(data.days) || 3;
                const sqlQuery = `
                    SELECT personel_adi, 
                           ROUND(AVG(gunluk_hiz)) as genel_hiz 
                    FROM (
                        SELECT personel_adi, tarih, AVG(hiz_kg_saat) as gunluk_hiz
                        FROM uretim_verimlilik
                        WHERE tarih IN (
                            SELECT tarih FROM (
                                SELECT DISTINCT tarih 
                                FROM uretim_verimlilik 
                                ORDER BY tarih DESC 
                                LIMIT ${gunSayisi}
                            ) as son_tarihler
                        )
                        AND personel_adi NOT IN ('Sevgi Sert', 'Dilara sert', 'Dilara Sert')
                        GROUP BY personel_adi, tarih
                    ) as gunluk_tablo
                    GROUP BY personel_adi
                    ORDER BY genel_hiz DESC
                `;

                try {
                    const [rows] = await pool.query(sqlQuery);
                    return ws.send(JSON.stringify({ status: 'success', type: 'performance_data', data: rows }));
                } catch (sqlError) {
                    return ws.send(JSON.stringify({ status: 'error', reply: "Sunucu SQL Hatası: " + sqlError.message }));
                }
            }
            
            // 🤖 V-CORE ASİSTAN MODLARI (Vision, Data, Chat)
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

            // 🚀 ADIM 4: SADECE RESMİ KAYDET, "[Görsel eklendi]" YAZISINI SİL
            let imgDataToSave = null;
            if (data.imagesBase64 && data.imagesBase64.length > 0) {
                imgDataToSave = data.imagesBase64[0]; 
            } else if (imageBase64) {
                imgDataToSave = imageBase64;
            }
            
            // Sadece prompt'u kaydediyoruz, ekstra yazı eklemiyoruz
            await pool.query(
                "INSERT INTO chat_messages (session_id, sender, message, image_data) VALUES (?, 'user', ?, ?)", 
                [activeSessionId, prompt, imgDataToSave]
            );

            let history = [];
            if(mode === 'chat') {
                history = await getChatHistory(activeSessionId);
            }

            if (mode === 'vision' && data.imagesBase64 && data.imagesBase64.length > 0) {
                let geminiParts = [ prompt || "Lütfen ekteki dosyayı/görseli detaylıca analiz et." ];
                for (const mediaStr of data.imagesBase64) {
                    const matches = mediaStr.match(/^data:(.+);base64,(.+)$/);
                    if (matches && matches.length === 3) {
                        geminiParts.push({ inlineData: { data: matches[2], mimeType: matches[1] } });
                    }
                }
                const result = await model.generateContent(geminiParts);
                aiReply = result.response.text();
            }
            else if (mode === 'data') {
                const factoryData = await getAllFactoryData();
                const chat = model.startChat({ history: [] }); 
                const msg = `Fabrika Verileri:\n${factoryData}\n\nSoru: ${prompt}`;
                const result = await chat.sendMessage(msg);
                aiReply = result.response.text();
            }
            else if (mode === 'chat') {
                // 🚀 ADIM 5: maxOutputTokens: 1000 SINIRI TAMAMEN SİLİNDİ!
                const chat = model.startChat({
                    history: history
                });
                const result = await chat.sendMessage(prompt);
                aiReply = result.response.text();
            }

            if(aiReply) {
                await pool.query(
                    "INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'ai', ?)", 
                    [activeSessionId, aiReply]
                );
            }

            ws.send(JSON.stringify({ 
                status: 'success', 
                reply: aiReply,
                sessionId: activeSessionId
            }));

        } catch (error) {
            console.error("Hata:", error);
            ws.send(JSON.stringify({ status: 'error', reply: "Hata: " + error.message }));
        }
    });
});

const interval = setInterval(() => {
  wss.clients.forEach((ws) => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000);

