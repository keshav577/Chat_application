# ChatConnect

A real-time, WhatsApp-style chat app built with **Node.js + Express + Socket.IO** and a
**local SQLite database**. No third-party or cloud services — everything runs on your
machine against a single `chat.db` file.

## Features

**Messaging**
- Real-time 1-to-1 messaging over WebSockets
- Typing indicators, online/offline presence and last seen
- Delivered (✓✓) and read (blue ✓✓) receipts, plus unread badges
- Edit and delete your own messages; clear a whole conversation
- Day separators (Today / Yesterday / date) between messages

**Rich content**
- Emoji picker with 9 categories
- Photo, video and document attachments with inline previews
- Voice notes — hold the mic button to record, release to send
- Files up to 25MB, stored locally in `uploads/`

**Calls**
- Voice and video calls over **WebRTC** (peer-to-peer; the server only relays signalling)
- Incoming-call banner with accept/decline, mute and camera toggle

**Accounts**
- Phone + password sign-up and sign-in (bcrypt hashed, JWT sessions)
- Search registered users by name or number, with match highlighting
- Editable profile (name + about)

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000>.

To see real-time messaging, open the app in **two different browsers** (or one normal
and one incognito window), sign in as two different people, add each other from the
new-chat button, and start typing.

### Demo accounts

All use the password `pass1234`:

| Name   | Phone      |
|--------|------------|
| Alice  | 9990000001 |
| Bob    | 9990000002 |
| Keshav | 6265728921 |
| Priya  | 9812345670 |
| Rahul  | 9812345671 |

These live only in your local `chat.db`. Delete that file to start fresh — the schema
is recreated automatically on the next launch.

## Project layout

```
server.js        Express routes + Socket.IO events (messaging, presence, WebRTC relay)
db.js            SQLite connection, schema and promise-based query helpers
chat.db          Local database file (auto-created, git-ignored)
public/
  index.html     Markup
  css/styles.css Dark WhatsApp-inspired theme, responsive down to small phones
  js/app.js      Client: session, socket, chat UI, emoji, uploads, calls
uploads/         Uploaded files and voice notes (git-ignored)
```

## Microphone, camera and calls

Browsers only expose the mic and camera on a **secure origin** — `http://localhost` or
an `https://` URL. Over plain `http://` to a LAN IP the browser blocks them, so voice
notes and calls will report a permission error. Use localhost or serve over HTTPS.

Calls connect peer-to-peer using public STUN servers. Two devices behind strict
(symmetric) NATs may fail to connect without a TURN server, which is not included.

## Notes

- **Sessions** are stored in memory, `localStorage`, `sessionStorage` *and* a cookie.
  That redundancy matters when the app runs inside an iframe, where browsers often
  block or partition web storage and a login would otherwise be lost on reload.
- **Asset cache-busting**: `index.html` is served with a version stamp derived from the
  CSS/JS file times, so browsers can never run a stale bundle after an edit.
- **SQLite driver**: uses the native `sqlite3` package when it builds, otherwise falls
  back to Node's built-in `node:sqlite` (Node 22+). Both use the same `chat.db`.

## Configuration

`.env`:

```
PORT=3000
JWT_SECRET=change-this
NODE_ENV=development
```

Change `JWT_SECRET` before exposing the app to anyone else — it signs all login tokens.
