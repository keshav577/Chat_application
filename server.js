require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
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
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// `index: false` so express.static doesn't serve index.html directly for '/'.
// The GET '/' route below renders it with a cache-busting asset version.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

// Rate limiting
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: process.env.NODE_ENV === 'production' ? 5 : 100,
    message: 'Too many attempts, please try again later'
});

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB (video / voice notes)
    fileFilter: (req, file, cb) => {
        const allowed = /jpeg|jpg|png|gif|webp|bmp|svg|pdf|docx?|xlsx?|pptx?|txt|csv|zip|rar|7z|mp4|webm|mov|avi|mkv|mp3|wav|ogg|oga|m4a|aac|opus|flac/;
        const ext = allowed.test(path.extname(file.originalname).toLowerCase());
        const mime = /^(image|video|audio)\//.test(file.mimetype) || allowed.test(file.mimetype);
        if (ext || mime) return cb(null, true);
        cb(new Error('Unsupported file type'));
    }
});

// Helper function to verify JWT token
const verifyToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1] || req.session.token;
    
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.userId = decoded.id;
        next();
    });
};

// ===================== AUTHENTICATION ROUTES =====================

// Register
app.post('/api/auth/register', authLimiter, async (req, res) => {
    const { phone, name, password } = req.body;
    
    try {
        // Check if user exists
        db.get('SELECT * FROM users WHERE phone = ?', [phone], async (err, user) => {
            if (user) {
                return res.status(400).json({ error: 'Phone number already registered' });
            }
            
            // Hash password
            const hashedPassword = await bcrypt.hash(password, 10);
            
            // Insert new user
            db.run(
                'INSERT INTO users (phone, name, password) VALUES (?, ?, ?)',
                [phone, name, hashedPassword],
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: 'Registration failed' });
                    }
                    
                    const userId = this.lastID;
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
                }
            );
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
    const { phone, password } = req.body;
    
    db.get('SELECT * FROM users WHERE phone = ?', [phone], async (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign(
            { id: user.id, phone: user.phone, name: user.name },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        // Update online status
        db.run('UPDATE users SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
        
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
    });
});

// Logout
app.post('/api/auth/logout', verifyToken, (req, res) => {
    db.run('UPDATE users SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?', [req.userId]);
    req.session.destroy();
    res.json({ success: true });
});

// ===================== USER ROUTES =====================

// Get user profile
app.get('/api/user/profile', verifyToken, (req, res) => {
    db.get(
        'SELECT id, phone, name, avatar, bio, last_seen, is_online FROM users WHERE id = ?',
        [req.userId],
        (err, user) => {
            if (err || !user) {
                return res.status(404).json({ error: 'User not found' });
            }
            res.json(user);
        }
    );
});

// Update profile
app.put('/api/user/profile', verifyToken, upload.single('avatar'), (req, res) => {
    const { name, bio } = req.body;
    const avatar = req.file ? `/uploads/${req.file.filename}` : null;
    
    let query = 'UPDATE users SET updated_at = CURRENT_TIMESTAMP';
    const params = [];
    
    if (name) {
        query += ', name = ?';
        params.push(name);
    }
    if (bio) {
        query += ', bio = ?';
        params.push(bio);
    }
    if (avatar) {
        query += ', avatar = ?';
        params.push(avatar);
    }
    
    query += ' WHERE id = ?';
    params.push(req.userId);
    
    db.run(query, params, (err) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to update profile' });
        }
        res.json({ success: true });
    });
});

// ===================== CONTACT ROUTES =====================

// Add contact
// Search registered users by name or phone (excludes self)
app.get('/api/users/search', verifyToken, (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const like = `%${q}%`;
    db.all(
        `SELECT u.id, u.name, u.phone, u.avatar, u.bio, u.is_online,
                EXISTS(SELECT 1 FROM contacts c WHERE c.user_id = ? AND c.contact_id = u.id) AS is_contact
         FROM users u
         WHERE u.id != ? AND (u.name LIKE ? OR u.phone LIKE ?)
         ORDER BY u.name LIMIT 20`,
        [req.userId, req.userId, like, like],
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'Search failed' });
            res.json(rows || []);
        }
    );
});

