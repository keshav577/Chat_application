/* ============================================================
   ChatConnect — client
   ============================================================ */
(() => {
'use strict';

// ------------------------------------------------------------- state ----

const state = {
    me: null,
    socket: null,
    contacts: [],
    peer: null,            // contact currently open
    conversationId: null,
    onlineIds: new Set(),
    editingId: null,
    typingTimer: null,
    typingSent: false
};

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------- session -----
// The app frequently runs inside an iframe where localStorage can throw or be
// partitioned. Persist through every channel available so a reload never
// destroys a valid session.

const mem = Object.create(null);

const store = {
    get(key) {
        if (mem[key] != null) return mem[key];
        const readers = [
            () => localStorage.getItem(key),
            () => sessionStorage.getItem(key),
            () => {
                const m = document.cookie.match(new RegExp('(?:^|; )' + key + '=([^;]*)'));
                return m ? decodeURIComponent(m[1]) : null;
            }
        ];
        for (const read of readers) {
            try {
                const v = read();
                if (v != null && v !== 'null' && v !== 'undefined') { mem[key] = v; return v; }
            } catch { /* try next */ }
        }
        return null;
    },
    set(key, value) {
        mem[key] = value;
        try { localStorage.setItem(key, value); } catch {}
        try { sessionStorage.setItem(key, value); } catch {}
        try {
            const sec = location.protocol === 'https:' ? '; Secure; SameSite=None' : '; SameSite=Lax';
            document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=2592000${sec}`;
        } catch {}
    },
    clear(key) {
        delete mem[key];
        try { localStorage.removeItem(key); } catch {}
        try { sessionStorage.removeItem(key); } catch {}
        try { document.cookie = `${key}=; path=/; max-age=0`; } catch {}
    }
};

const token = () => store.get('token');

// ------------------------------------------------------------- api -----

// Asks the server whether a token is still good. Used to tell a genuinely
// expired session apart from a one-off 401, so we never sign a user out by
// mistake. Network failures count as "still valid" — losing connectivity is
// not a reason to destroy a login.
async function tokenStillValid(t) {
    try {
        const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${t}` } });
        return res.status !== 401;
    } catch {
        return true;
    }
}

