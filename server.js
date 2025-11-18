const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(express.static(path.join(__dirname, '.')));
app.use(cors());
// DB 연결
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'wowxc', // 본인 비밀번호 확인!
    database: 'chatgpt_clone'
});

// 1. 회원가입
app.post('/api/signup', async (req, res) => {
    const { name, email, password, apiKey } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = 'INSERT INTO users (name, email, password, api_key) VALUES (?, ?, ?, ?)';
        db.query(sql, [name, email, hashedPassword, apiKey], (err) => {
            if (err) return res.status(500).json({ message: '회원가입 실패' });
            res.status(201).json({ message: '가입 성공' });
        });
    } catch (error) {
        res.status(500).json({ message: '서버 에러' });
    }
});

// 2. 로그인
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
        if (err || results.length === 0) return res.status(401).json({ message: '로그인 실패' });
        const user = results[0];
        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (isMatch) res.status(200).json({ message: '성공', user: { id: user.id, name: user.name } });
            else res.status(401).json({ message: '비밀번호 불일치' });
        });
    });
});

// 3. 대화 목록 가져오기
app.get('/api/conversations/:userId', (req, res) => {
    const sql = 'SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC';
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: 'DB 오류' });
        res.json(results);
    });
});

// 4. 특정 대화의 메시지 내역 가져오기
app.get('/api/conversations/:conversationId/messages', (req, res) => {
    const sql = 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC';
    db.query(sql, [req.params.conversationId], (err, results) => {
        if (err) return res.status(500).json({ error: 'DB 오류' });
        res.json(results);
    });
});

// [NEW] 4.5 이미지 라이브러리 목록 가져오기
// ==========================================
app.get('/api/images/:userId', (req, res) => {
    const sql = 'SELECT * FROM generated_images WHERE user_id = ? ORDER BY created_at DESC';
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: 'DB 오류' });
        res.json(results);
    });
});

// 5. [UPDATE] 채팅, 이미지 생성, 비전 인식 통합 API
app.post('/api/chat', async (req, res) => {
    const { userId, message, conversationId, model, image } = req.body; // [NEW] image 받기
    const selectedModel = model || "gpt-4o";
    let currentConvId = conversationId;

    try {
        // 1. 기본 설정 (API Key 등) - 기존과 동일
        const [userRows] = await db.promise().query('SELECT api_key FROM users WHERE id = ?', [userId]);
        if (userRows.length === 0) return res.status(400).json({ error: '유저 정보 없음' });
        const apiKey = userRows[0].api_key;
        const openai = new OpenAI({ apiKey });

        // 2. 대화방 없으면 생성
        if (!currentConvId) {
            // 이미지가 있으면 제목을 '이미지 대화'로
            const title = image ? "이미지 분석" : message.substring(0, 20);
            const [convResult] = await db.promise().query('INSERT INTO conversations (user_id, title) VALUES (?, ?)', [userId, title]);
            currentConvId = convResult.insertId;
        }

        // 3. 유저 메시지 저장 (이미지는 용량 문제로 텍스트인 [이미지 첨부됨]으로 대체 저장 권장)
        const savedContent = image ? `[이미지 첨부됨] ${message}` : message;
        await db.promise().query('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', [currentConvId, 'user', savedContent]);

        let reply = "";

        // ====================================================
        // 4. 모델 분기 처리
        // ====================================================
        
        // [A] DALL-E 3 (이미지 생성)
        if (selectedModel === 'dall-e-3') {
            // ... (기존 DALL-E 코드 그대로 사용) ...
            try {
                const imageResponse = await openai.images.generate({
                    model: "dall-e-3", prompt: message, n: 1, size: "1024x1024",
                });
                const originalUrl = imageResponse.data[0].url;
                const fileName = `img-${Date.now()}.png`;
                const localPath = path.join(__dirname, 'uploads', fileName);
                const imgRes = await fetch(originalUrl);
                const buffer = Buffer.from(await imgRes.arrayBuffer());
                fs.writeFileSync(localPath, buffer);
                const webPath = `/uploads/${fileName}`;
                await db.promise().query('INSERT INTO generated_images (user_id, prompt, image_path) VALUES (?, ?, ?)', [userId, message, webPath]);
                reply = `<img src="${webPath}" alt="${message}" style="max-width: 100%; border-radius: 10px; margin-top: 10px;">`;
            } catch (e) { reply = "에러: " + e.message; }

        } 
        // [B] Sora (비디오)
        else if (selectedModel.startsWith('sora')) {
            // ... (기존 Sora 코드 그대로 사용) ...
            reply = "Sora 기능은 현재 API 정책상 보류 중입니다."; 
        }
        // [C] GPT (텍스트 & 비전) <--- 여기가 핵심 수정됨!
        else {
            const systemMessage = {
                role: "system",
                content: `You are a helpful assistant. Model: ${selectedModel}.`
            };

            // 이전 대화 기록 불러오기
            const [historyRows] = await db.promise().query(
                'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', 
                [currentConvId]
            );

            const messagesForAI = [
                systemMessage, 
                ...historyRows.map(row => ({ role: row.role, content: row.content })),
            ];

            // [NEW] 현재 메시지 구성 (이미지가 있냐 없냐에 따라 다름)
            if (image) {
                // 이미지가 있으면: 멀티모달 포맷으로 전송
                messagesForAI.push({
                    role: "user",
                    content: [
                        { type: "text", text: message || "이 이미지에 대해 설명해줘" },
                        { type: "image_url", image_url: { url: image } } // Base64 이미지
                    ]
                });
            } else {
                // 텍스트만 있으면: 일반 포맷
                messagesForAI.push({ role: "user", content: message });
            }

            const completion = await openai.chat.completions.create({
                model: selectedModel,
                messages: messagesForAI, 
            });

            reply = completion.choices[0].message.content;
        }

        // 5. 결과 저장
        await db.promise().query('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', [currentConvId, 'assistant', reply]);

        res.json({ reply, conversationId: currentConvId });

    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ error: '서버 에러: ' + error.message });
    }
});
app.delete('/api/conversations/:id', (req, res) => {
    const conversationId = req.params.id;

    // 1. 메시지 먼저 삭제
    db.query('DELETE FROM messages WHERE conversation_id = ?', [conversationId], (err) => {
        if (err) return res.status(500).json({ error: '메시지 삭제 실패' });

        // 2. 대화방 삭제
        db.query('DELETE FROM conversations WHERE id = ?', [conversationId], (err) => {
            if (err) return res.status(500).json({ error: '대화방 삭제 실패' });
            res.json({ message: '삭제 성공' });
        });
    });
});

app.listen(3000, () => {
    console.log('🚀 서버 실행 중: http://localhost:3000');
});