app.post('/api/contacts/add', verifyToken, (req, res) => {
    const { phone, name } = req.body;
    
    // Find user by phone
    db.get('SELECT id, name, avatar FROM users WHERE phone = ?', [phone], (err, contactUser) => {
        if (err || !contactUser) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (contactUser.id === req.userId) {
            return res.status(400).json({ error: 'Cannot add yourself as contact' });
        }
        
        // Add contact
        db.run(
            'INSERT OR REPLACE INTO contacts (user_id, contact_id, name) VALUES (?, ?, ?)',
            [req.userId, contactUser.id, name || contactUser.name],
            (err) => {
                if (err) {
                    return res.status(500).json({ error: 'Failed to add contact' });
                }
                
                // Create or get conversation
                const user1_id = Math.min(req.userId, contactUser.id);
                const user2_id = Math.max(req.userId, contactUser.id);
                
                db.run(
                    'INSERT OR IGNORE INTO conversations (user1_id, user2_id) VALUES (?, ?)',
                    [user1_id, user2_id],
                    (err) => {
                        if (err) {
                            return res.status(500).json({ error: 'Failed to create conversation' });
                        }
                        res.json({ success: true, contact: contactUser });
                    }
                );
            }
        );
    });
});

// Get contacts
app.get('/api/contacts', verifyToken, (req, res) => {
    db.all(
        `SELECT 
            c.id,
            c.contact_id,
            c.name as contact_name,
            c.is_blocked,
            u.phone,
            u.name as user_name,
            u.avatar,
            u.bio,
            u.is_online,
            u.last_seen,
            conv.id as conversation_id,
            m.message as last_message,
            m.created_at as last_message_time,
            (SELECT COUNT(*) FROM messages 
             WHERE conversation_id = conv.id 
             AND sender_id = c.contact_id 
             AND is_read = 0) as unread_count
         FROM contacts c
         INNER JOIN users u ON c.contact_id = u.id
         LEFT JOIN conversations conv ON 
            (conv.user1_id = c.user_id AND conv.user2_id = c.contact_id) OR
            (conv.user1_id = c.contact_id AND conv.user2_id = c.user_id)
         LEFT JOIN messages m ON m.id = conv.last_message_id
         WHERE c.user_id = ?
         ORDER BY COALESCE(m.created_at, c.created_at) DESC`,
        [req.userId],
        (err, contacts) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to fetch contacts' });
            }
            res.json(contacts);
        }
    );
});

// Block/Unblock contact
app.put('/api/contacts/:contactId/block', verifyToken, (req, res) => {
    const { contactId } = req.params;
    const { block } = req.body;
    
    db.run(
        'UPDATE contacts SET is_blocked = ? WHERE user_id = ? AND contact_id = ?',
        [block ? 1 : 0, req.userId, contactId],
        (err) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to update contact' });
            }
            res.json({ success: true });
        }
    );
});

// ===================== MESSAGE ROUTES =====================

// Get messages for a conversation
app.get('/api/messages/:conversationId', verifyToken, (req, res) => {
    const { conversationId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    
    db.all(
        `SELECT 
            m.*,
            u.name as sender_name,
            u.avatar as sender_avatar
         FROM messages m
         INNER JOIN users u ON m.sender_id = u.id
         WHERE m.conversation_id = ? 
         AND m.is_deleted = 0
         ORDER BY m.created_at DESC
         LIMIT ? OFFSET ?`,
        [conversationId, limit, offset],
        (err, messages) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to fetch messages' });
            }
            
            // Mark messages as read
            db.run(
                'UPDATE messages SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND receiver_id = ? AND is_read = 0',
                [conversationId, req.userId]
            );
            
            res.json(messages.reverse());
        }
    );
});

