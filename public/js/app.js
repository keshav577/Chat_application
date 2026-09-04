// ==================== GLOBAL VARIABLES ====================
let socket = null;
let currentUser = null;
let currentConversation = null;
let currentContact = null;
let contacts = [];
let conversations = {};
let typingTimer = null;
let selectedMessageId = null;
let isTyping = false;

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
    checkAuthentication();
    setupEventListeners();
    initializeSocketEvents();
});

// ==================== SESSION STORAGE ====================
// The app often runs inside an iframe (preview panels) where localStorage can
// throw or be partitioned away. Persist through every channel available --
// memory, localStorage, sessionStorage and finally a cookie -- so a page
// reload doesn't silently destroy a perfectly valid session.
let memoryStore = { token: null, userData: null };

function cookieGet(key) {
    try {
        const m = document.cookie.match(new RegExp('(?:^|; )' + key + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
}

function cookieSet(key, value) {
    try {
        const secure = location.protocol === 'https:' ? '; Secure; SameSite=None' : '; SameSite=Lax';
        document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=${7 * 24 * 60 * 60}${secure}`;
    } catch (e) { /* non-fatal */ }
}

function cookieDelete(key) {
    try { document.cookie = `${key}=; path=/; max-age=0`; } catch (e) { /* non-fatal */ }
}

const safeStorage = {
    get(key) {
        if (memoryStore[key] != null) return memoryStore[key];
        for (const read of [
            () => localStorage.getItem(key),
            () => sessionStorage.getItem(key),
            () => cookieGet(key)
        ]) {
            try {
                const v = read();
                if (v != null) { memoryStore[key] = v; return v; }
            } catch (e) { /* try next channel */ }
        }
        return null;
    },
    set(key, value) {
        memoryStore[key] = value;
        try { localStorage.setItem(key, value); } catch (e) {}
        try { sessionStorage.setItem(key, value); } catch (e) {}
        cookieSet(key, value);
    },
    remove(key) {
        memoryStore[key] = null;
        try { localStorage.removeItem(key); } catch (e) {}
        try { sessionStorage.removeItem(key); } catch (e) {}
        cookieDelete(key);
    }
};

function getToken() {
    const t = safeStorage.get('token');
    return (!t || t === 'null' || t === 'undefined') ? null : t;
}

// Auth headers for every protected request.
function authHeaders(extra) {
    return Object.assign({ 'Authorization': `Bearer ${getToken()}` }, extra || {});
}

// Wrapper that forces a clean logout if the session is missing/expired,
// instead of leaving the user in a logged-in UI with no valid token.
async function apiFetch(url, options = {}) {
    const token = getToken();
    if (!token) {
        forceLogout('Your session expired. Please sign in again.');
        throw new Error('No session');
    }
    options.headers = Object.assign({}, options.headers || {}, {
        'Authorization': `Bearer ${token}`
    });
    const response = await fetch(url, options);
    if (response.status === 401 || response.status === 403) {
        forceLogout('Your session expired. Please sign in again.');
        throw new Error('Session expired');
    }
    return response;
}

function forceLogout(message) {
    safeStorage.remove('token');
    safeStorage.remove('userData');
    currentUser = null;
    currentConversation = null;
    currentContact = null;
    if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
    showAuthScreen();
    if (message) showToast(message, 'error');
}

function checkAuthentication() {
    const token = getToken();
    const userData = safeStorage.get('userData');
    
    // Both must be present, otherwise the session is broken -> clear it.
    if (token && userData) {
        try {
            currentUser = JSON.parse(userData);
        } catch (e) {
            forceLogout();
            return;
        }
        showChatInterface();
        initializeChat().catch(err => console.error('Init failed:', err));
    } else {
        // No stored session at all -- just show the login screen quietly.
        showAuthScreen();
    }
}

// Setup all event listeners
function setupEventListeners() {
    // Auth form submissions
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('registerForm').addEventListener('submit', handleRegister);
    
    // Message input
    const messageInput = document.getElementById('messageInput');
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    
    messageInput.addEventListener('input', handleTyping);
    
    // Search functionality
    document.getElementById('searchInput').addEventListener('input', (e) => {
        searchContacts(e.target.value);
    });
    
    // People search inside the Add People modal
    document.getElementById('peopleSearchInput').addEventListener('input', (e) => {
        handlePeopleSearch(e.target.value);
    });
    
    // Attachment picker
    document.getElementById('fileInput').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) uploadAndSend(file);
    });
    
    // Voice notes: hold the mic (mouse or touch) to record
    const mic = document.getElementById('btnMic');
    mic.addEventListener('mousedown', startRecording);
    mic.addEventListener('mouseup', () => stopRecording(true));
    mic.addEventListener('mouseleave', () => { if (mediaRecorder) stopRecording(true); });
    mic.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
    mic.addEventListener('touchend', (e) => { e.preventDefault(); stopRecording(true); });
    
    // Close emoji/attach popovers when clicking elsewhere
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#emojiPanel') && !e.target.closest('#btnEmoji')) {
            document.getElementById('emojiPanel').classList.remove('open');
        }
        if (!e.target.closest('#attachSheet') && !e.target.closest('#btnAttach')) {
            document.getElementById('attachSheet').classList.remove('open');
        }
    });
    
    // Escape closes any open modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
        }
    });
    
    // Close modals on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });
    });
    
    // Message context menu
    document.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.message')) {
            e.preventDefault();
            showMessageMenu(e);
        }
    });
    
    // Close context menu on click outside
    document.addEventListener('click', () => {
        const menu = document.getElementById('messageMenu');
        if (menu) menu.style.display = 'none';
    });
}

// ==================== AUTHENTICATION ====================
async function handleLogin(e) {
    e.preventDefault();
    const phone = document.getElementById('loginPhone').value;
    const password = document.getElementById('loginPassword').value;
    const button = e.target.querySelector('.btn-submit');
    
    button.classList.add('loading');
    
    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            safeStorage.set('token', data.token);
            safeStorage.set('userData', JSON.stringify(data.user));
            currentUser = data.user;
            showChatInterface();
            await initializeChat();
            // Don't overwrite a session error toast with a success message.
            if (currentUser) showToast('Welcome back!', 'success');
        } else {
            showToast(data.error || 'Login failed', 'error');
        }
    } catch (error) {
        showToast('Connection error. Please try again.', 'error');
    } finally {
        button.classList.remove('loading');
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const name = document.getElementById('registerName').value;
    const phone = document.getElementById('registerPhone').value;
    const password = document.getElementById('registerPassword').value;
    const button = e.target.querySelector('.btn-submit');
    
    // Validate phone number format
    if (!validatePhoneNumber(phone)) {
        showToast('Please enter a valid phone number', 'error');
        return;
    }
    
    // Validate password strength
    if (password.length < 6) {
        showToast('Password must be at least 6 characters', 'error');
        return;
    }
    
    button.classList.add('loading');
    
    try {
        const response = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, phone, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            safeStorage.set('token', data.token);
            safeStorage.set('userData', JSON.stringify(data.user));
            currentUser = data.user;
            showChatInterface();
            await initializeChat();
            if (currentUser) showToast('Account created successfully!', 'success');
        } else if (response.status === 400 && /already registered/i.test(data.error || '')) {
            // Don't dead-end the user: pre-fill the sign-in tab for them.
            showToast('That number is already registered. Please sign in.', 'warning');
            document.getElementById('loginPhone').value = phone;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
            document.querySelector('.tab-btn').classList.add('active');
            document.getElementById('loginForm').classList.add('active');
            document.getElementById('loginPassword').focus();
        } else {
            showToast(data.error || 'Registration failed', 'error');
        }
    } catch (error) {
        showToast('Connection error. Please try again.', 'error');
    } finally {
        button.classList.remove('loading');
    }
}

function logout() {
    if (confirm('Are you sure you want to logout?')) {
        fetch('/api/auth/logout', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${getToken()}`
            }
        });
        
        safeStorage.remove('token');
        safeStorage.remove('userData');
        
        if (socket) {
            socket.disconnect();
        }
        
        currentUser = null;
        currentConversation = null;
        currentContact = null;
        
        showAuthScreen();
        showToast('Logged out successfully', 'success');
    }
}

