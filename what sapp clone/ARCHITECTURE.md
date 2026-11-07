# SYX Architecture

## Active application

- **Browser UI:** `login.html`, `signup.html`, `index.html`, and `app.js`. Express serves these same-origin pages; the frontend calls `/api/...` using the browser's session cookie.
- **HTTP API:** `server.js` provides account authentication, profiles, feed posts, direct messages, Reels, expiring Updates, Channels, and Communities.
- **Database:** SQLite stores accounts, posts, messages, Reels, statuses, Channels, and Communities. `DATA_DIR` selects its location. `connect-sqlite3` stores login sessions in the same directory.
- **Direct messages:** Message content is persisted before a successful response. The recipient can load their conversation history; an open conversation refreshes on a five-second interval.
- **Calls:** SYX creates Jitsi Meet invite links. The call-link share action uses the browser's native share sheet, while the WhatsApp action opens a prefilled `wa.me` message. Call rooms are hosted outside SYX and anyone with a room link may join.

The React files under `src/` are a separate UI prototype. Vite's build currently validates and builds that prototype, but Express serves the `index.html`/`app.js` interface instead.

## Local checks

Run `npm test` to exercise signup, login-session cookies, and stored direct messages against a temporary SQLite database. Run `npm run build` to type-check and build the React prototype.

## Deployment

`render.yaml` describes the `syx-social` Render service and its persistent disk. A configured blueprint is not itself a deployment: the public service URL is available only after Render provisions and deploys the service.
