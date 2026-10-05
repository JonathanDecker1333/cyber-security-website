# SYX Architecture (Proposal)

## System shape

- **Web client:** React + TypeScript + Tailwind. Mobile-first, installable PWA, with feed, messaging, profiles, and vertical Reels experiences.
- **HTTP API:** Node.js + Express for authentication, profiles, social graph, posts, comments, media signing, and paginated reads.
- **Realtime:** Socket.IO for chat events, delivery/read receipts, typing, presence, and notifications. Persist events to PostgreSQL before broadcasting; sockets are a delivery layer, not the source of truth.
- **Database:** PostgreSQL with migrations and UUID primary keys. Store timestamps in UTC and display in `Africa/Freetown`.
- **Media:** Cloudinary signed direct uploads; persist ownership, dimensions, duration, type, and provider ID in `media_assets`. Generate small responsive variants and defer video loading.
- **Operations:** HTTPS, secure same-site session cookies, rate limits, validation, structured logs, automated database backups, and environment-based secrets.

## Proposed relational schema

- `users(id, handle, display_name, phone_e164, email, password_hash, avatar_media_id, bio, created_at, updated_at)`; unique normalized handle and optional phone/email.
- `sessions(id, user_id, token_hash, expires_at, created_at)`; store hashes, never raw session tokens.
- `follows(follower_id, followed_id, created_at)`; composite primary key and no self-follow.
- `friend_requests(id, requester_id, recipient_id, status, created_at, responded_at)`; unique pending pair.
- `posts(id, author_id, body, visibility, created_at, updated_at, deleted_at)`.
- `media_assets(id, owner_id, provider, provider_key, resource_type, mime_type, bytes, width, height, duration_ms, created_at)`.
- `post_media(post_id, media_id, position)`; ordered attachments.
- `post_likes(post_id, user_id, created_at)`; composite primary key.
- `comments(id, post_id, author_id, parent_id, body, created_at, updated_at, deleted_at)`; `parent_id` supports replies.
- `conversations(id, kind, title, created_by, created_at, updated_at)`; `kind` is `direct` or `group`.
- `conversation_members(conversation_id, user_id, role, joined_at, last_read_message_id, muted_until)`; composite key and role for group administration.
- `messages(id, conversation_id, sender_id, kind, body, media_id, reply_to_id, created_at, edited_at, deleted_at)`; kinds include text, image, video, and audio.
- `message_receipts(message_id, user_id, delivered_at, read_at)`; per-recipient receipts.
- `notifications(id, recipient_id, actor_id, kind, entity_id, read_at, created_at)`.

Important indexes: `posts(created_at DESC, id DESC)`, `posts(author_id, created_at DESC)`, `messages(conversation_id, created_at DESC, id DESC)`, `conversation_members(user_id, conversation_id)`, and `notifications(recipient_id, read_at, created_at DESC)`. Use keyset cursors rather than large offsets for feed and chat history.

## Delivery sequence

1. Frontend shell and component interactions with mock data (current step).
2. Express app, migrations, validation, auth/session, and REST endpoints.
3. Socket.IO authentication and persisted chat/presence/receipt events.
4. Signed media uploads, moderation/report flows, notifications, tests, and deployment.

The current UI is a prototype. Feed and Reels use mock data; chat messages persist in browser local storage but are not delivered to another user. Authentication, server-backed messaging, and media uploads are not active yet.
