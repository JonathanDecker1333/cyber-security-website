import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import sqlite3 from 'sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'syx-local-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

const db = new sqlite3.Database(path.join(__dirname, 'syx.db'));

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      CHECK (email IS NOT NULL OR phone IS NOT NULL)
    )
  `);

  const userColumns = await all('PRAGMA table_info(users)');
  const emailIsRequired = userColumns.some((column) => column.name === 'email' && column.notnull);
  const hasPhone = userColumns.some((column) => column.name === 'phone');

  if (emailIsRequired) {
    await run('PRAGMA foreign_keys = OFF');
    await run('BEGIN TRANSACTION');
    try {
      await run(`
        CREATE TABLE users_rebuilt (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          full_name TEXT NOT NULL,
          username TEXT NOT NULL UNIQUE,
          email TEXT UNIQUE,
          phone TEXT,
          password_hash TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          CHECK (email IS NOT NULL OR phone IS NOT NULL)
        )
      `);
      await run(`
        INSERT INTO users_rebuilt (id, full_name, username, email, phone, password_hash, created_at)
        SELECT id, full_name, username, email, ${hasPhone ? 'phone' : 'NULL'}, password_hash, created_at
        FROM users
      `);
      await run('DROP TABLE users');
      await run('ALTER TABLE users_rebuilt RENAME TO users');
      await run('COMMIT');
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    } finally {
      await run('PRAGMA foreign_keys = ON');
    }
  } else if (!hasPhone) {
    await run('ALTER TABLE users ADD COLUMN phone TEXT');
  }

  await run('CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(phone)');

  for (const [column, definition] of [
    ['about', "TEXT NOT NULL DEFAULT ''"],
    ['profile_photo', 'TEXT'],
    ['profile_photo_privacy', "TEXT NOT NULL DEFAULT 'all'"],
    ['profile_photo_privacy_user_ids', "TEXT NOT NULL DEFAULT '[]'"],
    ['phone_verified', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!userColumns.some((entry) => entry.name === column)) {
      await run(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
    }
  }

  await run(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      recipient_id INTEGER NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME,
      CHECK (sender_id <> recipient_id)
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages(sender_id, recipient_id, id)');
  await run('CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages(recipient_id, sender_id, id)');

  await run(`
    CREATE TABLE IF NOT EXISTS reels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      video_url TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS reel_likes (
      reel_id INTEGER NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (reel_id, user_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      media_type TEXT,
      media_data TEXT,
      privacy_mode TEXT NOT NULL DEFAULT 'all' CHECK (privacy_mode IN ('all', 'except', 'only')),
      privacy_user_ids TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      CHECK (length(trim(content)) > 0 OR media_data IS NOT NULL)
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS statuses_expiry_idx ON statuses(expires_at)');

  await run(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS channel_followers (
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (channel_id, user_id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS channel_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS channel_posts_feed_idx ON channel_posts(channel_id, id)');

  await run(`
    CREATE TABLE IF NOT EXISTS communities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS community_members (
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (community_id, user_id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS community_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS community_messages_feed_idx ON community_messages(community_id, id)');
  await run(`
    CREATE TABLE IF NOT EXISTS linked_devices (
      device_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS linked_devices_user_idx ON linked_devices(user_id, last_seen_at)');
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login.html');
  }
  next();
}

function sanitizeUser(user) {
  return {
    id: user.id,
    fullName: user.full_name,
    username: user.username,
    email: user.email,
    phone: user.phone,
    about: user.about || '',
    phoneVerified: Boolean(user.phone_verified),
  };
}

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const user = await get('SELECT id, full_name, username, email, phone, about, phone_verified FROM users WHERE id = ?', [req.session.userId]);
    if (!user) {
      req.session.destroy(() => undefined);
      return res.status(401).json({ message: 'User not found' });
    }
    res.json(sanitizeUser(user));
  } catch (error) {
    res.status(500).json({ message: 'Could not fetch user' });
  }
});

function canViewProfilePhoto(profile, viewerId) {
  if (profile.id === viewerId || profile.profilePhotoPrivacy === 'all') return true;
  let allowedUsers = [];
  try { allowedUsers = JSON.parse(profile.profilePhotoPrivacyUserIds); } catch { return false; }
  return profile.profilePhotoPrivacy === 'only'
    ? allowedUsers.includes(viewerId)
    : !allowedUsers.includes(viewerId);
}

app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const user = await get(
      `SELECT id, full_name, username, email, phone, about, phone_verified,
              profile_photo AS profilePhoto,
              profile_photo_privacy AS profilePhotoPrivacy,
              profile_photo_privacy_user_ids AS profilePhotoPrivacyUserIds
       FROM users WHERE id = ?`,
      [req.session.userId]
    );
    if (!user) return res.status(404).json({ message: 'Profile not found.' });
    const response = sanitizeUser(user);
    response.hasProfilePhoto = Boolean(user.profilePhoto);
    response.profilePhotoPrivacy = user.profilePhotoPrivacy;
    response.profilePhotoPrivacyUserIds = JSON.parse(user.profilePhotoPrivacyUserIds || '[]');
    if (response.profilePhotoPrivacyUserIds.length) {
      const marks = response.profilePhotoPrivacyUserIds.map(() => '?').join(',');
      response.profilePhotoPrivacyUsers = await all(
        `SELECT id, full_name AS fullName, username FROM users WHERE id IN (${marks})`,
        response.profilePhotoPrivacyUserIds
      );
    } else {
      response.profilePhotoPrivacyUsers = [];
    }
    res.json(response);
  } catch (error) {
    res.status(500).json({ message: 'Could not load your profile settings.' });
  }
});

