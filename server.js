/**
 * ChatConnect — real-time chat server.
 *
 * Express + Socket.IO + local SQLite. No third-party/cloud services.
 */
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { Server } = require('socket.io');

const db = require('./db');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: true, credentials: true },
    maxHttpBufferSize: 1e7
});

// Reflect the requesting origin and allow credentials, so the session cookie
// is accepted when the app is embedded in an iframe on another domain.
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ---------------------------------------------------------------- static ----

// `index: false` so the templated route below handles "/" (cache busting).
app.use(express.static(PUBLIC_DIR, { index: false }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

// Asset version = newest mtime of css/js, so browsers can never serve a stale
// bundle after an edit.
function assetVersion() {
    try {
        const a = fs.statSync(path.join(PUBLIC_DIR, 'css', 'styles.css')).mtimeMs;
        const b = fs.statSync(path.join(PUBLIC_DIR, 'js', 'app.js')).mtimeMs;
        return Math.floor(Math.max(a, b)).toString(36);
    } catch {
        return Date.now().toString(36);
    }
}

app.get('/', (req, res) => {
    fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
        if (err) return res.status(500).send('Failed to load app');
        res.set('Cache-Control', 'no-store, must-revalidate');
        res.type('html').send(html.replace(/__V__/g, assetVersion()));
    });
});

