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
function checkAuthentication() {
    const token = localStorage.getItem('token');
    const userData = localStorage.getItem('userData');
    
    if (token && userData) {
        currentUser = JSON.parse(userData);
        showChatInterface();
        initializeChat();
    } else {
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
    
    // File attachment
    document.getElementById('fileInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) uploadFile(file);
        e.target.value = '';
    });
    
    // Emoji picker
    buildEmojiPicker();
    
    // Close emoji picker when clicking outside
    document.addEventListener('click', (e) => {
        const picker = document.getElementById('emojiPicker');
        if (picker && !e.target.closest('#emojiPicker') && !e.target.closest('[onclick="openEmoji()"]')) {
            picker.style.display = 'none';
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

function showChatInterface() {
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('chatInterface').style.display = 'flex';
}

function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelectorAll('.auth-form').forEach(form => {
        form.classList.remove('active');
    });
    
    event.target.classList.add('active');
    document.getElementById(tab + 'Form').classList.add('active');
}

// ==================== CHAT INITIALIZATION ====================
async function initializeChat() {
    updateUserProfile();
    await loadContacts();
    connectSocket();
    initializeSocketEvents();
    if (window.matchMedia('(max-width: 768px)').matches) {
        document.getElementById('sidebar').classList.add('open');
    }
}

function isMobileView() {
    return window.matchMedia('(max-width: 768px)').matches;
}

function updateUserProfile() {
    document.getElementById('userName').textContent = currentUser.name;
    document.getElementById('userStatus').textContent = 'Online';
    
    const avatarUrl = currentUser.avatar || createAvatarDataUri(currentUser.name, '#FF6B6B');
    document.getElementById('profileImg').src = avatarUrl;
}

// ==================== SOCKET CONNECTION ====================
function connectSocket() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('Connected to server');
        socket.emit('authenticate', currentUser.id);
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
    });
}

