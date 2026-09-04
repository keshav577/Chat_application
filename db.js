/**
 * Local SQLite database.
 *
 * Uses the native `sqlite3` package when it is available, and otherwise falls
 * back to Node's built-in `node:sqlite` engine (Node 22+). Both drivers read
 * and write the same `chat.db` file, so behaviour is identical either way.
 *
 * The exported API is promise-based: `run`, `get`, `all`.
 */
const path = require('path');

// DB_PATH lets the test suite run against a throwaway database instead of
// polluting the real one with fixture accounts.
const DB_FILE = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, 'chat.db');

let impl;

try {
    // ---- Native sqlite3 driver (callback based) ----
    const sqlite3 = require('sqlite3');
    const database = new sqlite3.Database(DB_FILE);

    database.serialize(() => {
        database.run('PRAGMA journal_mode = WAL');
        database.run('PRAGMA foreign_keys = ON');
    });

    impl = {
        run: (sql, params = []) => new Promise((resolve, reject) => {
            database.run(sql, params, function (err) {
                if (err) return reject(err);
                resolve({ lastID: this.lastID, changes: this.changes });
            });
        }),
        get: (sql, params = []) => new Promise((resolve, reject) => {
            database.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
        }),
        all: (sql, params = []) => new Promise((resolve, reject) => {
            database.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
        }),
        exec: (sql) => new Promise((resolve, reject) => {
            database.exec(sql, (err) => (err ? reject(err) : resolve()));
        })
    };
    console.log('[db] using native sqlite3');
} catch (e) {
    // ---- Built-in node:sqlite fallback (synchronous) ----
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(DB_FILE);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA foreign_keys = ON');

    // node:sqlite only binds primitives, so normalise values first.
    const clean = (params) => params.map((p) => {
        if (typeof p === 'boolean') return p ? 1 : 0;
        if (p === undefined) return null;
        if (p instanceof Date) return p.toISOString();
        return p;
    });

    impl = {
        run: async (sql, params = []) => {
            const r = database.prepare(sql).run(...clean(params));
            return { lastID: Number(r.lastInsertRowid) || 0, changes: Number(r.changes) || 0 };
        },
        get: async (sql, params = []) => database.prepare(sql).get(...clean(params)),
        all: async (sql, params = []) => database.prepare(sql).all(...clean(params)) || [],
        exec: async (sql) => database.exec(sql)
    };
    console.log('[db] using built-in node:sqlite');
}

/**
 * Creates the schema. Safe to call on every boot.
 */
async function init() {
    await impl.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            phone       TEXT UNIQUE NOT NULL,
            name        TEXT NOT NULL,
            password    TEXT NOT NULL,
            avatar      TEXT,
            about       TEXT DEFAULT 'Hey there! I am using ChatConnect',
            is_online   INTEGER DEFAULT 0,
            last_seen   TEXT DEFAULT CURRENT_TIMESTAMP,
            created_at  TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS contacts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id    INTEGER NOT NULL,
            contact_id  INTEGER NOT NULL,
            nickname    TEXT,
            created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(owner_id, contact_id),
            FOREIGN KEY (owner_id)   REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (contact_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_a      INTEGER NOT NULL,
            user_b      INTEGER NOT NULL,
            created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_a, user_b),
            FOREIGN KEY (user_a) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (user_b) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS messages (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id  INTEGER NOT NULL,
            sender_id        INTEGER NOT NULL,
            receiver_id      INTEGER NOT NULL,
            body             TEXT,
            kind             TEXT DEFAULT 'text',
            file_url         TEXT,
            file_name        TEXT,
            file_size        INTEGER,
            duration         INTEGER,
            is_edited        INTEGER DEFAULT 0,
            is_deleted       INTEGER DEFAULT 0,
            delivered_at     TEXT,
            read_at          TEXT,
            created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
            FOREIGN KEY (sender_id)       REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (receiver_id)     REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_msg_convo   ON messages(conversation_id, id);
        CREATE INDEX IF NOT EXISTS idx_msg_unread  ON messages(receiver_id, read_at);
        CREATE INDEX IF NOT EXISTS idx_contacts    ON contacts(owner_id);
    `);
    console.log('[db] schema ready');
}

module.exports = { ...impl, init, DB_FILE };