// ---------------------------------------------------------------- uploads ---

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_DIR),
        filename: (req, file, cb) => {
            const safe = path.extname(file.originalname).slice(0, 12).replace(/[^\w.]/g, '');
            cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safe}`);
        }
    }),
    limits: { fileSize: 25 * 1024 * 1024 }
});

// ------------------------------------------------------------------ auth ----

function sign(user) {
    // jti makes every issued token unique, so signing in again after a
    // sign-out never reuses a revoked token.
    return jwt.sign({
        id: user.id,
        phone: user.phone,
        name: user.name,
        jti: crypto.randomBytes(12).toString('hex')
    }, JWT_SECRET, { expiresIn: '30d' });
}

// Session cookie. Set by the server (HttpOnly) so it survives the browser
// clearing localStorage/sessionStorage — which is routine for a site running
// inside a cross-origin iframe, and used to log people out after a minute.
const COOKIE = 'cc_session';
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

function setSessionCookie(res, token) {
    res.cookie(COOKIE, token, {
        httpOnly: true,
        sameSite: 'none',   // required for the app to work inside an iframe
        secure: true,       // SameSite=None demands Secure
        maxAge: THIRTY_DAYS,
        path: '/'
    });
    // Fallback for plain http://localhost, where a Secure cookie is dropped.
    res.cookie(COOKIE + '_lax', token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: THIRTY_DAYS,
        path: '/'
    });
}

// Tokens invalidated by an explicit sign-out. Belt-and-braces: clearing the
// cookie should be enough, but a client that still presents one must not be
// let back in. Entries are dropped once the token would have expired anyway.
const revoked = new Map(); // token -> expiry ms

function revoke(token) {
    if (!token) return;
    revoked.set(token, Date.now() + THIRTY_DAYS);
    if (revoked.size > 5000) {
        const now = Date.now();
        for (const [t, exp] of revoked) if (exp < now) revoked.delete(t);
    }
}

function clearSessionCookie(res) {
    res.clearCookie(COOKIE, { path: '/', sameSite: 'none', secure: true });
    res.clearCookie(COOKIE + '_lax', { path: '/', sameSite: 'lax' });
}

// Accepts the token from the Authorization header or, if the browser has
// dropped web storage, from the session cookie.
function readToken(req) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
        const t = header.slice(7);
        if (t && t !== 'null' && t !== 'undefined') return t;
    }
    return (req.cookies && (req.cookies[COOKIE] || req.cookies[COOKIE + '_lax'])) || null;
}

function auth(req, res, next) {
    const token = readToken(req);
    if (!token || token === 'null' || token === 'undefined') {
        return res.status(401).json({ error: 'Not signed in' });
    }
    if (revoked.has(token)) {
        return res.status(401).json({ error: 'Session expired' });
    }
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Session expired' });
    }
}

// Wraps async handlers so a rejected promise becomes a clean 500.
const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
        console.error(`[api] ${req.method} ${req.path}`, err);
        if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    });

const normalisePhone = (p) => String(p || '').replace(/[\s\-().]/g, '');

const publicUser = (u) => ({
    id: u.id,
    phone: u.phone,
    name: u.name,
    avatar: u.avatar,
    about: u.about
});

app.post('/api/auth/register', wrap(async (req, res) => {
    const phone = normalisePhone(req.body.phone);
    const name = String(req.body.name || '').trim();
    const password = String(req.body.password || '');

    if (!/^\+?\d{7,15}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number' });
    if (name.length < 2) return res.status(400).json({ error: 'Enter your name' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await db.get('SELECT id FROM users WHERE phone = ?', [phone]);
    if (existing) return res.status(409).json({ error: 'That number is already registered' });

    const hash = await bcrypt.hash(password, 10);
    const { lastID } = await db.run(
        'INSERT INTO users (phone, name, password) VALUES (?, ?, ?)',
        [phone, name, hash]
    );

    const user = await db.get('SELECT * FROM users WHERE id = ?', [lastID]);
    const token = sign(user);
    setSessionCookie(res, token);
    res.json({ token, user: publicUser(user) });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
    const phone = normalisePhone(req.body.phone);
    const password = String(req.body.password || '');

    const user = await db.get('SELECT * FROM users WHERE phone = ?', [phone]);
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Wrong phone number or password' });
    }

    const token = sign(user);
    setSessionCookie(res, token);
    res.json({ token, user: publicUser(user) });
}));

app.post('/api/auth/logout', (req, res) => {
    revoke(readToken(req));
    clearSessionCookie(res);
    res.json({ ok: true });
});

app.get('/api/me', auth, wrap(async (req, res) => {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    res.json(publicUser(user));
}));

app.put('/api/me', auth, wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const about = String(req.body.about || '').trim();
    if (name.length < 2) return res.status(400).json({ error: 'Enter your name' });

    await db.run('UPDATE users SET name = ?, about = ? WHERE id = ?', [name, about, req.user.id]);
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json(publicUser(user));
}));

// -------------------------------------------------------------- contacts ----

/** Returns the conversation id for a pair, creating it when missing. */
async function conversationFor(a, b) {
    const [x, y] = a < b ? [a, b] : [b, a];
    const found = await db.get('SELECT id FROM conversations WHERE user_a = ? AND user_b = ?', [x, y]);
    if (found) return found.id;
    const { lastID } = await db.run('INSERT INTO conversations (user_a, user_b) VALUES (?, ?)', [x, y]);
    return lastID;
}

app.get('/api/users/search', auth, wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const like = `%${q}%`;
    const rows = await db.all(
        `SELECT u.id, u.name, u.phone, u.avatar, u.about, u.is_online,
                EXISTS(SELECT 1 FROM contacts c
                        WHERE c.owner_id = ? AND c.contact_id = u.id) AS is_contact
           FROM users u
          WHERE u.id != ? AND (u.name LIKE ? OR u.phone LIKE ?)
       ORDER BY u.name
          LIMIT 25`,
        [req.user.id, req.user.id, like, like]
    );
    res.json(rows);
}));

app.get('/api/contacts', auth, wrap(async (req, res) => {
    const rows = await db.all(
        `SELECT u.id                AS contact_id,
                COALESCE(c.nickname, u.name) AS name,
                u.phone, u.avatar, u.about, u.is_online, u.last_seen,
                cv.id               AS conversation_id,
                (SELECT body FROM messages m
                  WHERE m.conversation_id = cv.id AND m.is_deleted = 0
               ORDER BY m.id DESC LIMIT 1)        AS last_message,
                (SELECT kind FROM messages m
                  WHERE m.conversation_id = cv.id AND m.is_deleted = 0
               ORDER BY m.id DESC LIMIT 1)        AS last_kind,
                (SELECT created_at FROM messages m
                  WHERE m.conversation_id = cv.id AND m.is_deleted = 0
               ORDER BY m.id DESC LIMIT 1)        AS last_at,
                (SELECT COUNT(*) FROM messages m
                  WHERE m.conversation_id = cv.id
                    AND m.receiver_id = ? AND m.read_at IS NULL
                    AND m.is_deleted = 0)         AS unread
           FROM contacts c
           JOIN users u ON u.id = c.contact_id
      LEFT JOIN conversations cv
                 ON cv.user_a = MIN(c.owner_id, c.contact_id)
                AND cv.user_b = MAX(c.owner_id, c.contact_id)
          WHERE c.owner_id = ?
       ORDER BY (last_at IS NULL), last_at DESC, u.name`,
        [req.user.id, req.user.id]
    );
    res.json(rows);
}));

app.post('/api/contacts', auth, wrap(async (req, res) => {
    const phone = normalisePhone(req.body.phone);
    const target = req.body.userId
        ? await db.get('SELECT * FROM users WHERE id = ?', [req.body.userId])
        : await db.get('SELECT * FROM users WHERE phone = ?', [phone]);

    if (!target) return res.status(404).json({ error: 'No account found with that number' });
    if (target.id === req.user.id) return res.status(400).json({ error: "You can't add yourself" });

    await db.run(
        'INSERT OR IGNORE INTO contacts (owner_id, contact_id, nickname) VALUES (?, ?, ?)',
        [req.user.id, target.id, req.body.nickname || null]
    );
    // Make the contact mutual so either side can start the chat.
    await db.run(
        'INSERT OR IGNORE INTO contacts (owner_id, contact_id) VALUES (?, ?)',
        [target.id, req.user.id]
    );
    const conversationId = await conversationFor(req.user.id, target.id);

    io.to(`user:${target.id}`).emit('contacts:changed');
    res.json({ contact: publicUser(target), conversationId });
}));

app.delete('/api/contacts/:id', auth, wrap(async (req, res) => {
    await db.run('DELETE FROM contacts WHERE owner_id = ? AND contact_id = ?', [
        req.user.id, req.params.id
    ]);
    res.json({ ok: true });
}));

// --------------------------------------------------------------- messages ---

/** Confirms the signed-in user belongs to the conversation. */
async function assertMember(conversationId, userId) {
    const cv = await db.get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
    if (!cv) return null;
    if (cv.user_a !== userId && cv.user_b !== userId) return null;
    return cv;
}

app.get('/api/messages/:conversationId', auth, wrap(async (req, res) => {
    const cv = await assertMember(Number(req.params.conversationId), req.user.id);
    if (!cv) return res.status(404).json({ error: 'Conversation not found' });

    const rows = await db.all(
        `SELECT id, conversation_id, sender_id, receiver_id, body, kind,
                file_url, file_name, file_size, duration,
                is_edited, is_deleted, delivered_at, read_at, created_at
           FROM messages
          WHERE conversation_id = ?
       ORDER BY id ASC
          LIMIT 500`,
        [cv.id]
    );

    // Opening a chat marks everything addressed to me as read.
    await db.run(
        `UPDATE messages SET read_at = CURRENT_TIMESTAMP
          WHERE conversation_id = ? AND receiver_id = ? AND read_at IS NULL`,
        [cv.id, req.user.id]
    );

    const other = cv.user_a === req.user.id ? cv.user_b : cv.user_a;
    io.to(`user:${other}`).emit('messages:read', { conversationId: cv.id, by: req.user.id });

    res.json(rows);
}));

app.post('/api/messages', auth, wrap(async (req, res) => {
    const receiverId = Number(req.body.receiverId);
    const kind = ['text', 'image', 'video', 'audio', 'file'].includes(req.body.kind)
        ? req.body.kind : 'text';
    const body = String(req.body.body || '').slice(0, 4000);

    if (!receiverId) return res.status(400).json({ error: 'Missing recipient' });
    if (kind === 'text' && !body.trim()) return res.status(400).json({ error: 'Message is empty' });

    const receiver = await db.get('SELECT id FROM users WHERE id = ?', [receiverId]);
    if (!receiver) return res.status(404).json({ error: 'Recipient not found' });

    const conversationId = await conversationFor(req.user.id, receiverId);

    const { lastID } = await db.run(
        `INSERT INTO messages
            (conversation_id, sender_id, receiver_id, body, kind, file_url, file_name, file_size, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            conversationId, req.user.id, receiverId, body, kind,
            req.body.fileUrl || null, req.body.fileName || null,
            req.body.fileSize || null, req.body.duration || null
        ]
    );

    const message = await db.get('SELECT * FROM messages WHERE id = ?', [lastID]);

    // Deliver instantly to the recipient (and the sender's other tabs).
    io.to(`user:${receiverId}`).emit('message:new', message);
    io.to(`user:${req.user.id}`).emit('message:new', message);

    res.json(message);
}));