app.patch('/api/profile', requireAuth, async (req, res) => {
  try {
    const fullName = String(req.body.fullName || '').trim();
    const about = String(req.body.about || '').trim();
    const profilePhoto = req.body.profilePhoto === undefined ? undefined : req.body.profilePhoto === null ? null : String(req.body.profilePhoto || '');
    const privacy = String(req.body.profilePhotoPrivacy || 'all');
    const selectedIds = Array.isArray(req.body.profilePhotoPrivacyUserIds)
      ? [...new Set(req.body.profilePhotoPrivacyUserIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0 && id !== req.session.userId))]
      : [];

    if (!fullName || fullName.length > 100) return res.status(400).json({ message: 'Name must be between 1 and 100 characters.' });
    if (about.length > 140) return res.status(400).json({ message: 'About must be 140 characters or fewer.' });
    if (!['all', 'except', 'only'].includes(privacy)) return res.status(400).json({ message: 'Choose a valid profile photo privacy option.' });
    if (privacy !== 'all' && selectedIds.length !== req.body.profilePhotoPrivacyUserIds?.length) {
      return res.status(400).json({ message: 'Choose valid members for profile photo privacy.' });
    }

    let photoToStore = profilePhoto;
    if (profilePhoto) {
      const match = profilePhoto.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]*={0,2})$/);
      if (!match || Buffer.from(match[2], 'base64').length > 2 * 1024 * 1024) {
        return res.status(400).json({ message: 'Profile photos must be JPEG, PNG, or WebP and 2 MB or smaller.' });
      }
    }

    if (selectedIds.length) {
      const marks = selectedIds.map(() => '?').join(',');
      const matchedUsers = await get(`SELECT COUNT(*) AS count FROM users WHERE id IN (${marks})`, selectedIds);
      if (matchedUsers.count !== selectedIds.length) return res.status(400).json({ message: 'A selected member no longer exists.' });
    }

    if (photoToStore === undefined) {
      const currentPhoto = await get('SELECT profile_photo AS profilePhoto FROM users WHERE id = ?', [req.session.userId]);
      photoToStore = currentPhoto.profilePhoto;
    }
    await run(
      `UPDATE users SET full_name = ?, about = ?, profile_photo = ?,
       profile_photo_privacy = ?, profile_photo_privacy_user_ids = ? WHERE id = ?`,
      [fullName, about, photoToStore, privacy, JSON.stringify(selectedIds), req.session.userId]
    );
    const user = await get('SELECT id, full_name, username, email, phone, about, phone_verified FROM users WHERE id = ?', [req.session.userId]);
    res.json(sanitizeUser(user));
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Could not update your profile.' });
  }
});

app.get('/api/users/:userId/profile', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const profile = await get(
      `SELECT id, full_name AS fullName, username, about,
              profile_photo AS profilePhoto, profile_photo_privacy AS profilePhotoPrivacy,
              profile_photo_privacy_user_ids AS profilePhotoPrivacyUserIds
       FROM users WHERE id = ?`,
      [userId]
    );
    if (!profile) return res.status(404).json({ message: 'Member not found.' });
    const canViewPhoto = canViewProfilePhoto(profile, req.session.userId) && Boolean(profile.profilePhoto);
    delete profile.profilePhoto;
    delete profile.profilePhotoPrivacy;
    delete profile.profilePhotoPrivacyUserIds;
    res.json({ ...profile, profilePhotoUrl: canViewPhoto ? `/api/users/${userId}/photo` : null });
  } catch (error) {
    res.status(500).json({ message: 'Could not load member profile.' });
  }
});

app.get('/api/users/:userId/photo', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const profile = await get(
      `SELECT id, profile_photo AS profilePhoto,
              profile_photo_privacy AS profilePhotoPrivacy,
              profile_photo_privacy_user_ids AS profilePhotoPrivacyUserIds
       FROM users WHERE id = ?`,
      [userId]
    );
    if (!profile || !profile.profilePhoto || !canViewProfilePhoto(profile, req.session.userId)) return res.status(404).end();
    const [metadata, encodedData] = profile.profilePhoto.split(',');
    const mimeType = metadata.match(/^data:(image\/(?:jpeg|png|webp));base64$/)?.[1];
    if (!mimeType) return res.status(404).end();
    res.set('Content-Type', mimeType);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(encodedData, 'base64'));
  } catch (error) {
    res.status(500).end();
  }
});

