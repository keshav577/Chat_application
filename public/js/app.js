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

// Check if user is authenticated
function getToken() {
    const t = localStorage.getItem('token');
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
    localStorage.removeItem('token');
    localStorage.removeItem('userData');
    currentUser = null;
    currentConversation = null;
    currentContact = null;
    if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
    showAuthScreen();
    if (message) showToast(message, 'error');
}

function checkAuthentication() {
    const token = getToken();
    const userData = localStorage.getItem('userData');
    
    // Both must be present, otherwise the session is broken -> clear it.
    if (token && userData) {
        try {
            currentUser = JSON.parse(userData);
        } catch (e) {
            forceLogout();
            return;
        }
        showChatInterface();
        initializeChat();
    } else {
        forceLogout();
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
            localStorage.setItem('token', data.token);
            localStorage.setItem('userData', JSON.stringify(data.user));
            currentUser = data.user;
            showChatInterface();
            initializeChat();
            showToast('Welcome back!', 'success');
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
            localStorage.setItem('token', data.token);
            localStorage.setItem('userData', JSON.stringify(data.user));
            currentUser = data.user;
            showChatInterface();
            initializeChat();
            showToast('Account created successfully!', 'success');
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
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });
        
        localStorage.removeItem('token');
        localStorage.removeItem('userData');
        
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
    updateUserProfile();
    await loadContacts();
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
}

// ==================== CONTACTS MANAGEMENT ====================
async function loadContacts() {
    try {
        const response = await apiFetch('/api/contacts');
        
        if (response.ok) {
            contacts = await response.json();
            displayContacts();
        }
    } catch (error) {
        console.error('Failed to load contacts:', error);
        showToast('Failed to load contacts', 'error');
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

    box.innerHTML = users.map(u => {
        const avatar = u.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.name)}&background=667eea&color=fff`;
        const action = u.is_contact
            ? `<button class="btn-added" onclick="messageExisting(${u.id})">Message</button>`
            : `<button class="btn-add" onclick="addPerson(${u.id}, this)">Add</button>`;
        return `
            <div class="person-row">
                <div class="person-avatar-wrap">
                    <img class="person-avatar" src="${avatar}" alt="${escapeHtml(u.name)}">
                    ${u.is_online ? '<span class="online-indicator"></span>' : ''}
                </div>
                <div class="person-info">
                    <div class="person-name">${escapeHtml(u.name)}</div>
                    <div class="person-phone">${escapeHtml(u.phone)}</div>
                </div>
                ${action}
            </div>`;
    }).join('');
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

function createMessageElement(message) {
    const div = document.createElement('div');
    const isSent = message.sender_id === currentUser.id;
    div.className = `message ${isSent ? 'sent' : 'received'}`;
    div.dataset.messageId = message.id;
    
    const time = formatMessageTime(message.created_at);
    const editedText = message.is_edited ? ' (edited)' : '';
    
    div.innerHTML = `
        <div class="message-bubble">
            <div class="message-text">${escapeHtml(message.message)}</div>
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

function makeCall(type) {
    showToast(`${type === 'audio' ? 'Voice' : 'Video'} calling feature coming soon`, 'warning');
}

function openChatMenu() {
    showToast('Chat menu coming soon', 'warning');
}

function openAttachment() {
    showToast('File attachment feature coming soon', 'warning');
}

function openEmoji() {
    showToast('Emoji picker coming soon', 'warning');
}

// ==================== ERROR HANDLING ====================
window.addEventListener('error', (e) => {
    console.error('Global error:', e);
    showToast('Something went wrong. Please refresh the page.', 'error');
});

window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e);
    showToast('Connection error. Please check your internet.', 'error');
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
