# SYX

An authenticated social app for Sierra Leone with a persistent community feed, member messaging, and playable short-video posts.

## Local setup

Requires Node.js 20.19+ and npm. Install dependencies, then start the Express server:

```sh
npm install
npm run dev
```

The Express app serves the authenticated, API-connected site at `http://localhost:3000`. To use the Vite development server, run `npx vite --host 127.0.0.1` in a second terminal; it serves `http://localhost:5173` and proxies `/api` requests to Express. The full-width responsive layout is shared by both entry points.

SQLite data is stored in `syx.db`, and login sessions in `syx-sessions.sqlite`, under `DATA_DIR` (defaults to this folder). The server creates or migrates the user, post, message, Reel, status, channel, and community tables on startup. For Render, the blueprint mounts a persistent disk at `/var/data`, sets `DATA_DIR` there, and generates a production `SESSION_SECRET`; the cookie is HTTPS-only in production. Keep the SQLite install script enabled during dependency installation so its native module can be built.

The active app is the Express-served `index.html` and `app.js`; `src/App.tsx` is a separate UI prototype and is not served by the backend. Direct messages are saved to SQLite and refreshed while a conversation is open. They are not real-time push messages.

## Features

- Sign up with an email address or phone number, confirm the password, and log in using email, phone, or username.
- Edit your profile, manage profile-photo visibility, and create expiring status updates.
- Publish feed updates, search posts, and persist posts in SQLite.
- Find registered members, send private messages, and refresh an open conversation for new messages.
- Publish Reels using a direct MP4, WebM, or Ogg video URL; play them with the browser's native video controls and persist likes.
- Create channels and communities, follow or join them, and publish updates or messages.
- Create voice/video call links and share an invite message directly with WhatsApp.
- No demo conversations or sample Reels are inserted into the app.

## Checks

```sh
npm test
npm run build
node --check server.js
node --check app.js
```

`npm test` starts an isolated server with a temporary SQLite database, creates two test accounts, and verifies that a private message is stored and visible to its recipient. It does not use or modify the local app database.