app.post('/api/signup', async (req, res) => {
  try {
    const fullName = String(req.body.fullName || '').trim();
    const username = String(req.body.username || '').trim().replace(/^@/, '').toLowerCase();
    const contact = String(req.body.contact || req.body.email || '').trim();
    const password = String(req.body.password || '');

    if (!fullName || !username || !contact || !password) {
      return res.status(400).json({ message: 'Full name, username, email or phone number, and password are required.' });
    }

    const isEmail = contact.includes('@');
    const email = isEmail ? contact.toLowerCase() : null;
    const phone = isEmail ? null : normalizePhone(contact);

    if (isEmail ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) : !phone) {
      return res.status(400).json({ message: 'Enter a valid email address or phone number.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
    }

    const existingUser = await get('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
    const existingPhone = phone ? await findUserByPhone(phone) : null;
    if (existingUser || existingPhone) {
      return res.status(409).json({ message: 'Username, email, or phone number already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const insertResult = await run(
      'INSERT INTO users (full_name, username, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)',
      [fullName, username, email, phone, passwordHash]
    );

    req.session.userId = insertResult.id;

    const createdUser = await get('SELECT id, full_name, username, email, phone FROM users WHERE id = ?', [insertResult.id]);
    res.status(201).json({ message: 'Account created successfully.', user: sanitizeUser(createdUser) });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ message: 'Unable to create account.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const identifier = String(req.body.identifier || '').trim();
    const normalizedIdentifier = identifier.toLowerCase();
    const normalizedPhone = normalizePhone(identifier);
    const phoneVariants = phoneLookupVariants(normalizedPhone);
    const password = String(req.body.password || '');

    if (!identifier || !password) {
      return res.status(400).json({ message: 'Email, phone number, username, and password are required.' });
    }

    const user = await get(
      `SELECT * FROM users WHERE username = ? OR email = ? OR phone IN (${phoneVariants.map(() => '?').join(',')})`,
      [normalizedIdentifier, normalizedIdentifier, ...phoneVariants]
    );

    if (!user) {
      return res.status(401).json({ message: 'Invalid login details.' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid login details.' });
    }

    req.session.userId = user.id;
    res.json({ message: 'Login successful.', user: sanitizeUser(user) });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Unable to log in.' });
  }
});

function normalizePhone(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    // Keep international E.164 input as entered.
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('232')) {
    // The country code was entered without a plus sign.
  } else if (digits.startsWith('0')) {
    const nationalNumber = digits.slice(1);
    if (nationalNumber.length !== 8) return '';
    digits = `232${nationalNumber}`;
  } else {
    if (digits.length !== 8) return '';
    digits = `232${digits}`;
  }
  const normalized = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : '';
}

function phoneLookupVariants(normalizedPhone) {
  if (!normalizedPhone) return [''];
  const digits = normalizedPhone.slice(1);
  const variants = [normalizedPhone, digits];
  if (digits.startsWith('232')) variants.push(`0${digits.slice(3)}`);
  return [...new Set(variants)];
}

async function findUserByPhone(normalizedPhone) {
  const variants = phoneLookupVariants(normalizedPhone);
  return get(
    `SELECT id FROM users WHERE phone IN (${variants.map(() => '?').join(',')})`,
    variants
  );
}

function twilioVerifyConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  return accountSid && authToken && serviceSid ? { accountSid, authToken, serviceSid } : null;
}

const twilioSetupMessage = 'Phone verification is not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID to the project .env file, then restart the server.';

async function callTwilioVerify(config, endpoint, fields) {
  const credentials = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
  const response = await fetch(`https://verify.twilio.com/v2/Services/${config.serviceSid}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(12000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || 'Phone verification provider rejected the request.');
  return result;
}

app.post('/api/auth/otp/send', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const purpose = String(req.body.purpose || 'login');
    if (!phone) return res.status(400).json({ message: 'Enter a valid phone number with country code, such as +232761234567.' });
    if (!['signup', 'login'].includes(purpose)) return res.status(400).json({ message: 'Choose signup or login verification.' });
    const existingUser = await findUserByPhone(phone);
    if (purpose === 'signup' && existingUser) return res.status(409).json({ message: 'This phone number already has an account. Sign in instead.' });
    if (purpose === 'login' && !existingUser) return res.status(404).json({ message: 'No account uses this phone number.' });
    const config = twilioVerifyConfig();
    if (!config) return res.status(503).json({ message: twilioSetupMessage });

    await callTwilioVerify(config, 'Verifications', { To: phone, Channel: 'sms' });
    req.session.phoneOtpPending = { phone, purpose, expiresAt: Date.now() + 10 * 60 * 1000 };
    res.json({ message: 'Verification code sent by SMS.', expiresInSeconds: 600 });
  } catch (error) {
    console.error('Send OTP error:', error.message);
    res.status(502).json({ message: 'Could not send the SMS verification code.' });
  }
});

app.post('/api/auth/otp/verify', async (req, res) => {
  try {
    const pending = req.session.phoneOtpPending;
    const code = String(req.body.code || '').trim();
    if (!pending || pending.expiresAt <= Date.now()) {
      delete req.session.phoneOtpPending;
      return res.status(400).json({ message: 'Request a new verification code.' });
    }
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ message: 'Enter the six-digit code.' });
    const config = twilioVerifyConfig();
    if (!config) return res.status(503).json({ message: twilioSetupMessage });

    const result = await callTwilioVerify(config, 'VerificationCheck', { To: pending.phone, Code: code });
    if (result.status !== 'approved') return res.status(400).json({ message: 'That code is not valid. Check it and try again.' });

    if (pending.purpose === 'login') {
      const user = await findUserByPhone(pending.phone);
      if (!user) return res.status(404).json({ message: 'No account uses this phone number.' });
      await run('UPDATE users SET phone_verified = 1 WHERE id = ?', [user.id]);
      req.session.userId = user.id;
      req.session.deviceId = req.session.deviceId || randomUUID();
      delete req.session.phoneOtpPending;
      return res.json({ message: 'Phone verified. You are signed in.' });
    }

    req.session.verifiedSignupPhone = pending.phone;
    delete req.session.phoneOtpPending;
    res.json({ message: 'Phone verified. Finish setting up your profile.' });
  } catch (error) {
    console.error('Verify OTP error:', error.message);
    res.status(502).json({ message: 'Could not verify the code right now.' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const phone = req.session.verifiedSignupPhone;
    const fullName = String(req.body.fullName || '').trim();
    const about = String(req.body.about || '').trim();
    if (!phone) return res.status(403).json({ message: 'Verify your phone number before creating your account.' });
    if (!fullName || fullName.length > 100 || about.length > 140) {
      return res.status(400).json({ message: 'Enter a name of at most 100 characters and About text of at most 140 characters.' });
    }
    const existingUser = await findUserByPhone(phone);
    if (existingUser) return res.status(409).json({ message: 'This phone number already has an account.' });

    const baseUsername = `user${phone.replace(/\D/g, '').slice(-8)}`;
    let username = baseUsername;
    while (await get('SELECT id FROM users WHERE username = ?', [username])) {
      username = `${baseUsername}${randomUUID().slice(0, 4)}`;
    }
    const passwordHash = await bcrypt.hash(randomUUID(), 10);
    const result = await run(
      'INSERT INTO users (full_name, username, phone, phone_verified, about, password_hash) VALUES (?, ?, ?, 1, ?, ?)',
      [fullName, username, phone, about, passwordHash]
    );
    req.session.userId = result.id;
    req.session.deviceId = req.session.deviceId || randomUUID();
    delete req.session.verifiedSignupPhone;
    const user = await get('SELECT id, full_name, username, email, phone, about, phone_verified FROM users WHERE id = ?', [result.id]);
    res.status(201).json({ message: 'Account created successfully.', user: sanitizeUser(user) });
  } catch (error) {
    console.error('OTP registration error:', error);
    res.status(500).json({ message: 'Could not finish account setup.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ message: 'Could not log out.' });
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Logout successful.' });
  });
});

app.get('/api/posts', requireAuth, async (req, res) => {
  try {
    const rows = await all(`
      SELECT p.id, p.content, p.created_at AS createdAt,
             u.id AS userId, u.full_name AS fullName, u.username
      FROM posts p
      JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC
    `);

    const posts = rows.map((post) => ({
      id: post.id,
      content: post.content,
      createdAt: post.createdAt,
      user: {
        id: post.userId,
        fullName: post.fullName,
        username: post.username,
      },
    }));

    res.json(posts);
  } catch (error) {
    console.error('Fetch posts error:', error);
    res.status(500).json({ message: 'Could not load posts.' });
  }
});

app.post('/api/posts', requireAuth, async (req, res) => {
  try {
    const content = String(req.body.content || '').trim();
    if (!content) {
      return res.status(400).json({ message: 'Post text is required.' });
    }

    const user = await get('SELECT id, full_name, username FROM users WHERE id = ?', [req.session.userId]);
    const result = await run(
      'INSERT INTO posts (user_id, content) VALUES (?, ?)',
      [req.session.userId, content]
    );

    const createdPost = {
      id: result.id,
      content,
      createdAt: new Date().toISOString(),
      user: {
        id: user.id,
        fullName: user.full_name,
        username: user.username,
      },
    };

    res.status(201).json(createdPost);
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ message: 'Could not create post.' });
  }
});

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const query = String(req.query.q || '').trim().slice(0, 80);
    const pattern = `%${query}%`;
    const users = await all(
      `SELECT id, full_name AS fullName, username
       FROM users
       WHERE id <> ? AND (full_name LIKE ? OR username LIKE ?)
       ORDER BY full_name COLLATE NOCASE
       LIMIT 30`,
      [req.session.userId, pattern, pattern]
    );
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Could not search members.' });
  }
});

app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const conversations = await all(
      `SELECT partner.id, partner.full_name AS fullName, partner.username,
              latest.content AS lastMessage, latest.created_at AS createdAt,
              (SELECT COUNT(*) FROM messages unread
               WHERE unread.sender_id = partner.id AND unread.recipient_id = ? AND unread.read_at IS NULL) AS unreadCount
       FROM (
         SELECT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS partner_id,
                MAX(id) AS latest_id
         FROM messages
         WHERE sender_id = ? OR recipient_id = ?
         GROUP BY partner_id
       ) conversation
       JOIN users partner ON partner.id = conversation.partner_id
       JOIN messages latest ON latest.id = conversation.latest_id
       ORDER BY latest.id DESC`,
      [userId, userId, userId, userId]
    );
    res.json(conversations);
  } catch (error) {
    console.error('Fetch conversations error:', error);
    res.status(500).json({ message: 'Could not load conversations.' });
  }
});

app.get('/api/conversations/:partnerId/messages', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const partnerId = Number(req.params.partnerId);
    if (!Number.isSafeInteger(partnerId) || partnerId < 1 || partnerId === userId) {
      return res.status(400).json({ message: 'Choose a valid conversation.' });
    }

    const partner = await get('SELECT id, full_name AS fullName, username FROM users WHERE id = ?', [partnerId]);
    if (!partner) return res.status(404).json({ message: 'Member not found.' });

    await run(
      'UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL',
      [partnerId, userId]
    );
    const messages = await all(
      `SELECT id, sender_id AS senderId, recipient_id AS recipientId,
              content, created_at AS createdAt, read_at AS readAt
       FROM messages
       WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
       ORDER BY id ASC
       LIMIT 300`,
      [userId, partnerId, partnerId, userId]
    );
    res.json({ partner, messages });
  } catch (error) {
    console.error('Fetch messages error:', error);
    res.status(500).json({ message: 'Could not load messages.' });
  }
});

app.post('/api/messages', requireAuth, async (req, res) => {
  try {
    const recipientId = Number(req.body.recipientId);
    const content = String(req.body.content || '').trim();
    if (!Number.isSafeInteger(recipientId) || recipientId < 1 || recipientId === req.session.userId) {
      return res.status(400).json({ message: 'Choose a valid recipient.' });
    }
    if (!content || content.length > 2000) {
      return res.status(400).json({ message: 'Messages must be between 1 and 2000 characters.' });
    }
    const recipient = await get('SELECT id FROM users WHERE id = ?', [recipientId]);
    if (!recipient) return res.status(404).json({ message: 'Member not found.' });

    const result = await run(
      'INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)',
      [req.session.userId, recipientId, content]
    );
    const message = await get(
      'SELECT id, sender_id AS senderId, recipient_id AS recipientId, content, created_at AS createdAt, read_at AS readAt FROM messages WHERE id = ?',
      [result.id]
    );
    res.status(201).json(message);
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ message: 'Could not send message.' });
  }
});

app.get('/api/reels', requireAuth, async (req, res) => {
  try {
    const reels = await all(
      `SELECT r.id, r.video_url AS videoUrl, r.caption, r.created_at AS createdAt,
              u.id AS userId, u.full_name AS fullName, u.username,
              (SELECT COUNT(*) FROM reel_likes likes WHERE likes.reel_id = r.id) AS likeCount,
              EXISTS(SELECT 1 FROM reel_likes likes WHERE likes.reel_id = r.id AND likes.user_id = ?) AS liked
       FROM reels r
       JOIN users u ON u.id = r.user_id
       ORDER BY r.id DESC
       LIMIT 100`,
      [req.session.userId]
    );
    res.json(reels);
  } catch (error) {
    console.error('Fetch reels error:', error);
    res.status(500).json({ message: 'Could not load Reels.' });
  }
});

app.post('/api/reels', requireAuth, async (req, res) => {
  try {
    const videoUrl = String(req.body.videoUrl || '').trim();
    const caption = String(req.body.caption || '').trim();
    let parsedUrl;
    try {
      parsedUrl = new URL(videoUrl);
    } catch {
      return res.status(400).json({ message: 'Enter a direct MP4, WebM, or Ogg video URL.' });
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password
      || !/\.(mp4|webm|ogv|ogg)$/i.test(parsedUrl.pathname)) {
      return res.status(400).json({ message: 'Use a direct MP4, WebM, or Ogg video URL.' });
    }
    if (videoUrl.length > 2048 || caption.length > 500) {
      return res.status(400).json({ message: 'Video URLs must be under 2048 characters and captions under 500.' });
    }

    const result = await run(
      'INSERT INTO reels (user_id, video_url, caption) VALUES (?, ?, ?)',
      [req.session.userId, videoUrl, caption]
    );
    const reel = await get(
      `SELECT r.id, r.video_url AS videoUrl, r.caption, r.created_at AS createdAt,
              u.id AS userId, u.full_name AS fullName, u.username,
              0 AS likeCount, 0 AS liked
       FROM reels r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
      [result.id]
    );
    res.status(201).json(reel);
  } catch (error) {
    console.error('Create Reel error:', error);
    res.status(500).json({ message: 'Could not publish Reel.' });
  }
});

app.post('/api/reels/:reelId/like', requireAuth, async (req, res) => {
  try {
    const reelId = Number(req.params.reelId);
    if (!Number.isSafeInteger(reelId) || reelId < 1) {
      return res.status(400).json({ message: 'Choose a valid Reel.' });
    }
    const reel = await get('SELECT id FROM reels WHERE id = ?', [reelId]);
    if (!reel) return res.status(404).json({ message: 'Reel not found.' });

    const existingLike = await get('SELECT 1 FROM reel_likes WHERE reel_id = ? AND user_id = ?', [reelId, req.session.userId]);
    if (existingLike) {
      await run('DELETE FROM reel_likes WHERE reel_id = ? AND user_id = ?', [reelId, req.session.userId]);
    } else {
      await run('INSERT INTO reel_likes (reel_id, user_id) VALUES (?, ?)', [reelId, req.session.userId]);
    }
    const likeCount = await get('SELECT COUNT(*) AS count FROM reel_likes WHERE reel_id = ?', [reelId]);
    res.json({ liked: !existingLike, likeCount: likeCount.count });
  } catch (error) {
    console.error('Toggle Reel like error:', error);
    res.status(500).json({ message: 'Could not update Reel reaction.' });
  }
});

function canViewStatus(status, viewerId) {
  if (status.userId === viewerId || status.privacyMode === 'all') return true;
  let allowedUsers = [];
  try { allowedUsers = JSON.parse(status.privacyUserIds); } catch { return false; }
  return status.privacyMode === 'only'
    ? allowedUsers.includes(viewerId)
    : !allowedUsers.includes(viewerId);
}

app.get('/api/statuses', requireAuth, async (req, res) => {
  try {
    await run("DELETE FROM statuses WHERE julianday(expires_at) <= julianday('now')");
    const rows = await all(
      `SELECT s.id, s.user_id AS userId, s.content, s.media_type AS mediaType,
              s.media_data AS mediaData, s.privacy_mode AS privacyMode,
              s.privacy_user_ids AS privacyUserIds, s.created_at AS createdAt,
              s.expires_at AS expiresAt, u.full_name AS fullName, u.username
       FROM statuses s JOIN users u ON u.id = s.user_id
       WHERE julianday(s.expires_at) > julianday('now')
       ORDER BY s.id DESC`
    );
    const visible = rows.filter((status) => canViewStatus(status, req.session.userId))
      .map(({ privacyUserIds, mediaData, ...status }) => ({
        ...status,
        mediaUrl: mediaData ? `/api/statuses/${status.id}/media` : null,
      }));
    res.json(visible);
  } catch (error) {
    console.error('Fetch statuses error:', error);
    res.status(500).json({ message: 'Could not load Updates.' });
  }
});

app.post('/api/statuses', requireAuth, async (req, res) => {
  try {
    const content = String(req.body.content || '').trim();
    const mediaData = String(req.body.mediaData || '');
    const mediaType = String(req.body.mediaType || '');
    const privacyMode = String(req.body.privacyMode || 'all');
    const requestedUsers = Array.isArray(req.body.privacyUserIds) ? req.body.privacyUserIds : [];
    const privacyUserIds = [...new Set(requestedUsers.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0 && id !== req.session.userId))];

    if (content.length > 500) return res.status(400).json({ message: 'Updates must be 500 characters or fewer.' });
    if (!['all', 'except', 'only'].includes(privacyMode)) return res.status(400).json({ message: 'Choose a valid Status privacy option.' });
    if (!content && !mediaData) return res.status(400).json({ message: 'Write an update or attach media.' });
    if (privacyMode !== 'all' && privacyUserIds.length !== requestedUsers.length) {
      return res.status(400).json({ message: 'Choose valid members for this privacy option.' });
    }

    let storedMedia = null;
    let storedType = null;
    if (mediaData) {
      const match = mediaData.match(/^data:(image\/(?:jpeg|png|webp)|video\/(?:mp4|webm)|audio\/(?:webm|ogg|mpeg));base64,([A-Za-z0-9+/]*={0,2})$/);
      if (!match || match[1] !== mediaType) {
        return res.status(400).json({ message: 'Use a JPEG, PNG, WebP, MP4, WebM, Ogg, or MP3 file.' });
      }
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) {
        return res.status(413).json({ message: 'Status media must be 8 MB or smaller.' });
      }
      storedMedia = mediaData;
      storedType = mediaType;
    }

    if (privacyUserIds.length) {
      const marks = privacyUserIds.map(() => '?').join(',');
      const matches = await get(`SELECT COUNT(*) AS count FROM users WHERE id IN (${marks})`, privacyUserIds);
      if (matches.count !== privacyUserIds.length) return res.status(400).json({ message: 'A selected member no longer exists.' });
    }

    const result = await run(
      `INSERT INTO statuses (user_id, content, media_type, media_data, privacy_mode, privacy_user_ids, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+24 hours'))`,
      [req.session.userId, content, storedType, storedMedia, privacyMode, JSON.stringify(privacyUserIds)]
    );
    const created = await get(
      `SELECT s.id, s.user_id AS userId, s.content, s.media_type AS mediaType,
              s.media_data AS mediaData, s.privacy_mode AS privacyMode,
              s.created_at AS createdAt, s.expires_at AS expiresAt,
              u.full_name AS fullName, u.username
       FROM statuses s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      [result.id]
    );
    const { mediaData: statusMediaData, ...status } = created;
    res.status(201).json({ ...status, mediaUrl: statusMediaData ? `/api/statuses/${status.id}/media` : null });
  } catch (error) {
    console.error('Create status error:', error);
    res.status(500).json({ message: 'Could not post this Update.' });
  }
});

app.get('/api/statuses/:statusId/media', requireAuth, async (req, res) => {
  try {
    const statusId = Number(req.params.statusId);
    if (!Number.isSafeInteger(statusId) || statusId < 1) return res.status(404).end();
    const status = await get(
      `SELECT user_id AS userId, media_type AS mediaType, media_data AS mediaData,
              privacy_mode AS privacyMode, privacy_user_ids AS privacyUserIds
       FROM statuses WHERE id = ? AND julianday(expires_at) > julianday('now')`,
      [statusId]
    );
    if (!status || !status.mediaData || !canViewStatus(status, req.session.userId)) return res.status(404).end();
    const encodedData = status.mediaData.split(',')[1];
    res.set('Content-Type', status.mediaType);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(encodedData, 'base64'));
  } catch (error) {
    console.error('Fetch status media error:', error);
    res.status(500).end();
  }
});

app.get('/api/channels', requireAuth, async (req, res) => {
  try {
    const channels = await all(
      `SELECT c.id, c.name, c.description, c.owner_id AS ownerId,
              u.full_name AS ownerName, u.username AS ownerUsername,
              (SELECT COUNT(*) FROM channel_followers followers WHERE followers.channel_id = c.id) AS followerCount,
              EXISTS(SELECT 1 FROM channel_followers followers WHERE followers.channel_id = c.id AND followers.user_id = ?) AS following
       FROM channels c JOIN users u ON u.id = c.owner_id
       ORDER BY c.id DESC`,
      [req.session.userId]
    );
    res.json(channels);
  } catch (error) {
    res.status(500).json({ message: 'Could not load Channels.' });
  }
});

app.post('/api/channels', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();
    if (!name || name.length > 80 || description.length > 500) {
      return res.status(400).json({ message: 'Channel names are required and must be 80 characters or fewer; descriptions are limited to 500.' });
    }
    const result = await run('INSERT INTO channels (owner_id, name, description) VALUES (?, ?, ?)', [req.session.userId, name, description]);
    await run('INSERT INTO channel_followers (channel_id, user_id) VALUES (?, ?)', [result.id, req.session.userId]);
    const channel = await get(
      `SELECT c.id, c.name, c.description, c.owner_id AS ownerId,
              u.full_name AS ownerName, u.username AS ownerUsername,
              1 AS followerCount, 1 AS following
       FROM channels c JOIN users u ON u.id = c.owner_id WHERE c.id = ?`,
      [result.id]
    );
    res.status(201).json(channel);
  } catch (error) {
    res.status(500).json({ message: 'Could not create Channel.' });
  }
});

app.post('/api/channels/:channelId/follow', requireAuth, async (req, res) => {
  try {
    const channelId = Number(req.params.channelId);
    if (!Number.isSafeInteger(channelId) || channelId < 1) return res.status(400).json({ message: 'Choose a valid Channel.' });
    const channel = await get('SELECT id FROM channels WHERE id = ?', [channelId]);
    if (!channel) return res.status(404).json({ message: 'Channel not found.' });
    const following = await get('SELECT 1 FROM channel_followers WHERE channel_id = ? AND user_id = ?', [channelId, req.session.userId]);
    if (following) await run('DELETE FROM channel_followers WHERE channel_id = ? AND user_id = ?', [channelId, req.session.userId]);
    else await run('INSERT INTO channel_followers (channel_id, user_id) VALUES (?, ?)', [channelId, req.session.userId]);
    const result = await get('SELECT COUNT(*) AS count FROM channel_followers WHERE channel_id = ?', [channelId]);
    res.json({ following: !following, followerCount: result.count });
  } catch (error) {
    res.status(500).json({ message: 'Could not update Channel subscription.' });
  }
});

app.get('/api/channels/:channelId/posts', requireAuth, async (req, res) => {
  try {
    const channelId = Number(req.params.channelId);
    const following = await get('SELECT 1 FROM channel_followers WHERE channel_id = ? AND user_id = ?', [channelId, req.session.userId]);
    const channel = await get('SELECT id FROM channels WHERE id = ?', [channelId]);
    if (!channel) return res.status(404).json({ message: 'Channel not found.' });
    const owner = await get('SELECT owner_id AS ownerId FROM channels WHERE id = ?', [channelId]);
    if (!following && owner.ownerId !== req.session.userId) return res.status(403).json({ message: 'Follow this Channel to view its posts.' });
    const posts = await all(
      `SELECT p.id, p.content, p.created_at AS createdAt,
              u.id AS authorId, u.full_name AS authorName, u.username AS authorUsername
       FROM channel_posts p JOIN users u ON u.id = p.author_id
       WHERE p.channel_id = ? ORDER BY p.id DESC LIMIT 100`,
      [channelId]
    );
    res.json(posts);
  } catch (error) {
    res.status(500).json({ message: 'Could not load Channel posts.' });
  }
});

app.post('/api/channels/:channelId/posts', requireAuth, async (req, res) => {
  try {
    const channelId = Number(req.params.channelId);
    const content = String(req.body.content || '').trim();
    const channel = await get('SELECT id, owner_id AS ownerId FROM channels WHERE id = ?', [channelId]);
    if (!channel) return res.status(404).json({ message: 'Channel not found.' });
    if (channel.ownerId !== req.session.userId) return res.status(403).json({ message: 'Only the Channel owner can publish updates.' });
    if (!content || content.length > 3000) return res.status(400).json({ message: 'Channel updates must be between 1 and 3000 characters.' });
    const result = await run('INSERT INTO channel_posts (channel_id, author_id, content) VALUES (?, ?, ?)', [channelId, req.session.userId, content]);
    const post = await get(
      `SELECT p.id, p.content, p.created_at AS createdAt,
              u.id AS authorId, u.full_name AS authorName, u.username AS authorUsername
       FROM channel_posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
      [result.id]
    );
    res.status(201).json(post);
  } catch (error) {
    res.status(500).json({ message: 'Could not publish Channel update.' });
  }
});