// Send message
app.post('/api/messages/send', verifyToken, (req, res) => {
    const { receiverId, message, type = 'text', fileUrl = null } = req.body;
    
    // Get or create conversation
    const user1_id = Math.min(req.userId, receiverId);
    const user2_id = Math.max(req.userId, receiverId);
    
    db.get(
        'SELECT id FROM conversations WHERE user1_id = ? AND user2_id = ?',
        [user1_id, user2_id],
        (err, conversation) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to get conversation' });
            }
            
            const conversationId = conversation ? conversation.id : null;
            
            const insertMessage = (convId) => {
                db.run(
                    'INSERT INTO messages (conversation_id, sender_id, receiver_id, message, type, file_url) VALUES (?, ?, ?, ?, ?, ?)',
                    [convId, req.userId, receiverId, message, type, fileUrl],
                    function(err) {
                        if (err) {
                            return res.status(500).json({ error: 'Failed to send message' });
                        }
                        
                        const messageId = this.lastID;
                        
                        // Update conversation
                        db.run(
                            'UPDATE conversations SET last_message_id = ?, last_message_time = CURRENT_TIMESTAMP WHERE id = ?',
                            [messageId, convId]
                        );
                        
                        // Get the message to return
                        db.get(
                            `SELECT m.*, u.name as sender_name, u.avatar as sender_avatar
                             FROM messages m
                             INNER JOIN users u ON m.sender_id = u.id
                             WHERE m.id = ?`,
                            [messageId],
                            (err, newMessage) => {
                                if (err) {
                                    return res.status(500).json({ error: 'Message sent but failed to retrieve' });
                                }
                                
                                // Emit to receiver via Socket.IO
                                io.to(`user_${receiverId}`).emit('newMessage', {
                                    ...newMessage,
                                    conversationId: convId
                                });
                                
                                res.json({ ...newMessage, conversationId: convId });
                            }
                        );
                    }
                );
            };
            
            if (conversationId) {
                insertMessage(conversationId);
            } else {
                // Create conversation first
                db.run(
                    'INSERT INTO conversations (user1_id, user2_id) VALUES (?, ?)',
                    [user1_id, user2_id],
                    function(err) {
                        if (err) {
                            return res.status(500).json({ error: 'Failed to create conversation' });
                        }
                        insertMessage(this.lastID);
                    }
                );
            }
        }
    );
});

// Edit message
app.put('/api/messages/:messageId', verifyToken, (req, res) => {
    const { messageId } = req.params;
    const { message } = req.body;
    
    db.get(
        'SELECT * FROM messages WHERE id = ? AND sender_id = ?',
        [messageId, req.userId],
        (err, msg) => {
            if (err || !msg) {
                return res.status(404).json({ error: 'Message not found or unauthorized' });
            }
            
            db.run(
                'UPDATE messages SET message = ?, is_edited = 1, edited_at = CURRENT_TIMESTAMP WHERE id = ?',
                [message, messageId],
                (err) => {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to edit message' });
                    }
                    
                    // Notify receiver
                    io.to(`user_${msg.receiver_id}`).emit('messageEdited', {
                        messageId,
                        message,
                        conversationId: msg.conversation_id
                    });
                    
                    res.json({ success: true });
                }
            );
        }
    );
});

// Delete message
app.delete('/api/messages/:messageId', verifyToken, (req, res) => {
    const { messageId } = req.params;
    
    db.get(
        'SELECT * FROM messages WHERE id = ?',
        [messageId],
        (err, msg) => {
            if (err || !msg) {
                return res.status(404).json({ error: 'Message not found' });
            }
            
            if (msg.sender_id !== req.userId && msg.receiver_id !== req.userId) {
                return res.status(403).json({ error: 'Unauthorized' });
            }
            
            db.run(
                'UPDATE messages SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ?',
                [messageId],
                (err) => {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to delete message' });
                    }
                    
                    // Notify both users
                    io.to(`user_${msg.sender_id}`).emit('messageDeleted', {
                        messageId,
                        conversationId: msg.conversation_id
                    });
                    io.to(`user_${msg.receiver_id}`).emit('messageDeleted', {
                        messageId,
                        conversationId: msg.conversation_id
                    });
                    
                    res.json({ success: true });
                }
            );
        }
    );
});

// Delete entire chat
app.delete('/api/conversations/:conversationId', verifyToken, (req, res) => {
    const { conversationId } = req.params;
    
    db.get(
        'SELECT * FROM conversations WHERE id = ?',
        [conversationId],
        (err, conversation) => {
            if (err || !conversation) {
                return res.status(404).json({ error: 'Conversation not found' });
            }
            
            if (conversation.user1_id !== req.userId && conversation.user2_id !== req.userId) {
                return res.status(403).json({ error: 'Unauthorized' });
            }
            
            // Mark conversation as deleted for this user
            const column = conversation.user1_id === req.userId ? 'user1_deleted' : 'user2_deleted';
            db.run(
                `UPDATE conversations SET ${column} = 1 WHERE id = ?`,
                [conversationId],
                (err) => {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to delete conversation' });
                    }
                    res.json({ success: true });
                }
            );
        }
    );
});

