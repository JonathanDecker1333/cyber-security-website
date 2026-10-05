# SYX

An authenticated social app for Sierra Leone with a persistent community feed, member messaging, and playable short-video posts.

## Local setup

Requires Node.js 20.19+ and npm. Install dependencies, then start the Express server:

```sh
npm install
npm run dev
```

The Express app serves the authenticated site and API at `http://localhost:3000`. To use the Vite development URL, run `npx vite --host 127.0.0.1` in a second terminal; it serves `http://localhost:5173` and proxies `/api` to Express.

SQLite data is stored in `syx.db`. The server creates or migrates the user, post, message, Reel, and Reel-like tables on startup. If npm blocks the `sqlite3` install script, its native addon must be built before starting the server.

## Features

- Sign up with an email address or phone number, confirm the password, and log in using email, phone, or username.
- Publish feed updates, search posts, and keep posts in SQLite.
- Find registered members, send private messages, and refresh an open conversation for new messages.
- Publish Reels using a direct MP4, WebM, or Ogg video URL; play them with the browser's native video controls and persist likes.
- No demo conversations or sample Reels are inserted into the app.

## Checks

```sh
npm run build
node --check server.js
node --check app.js
```