app.get('/api/communities', requireAuth, async (req, res) => {
  try {
    const communities = await all(
      `SELECT c.id, c.name, c.description, c.owner_id AS ownerId,
              u.full_name AS ownerName,
              (SELECT COUNT(*) FROM community_members members WHERE members.community_id = c.id) AS memberCount,
              EXISTS(SELECT 1 FROM community_members members WHERE members.community_id = c.id AND members.user_id = ?) AS joined
       FROM communities c JOIN users u ON u.id = c.owner_id
       ORDER BY c.id DESC`,
      [req.session.userId]
    );
    res.json(communities);
  } catch (error) {
    res.status(500).json({ message: 'Could not load Communities.' });
  }
});

app.post('/api/communities', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();
    if (!name || name.length > 80 || description.length > 500) {
      return res.status(400).json({ message: 'Community names are required and must be 80 characters or fewer; descriptions are limited to 500.' });
    }
    const result = await run('INSERT INTO communities (owner_id, name, description) VALUES (?, ?, ?)', [req.session.userId, name, description]);
    await run('INSERT INTO community_members (community_id, user_id) VALUES (?, ?)', [result.id, req.session.userId]);
    const community = await get(
      `SELECT c.id, c.name, c.description, c.owner_id AS ownerId,
              u.full_name AS ownerName, 1 AS memberCount, 1 AS joined
       FROM communities c JOIN users u ON u.id = c.owner_id WHERE c.id = ?`,
      [result.id]
    );
    res.status(201).json(community);
  } catch (error) {
    res.status(500).json({ message: 'Could not create Community.' });
  }
});

