/* Demo accounts and a sample conversation.
   Run directly:  npm run seed
   Also imported by server.js to auto-populate an empty database.
   Writes through db.js, so it does not need the HTTP server to be running. */

const bcrypt = require('bcryptjs');
const db = require('./db');

const PASSWORD = 'pass1234';

const PEOPLE = [
    { name: 'Keshav Maheshwari', phone: '1234567890', about: 'Building ChatConnect' },
    { name: 'Alice Johnson',     phone: '9990000001', about: 'Available' },
    { name: 'Bob Singh',         phone: '9990000002', about: 'At work' },
    { name: 'Priya Sharma',      phone: '9812345670', about: 'Busy' },
    { name: 'Rahul Verma',       phone: '9812345671', about: 'Available' }
];

async function conversationFor(a, b) {
    const [x, y] = a < b ? [a, b] : [b, a];
    const found = await db.get('SELECT id FROM conversations WHERE user_a = ? AND user_b = ?', [x, y]);
    if (found) return found.id;
    const res = await db.run('INSERT INTO conversations (user_a, user_b) VALUES (?, ?)', [x, y]);
    return res.lastID;
}

async function link(a, b) {
    await db.run('INSERT OR IGNORE INTO contacts (owner_id, contact_id) VALUES (?, ?)', [a, b]);
    await db.run('INSERT OR IGNORE INTO contacts (owner_id, contact_id) VALUES (?, ?)', [b, a]);
    return conversationFor(a, b);
}

async function seed({ silent = false } = {}) {
    const log = (m) => { if (!silent) console.log(m); };
    const hash = bcrypt.hashSync(PASSWORD, 10);
    const ids = {};

    for (const p of PEOPLE) {
        const existing = await db.get('SELECT id FROM users WHERE phone = ?', [p.phone]);
        if (existing) {
            ids[p.phone] = existing.id;
            log(`  exists  ${p.name} (${p.phone})`);
        } else {
            const res = await db.run(
                'INSERT INTO users (phone, name, password, about) VALUES (?, ?, ?, ?)',
                [p.phone, p.name, hash, p.about]
            );
            ids[p.phone] = res.lastID;
            log(`  created ${p.name} (${p.phone})`);
        }
    }

    const me = ids['1234567890'];
    for (const p of PEOPLE.slice(1)) await link(me, ids[p.phone]);
    log('  linked contacts');

    // A short sample exchange so the app is not empty on first open.
    const alice = ids['9990000001'];
    const convo = await conversationFor(me, alice);
    const { count } = await db.get('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?', [convo]);
    if (count === 0) {
        await db.run(
            `INSERT INTO messages (conversation_id, sender_id, receiver_id, body, kind, created_at)
             VALUES (?, ?, ?, ?, 'text', datetime('now', '-2 minutes'))`,
            [convo, me, alice, 'Hey Alice! Welcome to ChatConnect 👋']
        );
        await db.run(
            `INSERT INTO messages (conversation_id, sender_id, receiver_id, body, kind, created_at)
             VALUES (?, ?, ?, ?, 'text', datetime('now', '-1 minutes'))`,
            [convo, alice, me, 'Hi Keshav! This is working great 🎉']
        );
        log('  added a sample conversation');
    }

    return ids;
}

module.exports = { seed, PASSWORD, PEOPLE };

if (require.main === module) {
    db.init()
        .then(() => seed())
        .then(() => {
            console.log(`\nDone. Sign in with any number above using the password: ${PASSWORD}`);
            process.exit(0);
        })
        .catch((err) => { console.error('Seed failed:', err); process.exit(1); });
}
