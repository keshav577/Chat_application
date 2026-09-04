require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Static files and uploads
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Rate limiting for auth attempts
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many attempts, please try again later'
});

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|mp4|mp3|webp|svg|txt|zip|rar|7z|xls|xlsx|csv|ppt|pptx|json/;
        const okExt = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const okMime = allowedTypes.test(file.mimetype);
        if (okMime || okExt) {
            return cb(null, true);
        }
        cb(new Error('Invalid file type'));
    }
});

// Helper: verify JWT token
const verifyToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1] || req.session?.token;
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.userId = decoded.id;
        req.userPhone = decoded.phone;
        next();
    });
};

const jsonError = (res, status, error) => res.status(status).json({ error });

// ===================== AUTHENTICATION ROUTES =====================

// Register
app.post('/api/auth/register', authLimiter, async (req, res) => {
    const { phone, name, password } = req.body;

    try {
        if (!phone || !name || !password) {
            return jsonError(res, 400, 'Phone, name and password are required');
        }

        const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
        if (existing) {
            return jsonError(res, 400, 'Phone number already registered');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const info = db.prepare('INSERT INTO users (phone, name, password) VALUES (?, ?, ?)').run(phone, name, hashedPassword);
        const userId = Number(info.lastInsertRowid);

        const token = jwt.sign(
            { id: userId, phone, name },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        req.session.token = token;
        req.session.userId = userId;

        res.json({
            success: true,
            token,
            user: { id: userId, phone, name }
        });
    } catch (error) {
        console.error('Register error:', error);
        jsonError(res, 500, 'Server error');
    }
});

// Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
    const { phone, password } = req.body;

    try {
        const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
        if (!user) {
            return jsonError(res, 401, 'Invalid credentials');
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return jsonError(res, 401, 'Invalid credentials');
        }

        const token = jwt.sign(
            { id: user.id, phone: user.phone, name: user.name },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        db.prepare('UPDATE users SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
        req.session.token = token;
        req.session.userId = user.id;

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                phone: user.phone,
                name: user.name,
                avatar: user.avatar,
                bio: user.bio
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        jsonError(res, 500, 'Server error');
    }
});

// Logout
app.post('/api/auth/logout', verifyToken, (req, res) => {
    db.prepare('UPDATE users SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(req.userId);
    if (req.session) req.session.destroy();
    res.json({ success: true });
});

// ===================== USER ROUTES =====================

// Get user profile
app.get('/api/user/profile', verifyToken, (req, res) => {
    const user = db.prepare(
        'SELECT id, phone, name, avatar, bio, last_seen, is_online FROM users WHERE id = ?'
    ).get(req.userId);

    if (!user) return jsonError(res, 404, 'User not found');
    res.json(user);
});

// Update profile
app.put('/api/user/profile', verifyToken, upload.single('avatar'), (req, res) => {
    try {
        const { name, bio } = req.body;
        const avatar = req.file ? `/uploads/${req.file.filename}` : null;

        const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
        if (!existing) return jsonError(res, 404, 'User not found');

        const newName = name || existing.name;
        const newBio = bio || existing.bio;
        const newAvatar = avatar || existing.avatar;

        db.prepare(
            'UPDATE users SET name = ?, bio = ?, avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(newName, newBio, newAvatar, req.userId);

        res.json({
            success: true,
            user: { id: req.userId, name: newName, bio: newBio, avatar: newAvatar }
        });
    } catch (error) {
        console.error('Profile update error:', error);
        jsonError(res, 500, 'Failed to update profile');
    }
});

// ===================== CONTACT ROUTES =====================

// Add contact (by phone number)
app.post('/api/contacts/add', verifyToken, (req, res) => {
    const { phone, name } = req.body;
    if (!phone) return jsonError(res, 400, 'Phone number is required');

    const contactUser = db.prepare('SELECT id, name, avatar FROM users WHERE phone = ?').get(phone);
    if (!contactUser) return jsonError(res, 404, 'User not found');
    if (contactUser.id === req.userId) return jsonError(res, 400, 'Cannot add yourself as contact');

    const displayName = name || contactUser.name;

    try {
        db.prepare(`
            INSERT INTO contacts (user_id, contact_id, name)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, contact_id) DO UPDATE SET name = excluded.name
        `).run(req.userId, contactUser.id, displayName);

        const user1 = Math.min(req.userId, contactUser.id);
        const user2 = Math.max(req.userId, contactUser.id);
        db.prepare('INSERT OR IGNORE INTO conversations (user1_id, user2_id) VALUES (?, ?)').run(user1, user2);

        res.json({ success: true, contact: contactUser });
    } catch (error) {
        console.error('Add contact error:', error);
        jsonError(res, 500, 'Failed to add contact');
    }
});

// Get contacts (with conversation and last message)
app.get('/api/contacts', verifyToken, (req, res) => {
    try {
        const contacts = db.prepare(`
            SELECT
                c.id,
                c.contact_id,
                c.name AS contact_name,
                c.is_blocked,
                u.phone,
                u.name AS user_name,
                u.avatar,
                u.bio,
                u.is_online,
                u.last_seen,
                conv.id AS conversation_id,
                m.message AS last_message,
                m.created_at AS last_message_time,
                (SELECT COUNT(*) FROM messages
                 WHERE conversation_id = conv.id
                   AND sender_id = c.contact_id
                   AND is_read = 0) AS unread_count
            FROM contacts c
            INNER JOIN users u ON c.contact_id = u.id
            LEFT JOIN conversations conv ON
                (conv.user1_id = c.user_id AND conv.user2_id = c.contact_id) OR
                (conv.user1_id = c.contact_id AND conv.user2_id = c.user_id)
            LEFT JOIN messages m ON m.id = conv.last_message_id
            WHERE c.user_id = ?
            ORDER BY COALESCE(m.created_at, c.created_at) DESC
        `).all(req.userId);

        res.json(contacts);
    } catch (error) {
        console.error('Get contacts error:', error);
        jsonError(res, 500, 'Failed to fetch contacts');
    }
});

// Block/Unblock contact
app.put('/api/contacts/:contactId/block', verifyToken, (req, res) => {
    const { contactId } = req.params;
    const { block } = req.body;

    try {
        db.prepare('UPDATE contacts SET is_blocked = ? WHERE user_id = ? AND contact_id = ?')
            .run(block ? 1 : 0, req.userId, contactId);
        res.json({ success: true });
    } catch (error) {
        jsonError(res, 500, 'Failed to update contact');
    }
});

// ===================== MESSAGE ROUTES =====================

// Get messages for a conversation
app.get('/api/messages/:conversationId', verifyToken, (req, res) => {
    const { conversationId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    try {
        const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
        if (!conv || (conv.user1_id !== req.userId && conv.user2_id !== req.userId)) {
            return jsonError(res, 403, 'Unauthorized');
        }

        const messages = db.prepare(`
            SELECT
                m.*,
                u.name AS sender_name,
                u.avatar AS sender_avatar
            FROM messages m
            INNER JOIN users u ON m.sender_id = u.id
            WHERE m.conversation_id = ? AND m.is_deleted = 0
            ORDER BY m.created_at DESC
            LIMIT ? OFFSET ?
        `).all(conversationId, limit, offset);

        db.prepare(`
            UPDATE messages SET is_read = 1, read_at = CURRENT_TIMESTAMP
            WHERE conversation_id = ? AND receiver_id = ? AND is_read = 0
        `).run(conversationId, req.userId);

        // Notify senders that their messages were read.
        messages
            .filter((m) => m.sender_id !== req.userId)
            .forEach((m) => io.to(`user_${m.sender_id}`).emit('messageRead', { messageId: m.id }));

        res.json(messages.reverse());
    } catch (error) {
        console.error('Get messages error:', error);
        jsonError(res, 500, 'Failed to fetch messages');
    }
});

// Send a message
app.post('/api/messages/send', verifyToken, (req, res) => {
    const { receiverId, message, type = 'text', fileUrl } = req.body;
    if (!receiverId || (!message && !fileUrl)) {
        return jsonError(res, 400, 'Receiver and message content are required');
    }

    const receiver = db.prepare('SELECT id FROM users WHERE id = ?').get(receiverId);
    if (!receiver) return jsonError(res, 404, 'Receiver not found');

    try {
        const senderId = req.userId;
        const user1 = Math.min(senderId, receiverId);
        const user2 = Math.max(senderId, receiverId);

        let conv = db.prepare('SELECT id FROM conversations WHERE user1_id = ? AND user2_id = ?').get(user1, user2);
        if (!conv) {
            const info = db.prepare('INSERT INTO conversations (user1_id, user2_id) VALUES (?, ?)').run(user1, user2);
            conv = { id: Number(info.lastInsertRowid) };
        }

        const insert = db.prepare(
            'INSERT INTO messages (conversation_id, sender_id, receiver_id, message, type, file_url) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(conv.id, senderId, receiverId, message || null, type, fileUrl || null);

        const messageId = Number(insert.lastInsertRowid);
        db.prepare('UPDATE conversations SET last_message_id = ?, last_message_time = CURRENT_TIMESTAMP WHERE id = ?')
            .run(messageId, conv.id);

        const newMessage = db.prepare(`
            SELECT m.*, u.name AS sender_name, u.avatar AS sender_avatar
            FROM messages m
            INNER JOIN users u ON m.sender_id = u.id
            WHERE m.id = ?
        `).get(messageId);

        newMessage.conversationId = conv.id;
        io.to(`user_${receiverId}`).emit('newMessage', newMessage);

        res.json(newMessage);
    } catch (error) {
        console.error('Send message error:', error);
        jsonError(res, 500, 'Failed to send message');
    }
});

// Edit message
app.put('/api/messages/:messageId', verifyToken, (req, res) => {
    const { messageId } = req.params;
    const { message } = req.body;
    if (!message) return jsonError(res, 400, 'Message content is required');

    try {
        const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND sender_id = ?').get(messageId, req.userId);
        if (!msg) return jsonError(res, 404, 'Message not found or unauthorized');

        db.prepare('UPDATE messages SET message = ?, is_edited = 1, edited_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(message, messageId);

        io.to(`user_${msg.receiver_id}`).emit('messageEdited', {
            messageId,
            message,
            conversationId: msg.conversation_id
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Edit message error:', error);
        jsonError(res, 500, 'Failed to edit message');
    }
});

// Delete message
app.delete('/api/messages/:messageId', verifyToken, (req, res) => {
    const { messageId } = req.params;

    try {
        const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
        if (!msg) return jsonError(res, 404, 'Message not found');
        if (msg.sender_id !== req.userId && msg.receiver_id !== req.userId) {
            return jsonError(res, 403, 'Unauthorized');
        }

        db.prepare('UPDATE messages SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(messageId);

        io.to(`user_${msg.sender_id}`).emit('messageDeleted', {
            messageId,
            conversationId: msg.conversation_id
        });
        io.to(`user_${msg.receiver_id}`).emit('messageDeleted', {
            messageId,
            conversationId: msg.conversation_id
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Delete message error:', error);
        jsonError(res, 500, 'Failed to delete message');
    }
});

// Delete a chat history for the current user
app.delete('/api/conversations/:conversationId', verifyToken, (req, res) => {
    const { conversationId } = req.params;

    try {
        const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
        if (!conv) return jsonError(res, 404, 'Conversation not found');
        if (conv.user1_id !== req.userId && conv.user2_id !== req.userId) {
            return jsonError(res, 403, 'Unauthorized');
        }

        const column = conv.user1_id === req.userId ? 'user1_deleted' : 'user2_deleted';
        db.prepare(`UPDATE conversations SET ${column} = 1 WHERE id = ?`).run(conversationId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete conversation error:', error);
        jsonError(res, 500, 'Failed to delete conversation');
    }
});

// ===================== FILE UPLOAD =====================

app.post('/api/upload', verifyToken, upload.single('file'), (req, res) => {
    if (!req.file) return jsonError(res, 400, 'No file uploaded');
    res.json({
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        url: `/uploads/${req.file.filename}`
    });
});

// ===================== SOCKET.IO =====================

const activeUsers = new Map();

io.on('connection', (socket) => {
    socket.on('authenticate', (userId) => {
        socket.userId = userId;
        socket.join(`user_${userId}`);
        activeUsers.set(userId, socket.id);

        db.prepare('UPDATE users SET is_online = 1 WHERE id = ?').run(userId);

        const contacts = db.prepare('SELECT user_id FROM contacts WHERE contact_id = ?').all(userId);
        contacts.forEach((contact) => {
            io.to(`user_${contact.user_id}`).emit('userOnline', userId);
        });
    });

    socket.on('typing', ({ conversationId, receiverId }) => {
        io.to(`user_${receiverId}`).emit('typing', { conversationId, userId: socket.userId });
    });

    socket.on('stopTyping', ({ conversationId, receiverId }) => {
        io.to(`user_${receiverId}`).emit('stopTyping', { conversationId, userId: socket.userId });
    });

    socket.on('markAsRead', ({ messageId, senderId }) => {
        db.prepare('UPDATE messages SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id = ?').run(messageId);
        io.to(`user_${senderId}`).emit('messageRead', { messageId });
    });

    socket.on('disconnect', () => {
        if (!socket.userId) return;
        activeUsers.delete(socket.userId);

        db.prepare('UPDATE users SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(socket.userId);

        const contacts = db.prepare('SELECT user_id FROM contacts WHERE contact_id = ?').all(socket.userId);
        contacts.forEach((contact) => {
            io.to(`user_${contact.user_id}`).emit('userOffline', socket.userId);
        });
    });
});

// JSON 404 for unknown API routes
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API route not found' });
});

// ===================== SERVER START =====================
app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Error handling middleware (returns JSON instead of HTML)
app.use((err, req, res, next) => {
    console.error('Request error:', err.message);
    const message = err instanceof multer.MulterError || /Invalid file type|File too large/.test(err.message)
        ? err.message
        : 'Server error';
    res.status(400).json({ error: message });
});

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, HOST, () => {
    console.log(`Chat server running on http://${HOST}:${PORT}`);
    console.log('Open this URL in multiple browser windows to test real-time chat.');
});