app.post('/api/communities/:communityId/membership', requireAuth, async (req, res) => {
  try {
    const communityId = Number(req.params.communityId);
    const community = await get('SELECT id FROM communities WHERE id = ?', [communityId]);
    if (!community) return res.status(404).json({ message: 'Community not found.' });
    const joined = await get('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', [communityId, req.session.userId]);
    if (req.body.join === false && joined) await run('DELETE FROM community_members WHERE community_id = ? AND user_id = ?', [communityId, req.session.userId]);
    else if (!joined) await run('INSERT INTO community_members (community_id, user_id) VALUES (?, ?)', [communityId, req.session.userId]);
    const count = await get('SELECT COUNT(*) AS count FROM community_members WHERE community_id = ?', [communityId]);
    res.json({ joined: req.body.join === false ? false : true, memberCount: count.count });
  } catch (error) {
    res.status(500).json({ message: 'Could not update Community membership.' });
  }
});

app.get('/api/communities/:communityId/messages', requireAuth, async (req, res) => {
  try {
    const communityId = Number(req.params.communityId);
    const membership = await get('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', [communityId, req.session.userId]);
    if (!membership) return res.status(403).json({ message: 'Join this Community to view its chat.' });
    const messages = await all(
      `SELECT m.id, m.content, m.created_at AS createdAt,
              u.id AS senderId, u.full_name AS senderName, u.username AS senderUsername
       FROM community_messages m JOIN users u ON u.id = m.sender_id
       WHERE m.community_id = ? ORDER BY m.id ASC LIMIT 300`,
      [communityId]
    );
    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: 'Could not load Community chat.' });
  }
});

app.post('/api/communities/:communityId/messages', requireAuth, async (req, res) => {
  try {
    const communityId = Number(req.params.communityId);
    const content = String(req.body.content || '').trim();
    const membership = await get('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', [communityId, req.session.userId]);
    if (!membership) return res.status(403).json({ message: 'Join this Community to send messages.' });
    if (!content || content.length > 2000) return res.status(400).json({ message: 'Messages must be between 1 and 2000 characters.' });
    const result = await run('INSERT INTO community_messages (community_id, sender_id, content) VALUES (?, ?, ?)', [communityId, req.session.userId, content]);
    const message = await get(
      `SELECT m.id, m.content, m.created_at AS createdAt,
              u.id AS senderId, u.full_name AS senderName, u.username AS senderUsername
       FROM community_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
      [result.id]
    );
    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({ message: 'Could not send Community message.' });
  }
});

app.get('/login.html', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/signup.html', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/app.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.js'));
});

app.use((req, res) => {
  if (req.path.endsWith('.html')) {
    res.redirect('/login.html');
    return;
  }
  res.status(404).json({ message: 'Not found' });
});

async function startServer() {
  await initDb();
  app.listen(port, () => {
    console.log(`SYX app running on http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
