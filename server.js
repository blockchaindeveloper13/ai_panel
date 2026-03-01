const express = require('express');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;
const server = express().listen(PORT, () => console.log(`Listening on ${PORT}`));
const wss = new WebSocketServer({ server });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Not: 2.5 yerine stabil ve güncel olan 2.5-flash modelini tanımladık
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
        const [rows] = await pool.query("SELECT sender, message FROM chat_messages WHERE session_id = ? ORDER BY id ASC LIMIT 20", [sessionId]);
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
            // Android'den artık userId, sourceLang ve targetLang de göndereceğiz
            const { userId, prompt, mode, imageBase64, sessionId, sourceLang, targetLang } = data;
            let aiReply = "";

            // 🛡️ 1. GÜVENLİK DUVARI: SADECE ADMİN KONTROLÜ
            if (!userId) {
                return ws.send(JSON.stringify({ status: 'error', reply: "Bağlantı reddedildi: Kullanıcı kimliği yok." }));
            }

            const [userRows] = await pool.query("SELECT role FROM users WHERE id = ?", [userId]);
            if (userRows.length === 0 || userRows[0].role.toUpperCase() !== 'ADMIN'){
                return ws.send(JSON.stringify({ 
                    status: 'error', 
                    reply: "Yetki Reddedildi: V-CORE özelliklerine sadece Yöneticiler (ADMİN) erişebilir." 
                }));
            }

            // 🌐 2. BÖLÜM: ÇEVİRMEN MODU (İzole Edilmiş Alan)
            if (mode === 'translate') {
                // Eğer dil seçilmemişse varsayılanları ata
                const kaynakDil = sourceLang || "Otomatik Algıla";
                const hedefDil = targetLang || "İngilizce"; 
                
                // Gemini'nin beynini yıkıyoruz: "Sen sadece bir çevirmensin"
                const systemInstruction = `Sen sadece profesyonel bir yeminli tercümansın. Sana verilen metni '${kaynakDil}' dilinden '${hedefDil}' diline çevir. Asla sohbet etme, açıklama yapma, soru sorma veya ekstra bilgi verme. Sadece çevrilmiş metni ver.`;
                
                const translatePrompt = `${systemInstruction}\n\nÇevrilecek Metin:\n${prompt}`;
                
                const result = await model.generateContent(translatePrompt);
                aiReply = result.response.text();

                // DİKKAT: Çeviri modunda veritabanına kayıt (History) YAPMIYORUZ. Direkt cevabı dönüp bitiriyoruz.
                return ws.send(JSON.stringify({ status: 'success', reply: aiReply }));
            }

                        // 🏆 4. BÖLÜM: PERFORMANS (LİDERLİK TABLOSU) MODU
            if (mode === 'performance') {
                const gunSayisi = data.days || 3; // Android'den 3, 7 veya 30 gelecek

                // Senin "Yevmiyeci" mantığına birebir uyan SQL Sorgusu:
                // 1. Önce her personelin (ve yevmiyecilerin) GÜNLÜK ortalama hızını bulur.
                // 2. Sonra bu günlük ortalamaların, seçilen gün sayısına göre GENEL ortalamasını alır.
                const sqlQuery = `
                    SELECT personel_adi, 
                           ROUND(AVG(gunluk_hiz)) as genel_hiz, 
                           COUNT(tarih) as rapor_gun_sayisi
                    FROM (
                        SELECT personel_adi, tarih, AVG(hiz_kg_saat) as gunluk_hiz
                        FROM uretim_verimlilik
                        WHERE tarih >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
                        GROUP BY personel_adi, tarih
                    ) as gunluk_tablo
                    GROUP BY personel_adi
                    ORDER BY genel_hiz DESC
                `;

                const [rows] = await pool.query(sqlQuery, [gunSayisi]);
                
                // Android'in listeye dökebilmesi için JSON formatında gönderiyoruz
                return ws.send(JSON.stringify({ 
                    status: 'success', 
                    type: 'performance_data',
                    data: rows 
                }));
            }
            

            // 🤖 3. BÖLÜM: V-CORE ASİSTAN MODLARI (Vision, Data, Chat)
            
            // Sadece asistan modlarında kullanıcının mesajını kaydet
            if(sessionId) {
                const imgDataToSave = imageBase64 ? imageBase64 : null;
                const msgText = imageBase64 ? "[Görsel]: " + prompt : prompt;
                await pool.query(
                    "INSERT INTO chat_messages (session_id, sender, message, image_data) VALUES (?, 'user', ?, ?)", 
                    [sessionId, msgText, imgDataToSave]
                );
            }

            let history = [];
            if(sessionId && mode === 'chat') {
                history = await getChatHistory(sessionId);
            }

            // Senaryo A: Görsel Analiz
            if (mode === 'vision' && imageBase64) {
                const cleanBase64 = imageBase64.split(',')[1];
                const imagePart = { inlineData: { data: cleanBase64, mimeType: "image/jpeg" } };
                const result = await model.generateContent([prompt || "Bu resimde ne görüyorsun?", imagePart]);
                aiReply = result.response.text();
            }
            // Senaryo B: Veri Madenciliği
            else if (mode === 'data') {
                const factoryData = await getAllFactoryData();
                const chat = model.startChat({ history: [] }); 
                const msg = `Fabrika Verileri:\n${factoryData}\n\nSoru: ${prompt}`;
                const result = await chat.sendMessage(msg);
                aiReply = result.response.text();
            }
            // Senaryo C: Sohbet (Hafızalı)
            else if (mode === 'chat') {
                const chat = model.startChat({
                    history: history,
                    generationConfig: { maxOutputTokens: 1000 }
                });
                const result = await chat.sendMessage(prompt);
                aiReply = result.response.text();
            }

            // Sadece asistan modlarında V-CORE'un cevabını kaydet
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