// ==================== LOCAL AVATARS (no external API) ====================
function createAvatarDataUri(name, background) {
    const initials = (name || '?')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map(part => part.charAt(0).toUpperCase())
        .join('') || '?';

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${background}"/><text x="48" y="48" dy="0.35em" font-family="Arial, sans-serif" font-size="34" font-weight="bold" fill="#fff" text-anchor="middle">${initials}</text></svg>`;

    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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
        const response = await fetch('/api/contacts', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });
        
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
        createAvatarDataUri(contact.contact_name || contact.user_name, '#667eea');
    
    const lastMessageTime = contact.last_message_time ? 
        formatMessageTime(contact.last_message_time) : '';
    
    div.innerHTML = `
        <div style="position: relative;">
            <img src="${avatarUrl}" alt="${escapeHtml(contact.contact_name || contact.user_name)}" class="contact-avatar">
            ${contact.is_online ? '<span class="online-indicator"></span>' : ''}
        </div>
        <div class="contact-info">
            <div class="contact-name">${escapeHtml(contact.contact_name || contact.user_name)}</div>
            <div class="last-message">${escapeHtml(contact.last_message || 'No messages yet')}</div>
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

// ==================== ADD CONTACT ====================
function openAddContact() {
    document.getElementById('addContactModal').classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

async function addContact() {
    const phone = document.getElementById('contactPhone').value;
    const name = document.getElementById('contactName').value;
    
    if (!validatePhoneNumber(phone)) {
        showToast('Please enter a valid phone number', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/contacts/add', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({ phone, name })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast('Contact added successfully!', 'success');
            closeModal('addContactModal');
            loadContacts();
            
            // Clear form
            document.getElementById('contactPhone').value = '';
            document.getElementById('contactName').value = '';
        } else {
            showToast(data.error || 'Failed to add contact', 'error');
        }
    } catch (error) {
        showToast('Connection error', 'error');
    }
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
        createAvatarDataUri(contactName, '#667eea');
    document.getElementById('contactImg').src = avatarUrl;
    
    const statusText = contact.is_online ? 'Online' : 
        `Last seen ${formatLastSeen(contact.last_seen)}`;
    document.getElementById('contactStatus').textContent = statusText;
    
    // Load messages
    await loadMessages();
    
    // Mark contact as active
    document.querySelectorAll('.contact-item').forEach(item => {
        item.classList.remove('active');
    });
    document.querySelectorAll('.contact-item').forEach(item => {
        if (item.dataset.contactId === String(contact.contact_id)) {
            item.classList.add('active');
        }
    });
    
    // Slide the contact list away on mobile so the chat fills the screen.
    if (isMobileView()) {
        document.getElementById('sidebar').classList.remove('open');
    }
    
    // Focus on message input
    document.getElementById('messageInput').focus();
}

function goBackToContacts() {
    document.getElementById('chatView').style.display = 'none';
    document.getElementById('welcomeScreen').style.display = 'flex';
    currentConversation = null;
    currentContact = null;
    if (isMobileView()) {
        document.getElementById('sidebar').classList.add('open');
    }
}

async function loadMessages() {
    if (!currentConversation) return;
    
    try {
        const response = await fetch(`/api/messages/${currentConversation}`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });
        
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
    
    let contentHtml = `<div class="message-text">${escapeHtml(message.message || '')}</div>`;
    
    if (message.type === 'file' && message.file_url) {
        const fileName = message.message || 'File';
        const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(fileName);
        const isVideo = /\.(mp4|webm|ogg)$/i.test(fileName);
        const isAudio = /\.(mp3|wav|m4a|ogg)$/i.test(fileName);
        
        if (isImage) {
            contentHtml = `<a href="${message.file_url}" target="_blank"><img src="${message.file_url}" alt="${escapeHtml(fileName)}" class="message-attachment"></a>`;
        } else if (isVideo) {
            contentHtml = `<video class="message-attachment" controls src="${message.file_url}"></video>`;
        } else if (isAudio) {
            contentHtml = `<audio class="message-attachment" controls src="${message.file_url}"></audio>`;
        } else {
            contentHtml = `<a class="message-file" href="${message.file_url}" target="_blank" download>
                📄 <span>${escapeHtml(fileName)}</span>
            </a>`;
        }
    }
    
    div.innerHTML = `
        <div class="message-bubble">
            ${contentHtml}
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
        const response = await fetch('/api/messages/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({
                receiverId: currentContact.contact_id,
                message: message,
                type: 'text'
            })
        });
        
        if (response.ok) {
            const newMessage = await response.json();
            appendMessageToUi(newMessage);
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

function appendMessageToUi(message) {
    const messageElement = createMessageElement(message);
    document.getElementById('messagesArea').appendChild(messageElement);
    const messagesArea = document.getElementById('messagesArea');
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

// ==================== FILE + EMOJI ====================
async function uploadFile(file) {
    if (!currentContact) {
        showToast('Select a contact first', 'warning');
        return;
    }

    try {
        const formData = new FormData();
        formData.append('file', file);
        
        const uploadRes = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
            body: formData
        });
        
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');
        
        const sendRes = await fetch('/api/messages/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({
                receiverId: currentContact.contact_id,
                message: file.name,
                type: 'file',
                fileUrl: uploadData.url
            })
        });
        
        const newMessage = await sendRes.json();
        if (!sendRes.ok) throw new Error(newMessage.error || 'Send failed');
        
        appendMessageToUi(newMessage);
        updateContactLastMessage(currentContact.contact_id, file.name);
        showToast('File sent', 'success');
    } catch (error) {
        console.error('Upload error:', error);
        showToast(error.message || 'Failed to send file', 'error');
    }
}

