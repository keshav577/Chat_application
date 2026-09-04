# ChatApp — Real-Time Chat (WhatsApp-style)

A real-time one-to-one chat web app built with **Node.js + Express + Socket.IO** and a
**local SQLite database file** (`chat.db`). No external/third-party APIs and no cloud
services — everything runs on your machine.

## Features

- Phone + password sign up / sign in (bcrypt hashed, JWT sessions)
- Contacts by phone number, with block/unblock
- **Real-time messaging** over WebSockets (Socket.IO)
- Typing indicators, online/offline presence, last seen
- Read receipts and unread counts
- Edit / delete messages, delete conversations
- **Emoji picker** with 9 categories (600+ emoji)
- **Attachments**: photos, video and documents, with inline previews
- **Voice notes** — hold the mic button to record, release to send
- **Voice & video calls** over WebRTC (peer-to-peer; the server only relays signalling)
- File & avatar uploads up to 25MB (stored locally in `uploads/`)
- Local SQLite persistence — messages survive restarts

## Quick start

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

To try it out, open the site in **two different browsers** (or one normal + one
incognito window), register two accounts, add each other by phone number, and chat.

### Demo accounts

| Name  | Phone      | Password |
|-------|------------|----------|
| Alice | 9990000001 | pass1234 |
| Bob   | 9990000002 | pass1234 |

These exist only in your local `chat.db`. Delete the file to start clean — the schema
is recreated automatically on the next launch.

## Project structure

```
server.js         Express routes + Socket.IO real-time event handlers
database.js       SQLite connection and schema creation
sqlite-compat.js  Fallback driver (see note below)
chat.db           Local SQLite database file (auto-created, git-ignored)
public/
  index.html      UI markup
  css/styles.css  Styles
  js/app.js       Client logic + Socket.IO client
uploads/          Uploaded files and avatars (git-ignored)
```

## Notes on calls, mic and camera

Browsers only expose the microphone and camera on a **secure origin**. That means
`http://localhost` (fine) or an `https://` URL. Over plain `http://` to a LAN IP the
browser blocks `getUserMedia`, so voice notes and calls will report a permission
error — use localhost or put the app behind HTTPS.

Calls are peer-to-peer via WebRTC using public STUN servers. Two devices behind
strict/symmetric NATs may fail to connect without a TURN server, which is not
included here.

## Configuration

Settings live in `.env`:

```
PORT=3000
JWT_SECRET=...
SESSION_SECRET=...
NODE_ENV=development
```

Change both secrets before deploying anywhere public. In `development` the auth rate
limit is relaxed (100 attempts / 15 min) so testing isn't blocked; in `production` it
tightens to 5.

## About the SQLite driver

The app uses the native `sqlite3` package. Building it requires a C++ toolchain, which
isn't available in every environment. If `sqlite3` fails to load, `database.js`
transparently falls back to Node's built-in `node:sqlite` engine (Node 22+) via
`sqlite-compat.js`. Both drivers read and write the exact same `chat.db` file, so
behaviour is identical either way — you don't need to do anything.

## Data model

`users`, `contacts`, `conversations`, `messages`, `message_status` — all created
automatically on first run, with indexes on the hot lookup columns.