// ==================== UI NAVIGATION ====================
function showAuthScreen() {
    document.getElementById('authScreen').style.display = 'flex';
    document.getElementById('chatInterface').style.display = 'none';
}

// ==================== MOBILE NAVIGATION ====================
function openSidebar() {
    document.querySelector('.sidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.add('active');
}

function closeSidebar() {
    document.querySelector('.sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('active');
}

// On mobile, go back from a chat to the conversation list.
function closeConversation() {
    if (window.matchMedia('(max-width: 768px)').matches) {
        document.getElementById('chatView').style.display = 'none';
        document.getElementById('welcomeScreen').style.display = 'flex';
        openSidebar();
    }
}

function showChatInterface() {
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('chatInterface').style.display = 'flex';
}

function switchTab(tab, evt) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelectorAll('.auth-form').forEach(form => {
        form.classList.remove('active');
    });
    
    const btn = (evt && evt.target) || (window.event && window.event.target);
    if (btn) btn.classList.add('active');
    document.getElementById(tab + 'Form').classList.add('active');
}

// ==================== CHAT INITIALIZATION ====================
async function initializeChat() {
    if (!currentUser) return;
    updateUserProfile();
    await loadContacts();
    // loadContacts() may have invalidated the session (expired token), which
    // clears currentUser -- so re-check before touching currentUser.id.
    if (!currentUser) return;
    connectSocket();
}

function updateUserProfile() {
    document.getElementById('userName').textContent = currentUser.name;
    document.getElementById('userStatus').textContent = 'Online';
    
    const avatarUrl = currentUser.avatar || 
        `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.name)}&background=FF6B6B&color=fff`;
    document.getElementById('profileImg').src = avatarUrl;
}

// ==================== SOCKET CONNECTION ====================
function connectSocket() {
    if (!currentUser) return;
    if (socket) { try { socket.disconnect(); } catch (e) {} }
    socket = io();
    
    socket.emit('authenticate', currentUser.id);
    
    socket.on('connect', () => {
        console.log('Connected to server');
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
    });
}

function initializeSocketEvents() {
    if (!socket) return;
    
    // New message received
    socket.on('newMessage', (data) => {
        handleNewMessage(data);
    });
    
    // Message edited
    socket.on('messageEdited', (data) => {
        handleMessageEdited(data);
    });
    
    // Message deleted
    socket.on('messageDeleted', (data) => {
        handleMessageDeleted(data);
    });
    
    // User online status
    socket.on('userOnline', (userId) => {
        updateUserStatus(userId, true);
    });
    
    socket.on('userOffline', (userId) => {
        updateUserStatus(userId, false);
    });
    
    // Typing indicators
    socket.on('typing', (data) => {
        showTypingIndicator(data);
    });
    
    socket.on('stopTyping', (data) => {
        hideTypingIndicator(data);
    });
    
    // Message read receipts
    socket.on('messageRead', (data) => {
        updateMessageStatus(data.messageId, 'read');
    });
    
    // ---------- Call signalling ----------
    socket.on('incomingCall', async ({ from, offer, callType }) => {
        if (peer) { socket.emit('rejectCall', { toUserId: from }); return; }
        callPeerId = from;
        pendingOffer = offer;
        currentCallType = callType;
        const contact = contacts.find(c => c.contact_id === from);
        const name = contact ? (contact.contact_name || contact.user_name) : 'Unknown caller';
        document.getElementById('incomingName').textContent = name;
        document.getElementById('incomingType').textContent =
            (callType === 'video' ? 'Incoming video call' : 'Incoming voice call');
        document.getElementById('incomingAvatar').src = (contact && contact.avatar) ||
            `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=667eea&color=fff`;
        document.getElementById('incomingCall').classList.add('active');
    });
    
    socket.on('callAnswered', async ({ answer }) => {
        if (peer) {
            await peer.setRemoteDescription(new RTCSessionDescription(answer));
            document.getElementById('callStatus').textContent = 'Connected';
        }
    });
    
    socket.on('iceCandidate', async ({ candidate }) => {
        if (peer && candidate) {
            try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
        }
    });
    
    socket.on('callRejected', () => { showToast('Call declined', 'warning'); hangUp(true); });
    socket.on('callEnded', () => { showToast('Call ended', 'warning'); hangUp(true); });
}

// ==================== CONTACTS MANAGEMENT ====================
async function loadContacts() {
    try {
        const response = await apiFetch('/api/contacts');
        
        if (response.ok) {
            contacts = await response.json();
            displayContacts();
            return true;
        }
        return false;
    } catch (error) {
        // A dead session already triggered forceLogout(); don't nag the user
        // with a second, misleading error toast.
        console.error('Failed to load contacts:', error);
        if (currentUser) showToast('Failed to load contacts', 'error');
        return false;
    }
}

function displayContacts() {
    const contactsList = document.getElementById('contactsList');
    contactsList.innerHTML = '';
    
    if (contacts.length === 0) {
        contactsList.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #718096;">
                <p style="margin-bottom: 20px;">No contacts yet</p>
                <button class="btn-primary" onclick="openAddContact()">
                    Add your first contact
                </button>
            </div>
        `;
        return;
    }
    
    contacts.forEach(contact => {
        const contactElement = createContactElement(contact);
        contactsList.appendChild(contactElement);
    });
}

function createContactElement(contact) {
    const div = document.createElement('div');
    div.className = 'contact-item';
    div.dataset.contactId = contact.contact_id;
    div.onclick = () => openConversation(contact);
    
    const avatarUrl = contact.avatar || 
        `https://ui-avatars.com/api/?name=${encodeURIComponent(contact.contact_name || contact.user_name)}&background=667eea&color=fff`;
    
    const lastMessageTime = contact.last_message_time ? 
        formatMessageTime(contact.last_message_time) : '';
    
    div.innerHTML = `
        <div style="position: relative;">
            <img src="${avatarUrl}" alt="${contact.contact_name}" class="contact-avatar">
            ${contact.is_online ? '<span class="online-indicator"></span>' : ''}
        </div>
        <div class="contact-info">
            <div class="contact-name">${contact.contact_name || contact.user_name}</div>
            <div class="last-message">${contact.last_message || 'No messages yet'}</div>
        </div>
        <div class="contact-meta">
            <div class="message-time">${lastMessageTime}</div>
            ${contact.unread_count > 0 ? 
                `<span class="unread-count">${contact.unread_count}</span>` : ''}
        </div>
    `;
    
    if (currentContact && currentContact.contact_id === contact.contact_id) {
        div.classList.add('active');
    }
    
    return div;
}

function searchContacts(query) {
    const filtered = contacts.filter(contact => {
        const name = (contact.contact_name || contact.user_name).toLowerCase();
        const phone = contact.phone.toLowerCase();
        return name.includes(query.toLowerCase()) || phone.includes(query);
    });
    
    const contactsList = document.getElementById('contactsList');
    contactsList.innerHTML = '';
    
    filtered.forEach(contact => {
        const contactElement = createContactElement(contact);
        contactsList.appendChild(contactElement);
    });
}

// ==================== ADD PEOPLE ====================
let peopleSearchTimer = null;
let peopleResultsCache = [];

function openAddContact() {
    document.getElementById('addContactModal').classList.add('active');
    closeSidebar();
    const input = document.getElementById('peopleSearchInput');
    input.value = '';
    document.getElementById('peopleSearchClear').classList.remove('visible');
    renderPeopleIdle();
    setTimeout(() => input.focus(), 100);
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

function clearPeopleSearch() {
    const input = document.getElementById('peopleSearchInput');
    input.value = '';
    document.getElementById('peopleSearchClear').classList.remove('visible');
    renderPeopleIdle();
    input.focus();
}

function renderPeopleIdle() {
    document.getElementById('peopleResults').innerHTML = `
        <div class="people-empty">
            <div class="people-empty-icon">&#128101;</div>
            <p class="people-empty-title">Find someone to chat with</p>
            <p class="people-empty-text">Start typing at least 2 characters to search registered users.</p>
        </div>`;
}

function renderPeopleLoading() {
    document.getElementById('peopleResults').innerHTML = `
        <div class="people-skeletons">
            ${'<div class="people-skeleton"><div class="sk-avatar"></div><div class="sk-lines"><div class="sk-line"></div><div class="sk-line short"></div></div></div>'.repeat(3)}
        </div>`;
}

// Debounced live search so we don't hammer the server on every keystroke.
function handlePeopleSearch(value) {
    const q = value.trim();
    document.getElementById('peopleSearchClear').classList.toggle('visible', q.length > 0);
    clearTimeout(peopleSearchTimer);

    if (q.length < 2) {
        renderPeopleIdle();
        return;
    }

    renderPeopleLoading();
    peopleSearchTimer = setTimeout(async () => {
        try {
            const response = await apiFetch(`/api/users/search?q=${encodeURIComponent(q)}`);
            if (!response.ok) throw new Error('search failed');
            peopleResultsCache = await response.json();
            renderPeopleResults(peopleResultsCache, q);
        } catch (error) {
            document.getElementById('peopleResults').innerHTML =
                `<div class="people-empty"><p class="people-empty-title">Couldn't search right now</p>
                 <p class="people-empty-text">Please check your connection and try again.</p></div>`;
        }
    }, 250);
}

function highlightMatch(text, query) {
    const safe = escapeHtml(text);
    const q = query.trim();
    if (!q) return safe;
    const escaped = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(`(${escaped})`, 'ig'), '<mark>$1</mark>');
}

function renderPeopleResults(users, query) {
    const box = document.getElementById('peopleResults');

    if (!users.length) {
        box.innerHTML = `
            <div class="people-empty">
                <div class="people-empty-icon">&#128533;</div>
                <p class="people-empty-title">No one found</p>
                <p class="people-empty-text">Nobody matching "${escapeHtml(query)}" has registered yet.
                Ask them to create an account first.</p>
            </div>`;
        return;
    }

    const rows = users.map((u, i) => {
        const avatar = u.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.name)}&background=667eea&color=fff`;
        const action = u.is_contact
            ? `<button class="btn-added" onclick="messageExisting(${u.id})">Message</button>`
            : `<button class="btn-add" onclick="addPerson(${u.id}, this)">Add</button>`;
        return `
            <div class="person-row" style="animation-delay:${i * 35}ms">
                <div class="person-avatar-wrap">
                    <img class="person-avatar" src="${avatar}" alt="${escapeHtml(u.name)}">
                    ${u.is_online ? '<span class="online-indicator"></span>' : ''}
                </div>
                <div class="person-info">
                    <div class="person-name">${highlightMatch(u.name, query)}</div>
                    <div class="person-phone">${highlightMatch(u.phone, query)}</div>
                </div>
                ${action}
            </div>`;
    }).join('');

    const label = `${users.length} ${users.length === 1 ? 'person' : 'people'} found`;
    box.innerHTML = `<div class="people-results-head">${label}</div>${rows}`;
}

// Add by user id straight from the search results.
async function addPerson(userId, buttonEl) {
    const user = peopleResultsCache.find(u => u.id === userId);
    if (!user) return;

    buttonEl.disabled = true;
    buttonEl.textContent = 'Adding...';

    try {
        const response = await apiFetch('/api/contacts/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: user.phone, name: user.name })
        });
        const data = await response.json();

        if (response.ok) {
            user.is_contact = 1;
            buttonEl.outerHTML = `<button class="btn-added" onclick="messageExisting(${userId})">Message</button>`;
            showToast(`${user.name} added to your chats`, 'success');
            loadContacts();
        } else {
            buttonEl.disabled = false;
            buttonEl.textContent = 'Add';
            showToast(data.error || 'Failed to add contact', 'error');
        }
    } catch (error) {
        buttonEl.disabled = false;
        buttonEl.textContent = 'Add';
        showToast('Connection error', 'error');
    }
}

// Jump straight into the conversation with an existing contact.
async function messageExisting(userId) {
    closeModal('addContactModal');
    await loadContacts();
    const contact = contacts.find(c => c.contact_id === userId);
    if (contact) openConversation(contact);
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// ==================== CONVERSATION ====================
async function openConversation(contact) {
    currentContact = contact;
    currentConversation = contact.conversation_id;
    
    // Update UI
    document.getElementById('welcomeScreen').style.display = 'none';
    document.getElementById('chatView').style.display = 'flex';
    
    // Update contact info in header
    const contactName = contact.contact_name || contact.user_name;
    document.getElementById('contactName').textContent = contactName;
    
    const avatarUrl = contact.avatar || 
        `https://ui-avatars.com/api/?name=${encodeURIComponent(contactName)}&background=667eea&color=fff`;
    document.getElementById('contactImg').src = avatarUrl;
    
    const statusText = contact.is_online ? 'Online' : 
        `Last seen ${formatLastSeen(contact.last_seen)}`;
    document.getElementById('contactStatus').textContent = statusText;
    
    // Load messages
    await loadMessages();
    
    // Mark contact as active (works whether or not this came from a click)
    document.querySelectorAll('.contact-item').forEach(item => {
        item.classList.toggle('active',
            Number(item.dataset.contactId) === Number(contact.contact_id));
    });
    
    // On mobile the sidebar covers the chat -- close it after picking a chat.
    closeSidebar();
    
    if (!window.matchMedia('(max-width: 768px)').matches) {
        document.getElementById('messageInput').focus();
    }
}

async function loadMessages() {
    if (!currentConversation) return;
    
    try {
        const response = await apiFetch(`/api/messages/${currentConversation}`);
        
        if (response.ok) {
            const messages = await response.json();
            displayMessages(messages);
        }
    } catch (error) {
        console.error('Failed to load messages:', error);
        showToast('Failed to load messages', 'error');
    }
}

function displayMessages(messages) {
    const messagesArea = document.getElementById('messagesArea');
    messagesArea.innerHTML = '';
    
    let lastDate = null;
    
    messages.forEach(message => {
        // Add date separator if needed
        const messageDate = new Date(message.created_at).toDateString();
        if (messageDate !== lastDate) {
            const dateSeparator = document.createElement('div');
            dateSeparator.className = 'date-separator';
            dateSeparator.innerHTML = `<span>${formatDateSeparator(messageDate)}</span>`;
            messagesArea.appendChild(dateSeparator);
            lastDate = messageDate;
        }
        
        // Add message
        const messageElement = createMessageElement(message);
        messagesArea.appendChild(messageElement);
    });
    
    // Scroll to bottom
    messagesArea.scrollTop = messagesArea.scrollHeight;
    
    // Mark messages as read
    if (socket && currentContact) {
        messages.forEach(msg => {
            if (msg.sender_id !== currentUser.id && !msg.is_read) {
                socket.emit('markAsRead', {
                    messageId: msg.id,
                    senderId: msg.sender_id
                });
            }
        });
    }
}

// Renders image / video / audio / document attachments inside a bubble.
function renderAttachment(message) {
    if (!message.file_url) return '';
    const url = escapeHtml(message.file_url);
    switch (message.type) {
        case 'image':
            return `<a href="${url}" target="_blank" rel="noopener" class="msg-image">
                        <img src="${url}" alt="image" loading="lazy">
                    </a>`;
        case 'video':
            return `<video class="msg-video" src="${url}" controls preload="metadata"></video>`;
        case 'audio':
            return `<audio class="msg-audio" src="${url}" controls preload="metadata"></audio>`;
        default:
            return `<a class="msg-file" href="${url}" target="_blank" rel="noopener" download>
                        <span class="msg-file-ico">&#128196;</span>
                        <span class="msg-file-name">${escapeHtml(message.message || 'Download file')}</span>
                    </a>`;
    }
}

function createMessageElement(message) {
    const div = document.createElement('div');
    const isSent = message.sender_id === currentUser.id;
    div.className = `message ${isSent ? 'sent' : 'received'}`;
    div.dataset.messageId = message.id;
    
    const time = formatMessageTime(message.created_at);
    const editedText = message.is_edited ? ' (edited)' : '';
    
    div.innerHTML = `
        <div class="message-bubble${message.file_url && message.type === 'image' ? ' media' : ''}">
            ${renderAttachment(message)}
            ${message.message && !(message.type === 'image' && message.file_url)
                ? `<div class="message-text">${escapeHtml(message.message)}</div>` : ''}
            <div class="message-info">
                <span class="message-time">${time}${editedText}</span>
                ${isSent ? getMessageStatusIcon(message) : ''}
            </div>
        </div>
    `;
    
    // Add context menu for own messages
    if (isSent) {
        div.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showMessageMenu(e, message);
        });
    }
    
    return div;
}