app.put('/api/messages/:id', auth, wrap(async (req, res) => {
    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [req.params.id]);
    if (!msg || msg.sender_id !== req.user.id) return res.status(404).json({ error: 'Message not found' });

    const body = String(req.body.body || '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: 'Message is empty' });

    await db.run('UPDATE messages SET body = ?, is_edited = 1 WHERE id = ?', [body, msg.id]);
    const updated = await db.get('SELECT * FROM messages WHERE id = ?', [msg.id]);

    io.to(`user:${msg.receiver_id}`).emit('message:updated', updated);
    io.to(`user:${msg.sender_id}`).emit('message:updated', updated);
    res.json(updated);
}));

app.delete('/api/messages/:id', auth, wrap(async (req, res) => {
    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [req.params.id]);
    if (!msg || msg.sender_id !== req.user.id) return res.status(404).json({ error: 'Message not found' });

    await db.run(
        "UPDATE messages SET is_deleted = 1, body = '', file_url = NULL WHERE id = ?",
        [msg.id]
    );
    const updated = await db.get('SELECT * FROM messages WHERE id = ?', [msg.id]);

    io.to(`user:${msg.receiver_id}`).emit('message:updated', updated);
    io.to(`user:${msg.sender_id}`).emit('message:updated', updated);
    res.json(updated);
}));

