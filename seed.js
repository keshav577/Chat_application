/* Creates demo accounts and a sample conversation.  Run:  npm run seed
   Safe to re-run: existing accounts are skipped. Server must be running. */

const B = process.env.SEED_URL || 'http://localhost:3000';
const PASSWORD = 'pass1234';

const PEOPLE = [
    { name: 'Keshav Maheshwari', phone: '1234567890' },
    { name: 'Alice Johnson',     phone: '9990000001' },
    { name: 'Bob Singh',         phone: '9990000002' },
    { name: 'Priya Sharma',      phone: '9812345670' },
    { name: 'Rahul Verma',       phone: '9812345671' }
];

const post = async (path, body, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(B + path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
};

(async () => {
    try {
        await fetch(B + '/');
    } catch {
        console.error(`Cannot reach ${B} — start the server first with: npm start`);
        process.exit(1);
    }

    const tokens = {};
    for (const p of PEOPLE) {
        let r = await post('/api/auth/register', { ...p, password: PASSWORD });
        if (r.status === 409) {
            r = await post('/api/auth/login', { phone: p.phone, password: PASSWORD });
            console.log(`  exists  ${p.name} (${p.phone})`);
        } else if (r.status === 200) {
            console.log(`  created ${p.name} (${p.phone})`);
        } else {
            console.log(`  failed  ${p.name}: ${r.body.error || r.status}`);
            continue;
        }
        if (r.body.token) tokens[p.phone] = r.body.token;
    }

    // Connect Keshav to everyone else.
    const me = tokens['1234567890'];
    if (me) {
        for (const p of PEOPLE.slice(1)) {
            await post('/api/contacts', { phone: p.phone }, me);
        }
        console.log('  linked contacts for Keshav');

        // A short sample exchange so the app is not empty on first open.
        const alice = tokens['9990000001'];
        const list = await (await fetch(B + '/api/contacts', { headers: { Authorization: 'Bearer ' + me } })).json();
        const a = list.find(c => c.phone === '9990000001');
        if (a && alice) {
            const meId = JSON.parse(Buffer.from(me.split('.')[1], 'base64').toString()).id;
            await post('/api/messages', { receiverId: a.contact_id, body: 'Hey Alice! Welcome to ChatConnect 👋', kind: 'text' }, me);
            await post('/api/messages', { receiverId: meId, body: 'Hi Keshav! This is working great 🎉', kind: 'text' }, alice);
            console.log('  added a sample conversation');
        }
    }

    console.log(`\nDone. Sign in with any number above and the password: ${PASSWORD}`);
})();