function getMessageStatusIcon(message) {
    if (message.is_read) {
        return '<span style="color: #4ECDC4;">✓✓</span>';
    } else if (message.is_delivered) {
        return '<span>✓✓</span>';
    } else {
        return '<span>✓</span>';
    }
}

// ==================== SEND MESSAGE ====================
async function sendMessage() {
    const messageInput = document.getElementById('messageInput');
    const message = messageInput.value.trim();
    
    if (!message || !currentContact) return;
    
    // Clear input immediately
    messageInput.value = '';
    
    // Stop typing indicator
    if (socket && isTyping) {
        socket.emit('stopTyping', {
            conversationId: currentConversation,
            receiverId: currentContact.contact_id
        });
        isTyping = false;
    }
    
    try {
        const response = await apiFetch('/api/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                receiverId: currentContact.contact_id,
                message: message,
                type: 'text'
            })
        });
        
        if (response.ok) {
            const newMessage = await response.json();
            
            // Add message to UI
            const messageElement = createMessageElement(newMessage);
            document.getElementById('messagesArea').appendChild(messageElement);
            
            // Scroll to bottom
            const messagesArea = document.getElementById('messagesArea');
            messagesArea.scrollTop = messagesArea.scrollHeight;
            
            // Update contact list with last message
            updateContactLastMessage(currentContact.contact_id, message);
        } else {
            showToast('Failed to send message', 'error');
            messageInput.value = message; // Restore message if failed
        }
    } catch (error) {
        showToast('Connection error', 'error');
        messageInput.value = message; // Restore message if failed
    }
}

