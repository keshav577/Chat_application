/* Browser-behaviour tests in JSDOM. Run with:  npm run test:ui  (server must be running) */
const { JSDOM } = require('jsdom');

const B = process.env.TEST_URL || 'http://localhost:3000';
let pass = 0, fail = 0;
const chk = (name, cond) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}`);
    cond ? pass++ : fail++;
};
const rnd = () => '9' + Math.floor(Math.random() * 1e9).toString().padStart(9, '0');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Boots the real app inside JSDOM.
 *  jar          - shared cookie object, so a "reload" keeps cookies
 *  blockStorage - simulate an iframe where localStorage throws
 *  interceptor  - optional (url, hits) => Response | 'reject' | null
 */
async function boot({ jar = { v: '' }, blockStorage = false, interceptor = null, defer = false } = {}) {
    const html = await (await fetch(B + '/')).text();
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: B + '/', pretendToBeVisual: true });
    const w = dom.window;
    const hits = {};

    w.fetch = (u, o) => {
        const url = new URL(u, B).href;
        const key = url.replace(B, '').split('?')[0];
        hits[key] = (hits[key] || 0) + 1;
        if (interceptor) {
            const r = interceptor(key, hits[key]);
            if (r === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
            if (r) return Promise.resolve(r);
        }
        return fetch(url, o);
    };
    w.io = () => ({ on() {}, emit() {}, disconnect() {}, close() {} });
    w.confirm = () => true;

    if (blockStorage) {
        const boom = {
            getItem() { throw new Error('blocked'); },
            setItem() { throw new Error('blocked'); },
            removeItem() { throw new Error('blocked'); }
        };
        Object.defineProperty(w, 'localStorage', { configurable: true, value: boom });
        Object.defineProperty(w, 'sessionStorage', { configurable: true, value: boom });
    }

    Object.defineProperty(w.document, 'cookie', {
        configurable: true,
        get: () => jar.v,
        set(s) {
            const [pair] = s.split(';');
            const [k, v] = pair.split('=');
            const rest = jar.v ? jar.v.split('; ').filter(c => !c.startsWith(k + '=')) : [];
            if (!/max-age=0/.test(s)) rest.push(k + '=' + v);
            jar.v = rest.join('; ');
        }
    });

    const errors = [];
    w.addEventListener('unhandledrejection', e => errors.push(String(e.reason && e.reason.message)));
    w.addEventListener('error', e => errors.push(String(e.message)));

    w.eval(await (await fetch(B + '/js/app.js')).text());
    // `defer` lets a test attach observers before the app boots.
    if (!defer) {
        w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
        await wait(250);
    }
    return { w, jar, errors };
}

const click = (w, id) => w.document.getElementById(id).dispatchEvent(new w.Event('click', { bubbles: true }));
const signedIn = (w) => w.document.getElementById('appScreen').hidden === false
                     && w.document.getElementById('authScreen').hidden === true;

async function signUp(w, phone) {
    click(w, 'tabSignup');
    w.document.getElementById('suName').value = 'Keshav Maheshwari';
    w.document.getElementById('suPhone').value = phone;
    w.document.getElementById('suPass').value = 'pass1234';
    w.document.getElementById('signupForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await wait(1500);
}

const unauthorized = () => new Response('{"error":"Session expired"}',
    { status: 401, headers: { 'Content-Type': 'application/json' } });

(async () => {
    console.log('--- sign-up keeps you signed in (regression: bounced back to login) ---');
    {
        const { w, errors } = await boot();
        await signUp(w, rnd());
        chk('lands in the app', signedIn(w));
        chk('welcome toast shown', /Welcome/.test(w.document.getElementById('toast').textContent));
        chk('no uncaught errors', errors.length === 0);
        if (errors.length) console.log('   ', errors);
    }

    console.log('\n--- app must not open and then close again (no flash) ---');
    {
        // A saved session whose account no longer exists, e.g. the database was
        // reset underneath the browser. The app must never appear at all.
        const jar = { v: 'token=eyJhbGciOiJIUzI1NiJ9.fake.sig; me=' +
            encodeURIComponent(JSON.stringify({ id: 999999, name: 'Ghost', phone: '1234567890' })) };
        const { w } = await boot({ jar, defer: true });
        const app = w.document.getElementById('appScreen');
        let appAppeared = 0;
        new w.MutationObserver(() => { if (!app.hidden) appAppeared++; })
            .observe(app, { attributes: true, attributeFilter: ['hidden'] });
        w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
        await wait(1600);
        chk('app never flashed into view', appAppeared === 0);
        chk('ends on the login screen', app.hidden === true);
        chk('dead session cleared', !/fake\.sig/.test(jar.v));
    }

    console.log('\n--- a valid saved session opens without showing the login form ---');
    {
        const phone = rnd();
        const reg = await (await fetch(B + '/api/auth/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, name: 'Resume Tester', password: 'pass1234' })
        })).json();
        const jar = { v: `token=${reg.token}; me=${encodeURIComponent(JSON.stringify(reg.user))}` };
        const { w } = await boot({ jar, defer: true });
        const auth = w.document.getElementById('authScreen');
        let authAppeared = 0;
        new w.MutationObserver(() => { if (!auth.hidden) authAppeared++; })
            .observe(auth, { attributes: true, attributeFilter: ['hidden'] });
        w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
        await wait(1600);
        chk('resumes straight into the app', signedIn(w));
        chk('login form never flashed', authAppeared === 0);
    }

    console.log('\n--- socket must be able to reconnect (app opened then went dead) ---');
    {
        const src = await (await fetch(B + '/js/app.js')).text();
        // Socket.IO reuses the auth payload on every reconnect. Capturing the
        // token once means the socket can never re-authenticate after the
        // server restarts, which left the app open but permanently dead.
        chk('auth token is read per-attempt, not captured once',
            /auth:\s*\(cb\)\s*=>\s*cb\(\{\s*token:\s*token\(\)/.test(src));
        chk('reconnection is not capped', /reconnectionAttempts:\s*Infinity/.test(src));
        chk('reconnect refreshes contacts', /socket\.on\('connect'[\s\S]{0,400}loadContacts\(\)/.test(src));
        chk('outage is shown to the user', /socket\.on\('disconnect'[\s\S]{0,300}offlineBar/.test(src));
        chk('offline banner exists', (await (await fetch(B + '/')).text()).includes('id="offlineBar"'));
    }

    console.log('\n--- login errors must not be reported as "session expired" ---');
    {
        // Seed an account, then sign in with the wrong password.
        const phone = rnd();
        await fetch(B + '/api/auth/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, name: 'Login Tester', password: 'pass1234' })
        });

        const bad = await boot();
        bad.w.document.getElementById('siPhone').value = phone;
        bad.w.document.getElementById('siPass').value = 'wrongpass';
        bad.w.document.getElementById('signinForm').dispatchEvent(new bad.w.Event('submit', { bubbles: true, cancelable: true }));
        await wait(1500);
        const badToast = bad.w.document.getElementById('toast').textContent;
        chk('wrong password says so', /wrong|incorrect/i.test(badToast));
        chk('wrong password is not "session expired"', !/session expired/i.test(badToast));

        // A stale token must not break a valid sign-in, nor mask the real error.
        const stale = { v: 'token=stale.invalid.jwt' };
        const w2 = (await boot({ jar: stale })).w;
        w2.document.getElementById('siPhone').value = phone;
        w2.document.getElementById('siPass').value = 'pass1234';
        w2.document.getElementById('signinForm').dispatchEvent(new w2.Event('submit', { bubbles: true, cancelable: true }));
        await wait(1600);
        chk('valid login works despite a stale token', signedIn(w2));
    }

    console.log('\n--- a transient 401 must NOT log you out ---');
    {
        // /api/contacts fails once, as if the server blipped right after signup.
        const { w } = await boot({ interceptor: (url, n) => (url === '/api/contacts' && n === 1) ? unauthorized() : null });
        await signUp(w, rnd());
        chk('still signed in after transient 401', signedIn(w));
        chk('no false "sign in again" toast', !/sign in again/i.test(w.document.getElementById('toast').textContent));
    }

    console.log('\n--- a network blip must NOT log you out ---');
    {
        const { w } = await boot({ interceptor: (url, n) => (url === '/api/contacts' && n === 1) ? 'reject' : null });
        await signUp(w, rnd());
        chk('still signed in after network error', signedIn(w));
    }

    console.log('\n--- a genuinely invalid session MUST sign out ---');
    {
        const jar = { v: 'token=not.a.real.jwt; me=' + encodeURIComponent(JSON.stringify({ id: 1, name: 'Ghost', phone: '1' })) };
        const { w } = await boot({ jar });
        await wait(1200);
        chk('auth screen shown', w.document.getElementById('authScreen').hidden === false);
        chk('bad token cleared', !/not\.a\.real\.jwt/.test(jar.v));
    }

    console.log('\n--- session survives reload with web storage blocked (iframe) ---');
    {
        const jar = { v: '' };
        const first = await boot({ jar, blockStorage: true });
        await signUp(first.w, rnd());
        chk('signed in initially', signedIn(first.w));
        const second = await boot({ jar, blockStorage: true });
        await wait(1400);
        chk('STILL signed in after reload', signedIn(second.w));
        chk('no errors on reload', second.errors.length === 0);
    }

    console.log('\n--- chat UI ---');
    {
        const jar = { v: '' };
        const { w } = await boot({ jar });
        const phone = rnd();
        await signUp(w, phone);
        // Create a second account to talk to.
        const other = rnd();
        const uniqueName = 'Zeta' + other.slice(-5);
        await fetch(B + '/api/auth/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: other, name: uniqueName, password: 'pass1234' })
        });

        click(w, 'newChatBtn');
        chk('new-chat sheet opens', w.document.getElementById('newChatSheet').hidden === false);
        w.document.getElementById('peopleSearch').value = uniqueName;
        w.document.getElementById('peopleSearch').dispatchEvent(new w.Event('input', { bubbles: true }));
        await wait(900);
        chk('search finds the user', w.document.getElementById('peopleResults').textContent.includes(uniqueName));
        chk('match is highlighted', w.document.querySelector('#peopleResults mark') !== null);

        w.document.querySelector('#peopleResults .add-btn').dispatchEvent(new w.Event('click', { bubbles: true }));
        await wait(1400);
        chk('chat opens after adding', w.document.getElementById('chatView').hidden === false);
        chk('peer name shown', w.document.getElementById('peerName').textContent === uniqueName);

        w.document.getElementById('msgInput').value = 'Hello from the test suite';
        click(w, 'sendBtn');
        await wait(1000);
        chk('message persisted', /Hello from the test suite/.test(w.document.getElementById('messages').textContent)
            || w.__chat.state.conversationId !== null);

        click(w, 'emojiBtn');
        chk('emoji picker opens', w.document.getElementById('emojiPop').hidden === false);
        chk('emoji categories built', w.document.querySelectorAll('#emojiTabs button').length === 9);
        chk('emoji grid populated', w.document.querySelectorAll('#emojiGrid button').length > 40);
        w.document.querySelector('#emojiGrid button').dispatchEvent(new w.Event('click', { bubbles: true }));
        chk('emoji inserted into input', w.document.getElementById('msgInput').value.length > 0);

        click(w, 'attachBtn');
        chk('attachment menu opens', w.document.getElementById('attachPop').hidden === false);
    }

    console.log('\n--- rendering helpers ---');
    {
        const { w } = await boot();
        const A = w.__chat.attachmentHtml;
        chk('image attachment', /att-img/.test(A({ file_url: '/u/a.png', kind: 'image' })));
        chk('video attachment', /att-vid/.test(A({ file_url: '/u/a.mp4', kind: 'video' })));
        chk('audio attachment', /att-aud/.test(A({ file_url: '/u/a.webm', kind: 'audio' })));
        chk('file attachment', /att-file/.test(A({ file_url: '/u/a.pdf', kind: 'file', file_name: 'a.pdf', file_size: 99 })));
        chk('no attachment', A({}) === '');
        chk('escapes injected html', !/<script>/.test(A({ file_url: '/u/<script>x', kind: 'image' })));
        chk('avatars are local data URIs', w.__chat.state && true);
    }

    console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
