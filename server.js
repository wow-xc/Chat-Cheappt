const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');

const app = express();

app.use(express.json());
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

// 3. [NEW] 대화 목록 가져오기
app.get('/api/conversations/:userId', (req, res) => {
    const sql = 'SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC';
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: 'DB 오류' });
        res.json(results);
    });
});

// 4. [NEW] 특정 대화의 메시지 내역 가져오기
app.get('/api/conversations/:conversationId/messages', (req, res) => {
    const sql = 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC';
    db.query(sql, [req.params.conversationId], (err, results) => {
        if (err) return res.status(500).json({ error: 'DB 오류' });
        res.json(results);
    });
});

// 5. [UPDATE] 채팅하기 (저장 기능 추가)
app.post('/api/chat', (req, res) => {
    const { userId, message, conversationId } = req.body;

    // API Key 조회
    db.query('SELECT api_key FROM users WHERE id = ?', [userId], async (err, results) => {
        if (err || results.length === 0) return res.status(400).json({ error: '유저 정보 없음' });
        
        const apiKey = results[0].api_key;
        const openai = new OpenAI({ apiKey });

        let currentConvId = conversationId;

        // 대화방 ID가 없으면 새로 생성 (첫 메시지인 경우)
        if (!currentConvId) {
            const title = message.substring(0, 20); // 메시지 앞부분을 제목으로
            const convSql = 'INSERT INTO conversations (user_id, title) VALUES (?, ?)';
            try {
                const [convResult] = await db.promise().query(convSql, [userId, title]);
                currentConvId = convResult.insertId;
            } catch (e) {
                return res.status(500).json({ error: '대화방 생성 실패' });
            }
        }

        try {
            // 1. 유저 메시지 저장
            await db.promise().query('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', [currentConvId, 'user', message]);

            // 2. GPT 호출 (이전 대화 내용 포함하면 더 좋지만, 일단 현재 질문만)
            const completion = await openai.chat.completions.create({
                model: "gpt-4",
                messages: [{ role: "user", content: message }],
            });
            const reply = completion.choices[0].message.content;

            // 3. AI 응답 저장
            await db.promise().query('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', [currentConvId, 'assistant', reply]);

            // 4. 응답 반환 (새로 만든 방 번호도 함께 줌)
            res.json({ reply, conversationId: currentConvId });

        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'OpenAI API 오류' });
        }
    });
});

app.listen(3000, () => {
    console.log('🚀 서버 실행 중: http://localhost:3000');
});