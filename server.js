const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();

// [NEW] 모델별 가격표 (단위: 100만 토큰당 달러 $ / 이미지 1장당 $)
const PRICING = {
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 }, // 가성비 갑
    'gpt-4-turbo': { input: 10.00, output: 30.00 },
    'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
    'o1-preview': { input: 15.00, output: 60.00 },
    'o1-mini': { input: 3.00, output: 12.00 },
    // 이미지는 장당 가격 (Standard 1024x1024 기준)
    'dall-e-3': { per_image: 0.040 } 
};

const EXCHANGE_RATE = 1400; // 환율 (1달러 = 1400원)

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
            if (isMatch) res.status(200).json({ message: '성공', user: { id: user.id, name: user.name, profile_image: user.profile_image } });
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

// 4. 특정 대화의 메시지 내역 가져오기 (수정됨: 불러올 때 환율 적용 💱)
app.get('/api/conversations/:conversationId/messages', (req, res) => {
    const sql = 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC';
    db.query(sql, [req.params.conversationId], (err, results) => {
        if (err) return res.status(500).json({ error: 'DB 오류' });

        // [핵심 수정] DB에서 꺼낸 달러($) 비용을 원화(KRW)로 변환!
        const messagesWithKRW = results.map(msg => ({
            ...msg,
            // cost가 있으면 환율(1400) 곱하기, 없으면 0원
            cost: msg.cost ? Math.round(msg.cost * EXCHANGE_RATE * 100) / 100 : 0
        }));

        res.json(messagesWithKRW);
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

// 5. [UPDATE] 채팅 + 비용 계산 + 모델명 저장 통합 API
app.post('/api/chat', async (req, res) => {
    const { userId, message, conversationId, model, image } = req.body;
    const selectedModel = model || "gpt-4o";
    let currentConvId = conversationId;

    try {
        // 1. 유저 확인 및 API 키 가져오기
        const [userRows] = await db.promise().query('SELECT api_key FROM users WHERE id = ?', [userId]);
        if (userRows.length === 0) return res.status(400).json({ error: '유저 정보 없음' });
        const apiKey = userRows[0].api_key;
        const openai = new OpenAI({ apiKey });

        // 2. 대화방 없으면 생성
        if (!currentConvId) {
            const title = image ? "이미지 분석" : message.substring(0, 20);
            const [convResult] = await db.promise().query('INSERT INTO conversations (user_id, title) VALUES (?, ?)', [userId, title]);
            currentConvId = convResult.insertId;
        }

        // 3. 유저 질문 저장
        const savedContent = image ? `[이미지 첨부됨] ${message}` : message;
        await db.promise().query('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', [currentConvId, 'user', savedContent]);

        // [중요] 변수 초기화 (여기서 미리 만들어둬야 에러가 안 남!)
        let reply = "";
        let usageData = { prompt_tokens: 0, completion_tokens: 0 };
        let totalCost = 0;

        // ====================================================
        // 4. 모델 분기 처리 (AI 응답 생성)
        // ====================================================
        
        // [A] DALL-E 3 (이미지 생성)
        if (selectedModel === 'dall-e-3') {
            try {
                const imageResponse = await openai.images.generate({
                    model: "dall-e-3", prompt: message, n: 1, size: "1024x1024",
                });
                const originalUrl = imageResponse.data[0].url;
                
                // 파일 저장
                const fileName = `img-${Date.now()}.png`;
                const localPath = path.join(__dirname, 'uploads', fileName);
                const imgRes = await fetch(originalUrl);
                fs.writeFileSync(localPath, Buffer.from(await imgRes.arrayBuffer()));
                const webPath = `/uploads/${fileName}`;
                
                // 이미지용 DB 저장
                await db.promise().query('INSERT INTO generated_images (user_id, prompt, image_path) VALUES (?, ?, ?)', [userId, message, webPath]);
                
                reply = `<img src="${webPath}" alt="${message}" style="max-width: 100%; border-radius: 10px; margin-top: 10px;">`;
                
                // 비용 계산
                const priceInfo = PRICING['dall-e-3'] || { per_image: 0.04 };
                totalCost = priceInfo.per_image;

            } catch (e) { reply = "에러: " + e.message; }

        } 
        // [B] GPT (텍스트 & 비전)
        else {
            // [수정됨] 프론트에서 보낸 설정이 있으면 적용, 없으면 기본값
            const customSystemPrompt = req.body.systemInstruction;
            console.log("👉 적용된 페르소나:", customSystemPrompt || "기본 설정");
            const defaultSystemPrompt = `You are a helpful assistant. Model: ${selectedModel}.`;
            
            const systemMessage = { 
                role: "system", 
                content: customSystemPrompt || defaultSystemPrompt 
            };

            const [historyRows] = await db.promise().query('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [currentConvId]);
            
            const messagesForAI = [
                systemMessage, // 여기에 적용됨!
                ...historyRows.map(row => ({ role: row.role, content: row.content })),
            ];

            // ... (이하 이미지 처리 및 요청 로직은 기존과 동일) ...
            if (image) {
                messagesForAI.push({
                    role: "user",
                    content: [{ type: "text", text: message || "설명해줘" }, { type: "image_url", image_url: { url: image } }]
                });
            } else {
                messagesForAI.push({ role: "user", content: message });
            }

            const completion = await openai.chat.completions.create({
                model: selectedModel,
                messages: messagesForAI, 
            });

            reply = completion.choices[0].message.content;
            
            // ... (이하 비용 계산 로직 동일) ...
            if (completion.usage) {
                usageData = completion.usage;
                const priceInfo = PRICING[selectedModel] || PRICING['gpt-4o'];
                const inputCost = (usageData.prompt_tokens * priceInfo.input) / 1000000;
                const outputCost = (usageData.completion_tokens * priceInfo.output) / 1000000;
                totalCost = inputCost + outputCost;
            }
        }

        // 5. 결과 및 비용 저장 (여기가 맨 마지막에 와야 함!)
        // (DB에 model 컬럼이 추가되었으므로 selectedModel도 같이 저장)
        await db.promise().query(
            'INSERT INTO messages (conversation_id, role, content, prompt_tokens, completion_tokens, cost, model) VALUES (?, ?, ?, ?, ?, ?, ?)', 
            [currentConvId, 'assistant', reply, usageData.prompt_tokens, usageData.completion_tokens, totalCost, selectedModel]
        );

        // 프론트엔드 응답
        const costKRW = Math.round(totalCost * EXCHANGE_RATE * 100) / 100;

        res.json({ 
            reply, 
            conversationId: currentConvId,
            cost: costKRW, 
            tokens: usageData.total_tokens 
        });

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

// ... (기존 코드들) ...

// ==========================================
// [NEW] 마이페이지용 API 모음
// ==========================================

// 1. 사용량 대시보드 데이터 조회 (수정됨: 가입일 추가)
app.get('/api/user/:id/usage', async (req, res) => {
    const userId = req.params.id;
    try {
        // (1) 채팅 비용 합계
        const [chatRows] = await db.promise().query(
            'SELECT SUM(cost) as total_cost, COUNT(*) as total_count FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)', 
            [userId]
        );
        
        // (2) 이미지 생성 개수
        const [imgRows] = await db.promise().query(
            'SELECT COUNT(*) as total_count FROM generated_images WHERE user_id = ?',
            [userId]
        );

        // (3) [NEW] 유저 가입일 조회
        const [userRows] = await db.promise().query(
            'SELECT created_at FROM users WHERE id = ?',
            [userId]
        );

        // (4) 비용 계산
        const imageCostDollar = imgRows[0].total_count * 0.04;
        const chatCostDollar = chatRows[0].total_cost || 0;
        const totalCostDollar = chatCostDollar + imageCostDollar;
        const totalCostKRW = Math.round(totalCostDollar * EXCHANGE_RATE);

        res.json({
            cost: totalCostKRW,
            messageCount: chatRows[0].total_count,
            imageCount: imgRows[0].total_count,
            apiCostDollar: totalCostDollar.toFixed(4),
            joinDate: userRows[0].created_at // [NEW] 가입일 추가
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'DB Error' });
    }
});
// 2. 회원정보 수정 (프로필 사진, 비번, 이름)
app.post('/api/user/update', async (req, res) => {
    const { userId, name, password, profileImageBase64 } = req.body;

    try {
        let updateFields = [];
        let queryParams = [];

        // 이름 변경
        if (name) {
            updateFields.push('name = ?');
            queryParams.push(name);
        }

        // 비밀번호 변경 (암호화)
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            updateFields.push('password = ?');
            queryParams.push(hashedPassword);
        }

        // 프로필 사진 변경 (파일로 저장)
        if (profileImageBase64) {
            const matches = profileImageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches) {
                const buffer = Buffer.from(matches[2], 'base64');
                const fileName = `profile-${userId}-${Date.now()}.png`;
                const localPath = path.join(__dirname, 'uploads', fileName);
                fs.writeFileSync(localPath, buffer);
                
                const webPath = `/uploads/${fileName}`;
                updateFields.push('profile_image = ?');
                queryParams.push(webPath);
            }
        }

        if (updateFields.length === 0) return res.json({ message: '변경할 내용이 없습니다.' });

        // DB 업데이트 실행
        queryParams.push(userId);
        const sql = `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`;
        
        await db.promise().query(sql, queryParams);

        // 변경된 최신 유저 정보 다시 조회해서 반환
        const [rows] = await db.promise().query('SELECT id, name, email, api_key, profile_image FROM users WHERE id = ?', [userId]);
        
        res.json({ success: true, user: rows[0] });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '업데이트 실패' });
    }
});

// [NEW] 이미지 삭제 API (DB + 파일 삭제)
app.delete('/api/images/:id', async (req, res) => {
    const imageId = req.params.id;

    try {
        // 1. 삭제할 이미지의 파일 경로 조회
        const [rows] = await db.promise().query('SELECT image_path FROM generated_images WHERE id = ?', [imageId]);
        
        if (rows.length > 0) {
            const webPath = rows[0].image_path; // 예: /uploads/img-123.png
            const fileName = webPath.split('/').pop(); // img-123.png
            const localPath = path.join(__dirname, 'uploads', fileName);

            // 2. 실제 파일 삭제 (파일이 존재하면)
            if (fs.existsSync(localPath)) {
                fs.unlinkSync(localPath);
            }
        }

        // 3. DB 기록 삭제
        await db.promise().query('DELETE FROM generated_images WHERE id = ?', [imageId]);

        res.json({ success: true });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '이미지 삭제 실패' });
    }
});

app.listen(3000, () => {
    console.log('🚀 서버 실행 중: http://localhost:3000');
});