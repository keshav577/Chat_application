/* API + realtime tests. Run with:  npm test   (server must be running) */
const io = require('socket.io-client');

const B = process.env.TEST_URL || 'http://localhost:3000';
let pass = 0, fail = 0;
const chk = (name, got, want) => {
    const ok = String(got) === String(want);
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  (got:${got} want:${want})`}`);
    ok ? pass++ : fail++;
};

const rnd = () => '9' + Math.floor(Math.random() * 1e9).toString().padStart(9, '0');

async function req(path, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(B + path, { method, headers, body: body && JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
}

(async () => {
    console.log('--- static assets ---');
    for (const [name, p] of [['index', '/'], ['css', '/css/styles.css'],
                             ['js', '/js/app.js'], ['socket.io', '/socket.io/socket.io.js']]) {
        chk(name, (await fetch(B + p)).status, 200);
    }
    chk('no unreplaced version token', (await (await fetch(B + '/')).text()).includes('__V__'), false);

    console.log('\n--- registration ---');
    const pa = rnd(), pb = rnd();
    const a = await req('/api/auth/register', { method: 'POST', body: { phone: pa, name: 'Alice', password: 'pass1234' } });
    const b = await req('/api/auth/register', { method: 'POST', body: { phone: pb, name: 'Bob', password: 'pass1234' } });
    chk('register alice', a.status, 200);
    chk('register bob', b.status, 200);
    const TA = a.body.token, TB = b.body.token, idB = b.body.user.id;
    chk('duplicate phone', (await req('/api/auth/register', { method: 'POST', body: { phone: pa, name: 'Copy', password: 'pass1234' } })).status, 409);
    chk('short password', (await req('/api/auth/register', { method: 'POST', body: { phone: rnd(), name: 'Ann', password: '12' } })).status, 400);
    chk('bad phone', (await req('/api/auth/register', { method: 'POST', body: { phone: 'abc', name: 'Ann', password: 'pass1234' } })).status, 400);
    chk('short name', (await req('/api/auth/register', { method: 'POST', body: { phone: rnd(), name: 'X', password: 'pass1234' } })).status, 400);

    console.log('\n--- login & auth guards ---');
    chk('correct password', (await req('/api/auth/login', { method: 'POST', body: { phone: pa, password: 'pass1234' } })).status, 200);
    chk('wrong password', (await req('/api/auth/login', { method: 'POST', body: { phone: pa, password: 'nope' } })).status, 401);
    chk('formatted phone', (await req('/api/auth/login', { method: 'POST', body: { phone: pa.replace(/(\d{3})(\d{3})/, '$1 $2-'), password: 'pass1234' } })).status, 200);
    chk('no token', (await req('/api/contacts')).status, 401);
    chk('garbage token', (await req('/api/contacts', { token: 'garbage' })).status, 401);
    chk('literal null token', (await req('/api/contacts', { token: 'null' })).status, 401);
    chk('/api/me works', (await req('/api/me', { token: TA })).status, 200);

    console.log('\n--- search & contacts ---');
    chk('1-char query ignored', JSON.stringify((await req('/api/users/search?q=a', { token: TA })).body), '[]');
    chk('finds bob', (await req('/api/users/search?q=Bob', { token: TA })).body.some(u => u.id === idB), true);
    chk('excludes self', (await req(`/api/users/search?q=${pa}`, { token: TA })).body.length, 0);
    const add = await req('/api/contacts', { method: 'POST', token: TA, body: { phone: pb } });
    chk('add contact', add.status, 200);
    const convo = add.body.conversationId;
    chk('conversation created', typeof convo === 'number', true);
    chk('cannot add self', (await req('/api/contacts', { method: 'POST', token: TA, body: { phone: pa } })).status, 400);
    chk('unknown number', (await req('/api/contacts', { method: 'POST', token: TA, body: { phone: rnd() } })).status, 404);
    chk('contact is mutual', (await req('/api/contacts', { token: TB })).body[0].name, 'Alice');

    console.log('\n--- messages ---');
    const sent = await req('/api/messages', { method: 'POST', token: TA, body: { receiverId: idB, body: 'hello there', kind: 'text' } });
    chk('send text', sent.status, 200);
    const mid = sent.body.id;
    chk('reject empty body', (await req('/api/messages', { method: 'POST', token: TA, body: { receiverId: idB, body: '   ', kind: 'text' } })).status, 400);
    chk('unread counted', (await req('/api/contacts', { token: TB })).body[0].unread, 1);
    chk('fetch history', (await req('/api/messages/' + convo, { token: TB })).body.length, 1);
    chk('read clears unread', (await req('/api/contacts', { token: TB })).body[0].unread, 0);
    chk('edit own message', (await req('/api/messages/' + mid, { method: 'PUT', token: TA, body: { body: 'edited' } })).body.is_edited, 1);
    chk('cannot edit others', (await req('/api/messages/' + mid, { method: 'PUT', token: TB, body: { body: 'hax' } })).status, 404);
    chk('cannot read foreign convo', (await req('/api/messages/999999', { token: TA })).status, 404);
    chk('soft delete', (await req('/api/messages/' + mid, { method: 'DELETE', token: TA })).status, 200);

    console.log('\n--- session resilience (the sign-in bounce bug) ---');
    // A valid token must survive repeated use; only a bad one may 401.
    chk('token reusable', (await req('/api/me', { token: TA })).status, 200);
    chk('token still valid after many calls',
        (await Promise.all([1, 2, 3, 4, 5].map(() => req('/api/contacts', { token: TA }))))
            .every(r => r.status === 200), true);

    console.log('\n--- realtime ---');
    const done = {};
    const SA = io(B, { auth: { token: TA } });
    const SB = io(B, { auth: { token: TB } });
    await new Promise(r => setTimeout(r, 600));

    SB.on('message:new', m => { if (m.body === 'realtime ping') done.deliver = true; });
    SB.on('typing', t => { if (t.typing) done.typing = true; });
    SA.on('messages:read', () => { done.receipt = true; });
    SB.on('call:incoming', d => { done.callIn = !!d.offer; SB.emit('call:answer', { toUserId: a.body.user.id, answer: { type: 'answer' } }); });
    SA.on('call:answered', () => { done.callAnswered = true; SA.emit('call:end', { toUserId: idB }); });
    SB.on('call:ended', () => { done.callEnded = true; });

    SA.emit('typing', { toUserId: idB, conversationId: convo, typing: true });
    await req('/api/messages', { method: 'POST', token: TA, body: { receiverId: idB, body: 'realtime ping', kind: 'text' } });
    await new Promise(r => setTimeout(r, 400));
    SB.emit('messages:seen', { conversationId: convo });
    SA.emit('call:offer', { toUserId: idB, offer: { type: 'offer' }, media: 'video' });
    await new Promise(r => setTimeout(r, 900));

    const bad = io(B, { auth: { token: 'garbage' } });
    bad.on('connect_error', e => { done.socketGuard = e.message === 'unauthorized'; });
    await new Promise(r => setTimeout(r, 600));
    SA.close();
    await new Promise(r => setTimeout(r, 700));

    ['deliver', 'typing', 'receipt', 'callIn', 'callAnswered', 'callEnded', 'socketGuard']
        .forEach(k => chk(k, !!done[k], true));
    SB.close(); bad.close();

    console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