app.delete('/api/conversations/:id', auth, wrap(async (req, res) => {
    const cv = await assertMember(Number(req.params.id), req.user.id);
    if (!cv) return res.status(404).json({ error: 'Conversation not found' });
    await db.run('DELETE FROM messages WHERE conversation_id = ?', [cv.id]);
    res.json({ ok: true });
}));

// ---------------------------------------------------------------- upload ----

app.post('/api/upload', auth, (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'File is too large (max 25MB)'
                : 'Upload failed';
            return res.status(400).json({ error: msg });
        }
        if (!req.file) return res.status(400).json({ error: 'No file received' });

        res.json({
            url: `/uploads/${req.file.filename}`,
            name: req.file.originalname,
            size: req.file.size,
            mime: req.file.mimetype
        });
    });
});

// -------------------------------------------------------------- socket.io ---

const online = new Map(); // userId -> Set(socketId)

io.use((socket, next) => {
    let token = socket.handshake.auth && socket.handshake.auth.token;
    // Fall back to the session cookie when web storage has been cleared.
    if (!token || token === 'null' || token === 'undefined') {
        const raw = socket.handshake.headers.cookie || '';
        const hit = raw.match(new RegExp('(?:^|; )' + COOKIE + '(?:_lax)?=([^;]*)'));
        token = hit ? decodeURIComponent(hit[1]) : null;
    }
    if (revoked.has(token)) return next(new Error('unauthorized'));
    try {
        socket.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        next(new Error('unauthorized'));
    }
});

io.on('connection', async (socket) => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);

    if (!online.has(userId)) online.set(userId, new Set());
    online.get(userId).add(socket.id);

    if (online.get(userId).size === 1) {
        await db.run('UPDATE users SET is_online = 1 WHERE id = ?', [userId]);
        socket.broadcast.emit('presence', { userId, online: true });
    }

    // Tell the newcomer who is currently online.
    socket.emit('presence:bulk', [...online.keys()]);

    // Mark undelivered messages as delivered now that they are connected.
    await db.run(
        'UPDATE messages SET delivered_at = CURRENT_TIMESTAMP WHERE receiver_id = ? AND delivered_at IS NULL',
        [userId]
    );

    socket.on('typing', ({ toUserId, conversationId, typing }) => {
        io.to(`user:${toUserId}`).emit('typing', {
            conversationId, from: userId, typing: !!typing
        });
    });

    socket.on('messages:seen', async ({ conversationId }) => {
        await db.run(
            `UPDATE messages SET read_at = CURRENT_TIMESTAMP
              WHERE conversation_id = ? AND receiver_id = ? AND read_at IS NULL`,
            [conversationId, userId]
        );
        const cv = await db.get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
        if (cv) {
            const other = cv.user_a === userId ? cv.user_b : cv.user_a;
            io.to(`user:${other}`).emit('messages:read', { conversationId, by: userId });
        }
    });

    // ---- WebRTC signalling: the server only relays, media stays peer-to-peer ----
    socket.on('call:offer', ({ toUserId, offer, media }) => {
        io.to(`user:${toUserId}`).emit('call:incoming', { from: userId, offer, media });
    });
    socket.on('call:answer', ({ toUserId, answer }) => {
        io.to(`user:${toUserId}`).emit('call:answered', { from: userId, answer });
    });
    socket.on('call:ice', ({ toUserId, candidate }) => {
        io.to(`user:${toUserId}`).emit('call:ice', { from: userId, candidate });
    });
    socket.on('call:decline', ({ toUserId }) => {
        io.to(`user:${toUserId}`).emit('call:declined', { from: userId });
    });
    socket.on('call:end', ({ toUserId }) => {
        io.to(`user:${toUserId}`).emit('call:ended', { from: userId });
    });

    socket.on('disconnect', async () => {
        const set = online.get(userId);
        if (!set) return;
        set.delete(socket.id);
        if (set.size === 0) {
            online.delete(userId);
            await db.run(
                'UPDATE users SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
                [userId]
            );
            socket.broadcast.emit('presence', { userId, online: false });
        }
    });
});

// ------------------------------------------------------------------ boot ----

db.init()
    .then(async () => {
        // If the database is empty (first run, or the file was lost) create the
        // demo accounts automatically, so the app is never a dead end.
        if (process.env.NODE_ENV !== 'test' && process.env.NO_AUTOSEED !== '1') {
            try {
                const { count } = await db.get('SELECT COUNT(*) AS count FROM users');
                if (count === 0) {
                    await require('./seed').seed({ silent: true });
                    console.log('[seed] empty database — demo accounts created (password: pass1234)');
                }
            } catch (err) {
                console.warn('[seed] skipped:', err.message);
            }
        }
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`ChatConnect running on http://localhost:${PORT}`);
        });
    })
    .catch((err) => {
        console.error('Failed to start:', err);
        process.exit(1);
    });