function buildEmojiPicker() {
    const emojis = ['😀','😁','😂','🤣','😊','😍','😘','😎','🤔','😴','😢','😭','😡','👍','👎','👏','🙏','💪','🔥','❤️','😉','🤗','🤩','🥳','😇','🙃','😅','😬','🤫','🤭','😔'];
    const picker = document.getElementById('emojiPicker');
    picker.innerHTML = '';
    
    emojis.forEach((emoji) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'emoji-btn';
        btn.textContent = emoji;
        btn.onclick = () => {
            const input = document.getElementById('messageInput');
            input.value += emoji;
            input.focus();
            picker.style.display = 'none';
        };
        picker.appendChild(btn);
    });
}

function openEmoji() {
    const picker = document.getElementById('emojiPicker');
    picker.style.display = picker.style.display === 'none' ? 'flex' : 'none';
}

function openAttachment() {
    document.getElementById('fileInput').click();
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
            const response = await fetch(`/api/messages/${selectedMessageId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
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
            const response = await fetch(`/api/messages/${selectedMessageId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                }
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

async function forwardMessage() {
    const messageElement = document.querySelector(`[data-message-id="${selectedMessageId}"]`);
    const messageText = messageElement ? messageElement.querySelector('.message-text')?.textContent : '';

    if (!contacts.length) {
        showToast('No contacts to forward to', 'warning');
        document.getElementById('messageMenu').style.display = 'none';
        return;
    }

    const list = contacts.map((c, i) => `${i + 1}. ${c.contact_name || c.user_name} (${c.phone})`).join('\n');
    const answer = prompt(`Forward to:\n\n${list}\n\nEnter a number or full phone:`);

    if (!answer || !answer.trim()) {
        document.getElementById('messageMenu').style.display = 'none';
        return;
    }

    const contact = contacts.find((c) => c.phone === answer.trim() || String(c.contact_id) === answer.trim());
    if (!contact) {
        showToast('Contact not found', 'error');
        document.getElementById('messageMenu').style.display = 'none';
        return;
    }

    try {
        const response = await fetch('/api/messages/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({
                receiverId: contact.contact_id,
                message: messageText,
                type: 'text'
            })
        });

        if (response.ok) {
            showToast('Message forwarded', 'success');
            await loadContacts();
        } else {
            showToast('Failed to forward message', 'error');
        }
    } catch (error) {
        showToast('Connection error', 'error');
    }

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
    // Basic phone validation - adjust regex based on your requirements
    const phoneRegex = /^[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}$/;
    return phoneRegex.test(phone);
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
        try {
            const notification = new Notification('New Message', {
                body: `${message.sender_name}: ${message.message || 'Sent you a file'}`,
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
        } catch (error) {
            console.error('Notification error:', error);
        }
    }
}

// ==================== ADDITIONAL FEATURES ====================
async function openSettings() {
    const name = prompt('Your display name:', currentUser.name || '');
    if (name === null) return;

    const bio = prompt('Your status / bio:', currentUser.bio || 'Hey there! I am using ChatApp');
    if (bio === null) return;

    try {
        const response = await fetch('/api/user/profile', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({ name, bio })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to update profile');

        currentUser.name = data.user.name;
        currentUser.bio = data.user.bio;
        currentUser.avatar = data.user.avatar;
        localStorage.setItem('userData', JSON.stringify(currentUser));

        updateUserProfile();
        await loadContacts();
        showToast('Profile updated', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to update profile', 'error');
    }
}

function makeCall(type) {
    showToast(`${type === 'audio' ? 'Voice' : 'Video'} calling feature coming soon`, 'warning');
}

function openChatMenu() {
    if (confirm('Clear this chat for yourself? This cannot be undone.')) {
        clearCurrentChat();
    }
}

async function clearCurrentChat() {
    if (!currentConversation) return;
    try {
        const response = await fetch(`/api/conversations/${currentConversation}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (response.ok) {
            document.getElementById('messagesArea').innerHTML = '';
            showToast('Chat cleared', 'success');
            await loadContacts();
        } else {
            showToast('Failed to clear chat', 'error');
        }
    } catch (error) {
        showToast('Connection error', 'error');
    }
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