// ===================== FILE UPLOAD =====================

app.post('/api/upload', verifyToken, (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'File is too large (max 25MB)'
                : (err.message || 'Upload failed');
            return res.status(400).json({ error: msg });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
    
        res.json({
            filename: req.file.filename,
            originalName: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype,
            url: `/uploads/${req.file.filename}`
        });
    });
});

// ===================== SOCKET.IO =====================

const activeUsers = new Map();

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    
    socket.on('authenticate', (userId) => {
        socket.userId = userId;
        socket.join(`user_${userId}`);
        activeUsers.set(userId, socket.id);
        
        // Update online status
        db.run('UPDATE users SET is_online = 1 WHERE id = ?', [userId]);
        
        // Notify contacts
        db.all(
            'SELECT user_id FROM contacts WHERE contact_id = ?',
            [userId],
            (err, contacts) => {
                if (!err && contacts) {
                    contacts.forEach(contact => {
                        io.to(`user_${contact.user_id}`).emit('userOnline', userId);
                    });
                }
            }
        );
    });
    
    socket.on('typing', ({ conversationId, receiverId }) => {
        io.to(`user_${receiverId}`).emit('typing', {
            conversationId,
            userId: socket.userId
        });
    });
    
    socket.on('stopTyping', ({ conversationId, receiverId }) => {
        io.to(`user_${receiverId}`).emit('stopTyping', {
            conversationId,
            userId: socket.userId
        });
    });
    
    socket.on('markAsRead', ({ messageId, senderId }) => {
        db.run(
            'UPDATE messages SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id = ?',
            [messageId],
            (err) => {
                if (!err) {
                    io.to(`user_${senderId}`).emit('messageRead', { messageId });
                }
            }
        );
    });
    
    // ---------- WebRTC call signalling (peer-to-peer; server only relays) ----------
    socket.on('callUser', ({ toUserId, offer, callType }) => {
        io.to(`user_${toUserId}`).emit('incomingCall', {
            from: socket.userId,
            offer,
            callType
        });
    });

    socket.on('answerCall', ({ toUserId, answer }) => {
        io.to(`user_${toUserId}`).emit('callAnswered', { from: socket.userId, answer });
    });

    socket.on('iceCandidate', ({ toUserId, candidate }) => {
        io.to(`user_${toUserId}`).emit('iceCandidate', { from: socket.userId, candidate });
    });

    socket.on('rejectCall', ({ toUserId }) => {
        io.to(`user_${toUserId}`).emit('callRejected', { from: socket.userId });
    });

    socket.on('endCall', ({ toUserId }) => {
        io.to(`user_${toUserId}`).emit('callEnded', { from: socket.userId });
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            activeUsers.delete(socket.userId);
            
            // Update offline status
            db.run(
                'UPDATE users SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
                [socket.userId]
            );
            
            // Notify contacts
            db.all(
                'SELECT user_id FROM contacts WHERE contact_id = ?',
                [socket.userId],
                (err, contacts) => {
                    if (!err && contacts) {
                        contacts.forEach(contact => {
                            io.to(`user_${contact.user_id}`).emit('userOffline', socket.userId);
                        });
                    }
                }
            );
        }
        console.log('Client disconnected:', socket.id);
    });
});

// Serve the chat UI.
// index.html is rendered with an asset version stamp derived from the CSS/JS
// mtimes, so browsers always pick up fresh styles/scripts after an edit
// instead of silently reusing a cached copy.
const fs = require('fs');

function assetVersion() {
    try {
        const css = fs.statSync(path.join(__dirname, 'public', 'css', 'styles.css')).mtimeMs;
        const js = fs.statSync(path.join(__dirname, 'public', 'js', 'app.js')).mtimeMs;
        return Math.floor(Math.max(css, js)).toString(36);
    } catch (e) {
        return Date.now().toString(36);
    }
}

app.get('/', (req, res) => {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8', (err, html) => {
        if (err) return res.status(500).send('Failed to load app');
        res.set('Cache-Control', 'no-store, must-revalidate');
        res.type('html').send(html.replace(/__V__/g, assetVersion()));
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
});