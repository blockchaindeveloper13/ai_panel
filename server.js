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

            // --- YENİ: GEÇMİŞİ YÜKLEME KOMUTU (AKILLI HAFIZA) ---
            if (mode === 'load_history') {
                let activeSessionId = sessionId;

                // 1. KİLİT NOKTA: Eğer Android numarayı unuttuysa (-1 ise), veritabanından kullanıcının son sohbetini bul!
                if (!activeSessionId || activeSessionId === -1) {
                    const [existingSessions] = await pool.query(
                        "SELECT id FROM chat_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1",
                        [userId]
                    );
                    if (existingSessions.length > 0) {
                        activeSessionId = existingSessions[0].id; // Kullanıcının gizli sohbet odasını bulduk!
                    }
                }

                // 2. Eğer geçerli bir sohbet odası bulduysak mesajları çek ve Android'e fırlat
                if (activeSessionId && activeSessionId !== -1) {
                    const [rows] = await pool.query(
                        "SELECT sender, message FROM chat_messages WHERE session_id = ? ORDER BY id ASC", 
                        [activeSessionId]
                    );
                    ws.send(JSON.stringify({ status: 'history', data: rows, sessionId: activeSessionId }));
                } else {
                    // 3. Hiç sohbeti yoksa, boş bir liste gönder ki Android o ilk "Merhaba" karşılama yazısını ekrana çizebilsin!
                    ws.send(JSON.stringify({ status: 'history', data: [], sessionId: -1 }));
                }
                return;
            }

            // --- YENİ: SOHBETİ TEMİZLEME KOMUTU ---
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
                console.log("=====================================");
                console.log("🟢 PERFORMANS MODU TETİKLENDİ");
                console.log("Gelen Veri (data):", data);

                const gunSayisi = parseInt(data.days) || 3;
                console.log("Hesaplanacak Aktif Gün Sayısı:", gunSayisi);

                // YENİ MANTIK: Takvimden değil, "en son rapor girilen X günden" verileri çeker
                // FİLTRE: Deneme isimlerini listeye alma ve gereksiz rapor sayısını gizle
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
                        /* İŞTE FİLTRE BURADA: Deneme kayıtlarını listeye alma */
                        AND personel_adi NOT IN ('Sevgi Sert', 'Dilara sert', 'Dilara Sert')
                        GROUP BY personel_adi, tarih
                    ) as gunluk_tablo
                    GROUP BY personel_adi
                    ORDER BY genel_hiz DESC
                `;

                console.log("Çalıştırılacak SQL Sorgusu Hazırlandı.");

                try {
                    console.log("⏳ Veritabanına sorgu atılıyor...");
                    const [rows] = await pool.query(sqlQuery);
                    
                    console.log("✅ SQL Sorgusu Başarılı! Dönen Satır Sayısı:", rows.length);
                    if (rows.length > 0) {
                        console.log("Örnek Veri (İlk Satır):", rows[0]);
                    } else {
                        console.log("Uyarı: Veritabanından boş tablo döndü (Kayıt yok veya filtrelendi).");
                    }

                    const responsePacket = JSON.stringify({ 
                        status: 'success', 
                        type: 'performance_data',
                        data: rows 
                    });
                    
                    console.log("🚀 Android'e veri paketi gönderiliyor...");
                    return ws.send(responsePacket);

                } catch (sqlError) {
                    // HATA YAKALAYICI
                    console.error("❌ SQL SORGUSU SIRASINDA KRİTİK HATA OLUŞTU:");
                    console.error("Hata Detayı (Message):", sqlError.message);
                    console.error("SQL Kodu (Code):", sqlError.code);
                    
                    return ws.send(JSON.stringify({ 
                        status: 'error', 
                        reply: "Sunucu SQL Hatası: " + sqlError.message 
                    }));
                }
            }
            
            
            

            // 🤖 3. BÖLÜM: V-CORE ASİSTAN MODLARI (Vision, Data, Chat)
            
            // Sadece asistan modlarında kullanıcının mesajını kaydet
                        // 🤖 3. BÖLÜM: V-CORE ASİSTAN MODLARI (Vision, Data, Chat)
            
            // MOBİL İÇİN OTOMATİK SESSION (SOHBET NO) MANTIĞI:
            let activeSessionId = sessionId;
            
            // Eğer Android geçerli bir sessionId göndermediyse (veya kendi User ID'sini yolladıysa),
            // Veritabanına bak, bu kullanıcının mevcut bir sohbeti var mı? Yoksa oluştur.
            if (!activeSessionId || activeSessionId === -1 || activeSessionId === userId) {
                // 1. Önce bu kullanıcının "chat_sessions" tablosunda bir sohbeti var mı bak
                const [existingSessions] = await pool.query(
                    "SELECT id FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1", 
                    [userId]
                );
                
                if (existingSessions.length > 0) {
                    activeSessionId = existingSessions[0].id; // Var olanı kullan
                } else {
                    // 2. Yoksa yepyeni bir sohbet dosyası oluştur
                    const [newSession] = await pool.query(
                        "INSERT INTO chat_sessions (user_id) VALUES (?)", 
                        [userId]
                    );
                    activeSessionId = newSession.insertId; // Yeni oluşturulanın ID'sini al
                }
            }

            // Artık güvenli ve geçerli bir activeSessionId'miz var!
            // Kullanıcının mesajını ve varsa resmini kaydet
            const imgDataToSave = imageBase64 ? imageBase64 : null;
            const msgText = imageBase64 ? "[Görsel eklendi] " + prompt : prompt;
            
            await pool.query(
                "INSERT INTO chat_messages (session_id, sender, message, image_data) VALUES (?, 'user', ?, ?)", 
                [activeSessionId, msgText, imgDataToSave]
            );

            // Geçmişi Getir (Hafıza)
            let history = [];
            if(mode === 'chat') {
                history = await getChatHistory(activeSessionId);
            }

            // Senaryo A: Görsel Analiz
                        // Senaryo A: Görsel ve DOSYA (PDF, TXT vb.) Analizi
            if (mode === 'vision' && data.imagesBase64 && data.imagesBase64.length > 0) {
                // Gemini'ye gönderilecek parçaları (Soru + Dosyalar) hazırlıyoruz
                let geminiParts = [ prompt || "Lütfen ekteki dosyayı/görseli detaylıca analiz et." ];

                // Android'den gelen tüm dosyaları dön ve formatlarını algıla
                for (const mediaStr of data.imagesBase64) {
                    // Gelen formatı parçala (Örn: "data:application/pdf;base64,JVBERi...")
                    const matches = mediaStr.match(/^data:(.+);base64,(.+)$/);
                    
                    if (matches && matches.length === 3) {
                        const detectedMimeType = matches[1]; // image/jpeg, application/pdf vb.
                        const cleanBase64 = matches[2];      // Saf dosya şifresi
                        
                        // Gemini'nin anlayacağı formata çevirip pakete ekle
                        geminiParts.push({
                            inlineData: {
                                data: cleanBase64,
                                mimeType: detectedMimeType
                            }
                        });
                    }
                }

                // Paketi (Soru + İçindeki PDF/Resimler) Gemini'ye fırlat
                const result = await model.generateContent(geminiParts);
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
            if(aiReply) {
                await pool.query(
                    "INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'ai', ?)", 
                    [activeSessionId, aiReply]
                );
            }

            // Android'e cevabı yollarken, yeni oluşan session_id'yi de bildir ki telefonda aklında tutsun
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
