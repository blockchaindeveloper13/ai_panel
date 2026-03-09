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

// =========================================================
// --- YARDIMCI FONKSİYON: SQL İLE PERFORMANS HESAPLAMA ---
// =========================================================
async function getPerformanceDataForAI(limit) {
    const perfSql = `
        SELECT * FROM (
            SELECT personel_adi, ROUND(AVG(hiz_kg_saat)) as genel_hiz 
            FROM (
                SELECT personel_adi, hiz_kg_saat, 
                       ROW_NUMBER() OVER(PARTITION BY personel_adi ORDER BY id DESC) as sira
                FROM uretim_verimlilik 
                WHERE personel_adi != 'YEVMİYECİ' 
                  AND personel_adi NOT IN ('Sevgi Sert', 'Dilara sert', 'Dilara Sert')
            ) as sigortali_sirali 
            WHERE sira <= ${limit} 
            GROUP BY personel_adi
            
            UNION ALL
            
            SELECT personel_adi, ROUND(AVG(gunluk_hiz)) as genel_hiz 
            FROM (
                SELECT personel_adi, gunluk_hiz, 
                       ROW_NUMBER() OVER(PARTITION BY personel_adi ORDER BY islem_tarihi DESC) as sira
                FROM (
                    SELECT personel_adi, DATE(tarih) as islem_tarihi, AVG(hiz_kg_saat) as gunluk_hiz 
                    FROM uretim_verimlilik 
                    WHERE personel_adi = 'YEVMİYECİ' 
                    GROUP BY personel_adi, islem_tarihi
                ) as yevmiyeci_gunluk
            ) as yevmiyeci_sirali 
            WHERE sira <= ${limit} 
            GROUP BY personel_adi
        ) AS final_tablo 
        ORDER BY genel_hiz DESC
    `;
    const [rows] = await pool.query(perfSql);
    return rows;
}

// =========================================================
// --- ANA RAPOR ÇEKME FONKSİYONU ---
// =========================================================
async function getComprehensiveReports() {
    try {
        let reportData = "--- V-QMS TESİS RAPORLARI VE PERFORMANS VERİLERİ ---\n";
        
        // Sadece özet bilgi gönderiyoruz, AI'ın kafası karışmasın
        const [uretim] = await pool.query("SELECT id, tarih, personel_adi FROM uretim_verimlilik ORDER BY tarih DESC LIMIT 50");
        reportData += `\n[SON ÜRETİM KAYIT BİLGİSİ]: Toplam ${uretim.length} son işlem.\n`;
        
        // İŞTE BURASI: 3, 7 ve 30 Günlük Hazır SQL Tablolarını Yapay Zekaya Veriyoruz!
        const perf3 = await getPerformanceDataForAI(3);
        const perf7 = await getPerformanceDataForAI(7);
        const perf30 = await getPerformanceDataForAI(30);

        reportData += `\n[3 GÜNLÜK PERFORMANS TABLOSU (Hazır Hesaplanmış, Kesin Veri)]:\n` + JSON.stringify(perf3);
        reportData += `\n[7 GÜNLÜK PERFORMANS TABLOSU (Hazır Hesaplanmış, Kesin Veri)]:\n` + JSON.stringify(perf7);
        reportData += `\n[30 GÜNLÜK PERFORMANS TABLOSU (Hazır Hesaplanmış, Kesin Veri)]:\n` + JSON.stringify(perf30);
        
        return reportData;
    } catch (e) { 
        console.error("Rapor Çekme Hatası:", e);
        return "Raporlar çekilemedi."; 
    }
}

// =========================================================
// --- WEBSOCKET BAĞLANTISI VE AI İŞLEMLERİ ---
// =========================================================
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

            // ÇEVİRMEN MODU (Yeni SDK Kurallarına Göre Düzeltildi)
            if (mode === 'translate') {
                const kaynak = sourceLang || "Otomatik";
                const hedef = targetLang || "İngilizce"; 
                const response = await ai.models.generateContent({
                    model: 'gemini-3.1-flash-lite-preview',
                    contents: [{ role: 'user', parts: [{ text: `Çevrilecek Metin:\n${prompt}` }] }],
                    config: {
                        systemInstruction: `Sen yeminli tercümansın. '${kaynak}' dilinden '${hedef}' diline çevir. Sadece çeviriyi ver.`
                    }
                });
                return ws.send(JSON.stringify({ status: 'success', reply: response.text }));
            }

            // PERFORMANS MODU (Dokunulmadı, Orijinal Korumada)
            if (mode === 'performance') {
                const kayitSayisi = parseInt(data.days) || 3; 
                
                const sqlQuery = `
                    SELECT * FROM (
                        SELECT personel_adi, ROUND(AVG(hiz_kg_saat)) as genel_hiz 
                        FROM (
                            SELECT personel_adi, hiz_kg_saat, 
                                   ROW_NUMBER() OVER(PARTITION BY personel_adi ORDER BY id DESC) as sira
                            FROM uretim_verimlilik 
                            WHERE personel_adi != 'YEVMİYECİ' 
                              AND personel_adi NOT IN ('Sevgi Sert', 'Dilara sert', 'Dilara Sert')
                        ) as sigortali_sirali 
                        WHERE sira <= ${kayitSayisi} 
                        GROUP BY personel_adi
                        
                        UNION ALL
                        
                        SELECT personel_adi, ROUND(AVG(gunluk_hiz)) as genel_hiz 
                        FROM (
                            SELECT personel_adi, gunluk_hiz, 
                                   ROW_NUMBER() OVER(PARTITION BY personel_adi ORDER BY islem_tarihi DESC) as sira
                            FROM (
                                SELECT personel_adi, DATE(tarih) as islem_tarihi, AVG(hiz_kg_saat) as gunluk_hiz 
                                FROM uretim_verimlilik 
                                WHERE personel_adi = 'YEVMİYECİ' 
                                GROUP BY personel_adi, islem_tarihi
                            ) as yevmiyeci_gunluk
                        ) as yevmiyeci_sirali 
                        WHERE sira <= ${kayitSayisi} 
                        GROUP BY personel_adi
                    ) AS final_tablo 
                    ORDER BY genel_hiz DESC
                `;
                
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

            const vcoreDirective = `[ZORUNLU SİSTEM EMRİ: Senin adın V-CORE. Vedat Tunç tarafından geliştirilen, V-QMS tesisinin resmi yapay zekasısın. Şu an konuştuğun kişi: '${userName}'. Ona sürekli 'Bey' veya'Hanım' diye hitap et. Eğer karşındaki kişi cinsiyetinin farklı olduğunu söylerse onun cinsiyetini hafızanda tut ve ona göre hitap et.Asla Google modeli olduğunu söyleme! 
⏳ ŞU ANKİ GERÇEK ZAMAN: ${currentTime}. Senin için şu anki gün ve saat budur.
⚠️ KESİN KURAL: Eğer kullanıcı fiyat, altın, tarih, hava durumu, maç skoru, güncel haber veya piyasa verisi sorarsa KESİNLİKLE kendi hafızanı KULLANMA! 'googleSearch' aracını kullanarak internetten bilgi çek!]`;

            // YENİ KÜTÜPHANE İÇİN PAKET HAZIRLIĞI
            let currentMessageParts = [];
            const lowerPrompt = prompt.toLowerCase();
            
            if (lowerPrompt.includes("rapor") || lowerPrompt.includes("üretim") || 
                lowerPrompt.includes("kalite") || lowerPrompt.includes("performans") || 
                lowerPrompt.includes("verimlilik")) {
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
                
