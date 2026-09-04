# ChatConnect — Real-Time Chat Application (WhatsApp-style)

A full-stack, real-time messaging site built with **Node.js**, **Express**, **Socket.IO**, and a **local SQLite database**. No external chat APIs are required — every message, contact, and user is stored locally in `chat.db`.

Repo: https://github.com/keshav577/Chat_application

---

## ✨ Features

- 🔐 Register / login with a phone number + password (passwords are bcrypt-hashed)
- 💬 Real-time 1-to-1 chat using Socket.IO
- 👥 Add contacts by phone number
- ✅ Read receipts (✓ → ✓✓)
- ✏️ Edit and delete your own messages
- 🔍 Search contacts
- ⌨️ Typing indicators
- 😊 Built-in emoji picker
- 📎 File/image/audio/video attachment upload (saved in `uploads/` locally)
- 🟢 Online / offline status and last-seen
- 🗑️ Clear a chat
- 📱 Responsive mobile-friendly UI
- 🈚 Zero external APIs — avatars and fonts are generated locally

## 🧱 Tech Stack

| Layer    | Technology |
|----------|------------|
| Backend  | Node.js, Express |
| Real-time| Socket.IO |
| Database | SQLite (built-in `node:sqlite`) |
| Frontend | HTML, CSS, Vanilla JavaScript |
| Auth     | JWT + bcryptjs sessions |

## 📦 Requirements

- **Node.js 22+** (uses the built-in `node:sqlite` module, so no native database library is compiled)

## 🚀 Getting Started

```bash
# 1) Install dependencies
npm install

# 2) Configure environment (optional – defaults work out of the box)
cp .env.example .env

# 3) Create the local database (automatically created on server start too)
npm run init-db

# 4) Start the server
npm start
```

The app will be available at:

```
http://localhost:3000
```

## 🧪 Testing real-time chat

1. Open `http://localhost:3000` in **two different browser windows** (or one window + incognito).
2. Register two accounts with different phone numbers (e.g. `+15550000001` and `+15550000002`).
3. Add each other as a contact by phone number.
4. Start chatting — messages, typing indicators, and read receipts update in real time.

## 📂 Project Structure

```
Chat_application/
├── database.js          # SQLite schema + connection
├── server.js            # Express + Socket.IO server (API + real-time)
├── package.json
├── public/
│   ├── index.html       # Frontend UI
│   ├── css/styles.css   # Styling
│   └── js/app.js        # Frontend logic + Socket.IO client
├── uploads/             # Uploaded files (created at runtime)
└── chat.db              # Local SQLite database (created at runtime)
```

## 🔒 Security Notes

- The token/session secret lives in `.env` (not committed).
- Passwords are hashed with bcrypt.
- This app is designed for local development / small-scale self-hosted use. For production, add HTTPS, a real session store/DB pooling, CSRF protections, and strict CORS/origin checks for Socket.IO.

## 🛠️ Helpful Scripts

```bash
npm start       # run the server
npm run dev     # run with nodemon auto-reload
npm run init-db # initialize the SQLite database
```