async function api(path, options = {}) {
    const opts = { ...options, headers: { ...(options.headers || {}) } };
    // Signing in or registering is not an authenticated action. Never attach a
    // stale token to it: the server would reject the request and we would
    // report "session expired" instead of the real reason (e.g. wrong password).
    const isAuthCall = path.startsWith('/api/auth/');
    const t = isAuthCall ? null : token();
    if (t) opts.headers.Authorization = `Bearer ${t}`;
    if (opts.body && !(opts.body instanceof FormData)) {
        opts.headers['Content-Type'] = 'application/json';
        if (typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    }

    let res;
    try {
        res = await fetch(path, opts);
    } catch {
        throw new Error('Network unavailable');
    }

    // On a login/register call a 401 means bad credentials, so fall through and
    // surface the server's own message.
    if (res.status === 401 && !isAuthCall) {
        // Don't tear down the session on a single 401 — a restarted server or a
        // proxy that dropped the Authorization header would log the user out
        // moments after a successful sign-in. Re-verify the token first and
        // only sign out when it is genuinely no longer accepted.
        if (!opts._revalidated && t && await tokenStillValid(t)) {
            return api(path, { ...options, _revalidated: true });
        }
        signOut(true);
        throw new Error('Session expired');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
}

// ------------------------------------------------------------ utils ----

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Avatars are generated locally as inline SVG — no external image service.
const AVATAR_COLORS = ['#00a884', '#0b8ecb', '#7f66ff', '#e5637f', '#e59e37', '#3aa76d', '#c85a9e', '#5b7fd4'];

function initialsOf(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function avatarFor(name, url) {
    if (url) return url;
    const label = initialsOf(name);
    let hash = 0;
    for (const ch of String(name || '?')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const bg = AVATAR_COLORS[hash % AVATAR_COLORS.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">` +
        `<rect width="120" height="120" fill="${bg}"/>` +
        `<text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="#04231b"` +
        ` font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="48" font-weight="700">${esc(label)}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function toast(message, kind = '') {
    const el = $('toast');
    el.textContent = message;
    el.className = 'toast ' + kind;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

// SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC; make it parse correctly.
function parseTime(value) {
    if (!value) return new Date();
    if (value instanceof Date) return value;
    const s = String(value);
    return new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}

function clockTime(value) {
    return parseTime(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function listTime(value) {
    if (!value) return '';
    const d = parseTime(value);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return clockTime(d);
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function dayLabel(value) {
    const d = parseTime(value);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
}

function fileSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function kindOf(file) {
    const n = file.name || '';
    const m = file.type || '';
    if (/^image\//.test(m) || /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(n)) return 'image';
    if (/^video\//.test(m) || /\.(mp4|webm|mov|avi|mkv)$/i.test(n)) return 'video';
    if (/^audio\//.test(m) || /\.(mp3|wav|ogg|oga|m4a|aac|opus|flac)$/i.test(n)) return 'audio';
    return 'file';
}

const preview = (m) => {
    if (!m) return '';
    if (m.last_kind === 'image') return '📷 Photo';
    if (m.last_kind === 'video') return '🎬 Video';
    if (m.last_kind === 'audio') return '🎤 Voice note';
    if (m.last_kind === 'file') return '📄 Document';
    return m.last_message || '';
};

// ------------------------------------------------------------- auth ----

function showAuth() {
    $('appScreen').hidden = true;
    $('authScreen').hidden = false;
}

function showApp() {
    $('authScreen').hidden = true;
    $('appScreen').hidden = false;
}

function signOut(expired) {
    store.clear('token');
    store.clear('me');
    if (state.socket) { try { state.socket.disconnect(); } catch {} }
    Object.assign(state, {
        me: null, socket: null, contacts: [], peer: null,
        conversationId: null, onlineIds: new Set(), editingId: null
    });
    showAuth();
    if (expired) toast('Please sign in again', 'warn');
}

async function boot() {
    const saved = store.get('me');
    if (!token() || !saved) { showAuth(); return; }

    try {
        state.me = JSON.parse(saved);
    } catch {
        signOut();
        return;
    }

    showApp();
    paintMe();
    try {
        // Confirm the token is still valid before trusting the cached profile.
        state.me = await api('/api/me');
        store.set('me', JSON.stringify(state.me));
        paintMe();
        connectSocket();
        await loadContacts();
    } catch (err) {
        if (err.message !== 'Session expired') toast(err.message, 'err');
    }
}

async function authenticate(path, payload, button) {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Please wait…';
    try {
        const data = await api(path, { method: 'POST', body: payload });
        store.set('token', data.token);
        store.set('me', JSON.stringify(data.user));
        state.me = data.user;
        showApp();
        paintMe();
        connectSocket();
        // Greet the user as soon as the account is confirmed. Loading contacts
        // is secondary: if it fails we stay signed in and show that error
        // instead of pretending the sign-in itself failed.
        toast(`Welcome, ${data.user.name}`, 'ok');
        await loadContacts();
    } catch (err) {
        // A duplicate signup should guide the user to sign in, not dead-end.
        if (/already registered/i.test(err.message)) {
            $('siPhone').value = $('suPhone').value;
            switchTab('signin');
            $('siPass').focus();
            toast('That number already has an account — please sign in', 'warn');
        } else {
            toast(err.message, 'err');
        }
    } finally {
        button.disabled = false;
        button.textContent = original;
    }
}

function switchTab(which) {
    const signin = which === 'signin';
    $('tabSignin').classList.toggle('is-active', signin);
    $('tabSignup').classList.toggle('is-active', !signin);
    $('signinForm').classList.toggle('is-active', signin);
    $('signupForm').classList.toggle('is-active', !signin);
}

function paintMe() {
    if (!state.me) return;
    $('meName').textContent = state.me.name;
    $('meAbout').textContent = state.me.about || 'Available';
    $('meAvatar').src = avatarFor(state.me.name, state.me.avatar);
}

// ----------------------------------------------------------- socket ----

function connectSocket() {
    if (state.socket) { try { state.socket.disconnect(); } catch {} }

    const socket = io({ auth: { token: token() } });
    state.socket = socket;

    socket.on('connect_error', () => { /* transport retries automatically */ });

    socket.on('presence:bulk', (ids) => {
        state.onlineIds = new Set(ids);
        renderChatList();
        paintPeerStatus();
    });

    socket.on('presence', ({ userId, online }) => {
        if (online) state.onlineIds.add(userId); else state.onlineIds.delete(userId);
        renderChatList();
        paintPeerStatus();
    });

    socket.on('contacts:changed', () => loadContacts());

    socket.on('message:new', (msg) => {
        const mine = msg.sender_id === state.me.id;
        const otherId = mine ? msg.receiver_id : msg.sender_id;

        if (state.peer && otherId === state.peer.contact_id) {
            appendMessage(msg);
            scrollDown();
            if (!mine) socket.emit('messages:seen', { conversationId: msg.conversation_id });
        } else if (!mine) {
            const from = state.contacts.find((c) => c.contact_id === msg.sender_id);
            toast(`${from ? from.name : 'New message'}: ${msg.body || 'Attachment'}`.slice(0, 70));
        }
        loadContacts();
    });

    socket.on('message:updated', (msg) => {
        const node = document.querySelector(`[data-mid="${msg.id}"]`);
        if (node) node.replaceWith(buildMessage(msg));
        loadContacts();
    });

    socket.on('messages:read', ({ conversationId }) => {
        if (conversationId !== state.conversationId) return;
        document.querySelectorAll('.tick').forEach((t) => {
            t.textContent = '✓✓';
            t.classList.add('read');
        });
    });

    socket.on('typing', ({ from, typing }) => {
        if (!state.peer || from !== state.peer.contact_id) return;
        $('typingRow').hidden = !typing;
        if (typing) scrollDown();
    });

    bindCallSignals(socket);
}

// --------------------------------------------------------- contacts ----

async function loadContacts() {
    try {
        state.contacts = await api('/api/contacts');
        renderChatList();
    } catch (err) {
        // Never let a failed refresh blank an already-populated list.
        if (err.message === 'Session expired') return;
        if (!state.contacts.length) {
            $('chatList').innerHTML = `<div class="hint">
                <div class="hi">⚠️</div><b>Couldn't load chats</b>
                <p>${esc(err.message)}</p>
                <button class="retry" id="retryContacts">Try again</button></div>`;
            const btn = $('retryContacts');
            if (btn) btn.onclick = loadContacts;
        }
    }
}

function renderChatList() {
    const box = $('chatList');
    const term = $('chatSearch').value.trim().toLowerCase();

    const rows = state.contacts.filter((c) =>
        !term || c.name.toLowerCase().includes(term) || c.phone.includes(term));

    if (!rows.length) {
        box.innerHTML = `<div class="hint">
            <div class="hi">💬</div>
            <b>${term ? 'No matches' : 'No chats yet'}</b>
            <p>${term ? 'Try a different name or number.' : 'Tap the new-chat button to find people and start talking.'}</p>
        </div>`;
        return;
    }

    box.innerHTML = rows.map((c) => {
        const online = state.onlineIds.has(c.contact_id);
        const active = state.peer && state.peer.contact_id === c.contact_id;
        return `
        <div class="row${active ? ' is-active' : ''}" data-cid="${c.contact_id}">
            <div class="row-avatar">
                <img src="${avatarFor(c.name, c.avatar)}" alt="">
                ${online ? '<span class="presence"></span>' : ''}
            </div>
            <div class="row-body">
                <div class="row-top">
                    <strong>${esc(c.name)}</strong>
                    <span class="row-time">${listTime(c.last_at)}</span>
                </div>
                <div class="row-bottom">
                    <span class="row-msg">${esc(preview(c)) || '<i>Tap to chat</i>'}</span>
                    ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');

    box.querySelectorAll('.row').forEach((row) => {
        row.onclick = () => {
            const c = state.contacts.find((x) => x.contact_id === Number(row.dataset.cid));
            if (c) openChat(c);
        };
    });
}

// ------------------------------------------------------------- chat ----

async function openChat(contact) {
    state.peer = contact;
    state.conversationId = contact.conversation_id;
    cancelEdit();

    $('emptyState').hidden = true;
    $('chatView').hidden = false;
    $('appScreen').classList.add('viewing');
    $('typingRow').hidden = true;

    $('peerName').textContent = contact.name;
    $('peerAvatar').src = avatarFor(contact.name, contact.avatar);
    paintPeerStatus();
    renderChatList();

    $('messages').innerHTML = '<div class="hint"><p>Loading…</p></div>';

    try {
        if (!state.conversationId) {
            const r = await api('/api/contacts', { method: 'POST', body: { userId: contact.contact_id } });
            state.conversationId = r.conversationId;
            contact.conversation_id = r.conversationId;
        }
        const list = await api(`/api/messages/${state.conversationId}`);
        renderMessages(list);
        loadContacts();
    } catch (err) {
        $('messages').innerHTML = `<div class="hint"><b>Couldn't load messages</b><p>${esc(err.message)}</p></div>`;
    }
}

function closeChat() {
    state.peer = null;
    state.conversationId = null;
    $('chatView').hidden = true;
    $('emptyState').hidden = false;
    $('appScreen').classList.remove('viewing');
    renderChatList();
}

function paintPeerStatus() {
    if (!state.peer) return;
    const online = state.onlineIds.has(state.peer.contact_id);
    const el = $('peerStatus');
    el.textContent = online ? 'online' : 'offline';
    el.classList.toggle('online', online);
}

function renderMessages(list) {
    const box = $('messages');
    box.innerHTML = '';

    if (!list.length) {
        box.innerHTML = `<div class="hint">
            <div class="hi">👋</div><b>Say hello</b>
            <p>This is the start of your conversation.</p></div>`;
        return;
    }

    let lastDay = '';
    list.forEach((m) => {
        const day = dayLabel(m.created_at);
        if (day !== lastDay) {
            const d = document.createElement('div');
            d.className = 'day';
            d.textContent = day;
            box.appendChild(d);
            lastDay = day;
        }
        box.appendChild(buildMessage(m));
    });
    scrollDown(true);
}

function attachmentHtml(m) {
    if (!m.file_url) return '';
    const url = esc(m.file_url);
    if (m.kind === 'image') {
        return `<a href="${url}" target="_blank" rel="noopener"><img class="att-img" src="${url}" alt="" loading="lazy"></a>`;
    }
    if (m.kind === 'video') {
        return `<video class="att-vid" src="${url}" controls preload="metadata"></video>`;
    }
    if (m.kind === 'audio') {
        return `<audio class="att-aud" src="${url}" controls preload="metadata"></audio>`;
    }
    return `<a class="att-file" href="${url}" target="_blank" rel="noopener" download>
                <span class="fi">📄</span>
                <span><b>${esc(m.file_name || 'Document')}</b><small>${fileSize(m.file_size)}</small></span>
            </a>`;
}

function buildMessage(m) {
    const mine = m.sender_id === state.me.id;
    const wrap = document.createElement('div');
    wrap.className = `msg ${mine ? 'out' : 'in'}`;
    wrap.dataset.mid = m.id;

    if (m.is_deleted) {
        wrap.innerHTML = `<div class="bubble"><span class="deleted">🚫 This message was deleted</span>
            <div class="meta">${clockTime(m.created_at)}</div></div>`;
        return wrap;
    }

    const media = m.file_url && m.kind !== 'file';
    const tick = mine
        ? `<span class="tick${m.read_at ? ' read' : ''}">${m.read_at || m.delivered_at ? '✓✓' : '✓'}</span>`
        : '';

    wrap.innerHTML = `
        <div class="bubble${media ? ' media' : ''}">
            ${attachmentHtml(m)}
            ${m.body ? `<div class="text">${esc(m.body)}</div>` : ''}
            <div class="meta">
                ${m.is_edited ? '<span>edited</span>' : ''}
                <span>${clockTime(m.created_at)}</span>${tick}
            </div>
        </div>`;

    if (mine) {
        const open = (e) => { e.preventDefault(); openMsgMenu(e, m); };
        wrap.addEventListener('contextmenu', open);
        // Long-press for touch devices.
        let timer;
        wrap.addEventListener('touchstart', (e) => { timer = setTimeout(() => open(e), 550); }, { passive: true });
        wrap.addEventListener('touchend', () => clearTimeout(timer));
        wrap.addEventListener('touchmove', () => clearTimeout(timer));
    }
    return wrap;
}

function appendMessage(m) {
    const box = $('messages');
    if (box.querySelector('.hint')) box.innerHTML = '';
    box.appendChild(buildMessage(m));
}

function scrollDown(instant) {
    const box = $('messages');
    requestAnimationFrame(() => {
        if (typeof box.scrollTo === 'function') {
            box.scrollTo({ top: box.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
        } else {
            box.scrollTop = box.scrollHeight;
        }
    });
}

// ---------------------------------------------------------- sending ----

async function sendText() {
    const input = $('msgInput');
    const body = input.value.trim();
    if (!body || !state.peer) return;

    // Editing an existing message.
    if (state.editingId) {
        const id = state.editingId;
        cancelEdit();
        input.value = '';
        try { await api(`/api/messages/${id}`, { method: 'PUT', body: { body } }); }
        catch (err) { toast(err.message, 'err'); }
        return;
    }

    input.value = '';
    autoGrow();
    stopTyping();

    try {
        await api('/api/messages', {
            method: 'POST',
            body: { receiverId: state.peer.contact_id, body, kind: 'text' }
        });
        // The socket echo renders the bubble, keeping one code path.
    } catch (err) {
        toast(err.message, 'err');
        input.value = body;
    }
}

async function sendFile(file, kind) {
    if (!state.peer) { toast('Open a chat first', 'warn'); return; }
    if (file.size > 25 * 1024 * 1024) { toast('File is too large (max 25MB)', 'err'); return; }

    const type = kind || kindOf(file);
    toast('Uploading…');

    try {
        const form = new FormData();
        form.append('file', file, file.name || 'voice-note.webm');
        const up = await api('/api/upload', { method: 'POST', body: form });

        await api('/api/messages', {
            method: 'POST',
            body: {
                receiverId: state.peer.contact_id,
                body: type === 'audio' ? '' : '',
                kind: type,
                fileUrl: up.url,
                fileName: up.name,
                fileSize: up.size
            }
        });
    } catch (err) {
        toast(err.message, 'err');
    }
}

// ----------------------------------------------------------- typing ----

function onTyping() {
    if (!state.peer || !state.socket) return;
    if (!state.typingSent) {
        state.typingSent = true;
        state.socket.emit('typing', {
            toUserId: state.peer.contact_id,
            conversationId: state.conversationId,
            typing: true
        });
    }
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(stopTyping, 1600);
}

function stopTyping() {
    clearTimeout(state.typingTimer);
    if (!state.typingSent || !state.peer || !state.socket) return;
    state.typingSent = false;
    state.socket.emit('typing', {
        toUserId: state.peer.contact_id,
        conversationId: state.conversationId,
        typing: false
    });
}

// ------------------------------------------------------ message menu ----

let menuTarget = null;

function openMsgMenu(event, message) {
    menuTarget = message;
    const menu = $('msgMenu');
    menu.hidden = false;

    const x = event.touches ? event.touches[0].clientX : event.clientX;
    const y = event.touches ? event.touches[0].clientY : event.clientY;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 12) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 12) + 'px';

    // Only text messages can be edited.
    menu.querySelector('[data-act="edit"]').style.display = message.kind === 'text' ? '' : 'none';
}

function closeMsgMenu() { $('msgMenu').hidden = true; }

function startEdit(message) {
    state.editingId = message.id;
    $('editStrip').hidden = false;
    $('editPreview').textContent = message.body;
    $('msgInput').value = message.body;
    $('msgInput').focus();
    autoGrow();
}

function cancelEdit() {
    state.editingId = null;
    $('editStrip').hidden = true;
}

// ------------------------------------------------------ people search ---

let searchTimer = null;
let searchCache = [];

function highlight(text, term) {
    const safe = esc(text);
    if (!term) return safe;
    const pattern = esc(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(`(${pattern})`, 'ig'), '<mark>$1</mark>');
}

function peopleIdle() {
    $('peopleResults').innerHTML = `<div class="hint">
        <div class="hi">🔎</div><b>Find someone</b>
        <p>Type at least 2 characters to search people who have registered.</p></div>`;
}

function peopleLoading() {
    $('peopleResults').innerHTML = Array(3).fill(
        `<div class="skeleton"><div class="sk-c"></div>
         <div class="sk-lines"><div class="sk-l"></div><div class="sk-l s"></div></div></div>`
    ).join('');
}

function runSearch(term) {
    clearTimeout(searchTimer);
    const q = term.trim();
    if (q.length < 2) { peopleIdle(); return; }

    peopleLoading();
    searchTimer = setTimeout(async () => {
        try {
            searchCache = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
            renderPeople(searchCache, q);
        } catch (err) {
            $('peopleResults').innerHTML =
                `<div class="hint"><b>Search failed</b><p>${esc(err.message)}</p></div>`;
        }
    }, 220);
}

function renderPeople(users, term) {
    const box = $('peopleResults');
    if (!users.length) {
        box.innerHTML = `<div class="hint">
            <div class="hi">🤷</div><b>Nobody found</b>
            <p>No one matching “${esc(term)}” has registered yet.</p></div>`;
        return;
    }

    box.innerHTML = users.map((u, i) => `
        <div class="person" style="animation-delay:${i * 30}ms">
            <img src="${avatarFor(u.name, u.avatar)}" alt="">
            <div class="pi">
                <b>${highlight(u.name, term)}</b>
                <small>${highlight(u.phone, term)}</small>
            </div>
            <button class="add-btn${u.is_contact ? ' ghost' : ''}" data-uid="${u.id}">
                ${u.is_contact ? 'Message' : 'Add'}
            </button>
        </div>`).join('');

    box.querySelectorAll('.add-btn').forEach((btn) => {
        btn.onclick = () => addPerson(Number(btn.dataset.uid), btn);
    });
}

async function addPerson(userId, button) {
    const user = searchCache.find((u) => u.id === userId);
    if (!user) return;

    button.disabled = true;
    button.textContent = user.is_contact ? 'Opening…' : 'Adding…';

    try {
        await api('/api/contacts', { method: 'POST', body: { userId } });
        await loadContacts();
        closeSheets();
        const contact = state.contacts.find((c) => c.contact_id === userId);
        if (contact) openChat(contact);
    } catch (err) {
        toast(err.message, 'err');
        button.disabled = false;
        button.textContent = user.is_contact ? 'Message' : 'Add';
    }
}

// ------------------------------------------------------------ sheets ---

function openSheet(id) {
    $('scrim').hidden = false;
    $(id).hidden = false;
}

function closeSheets() {
    $('scrim').hidden = true;
    $('newChatSheet').hidden = true;
    $('profileSheet').hidden = true;
}

// ------------------------------------------------------------ emoji ----

const EMOJI = {
    '😀': '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤗 🤭 🤔 🤐 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🤢 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖',
    '👍': '👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 ✍️ 💪 🦾 👏 🙌 👐 🤲 🫶 🤳 💅',
    '❤️': '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ✨ ⭐ 🌟 💫 ⚡ 🔥 💥 💯 🎉 🎊 🎈 🎁 🏆 🥇 🎯',
    '🐶': '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐒 🦄 🐝 🦋 🐞 🐢 🐍 🐙 🦐 🐠 🐟 🐬 🐳 🦈 🐘 🦒 🌵 🌲 🌴 🌱 🍀 🌺 🌸 🌼 🌻 🌙 🌈 ☀️ ⛅ ☁️ ❄️ ⛄ 💧 🌊',
    '🍔': '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🌽 🥕 🥔 🍞 🧀 🥚 🍳 🥞 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🍤 🍚 🍦 🍰 🎂 🍫 🍬 🍭 🍩 🍪 ☕ 🍵 🥤 🍺 🍻 🥂 🍷',
    '⚽': '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥅 ⛳ 🏹 🎣 🥊 🥋 🛹 ⛸️ 🎿 🏂 🏋️ 🤸 🚴 🚵 🧗 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 🎮 🎰 🧩',
    '🚗': '🚗 🚕 🚙 🚌 🏎️ 🚓 🚑 🚒 🚚 🚜 🛴 🚲 🛵 🏍️ 🚂 🚄 🚈 🚊 ✈️ 🛫 🛬 🚀 🛸 🚁 ⛵ 🚤 🛳️ ⚓ 🗺️ 🗽 🗼 🏰 🎡 🎢 ⛲ 🏖️ 🏝️ 🌋 ⛰️ 🏕️ ⛺ 🏠 🏢 🏬 🏥 🏫 ⛪ 🕌',
    '💻': '⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 💿 📷 📹 🎥 📞 ☎️ 📺 📻 ⏰ ⏳ 🔋 🔌 💡 🔦 💰 💳 💎 ⚖️ 🔧 🔨 🛠️ ⚙️ 🧲 💣 🔪 🔮 💊 💉 🩺 🧹 🔑 🚪 🛏️ 🧸 🖼️ 🛍️ 📦 📜 📄 📊 📈 📉 📅 📋 📁 📰 📚 📖 🔖 🔗 📎 📐 📌 ✂️ 🖊️ 📝 ✏️ 🔍 🔒 🔓',
    '✅': '✅ ❌ ⭕ 🛑 ⛔ 🚫 ❗ ❓ ⚠️ 🔞 ♻️ 🔱 ⚜️ 🌐 ♿ 🚻 🅿️ 🆗 🆕 🆓 🔟 #️⃣ 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ ▶️ ⏸️ ⏹️ ⏭️ 🔀 🔁 🔊 🔇 📶 ➕ ➖ ✖️ ➗ ♾️'
};

let emojiBuilt = false;

function buildEmoji() {
    if (emojiBuilt) return;
    const tabs = $('emojiTabs');
    const grid = $('emojiGrid');
    const keys = Object.keys(EMOJI);

    const paint = (key) => {
        grid.innerHTML = EMOJI[key].split(' ').filter(Boolean)
            .map((e) => `<button type="button">${e}</button>`).join('');
        grid.querySelectorAll('button').forEach((b) => {
            b.onclick = () => insertEmoji(b.textContent);
        });
    };

    tabs.innerHTML = keys.map((k, i) =>
        `<button type="button" class="${i === 0 ? 'is-active' : ''}">${k}</button>`).join('');

    tabs.querySelectorAll('button').forEach((btn, i) => {
        btn.onclick = () => {
            tabs.querySelectorAll('button').forEach((b) => b.classList.remove('is-active'));
            btn.classList.add('is-active');
            paint(keys[i]);
        };
    });

    paint(keys[0]);
    emojiBuilt = true;
}

function insertEmoji(emoji) {
    const input = $('msgInput');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    input.focus();
    input.setSelectionRange(start + emoji.length, start + emoji.length);
    autoGrow();
}

// ------------------------------------------------------ voice notes ----

let recorder = null, chunks = [], recTimer = null, recSecs = 0, recAborted = false;

async function startRecording() {
    if (recorder || !state.peer) {
        if (!state.peer) toast('Open a chat first', 'warn');
        return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
        toast('Recording needs a secure (https) connection', 'err');
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = []; recAborted = false; recSecs = 0;
        recorder = new MediaRecorder(stream);

        recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        recorder.onstop = () => {
            stream.getTracks().forEach((t) => t.stop());
            clearInterval(recTimer);
            $('recorder').hidden = true;
            $('composer').hidden = false;
            $('micBtn').classList.remove('is-rec');
            const blob = new Blob(chunks, { type: 'audio/webm' });
            recorder = null;
            if (!recAborted && blob.size > 1000) {
                sendFile(new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' }), 'audio');
            }
        };

        recorder.start();
        $('recorder').hidden = false;
        $('composer').hidden = true;
        $('micBtn').classList.add('is-rec');
        recTimer = setInterval(() => {
            recSecs++;
            $('recTime').textContent = `${Math.floor(recSecs / 60)}:${String(recSecs % 60).padStart(2, '0')}`;
        }, 1000);
    } catch {
        toast('Microphone permission denied', 'err');
    }
}

function stopRecording(send) {
    if (!recorder) return;
    recAborted = !send;
    recorder.stop();
}

// ------------------------------------------------------------ calls ----

const RTC_CONFIG = {
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
};

const call = { pc: null, stream: null, peerId: null, offer: null, media: 'audio' };

function callUI(name, avatar, status, video) {
    $('callName').textContent = name;
    $('callStatus').textContent = status;
    $('callAvatar').src = avatarFor(name, avatar);
    $('callScreen').hidden = false;
    $('callScreen').classList.toggle('video', !!video);
    $('camBtn').style.display = video ? '' : 'none';
}

function newPeerConnection(toUserId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pc.onicecandidate = (e) => {
        if (e.candidate) state.socket.emit('call:ice', { toUserId, candidate: e.candidate });
    };
    pc.ontrack = (e) => {
        $('remoteVideo').srcObject = e.streams[0];
        $('callStatus').textContent = 'Connected';
    };
    pc.onconnectionstatechange = () => {
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) endCall(true);
    };
    return pc;
}

async function startCall(media) {
    if (!state.peer) return;
    if (!navigator.mediaDevices) {
        toast('Calls need a secure (https) connection', 'err');
        return;
    }

    call.media = media;
    call.peerId = state.peer.contact_id;

    try {
        call.stream = await navigator.mediaDevices.getUserMedia({
            audio: true, video: media === 'video'
        });
    } catch {
        toast('Camera/microphone permission denied', 'err');
        return;
    }

    callUI(state.peer.name, state.peer.avatar, 'Ringing…', media === 'video');
    $('localVideo').srcObject = call.stream;

    call.pc = newPeerConnection(call.peerId);
    call.stream.getTracks().forEach((t) => call.pc.addTrack(t, call.stream));

    const offer = await call.pc.createOffer();
    await call.pc.setLocalDescription(offer);
    state.socket.emit('call:offer', { toUserId: call.peerId, offer, media });
}

async function acceptCall() {
    $('ringBanner').hidden = true;
    if (!call.offer) return;

    try {
        call.stream = await navigator.mediaDevices.getUserMedia({
            audio: true, video: call.media === 'video'
        });
    } catch {
        state.socket.emit('call:decline', { toUserId: call.peerId });
        toast('Permission denied', 'err');
        return;
    }

    const c = state.contacts.find((x) => x.contact_id === call.peerId);
    callUI(c ? c.name : 'Caller', c && c.avatar, 'Connecting…', call.media === 'video');
    $('localVideo').srcObject = call.stream;

    call.pc = newPeerConnection(call.peerId);
    call.stream.getTracks().forEach((t) => call.pc.addTrack(t, call.stream));
    await call.pc.setRemoteDescription(new RTCSessionDescription(call.offer));
    const answer = await call.pc.createAnswer();
    await call.pc.setLocalDescription(answer);
    state.socket.emit('call:answer', { toUserId: call.peerId, answer });
    call.offer = null;
}

function declineCall() {
    $('ringBanner').hidden = true;
    if (call.peerId) state.socket.emit('call:decline', { toUserId: call.peerId });
    call.offer = null; call.peerId = null;
}

function endCall(silent) {
    if (!silent && call.peerId && state.socket) {
        state.socket.emit('call:end', { toUserId: call.peerId });
    }
    if (call.pc) { try { call.pc.close(); } catch {} }
    if (call.stream) call.stream.getTracks().forEach((t) => t.stop());
    call.pc = null; call.stream = null; call.peerId = null; call.offer = null;
    $('remoteVideo').srcObject = null;
    $('localVideo').srcObject = null;
    $('callScreen').hidden = true;
    $('ringBanner').hidden = true;
}

function bindCallSignals(socket) {
    socket.on('call:incoming', ({ from, offer, media }) => {
        if (call.pc) { socket.emit('call:decline', { toUserId: from }); return; }
        call.peerId = from; call.offer = offer; call.media = media;
        const c = state.contacts.find((x) => x.contact_id === from);
        $('ringName').textContent = c ? c.name : 'Unknown caller';
        $('ringKind').textContent = media === 'video' ? 'Incoming video call' : 'Incoming voice call';
        $('ringAvatar').src = avatarFor(c ? c.name : '?', c && c.avatar);
        $('ringBanner').hidden = false;
    });

    socket.on('call:answered', async ({ answer }) => {
        if (call.pc) {
            await call.pc.setRemoteDescription(new RTCSessionDescription(answer));
            $('callStatus').textContent = 'Connected';
        }
    });

    socket.on('call:ice', async ({ candidate }) => {
        if (call.pc && candidate) {
            try { await call.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
        }
    });

    socket.on('call:declined', () => { toast('Call declined', 'warn'); endCall(true); });
    socket.on('call:ended', () => { toast('Call ended'); endCall(true); });
}

// ------------------------------------------------------------ input ----

function autoGrow() {
    const el = $('msgInput');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 130) + 'px';
}

// ------------------------------------------------------------- wire ----

function wire() {
    // auth
    $('tabSignin').onclick = () => switchTab('signin');
    $('tabSignup').onclick = () => switchTab('signup');

    $('signinForm').onsubmit = (e) => {
        e.preventDefault();
        authenticate('/api/auth/login',
            { phone: $('siPhone').value, password: $('siPass').value }, $('siBtn'));
    };

    $('signupForm').onsubmit = (e) => {
        e.preventDefault();
        authenticate('/api/auth/register', {
            name: $('suName').value,
            phone: $('suPhone').value,
            password: $('suPass').value
        }, $('suBtn'));
    };

    $('logoutBtn').onclick = () => { if (confirm('Sign out of ChatConnect?')) signOut(); };

    // navigation
    $('chatSearch').oninput = renderChatList;
    $('newChatBtn').onclick = () => { openSheet('newChatSheet'); peopleIdle(); $('peopleSearch').value = ''; setTimeout(() => $('peopleSearch').focus(), 80); };
    $('closeNewChat').onclick = closeSheets;
    $('closeProfile').onclick = closeSheets;
    $('scrim').onclick = closeSheets;
    $('backBtn').onclick = closeChat;
    $('openSidebarBtn').onclick = () => $('appScreen').classList.remove('viewing');

    $('peopleSearch').oninput = (e) => runSearch(e.target.value);

    // profile
    $('meAvatarBtn').onclick = () => {
        $('pfName').value = state.me.name;
        $('pfAbout').value = state.me.about || '';
        $('pfPhone').textContent = 'Phone: ' + state.me.phone;
        openSheet('profileSheet');
    };
    $('saveProfile').onclick = async () => {
        try {
            state.me = await api('/api/me', {
                method: 'PUT',
                body: { name: $('pfName').value, about: $('pfAbout').value }
            });
            store.set('me', JSON.stringify(state.me));
            paintMe();
            closeSheets();
            toast('Profile saved', 'ok');
        } catch (err) { toast(err.message, 'err'); }
    };

    // composer
    const input = $('msgInput');
    input.addEventListener('input', () => { autoGrow(); onTyping(); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
        if (e.key === 'Escape') cancelEdit();
    });
    $('sendBtn').onclick = sendText;
    $('cancelEditBtn').onclick = () => { cancelEdit(); input.value = ''; autoGrow(); };

    // emoji + attach
    $('emojiBtn').onclick = (e) => {
        e.stopPropagation();
        buildEmoji();
        $('attachPop').hidden = true;
        $('emojiPop').hidden = !$('emojiPop').hidden;
    };
    $('attachBtn').onclick = (e) => {
        e.stopPropagation();
        $('emojiPop').hidden = true;
        $('attachPop').hidden = !$('attachPop').hidden;
    };
    $('attachPop').querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
            const f = $('fileInput');
            f.accept = b.dataset.accept || '';
            f.value = '';
            f.click();
            $('attachPop').hidden = true;
        };
    });
    $('fileInput').onchange = (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) sendFile(file);
    };

    // voice notes — hold to record
    const mic = $('micBtn');
    mic.addEventListener('mousedown', startRecording);
    mic.addEventListener('mouseup', () => stopRecording(true));
    mic.addEventListener('mouseleave', () => { if (recorder) stopRecording(true); });
    mic.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
    mic.addEventListener('touchend', (e) => { e.preventDefault(); stopRecording(true); });
    $('recCancel').onclick = () => stopRecording(false);
    $('recSend').onclick = () => stopRecording(true);

    // calls
    $('callAudioBtn').onclick = () => startCall('audio');
    $('callVideoBtn').onclick = () => startCall('video');
    $('hangBtn').onclick = () => endCall();
    $('acceptBtn').onclick = acceptCall;
    $('declineBtn').onclick = declineCall;
    $('muteBtn').onclick = () => {
        const t = call.stream && call.stream.getAudioTracks()[0];
        if (!t) return;
        t.enabled = !t.enabled;
        $('muteBtn').classList.toggle('off', !t.enabled);
    };
    $('camBtn').onclick = () => {
        const t = call.stream && call.stream.getVideoTracks()[0];
        if (!t) return;
        t.enabled = !t.enabled;
        $('camBtn').classList.toggle('off', !t.enabled);
    };

    // clear chat
    $('clearChatBtn').onclick = async () => {
        if (!state.conversationId) return;
        if (!confirm(`Clear all messages with ${state.peer.name}?`)) return;
        try {
            await api(`/api/conversations/${state.conversationId}`, { method: 'DELETE' });
            renderMessages([]);
            loadContacts();
            toast('Chat cleared', 'ok');
        } catch (err) { toast(err.message, 'err'); }
    };

    // message menu
    $('msgMenu').querySelectorAll('button').forEach((btn) => {
        btn.onclick = async () => {
            const m = menuTarget;
            closeMsgMenu();
            if (!m) return;
            const act = btn.dataset.act;

            if (act === 'copy') {
                try { await navigator.clipboard.writeText(m.body || ''); toast('Copied', 'ok'); }
                catch { toast('Copy failed', 'err'); }
            }
            if (act === 'edit') startEdit(m);
            if (act === 'delete') {
                if (!confirm('Delete this message?')) return;
                try { await api(`/api/messages/${m.id}`, { method: 'DELETE' }); }
                catch (err) { toast(err.message, 'err'); }
            }
        };
    });

    // global dismissals
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#emojiPop') && !e.target.closest('#emojiBtn')) $('emojiPop').hidden = true;
        if (!e.target.closest('#attachPop') && !e.target.closest('#attachBtn')) $('attachPop').hidden = true;
        if (!e.target.closest('#msgMenu')) closeMsgMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeSheets(); closeMsgMenu(); $('emojiPop').hidden = true; $('attachPop').hidden = true; }
    });

    window.addEventListener('beforeunload', stopTyping);
}

// ------------------------------------------------------------- init ----

document.addEventListener('DOMContentLoaded', () => {
    wire();
    boot();
});

// Expose a few helpers for automated checks.
window.__chat = { state, buildMessage, attachmentHtml, highlight, store };

})();
