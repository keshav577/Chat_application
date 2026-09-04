// Prefer the native `sqlite3` driver; fall back to the built-in `node:sqlite`
// engine (Node >= 22) when the native module isn't built on this machine.
let sqlite3;
try {
    sqlite3 = require('sqlite3').verbose();
} catch (e) {
    console.warn('native sqlite3 unavailable, using built-in node:sqlite engine');
    sqlite3 = require('./sqlite-compat').verbose();
}
const path = require('path');

// Create or open database
const db = new sqlite3.Database(path.join(__dirname, 'chat.db'), (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

function initializeDatabase() {
    db.serialize(() => {
        // Users table
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone VARCHAR(20) UNIQUE NOT NULL,
                name VARCHAR(100) NOT NULL,
                password VARCHAR(255) NOT NULL,
                avatar TEXT,
                bio TEXT DEFAULT 'Hey there! I am using ChatApp',
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_online BOOLEAN DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Contacts table
        db.run(`
            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                contact_id INTEGER NOT NULL,
                name VARCHAR(100),
                is_blocked BOOLEAN DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (contact_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(user_id, contact_id)
            )
        `);

        // Conversations table
        db.run(`
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user1_id INTEGER NOT NULL,
                user2_id INTEGER NOT NULL,
                last_message_id INTEGER,
                last_message_time TIMESTAMP,
                user1_deleted BOOLEAN DEFAULT 0,
                user2_deleted BOOLEAN DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user1_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (user2_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(user1_id, user2_id)
            )
        `);

        // Messages table
        db.run(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                sender_id INTEGER NOT NULL,
                receiver_id INTEGER NOT NULL,
                message TEXT,
                type VARCHAR(20) DEFAULT 'text',
                file_url TEXT,
                is_edited BOOLEAN DEFAULT 0,
                edited_at TIMESTAMP,
                is_deleted BOOLEAN DEFAULT 0,
                deleted_at TIMESTAMP,
                is_read BOOLEAN DEFAULT 0,
                read_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Message status table
        db.run(`
            CREATE TABLE IF NOT EXISTS message_status (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                is_delivered BOOLEAN DEFAULT 0,
                delivered_at TIMESTAMP,
                is_read BOOLEAN DEFAULT 0,
                read_at TIMESTAMP,
                is_deleted BOOLEAN DEFAULT 0,
                deleted_at TIMESTAMP,
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(message_id, user_id)
            )
        `);

        // Create indexes for better performance
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_users ON conversations(user1_id, user2_id)`);
        
        console.log('Database tables created successfully');
    });
}

module.exports = db;