// ==================== MESSAGE ACTIONS ====================
function showMessageMenu(e, message) {
    e.preventDefault();
    
    const menu = document.getElementById('messageMenu');
    selectedMessageId = message.id;
    
    menu.style.display = 'block';
    menu.style.left = e.pageX + 'px';
    menu.style.top = e.pageY + 'px';
    
    // Adjust position if menu goes off-screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = (e.pageX - rect.width) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = (e.pageY - rect.height) + 'px';
    }
}

async function editMessage() {
    const messageElement = document.querySelector(`[data-message-id="${selectedMessageId}"]`);
    const messageText = messageElement.querySelector('.message-text').textContent;
    
    const newMessage = prompt('Edit message:', messageText);
    
    if (newMessage && newMessage !== messageText) {
        try {
            const response = await apiFetch(`/api/messages/${selectedMessageId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ message: newMessage })
            });
            
            if (response.ok) {
                messageElement.querySelector('.message-text').textContent = newMessage;
                
                // Add edited indicator
                const messageInfo = messageElement.querySelector('.message-info');
                if (!messageInfo.textContent.includes('edited')) {
                    const timeSpan = messageInfo.querySelector('.message-time');
                    timeSpan.textContent += ' (edited)';
                }
                
                showToast('Message edited', 'success');
            } else {
                showToast('Failed to edit message', 'error');
            }
        } catch (error) {
            showToast('Connection error', 'error');
        }
    }
    
    document.getElementById('messageMenu').style.display = 'none';
}

async function deleteMessage() {
    if (confirm('Delete this message?')) {
        try {
            const response = await apiFetch(`/api/messages/${selectedMessageId}`, {
                method: 'DELETE'
            });
            
            if (response.ok) {
                const messageElement = document.querySelector(`[data-message-id="${selectedMessageId}"]`);
                messageElement.remove();
                showToast('Message deleted', 'success');
            } else {
                showToast('Failed to delete message', 'error');
            }
        } catch (error) {
            showToast('Connection error', 'error');
        }
    }
    
    document.getElementById('messageMenu').style.display = 'none';
}

function copyMessage() {
    const messageElement = document.querySelector(`[data-message-id="${selectedMessageId}"]`);
    const messageText = messageElement.querySelector('.message-text').textContent;
    
    navigator.clipboard.writeText(messageText).then(() => {
        showToast('Message copied', 'success');
    });
    
    document.getElementById('messageMenu').style.display = 'none';
}

function forwardMessage() {
    // Implement forward functionality
    showToast('Forward feature coming soon', 'warning');
    document.getElementById('messageMenu').style.display = 'none';
}

// ==================== TYPING INDICATOR ====================
function handleTyping() {
    if (!socket || !currentConversation || !currentContact) return;
    
    const messageInput = document.getElementById('messageInput');
    
    if (messageInput.value.trim() && !isTyping) {
        socket.emit('typing', {
            conversationId: currentConversation,
            receiverId: currentContact.contact_id
        });
        isTyping = true;
    }
    
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        if (isTyping) {
            socket.emit('stopTyping', {
                conversationId: currentConversation,
                receiverId: currentContact.contact_id
            });
            isTyping = false;
        }
    }, 1000);
}

function showTypingIndicator(data) {
    if (data.conversationId === currentConversation) {
        document.getElementById('typingIndicator').style.display = 'flex';
    }
}

function hideTypingIndicator(data) {
    if (data.conversationId === currentConversation) {
        document.getElementById('typingIndicator').style.display = 'none';
    }
}

// ==================== REAL-TIME UPDATES ====================
function handleNewMessage(data) {
    // Update messages if in same conversation
    if (data.conversationId === currentConversation) {
        const messageElement = createMessageElement(data);
        document.getElementById('messagesArea').appendChild(messageElement);
        
        // Scroll to bottom
        const messagesArea = document.getElementById('messagesArea');
        messagesArea.scrollTop = messagesArea.scrollHeight;
        
        // Send read receipt
        if (socket && data.sender_id !== currentUser.id) {
            socket.emit('markAsRead', {
                messageId: data.id,
                senderId: data.sender_id
            });
        }
    }
    
    // Update contact list
    updateContactLastMessage(data.sender_id, data.message);
    
    // Show notification if not in conversation
    if (data.conversationId !== currentConversation && data.sender_id !== currentUser.id) {
        showNotification(data);
    }
}

function handleMessageEdited(data) {
    if (data.conversationId === currentConversation) {
        const messageElement = document.querySelector(`[data-message-id="${data.messageId}"]`);
        if (messageElement) {
            messageElement.querySelector('.message-text').textContent = data.message;
            
            const messageInfo = messageElement.querySelector('.message-info');
            if (!messageInfo.textContent.includes('edited')) {
                const timeSpan = messageInfo.querySelector('.message-time');
                timeSpan.textContent += ' (edited)';
            }
        }
    }
}

function handleMessageDeleted(data) {
    if (data.conversationId === currentConversation) {
        const messageElement = document.querySelector(`[data-message-id="${data.messageId}"]`);
        if (messageElement) {
            messageElement.remove();
        }
    }
}

function updateUserStatus(userId, isOnline) {
    const contact = contacts.find(c => c.contact_id === userId);
    if (contact) {
        contact.is_online = isOnline;
        
        // Update UI
        const contactElement = document.querySelector(`[data-contact-id="${userId}"]`);
        if (contactElement) {
            const indicator = contactElement.querySelector('.online-indicator');
            if (isOnline && !indicator) {
                // Add online indicator
                const avatarContainer = contactElement.querySelector('.contact-avatar').parentElement;
                const span = document.createElement('span');
                span.className = 'online-indicator';
                avatarContainer.appendChild(span);
            } else if (!isOnline && indicator) {
                // Remove online indicator
                indicator.remove();
            }
        }
        
        // Update chat header if current contact
        if (currentContact && currentContact.contact_id === userId) {
            const statusText = isOnline ? 'Online' : 
                `Last seen ${formatLastSeen(new Date().toISOString())}`;
            document.getElementById('contactStatus').textContent = statusText;
        }
    }
}

function updateContactLastMessage(contactId, message) {
    const contact = contacts.find(c => c.contact_id === contactId);
    if (contact) {
        contact.last_message = message;
        contact.last_message_time = new Date().toISOString();
        
        // Re-render contacts list
        displayContacts();
    }
}

function updateMessageStatus(messageId, status) {
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (messageElement) {
        const statusIcon = messageElement.querySelector('.message-info span:last-child');
        if (statusIcon) {
            if (status === 'read') {
                statusIcon.innerHTML = '<span style="color: #4ECDC4;">✓✓</span>';
            }
        }
    }
}

// ==================== UTILITIES ====================
function validatePhoneNumber(phone) {
    // Accept common formats (spaces, dashes, dots, brackets, +country code).
    // Rule: 7-15 digits once separators are stripped.
    const digits = String(phone).replace(/[\s\-\.\(\)]/g, '').replace(/^\+/, '');
    return /^[0-9]{7,15}$/.test(digits);
}

function formatMessageTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
        // Today - show time
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
        return 'Yesterday';
    } else if (diffDays < 7) {
        // This week - show day name
        return date.toLocaleDateString([], { weekday: 'short' });
    } else {
        // Older - show date
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
}

function formatLastSeen(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffMins < 1) {
        return 'just now';
    } else if (diffMins < 60) {
        return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    } else if (diffHours < 24) {
        return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    } else if (diffDays < 7) {
        return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    } else {
        return date.toLocaleDateString();
    }
}

function formatDateSeparator(dateString) {
    const date = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    if (date.toDateString() === today.toDateString()) {
        return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
        return 'Yesterday';
    } else {
        return date.toLocaleDateString([], { 
            weekday: 'long', 
            month: 'long', 
            day: 'numeric' 
        });
    }
}

function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

function showNotification(message) {
    // Check if browser supports notifications
    if (!('Notification' in window)) {
        return;
    }
    
    // Request permission if needed
    if (Notification.permission === 'default') {
        Notification.requestPermission();
    }
    
    // Show notification if permitted
    if (Notification.permission === 'granted') {
        const notification = new Notification('New Message', {
            body: `${message.sender_name}: ${message.message}`,
            icon: '/icon-192x192.png',
            badge: '/badge-72x72.png',
            vibrate: [200, 100, 200]
        });
        
        notification.onclick = () => {
            window.focus();
            const contact = contacts.find(c => c.contact_id === message.sender_id);
            if (contact) {
                openConversation(contact);
            }
            notification.close();
        };
        
        setTimeout(() => notification.close(), 5000);
    }
}

// ==================== ADDITIONAL FEATURES ====================
function openSettings() {
    showToast('Settings feature coming soon', 'warning');
}

async function deleteConversation() {
    if (!currentConversation) return;
    try {
        const res = await apiFetch(`/api/conversations/${currentConversation}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Conversation cleared', 'success');
            document.getElementById('chatView').style.display = 'none';
            document.getElementById('welcomeScreen').style.display = 'flex';
            currentContact = null;
            currentConversation = null;
            loadContacts();
        } else {
            showToast('Failed to clear conversation', 'error');
        }
    } catch (e) { /* apiFetch already handled auth errors */ }
}

// Chat header overflow menu: offer the useful destructive action.
function openChatMenu() {
    if (!currentContact) return;
    const name = currentContact.contact_name || currentContact.user_name;
    if (confirm(`Clear this conversation with ${name}?\n\nThis removes it from your chat list.`)) {
        deleteConversation();
    }
}

// ==================== EMOJI PICKER ====================
const EMOJI_SETS = {
    'Smileys': '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤗 🤭 🤔 🤐 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🤢 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡',
    'Gestures': '👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 ✍️ 💪 🦾 👏 🙌 👐 🤲 🫶 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💕 💞 💓 💗 💖 💘 💝',
    'People': '👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 👮 🕵️ 💂 👷 🤴 👸 🤵 👰 🤰 🎅 🦸 🦹 🧙 🧚 🧛 🧜 🧝 👻 👽 🤖 🙋 🙅 🙆 💁 🙇 🤦 🤷 💃 🕺 👯 🧘 🏃 🚶',
    'Nature': '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐒 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🦖 🐙 🦑 🦐 🦀 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦒 🐄 🐎 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🎍 🌺 🌸 🌼 🌻 🌞 🌝 🌚 🌙 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ ❄️ ⛄ 💧 🌊',
    'Food': '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶️ 🥒 🥬 🥦 🧄 🧅 🍄 🥜 🌰 🍞 🥐 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍦 🍰 🎂 🍫 🍬 🍭 🍩 🍪 ☕ 🍵 🧃 🥤 🍺 🍻 🥂 🍷 🥃',
    'Activity': '⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🏓 🏸 🏒 🏑 🥍 🏏 🥅 ⛳ 🏹 🎣 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🏋️ 🤼 🤸 🤺 🤾 🏌️ 🏇 🧗 🚴 🚵 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰',
    'Travel': '🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🚚 🚛 🚜 🛴 🚲 🛵 🏍️ 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🏠 🏡 🏘️ 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🕍 🛕 🕋',
    'Objects': '⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📷 📸 📹 🎥 📞 ☎️ 📟 📠 📺 📻 🧭 ⏰ ⏱️ ⌛ ⏳ 🔋 🔌 💡 🔦 🕯️ 🧯 🛢️ 💸 💵 💴 💶 💷 🪙 💰 💳 💎 ⚖️ 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 💊 💉 🩹 🩺 🌡️ 🧹 🧺 🧻 🚽 🚰 🚿 🛁 🧼 🪒 🧽 🔑 🗝️ 🚪 🪑 🛋️ 🛏️ 🧸 🖼️ 🛍️ 🎁 🎈 🎏 🎀 🎉 🎊 🎎 🏮 📩 📨 📧 💌 📮 📪 📫 📬 📭 📦 📯 📜 📃 📄 📑 📊 📈 📉 🗒️ 🗓️ 📆 📅 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🔗 📎 🖇️ 📐 📏 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓',
    'Symbols': '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 🏧 🚾 ♿ 🅿️ 🈳 🈂️ 🛂 🛃 🛄 🛅 🚹 🚺 🚼 ⚧️ 🚻 🚮 🎦 📶 🈁 🔣 ℹ️ 🔤 🔡 🔠 🆖 🆗 🆙 🆒 🆕 🆓 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟'
};

let emojiReady = false;

function buildEmojiPicker() {
    if (emojiReady) return;
    const tabs = document.getElementById('emojiTabs');
    const grid = document.getElementById('emojiGrid');
    const names = Object.keys(EMOJI_SETS);

    tabs.innerHTML = names.map((n, i) =>
        `<button class="emoji-tab${i === 0 ? ' active' : ''}" onclick="showEmojiGroup('${n}', this)">${EMOJI_SETS[n].split(' ')[0]}</button>`
    ).join('');

    const render = (name) => {
        grid.innerHTML = EMOJI_SETS[name].split(' ').filter(Boolean)
            .map(e => `<button class="emoji-cell" onclick="insertEmoji('${e}')">${e}</button>`).join('');
    };
    window.showEmojiGroup = (name, btn) => {
        document.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
        if (btn) btn.classList.add('active');
        render(name);
    };
    render(names[0]);
    emojiReady = true;
}

function toggleEmoji() {
    buildEmojiPicker();
    const panel = document.getElementById('emojiPanel');
    document.getElementById('attachSheet').classList.remove('open');
    panel.classList.toggle('open');
}

function insertEmoji(emoji) {
    const input = document.getElementById('messageInput');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    input.focus();
    const pos = start + emoji.length;
    input.setSelectionRange(pos, pos);
}

// ==================== ATTACHMENTS ====================
function toggleAttach() {
    document.getElementById('emojiPanel').classList.remove('open');
    document.getElementById('attachSheet').classList.toggle('open');
}

function pickFile(accept) {
    const input = document.getElementById('fileInput');
    input.accept = accept;
    input.value = '';
    input.click();
    document.getElementById('attachSheet').classList.remove('open');
}

function humanSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function kindFromFile(name, mime) {
    if (/^image\//.test(mime) || /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(name)) return 'image';
    if (/^video\//.test(mime) || /\.(mp4|webm|mov|avi|mkv)$/i.test(name)) return 'video';
    if (/^audio\//.test(mime) || /\.(mp3|wav|ogg|oga|m4a|aac|opus|flac)$/i.test(name)) return 'audio';
    return 'file';
}

async function uploadAndSend(file, forcedType) {
    if (!currentContact) { showToast('Open a chat first', 'warning'); return; }

    const type = forcedType || kindFromFile(file.name, file.type);
    showToast('Uploading ' + (file.name || 'voice note') + '...', 'warning');

    const form = new FormData();
    form.append('file', file, file.name || 'voice-note.webm');

    try {
        const res = await apiFetch('/api/upload', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Upload failed', 'error'); return; }

        const caption = type === 'file'
            ? `${data.originalName} (${humanSize(data.size)})`
            : (type === 'audio' ? 'Voice note' : data.originalName);

        const sent = await apiFetch('/api/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                receiverId: currentContact.contact_id,
                message: caption,
                type,
                fileUrl: data.url
            })
        });

        if (sent.ok) {
            const msg = await sent.json();
            const el = createMessageElement(msg);
            const area = document.getElementById('messagesArea');
            area.appendChild(el);
            area.scrollTop = area.scrollHeight;
            updateContactLastMessage(currentContact.contact_id, caption);
        } else {
            showToast('Failed to send attachment', 'error');
        }
    } catch (e) {
        showToast('Upload failed', 'error');
    }
}

// ==================== VOICE NOTES ====================
let mediaRecorder = null, recordedChunks = [], recTimer = null, recSeconds = 0, recCancelled = false;

async function startRecording() {
    if (!currentContact) { showToast('Open a chat first', 'warning'); return; }
    if (mediaRecorder) return;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordedChunks = []; recCancelled = false; recSeconds = 0;
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = e => { if (e.data.size) recordedChunks.push(e.data); };
        mediaRecorder.onstop = () => {
            stream.getTracks().forEach(t => t.stop());
            document.getElementById('recordingBar').classList.remove('active');
            clearInterval(recTimer);
            const blob = new Blob(recordedChunks, { type: 'audio/webm' });
            mediaRecorder = null;
            if (!recCancelled && blob.size > 800) {
                uploadAndSend(new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' }), 'audio');
            }
        };
        mediaRecorder.start();
        document.getElementById('recordingBar').classList.add('active');
        recTimer = setInterval(() => {
            recSeconds++;
            const m = Math.floor(recSeconds / 60), sec = String(recSeconds % 60).padStart(2, '0');
            document.getElementById('recTime').textContent = `${m}:${sec}`;
        }, 1000);
    } catch (e) {
        showToast('Microphone permission denied', 'error');
    }
}

function stopRecording(send) {
    if (!mediaRecorder) return;
    recCancelled = !send;
    mediaRecorder.stop();
}

function cancelRecording() { stopRecording(false); }

// ==================== VOICE / VIDEO CALLS (WebRTC) ====================
const ICE_CONFIG = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
let peer = null, localStream = null, callPeerId = null, pendingOffer = null, currentCallType = 'audio';

function showCallUI(name, avatar, status, video) {
    document.getElementById('callName').textContent = name;
    document.getElementById('callStatus').textContent = status;
    document.getElementById('callAvatar').src = avatar ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=667eea&color=fff`;
    document.getElementById('callOverlay').classList.add('active');
    document.getElementById('callOverlay').classList.toggle('video-mode', !!video);
    document.getElementById('btnCam').style.display = video ? '' : 'none';
}

function closeCallUI() {
    document.getElementById('callOverlay').classList.remove('active');
    document.getElementById('incomingCall').classList.remove('active');
}

async function buildPeer(toUserId) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    pc.onicecandidate = e => {
        if (e.candidate && socket) socket.emit('iceCandidate', { toUserId, candidate: e.candidate });
    };
    pc.ontrack = e => {
        const remote = document.getElementById('remoteVideo');
        if (remote.srcObject !== e.streams[0]) remote.srcObject = e.streams[0];
        document.getElementById('callStatus').textContent = 'Connected';
    };
    pc.onconnectionstatechange = () => {
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) hangUp(true);
    };
    return pc;
}

async function makeCall(type) {
    if (!currentContact) { showToast('Open a chat first', 'warning'); return; }
    if (!navigator.mediaDevices) { showToast('Calls need a secure (https) connection', 'error'); return; }

    currentCallType = type === 'video' ? 'video' : 'audio';
    callPeerId = currentContact.contact_id;
    const name = currentContact.contact_name || currentContact.user_name;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: currentCallType === 'video'
        });
    } catch (e) {
        showToast('Camera/microphone permission denied', 'error');
        return;
    }

    showCallUI(name, currentContact.avatar, 'Ringing...', currentCallType === 'video');
    document.getElementById('localVideo').srcObject = localStream;

    peer = await buildPeer(callPeerId);
    localStream.getTracks().forEach(t => peer.addTrack(t, localStream));

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit('callUser', { toUserId: callPeerId, offer, callType: currentCallType });
}

async function acceptCall() {
    document.getElementById('incomingCall').classList.remove('active');
    if (!pendingOffer) return;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: currentCallType === 'video'
        });
    } catch (e) {
        showToast('Permission denied', 'error');
        socket.emit('rejectCall', { toUserId: callPeerId });
        return;
    }

    const contact = contacts.find(c => c.contact_id === callPeerId);
    const name = contact ? (contact.contact_name || contact.user_name) : 'Caller';
    showCallUI(name, contact && contact.avatar, 'Connecting...', currentCallType === 'video');
    document.getElementById('localVideo').srcObject = localStream;

    peer = await buildPeer(callPeerId);
    localStream.getTracks().forEach(t => peer.addTrack(t, localStream));
    await peer.setRemoteDescription(new RTCSessionDescription(pendingOffer));
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    socket.emit('answerCall', { toUserId: callPeerId, answer });
    pendingOffer = null;
}

function declineCall() {
    document.getElementById('incomingCall').classList.remove('active');
    if (callPeerId && socket) socket.emit('rejectCall', { toUserId: callPeerId });
    pendingOffer = null; callPeerId = null;
}

function hangUp(silent) {
    if (!silent && callPeerId && socket) socket.emit('endCall', { toUserId: callPeerId });
    if (peer) { try { peer.close(); } catch (e) {} peer = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    document.getElementById('remoteVideo').srcObject = null;
    document.getElementById('localVideo').srcObject = null;
    closeCallUI();
    callPeerId = null; pendingOffer = null;
}

function toggleMute() {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    document.getElementById('btnMute').classList.toggle('off', !track.enabled);
}

function toggleCam() {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    document.getElementById('btnCam').classList.toggle('off', !track.enabled);
}


// ==================== ERROR HANDLING ====================
window.addEventListener('error', (e) => {
    // Ignore failed images/assets (e.g. offline avatar CDN) -- those must not
    // pop a scary full-page error toast.
    if (e.target && e.target !== window) return;
    console.error('Global error:', e.error || e.message);
});

window.addEventListener('unhandledrejection', (e) => {
    // Only claim a network problem when the browser is actually offline --
    // otherwise this masks real application errors behind a wrong message.
    console.error('Unhandled promise rejection:', e.reason || e);
    if (!navigator.onLine) {
        showToast('You appear to be offline. Check your connection.', 'error');
    }
});

// ==================== PAGE VISIBILITY ====================
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Page is hidden
        if (socket && currentUser) {
            socket.emit('away', currentUser.id);
        }
    } else {
        // Page is visible
        if (socket && currentUser) {
            socket.emit('online', currentUser.id);
        }
    }
});

// ==================== CLEANUP ====================
window.addEventListener('beforeunload', () => {
    if (socket) {
        socket.disconnect();
    }
});
