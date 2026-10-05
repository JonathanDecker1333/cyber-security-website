import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import PDFDocument from "pdfkit";

const root = dirname(fileURLToPath(import.meta.url));
const databasePath = process.env.SALONE_DB_PATH || resolve(root, "data", "salone.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
const sessionLifetime = 30 * 60 * 1000;
const sessionCookie = "salone_session";
const setupToken = process.env.SETUP_TOKEN || "";
if (setupToken && setupToken.length < 32) throw new Error("SETUP_TOKEN must be at least 32 characters.");
const classNames = new Set(["Nursery 1", "Nursery 2", ...Array.from({ length: 6 }, (_, i) => `Class ${i + 1}`), ...Array.from({ length: 3 }, (_, i) => `JSS ${i + 1}`), ...Array.from({ length: 3 }, (_, i) => `SSS ${i + 1}`)]);
const districts = new Set(["Bo", "Bombali", "Bonthe", "Falaba", "Karene", "Kailahun", "Kambia", "Kenema", "Koinadugu", "Kono", "Moyamba", "Port Loko", "Pujehun", "Tonkolili", "Western Area Rural", "Western Area Urban"]);
const loginAttempts = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    school_name TEXT NOT NULL DEFAULT '',
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    last_activity INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_activity_idx ON sessions(last_activity);
  CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    school TEXT NOT NULL,
    student_name TEXT NOT NULL,
    age INTEGER NOT NULL,
    class_name TEXT NOT NULL,
    district TEXT NOT NULL,
    guardian_name TEXT NOT NULL,
    guardian_phone TEXT NOT NULL,
    guardian_email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS students_owner_idx ON students(owner_id, created_at);
  CREATE TABLE IF NOT EXISTS student_shares (
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK(permission IN ('view', 'edit')),
    granted_by INTEGER NOT NULL REFERENCES teachers(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(student_id, teacher_id)
  );
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES teachers(id),
    student_name TEXT NOT NULL,
    class_name TEXT NOT NULL,
    school TEXT NOT NULL,
    term TEXT NOT NULL,
    academic_year TEXT NOT NULL,
    scores_json TEXT NOT NULL,
    total REAL NOT NULL,
    average REAL NOT NULL,
    teacher_name TEXT NOT NULL DEFAULT '',
    head_teacher_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS reports_student_idx ON reports(student_id, created_at);
  CREATE TABLE IF NOT EXISTS school_logos (
    school_name TEXT PRIMARY KEY COLLATE NOCASE,
    mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
    image_data BLOB NOT NULL,
    created_by INTEGER NOT NULL REFERENCES teachers(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
function ensureColumn(table, name, definition) {
	if (!database.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
		database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
	}
}
ensureColumn("teachers", "school_name", "TEXT NOT NULL DEFAULT ''");
ensureColumn("students", "guardian_email", "TEXT NOT NULL DEFAULT ''");
ensureColumn("reports", "teacher_name", "TEXT NOT NULL DEFAULT ''");
ensureColumn("reports", "head_teacher_name", "TEXT NOT NULL DEFAULT ''");

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(data));
}

function fail(status, message) {
  throw new HttpError(status, message);
}

async function readJson(request, maxLength = 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxLength) fail(413, "Request is too large.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Invalid request body.");
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, "Invalid JSON.");
  }
}

function requiredText(value, label, maxLength = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) fail(400, `${label} is required.`);
  return value.trim();
}

function setCookie(token, secure = process.env.NODE_ENV === "production") {
  return `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${secure ? "; Secure" : ""}`;
}

function clearCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

function readCookie(request) {
  const cookies = (request.headers.cookie || "").split(";");
  const value = cookies.find(cookie => cookie.trim().startsWith(`${sessionCookie}=`));
  return value ? value.trim().slice(sessionCookie.length + 1) : "";
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) fail(403, "Request origin could not be verified.");
  let expected;
  try {
    expected = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : `${request.socket.encrypted ? "https" : "http"}://${request.headers.host}`;
    if (new URL(origin).origin !== expected) fail(403, "Request origin could not be verified.");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(403, "Request origin could not be verified.");
  }
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

function validPassword(password) {
  return typeof password === "string" && password.length >= 12 && password.length <= 128;
}

function verifyPassword(password, salt, expectedHash) {
  if (typeof password !== "string" || password.length > 128) return false;
  const actual = Buffer.from(hashPassword(password, salt).hash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeUsername(value) {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) fail(400, "Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.");
  return username;
}

function isLoopback(request) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
}

function createTeacher(displayName, usernameValue, password) {
  const name = requiredText(displayName, "Teacher name", 80);
  const username = normalizeUsername(usernameValue);
  if (!validPassword(password)) fail(400, "Password must be between 12 and 128 characters.");
  if (database.prepare("SELECT id FROM teachers WHERE username = ?").get(username)) fail(409, "That username is already in use.");
  const { salt, hash } = hashPassword(password);
  const result = database.prepare("INSERT INTO teachers(display_name, username, salt, password_hash) VALUES (?, ?, ?, ?)").run(name, username, salt, hash);
  return database.prepare("SELECT id, display_name AS displayName, username, school_name AS schoolName FROM teachers WHERE id = ?").get(Number(result.lastInsertRowid));
}

function issueSession(response, teacherId) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  database.prepare("INSERT INTO sessions(token_hash, teacher_id, last_activity) VALUES (?, ?, ?)").run(tokenHash, teacherId, Date.now());
  response.setHeader("Set-Cookie", setCookie(token));
}

function requireTeacher(request, response) {
  const token = readCookie(request);
  if (!token) fail(401, "Sign in to continue.");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const session = database.prepare("SELECT teacher_id, last_activity FROM sessions WHERE token_hash = ?").get(tokenHash);
  if (!session || Date.now() - session.last_activity >= sessionLifetime) {
    database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    response.setHeader("Set-Cookie", clearCookie());
    fail(401, "Your session expired. Sign in again.");
  }
  database.prepare("UPDATE sessions SET last_activity = ? WHERE token_hash = ?").run(Date.now(), tokenHash);
  response.setHeader("Set-Cookie", setCookie(token));
  return database.prepare("SELECT id, display_name AS displayName, username, school_name AS schoolName FROM teachers WHERE id = ?").get(session.teacher_id);
}

function checkRateLimit(request, username) {
  const key = `${request.socket.remoteAddress}:${username}`;
  const attempt = loginAttempts.get(key);
  if (attempt?.lockedUntil > Date.now()) fail(429, "Too many attempts. Try again in 15 minutes.");
  return key;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  const attempt = !current || now - current.startedAt > 15 * 60 * 1000 ? { count: 0, startedAt: now, lockedUntil: 0 } : current;
  attempt.count++;
  if (attempt.count >= 5) attempt.lockedUntil = now + 15 * 60 * 1000;
  loginAttempts.set(key, attempt);
}

function studentAccess(studentId, teacherId) {
  const row = database.prepare(`SELECT s.owner_id, sh.permission FROM students s
    LEFT JOIN student_shares sh ON sh.student_id = s.id AND sh.teacher_id = ? WHERE s.id = ?`).get(teacherId, studentId);
  if (!row) fail(404, "Student record not found.");
  if (row.owner_id === teacherId) return "owner";
  if (row.permission) return row.permission;
  fail(404, "Student record not found.");
}

function studentDto(row, access, ownerName = "") {
  return { id: row.id, school: row.school, studentName: row.student_name, age: row.age, className: row.class_name, district: row.district, guardianName: row.guardian_name, guardianPhone: row.guardian_phone, guardianEmail: row.guardian_email || "", createdAt: row.created_at, access, ownerName };
}

function reportDto(row) {
  return { id: row.id, studentId: row.student_id, studentName: row.student_name, className: row.class_name, school: row.school, term: row.term, academicYear: row.academic_year, scores: JSON.parse(row.scores_json), total: row.total, average: row.average, teacherName: row.teacher_name || "", headTeacherName: row.head_teacher_name || "", createdAt: row.created_at };
}

function pdfText(value) {
  return String(value).replace(/[^\u0009\u000a\u000d\u0020-\u00ff]/g, "?");
}

function createReportPdf(report, logo) {
  return new Promise((resolvePdf, rejectPdf) => {
    const document = new PDFDocument({ size: "A4", margins: { top: 48, right: 48, bottom: 48, left: 48 }, info: { Title: `${report.student_name} report card`, Author: report.teacher_name || "Salone Register" } });
    const chunks = [];
    document.on("data", chunk => chunks.push(chunk));
    document.on("error", rejectPdf);
    document.on("end", () => resolvePdf(Buffer.concat(chunks)));

    let headingX = 48;
    if (logo && ["image/png", "image/jpeg"].includes(logo.mime_type)) {
      try {
        document.image(Buffer.from(logo.image_data), 48, 44, { fit: [56, 56] });
        headingX = 118;
      } catch { /* Invalid legacy image data should not prevent printing the report. */ }
    }
    document.fillColor("#176644").font("Helvetica-Bold").fontSize(9).text("SALONE REGISTER · STUDENT REPORT", headingX, 48);
    document.fillColor("#1d2c25").fontSize(20).text(pdfText(report.school), headingX, 64, { width: 390 });
    document.fillColor("#69766f").font("Helvetica").fontSize(10).text("Academic performance report", headingX, 90);
    document.moveTo(48, 116).lineTo(547, 116).lineWidth(2).strokeColor("#176644").stroke();

    document.fillColor("#45564b").font("Helvetica-Bold").fontSize(10);
    document.text("Student", 48, 132);
    document.text("Student ID", 260, 132);
    document.text("Class", 420, 132);
    document.fillColor("#1d2c25").font("Helvetica").fontSize(10);
    document.text(pdfText(report.student_name), 48, 148, { width: 190 });
    document.text(pdfText(report.student_id), 260, 148, { width: 145 });
    document.text(pdfText(report.class_name), 420, 148, { width: 120 });
    document.fillColor("#45564b").font("Helvetica-Bold").text("Term", 48, 174);
    document.text("Academic year", 150, 174);
    document.fillColor("#1d2c25").font("Helvetica").text(pdfText(report.term), 48, 190);
    document.text(pdfText(report.academic_year), 150, 190);

    let y = 220;
    document.rect(48, y, 499, 24).fill("#e8f3ec");
    document.fillColor("#1d2c25").font("Helvetica-Bold").fontSize(10).text("Subject", 58, y + 7);
    document.text("Score", 430, y + 7, { width: 105, align: "right" });
    y += 24;
    const scores = JSON.parse(report.scores_json);
    for (const [index, item] of scores.entries()) {
      document.rect(48, y, 499, 25).lineWidth(0.5).strokeColor("#dfe8e1").stroke();
      document.fillColor("#1d2c25").font("Helvetica").fontSize(10).text(pdfText(item.subject), 58, y + 8, { width: 340 });
      document.text(`${item.score} / 100`, 430, y + 8, { width: 105, align: "right" });
      y += 25;
    }

    y += 16;
    document.fillColor("#69766f").font("Helvetica").fontSize(9).text(`Total score · ${scores.length} subjects`, 340, y, { width: 207, align: "right" });
    document.fillColor("#176644").font("Helvetica-Bold").fontSize(14).text(`${report.total} / ${scores.length * 100}`, 340, y + 14, { width: 207, align: "right" });
    document.fillColor("#69766f").font("Helvetica").fontSize(9).text("Average score", 340, y + 39, { width: 207, align: "right" });
    document.fillColor("#176644").font("Helvetica-Bold").fontSize(14).text(`${Number(report.average).toFixed(2)} / 100`, 340, y + 53, { width: 207, align: "right" });

    const signatureY = y + 112;
    document.moveTo(48, signatureY).lineTo(255, signatureY).strokeColor("#bfcac1").lineWidth(0.7).stroke();
    document.moveTo(340, signatureY).lineTo(547, signatureY).stroke();
    document.fillColor("#69766f").font("Helvetica").fontSize(9).text("Class teacher", 48, signatureY + 7);
    document.fillColor("#1d2c25").font("Helvetica-Bold").fontSize(10).text(pdfText(report.teacher_name || "Not entered"), 48, signatureY + 20, { width: 207 });
    document.fillColor("#69766f").font("Helvetica").fontSize(9).text("Head teacher", 340, signatureY + 7);
    document.fillColor("#1d2c25").font("Helvetica-Bold").fontSize(10).text(pdfText(report.head_teacher_name || "Not entered"), 340, signatureY + 20, { width: 207 });
    document.end();
  });
}

function logoDataUrl(row) {
  return `data:${row.mime_type};base64,${Buffer.from(row.image_data).toString("base64")}`;
}

function parseSchoolLogo(value) {
  if (typeof value !== "string") fail(400, "Choose a PNG, JPEG, or WebP school logo.");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) fail(400, "Choose a PNG, JPEG, or WebP school logo.");
  const mimeType = match[1];
  const image = Buffer.from(match[2], "base64");
  if (!image.length || image.length > 1024 * 1024) fail(413, "School logos must be smaller than 1 MB.");
  const validSignature = mimeType === "image/png"
    ? image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === "image/jpeg"
      ? image.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : image.subarray(0, 4).toString("ascii") === "RIFF" && image.subarray(8, 12).toString("ascii") === "WEBP";
  if (!validSignature) fail(400, "The selected file is not a valid image of that type.");
  return { mimeType, image };
}

function normalizeSchoolDomain(value) {
  if (typeof value !== "string") fail(400, "Enter the school's website domain.");
  const domain = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (domain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    fail(400, "Enter a public domain such as school.edu.sl.");
  }
  return domain;
}

function requiredTeacherAccess(studentId, teacherId) {
  const access = studentAccess(studentId, teacherId);
  if (access === "view") fail(403, "This shared record is view-only.");
  return access;
}

async function routeApi(request, response, url) {
  const { pathname, searchParams } = url;
  if (request.method === "GET" && pathname === "/api/setup-status") {
    return sendJson(response, 200, { setupRequired: database.prepare("SELECT COUNT(*) AS count FROM teachers").get().count === 0 });
  }

  if (request.method === "POST" && pathname === "/api/auth/setup") {
    assertSameOrigin(request);
    if (database.prepare("SELECT id FROM teachers LIMIT 1").get()) fail(409, "Initial setup is already complete.");
    const body = await readJson(request);
    if (setupToken) {
      const provided = Buffer.from(typeof body.setupToken === "string" ? body.setupToken : "");
      const expected = Buffer.from(setupToken);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) fail(403, "The first-teacher setup key is missing or incorrect.");
    } else if (!isLoopback(request)) {
      fail(403, "Remote first-teacher setup requires a one-time setup key on the server.");
    }
    const teacher = createTeacher(body.displayName, body.username, body.password);
    issueSession(response, teacher.id);
    return sendJson(response, 201, { teacher });
  }

  if (request.method === "POST" && pathname === "/api/auth/signup") {
    assertSameOrigin(request);
    const body = await readJson(request);
    const key = checkRateLimit(request, `signup:${request.socket.remoteAddress}`);
    try {
      const teacher = createTeacher(body.displayName, body.username, body.password);
      loginAttempts.delete(key);
      issueSession(response, teacher.id);
      return sendJson(response, 201, { teacher });
    } catch (error) {
      recordLoginFailure(key);
      throw error;
    }
  }

  if (request.method === "POST" && pathname === "/api/auth/login") {
    assertSameOrigin(request);
    const body = await readJson(request);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const key = checkRateLimit(request, `${request.socket.remoteAddress}:${username}`);
    const row = database.prepare("SELECT id, display_name, username, school_name, salt, password_hash FROM teachers WHERE username = ?").get(username);
    if (!row || !verifyPassword(body.password, row.salt, row.password_hash)) {
      recordLoginFailure(key);
      fail(401, "Username or password is incorrect.");
    }
    loginAttempts.delete(key);
    const teacher = { id: row.id, displayName: row.display_name, username: row.username, schoolName: row.school_name };
    issueSession(response, teacher.id);
    return sendJson(response, 200, { teacher });
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    assertSameOrigin(request);
    const token = readCookie(request);
    if (token) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(createHash("sha256").update(token).digest("hex"));
    return sendJson(response, 200, { ok: true }, { "Set-Cookie": clearCookie() });
  }

  if (request.method === "GET" && pathname === "/api/auth/me") {
    if (!readCookie(request)) return sendJson(response, 200, { authenticated: false });
    return sendJson(response, 200, { authenticated: true, teacher: requireTeacher(request, response), idleTimeoutMinutes: 30 });
  }

  const teacher = requireTeacher(request, response);

  if (request.method === "PATCH" && pathname === "/api/auth/profile") {
    assertSameOrigin(request);
    const body = await readJson(request);
    const schoolName = requiredText(body.schoolName, "School name", 100);
    database.prepare("UPDATE teachers SET school_name = ? WHERE id = ?").run(schoolName, teacher.id);
    return sendJson(response, 200, { teacher: { ...teacher, schoolName } });
  }

  if (request.method === "GET" && pathname === "/api/teachers") {
    const query = (searchParams.get("q") || "").trim().slice(0, 80);
    if (query.length < 2) return sendJson(response, 200, { teachers: [] });
    const matches = database.prepare(`SELECT id, display_name AS displayName, username FROM teachers
      WHERE display_name LIKE ? COLLATE NOCASE OR username LIKE ? COLLATE NOCASE ORDER BY display_name LIMIT 15`).all(`%${query}%`, `%${query}%`);
    return sendJson(response, 200, { teachers: matches });
  }

  if (request.method === "GET" && pathname === "/api/schools") {
    const query = (searchParams.get("q") || "").trim().slice(0, 100);
    if (!query) return sendJson(response, 200, { schools: [] });
    const rows = database.prepare("SELECT school_name, mime_type, image_data FROM school_logos WHERE school_name LIKE ? COLLATE NOCASE ORDER BY school_name LIMIT 10").all(`%${query}%`);
    return sendJson(response, 200, { schools: rows.map(row => ({ name: row.school_name, logo: logoDataUrl(row) })) });
  }

  if (request.method === "POST" && pathname === "/api/schools/logos") {
    assertSameOrigin(request);
    const body = await readJson(request, 2 * 1024 * 1024);
    const schoolName = requiredText(body.schoolName, "School name", 100);
    const { mimeType, image } = parseSchoolLogo(body.logoDataUrl);
    const existing = database.prepare("SELECT created_by FROM school_logos WHERE school_name = ? COLLATE NOCASE").get(schoolName);
    if (existing && existing.created_by !== teacher.id) fail(409, "A logo for this school is already in the directory. Select it from the school suggestions.");
    database.prepare(`INSERT INTO school_logos(school_name, mime_type, image_data, created_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(school_name) DO UPDATE SET mime_type = excluded.mime_type, image_data = excluded.image_data, updated_at = CURRENT_TIMESTAMP`).run(schoolName, mimeType, image, teacher.id);
    return sendJson(response, 201, { school: { name: schoolName, logo: `data:${mimeType};base64,${image.toString("base64")}` } });
  }

  if (request.method === "POST" && pathname === "/api/schools/logos/lookup") {
    assertSameOrigin(request);
    const body = await readJson(request);
    const schoolName = requiredText(body.schoolName, "School name", 100);
    const domain = normalizeSchoolDomain(body.domain);
    let remote;
    try {
      const faviconUrl = new URL("https://www.google.com/s2/favicons");
      faviconUrl.searchParams.set("domain_url", `https://${domain}`);
      faviconUrl.searchParams.set("sz", "128");
      remote = await fetch(faviconUrl, { signal: AbortSignal.timeout(8000), headers: { Accept: "image/png,image/jpeg,image/webp" } });
    } catch {
      fail(502, "Could not look up the website icon. Try uploading the school badge instead.");
    }
    if (!remote.ok) fail(404, "No website icon was found for that domain.");
    const mimeType = (remote.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) fail(404, "No supported website icon was found. Upload the school badge instead.");
    const contentLength = Number(remote.headers.get("content-length") || 0);
    if (contentLength > 1024 * 1024) fail(413, "The website icon is too large.");
    const image = Buffer.from(await remote.arrayBuffer());
    const validated = parseSchoolLogo(`data:${mimeType};base64,${image.toString("base64")}`);
    const existing = database.prepare("SELECT created_by FROM school_logos WHERE school_name = ? COLLATE NOCASE").get(schoolName);
    if (existing && existing.created_by !== teacher.id) fail(409, "A logo for this school is already in the directory. Select it from the school suggestions.");
    database.prepare(`INSERT INTO school_logos(school_name, mime_type, image_data, created_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(school_name) DO UPDATE SET mime_type = excluded.mime_type, image_data = excluded.image_data, updated_at = CURRENT_TIMESTAMP`).run(schoolName, validated.mimeType, validated.image, teacher.id);
    return sendJson(response, 201, { school: { name: schoolName, domain, logo: `data:${validated.mimeType};base64,${validated.image.toString("base64")}` } });
  }

  if (request.method === "GET" && pathname === "/api/students") {
    const rows = database.prepare(`SELECT s.*, t.display_name AS owner_name, CASE WHEN s.owner_id = ? THEN 'owner' ELSE sh.permission END AS access
      FROM students s LEFT JOIN student_shares sh ON sh.student_id = s.id AND sh.teacher_id = ?
      JOIN teachers t ON t.id = s.owner_id WHERE s.owner_id = ? OR sh.teacher_id = ? ORDER BY s.created_at DESC, s.id DESC`).all(teacher.id, teacher.id, teacher.id, teacher.id);
    return sendJson(response, 200, { students: rows.map(row => studentDto(row, row.access, row.owner_name)) });
  }

  if (request.method === "POST" && pathname === "/api/students") {
    assertSameOrigin(request);
    const body = await readJson(request);
    const school = requiredText(body.school, "School name", 100);
    const studentName = requiredText(body.studentName, "Student name", 100);
    const age = Number(body.age);
    if (!Number.isInteger(age) || age < 3 || age > 25) fail(400, "Age must be between 3 and 25.");
    if (!classNames.has(body.className)) fail(400, "Choose a valid class.");
    if (!districts.has(body.district)) fail(400, "Choose a valid district.");
    const guardianName = requiredText(body.guardianName, "Guardian name", 100);
    const guardianPhone = requiredText(body.guardianPhone, "Guardian phone", 25);
		const guardianEmail = typeof body.guardianEmail === "string" ? body.guardianEmail.trim() : "";
		if (guardianEmail.length > 254 || (guardianEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail))) fail(400, "Enter a valid guardian email address.");
    database.prepare("UPDATE teachers SET school_name = ? WHERE id = ?").run(school, teacher.id);
    const year = new Date().getFullYear();
    const prefix = `SL-${year}-`;
    const max = database.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id, 9) AS INTEGER)), 0) AS value FROM students WHERE id LIKE ?").get(`${prefix}%`).value;
    const id = `${prefix}${String(max + 1).padStart(4, "0")}`;
    database.prepare(`INSERT INTO students(id, owner_id, school, student_name, age, class_name, district, guardian_name, guardian_phone, guardian_email)
  			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, teacher.id, school, studentName, age, body.className, body.district, guardianName, guardianPhone, guardianEmail);
    const row = database.prepare("SELECT * FROM students WHERE id = ?").get(id);
    return sendJson(response, 201, { student: studentDto(row, "owner", teacher.displayName) });
  }

  const sharePath = pathname.match(/^\/api\/students\/([^/]+)\/shares(?:\/([0-9]+))?$/);
  if (sharePath) {
    const studentId = decodeURIComponent(sharePath[1]);
    const student = database.prepare("SELECT owner_id FROM students WHERE id = ?").get(studentId);
    if (!student || student.owner_id !== teacher.id) fail(404, "Student record not found.");
    if (request.method === "GET" && !sharePath[2]) {
      const shares = database.prepare(`SELECT t.id AS teacherId, t.display_name AS displayName, t.username, sh.permission, sh.created_at AS createdAt
        FROM student_shares sh JOIN teachers t ON t.id = sh.teacher_id WHERE sh.student_id = ? ORDER BY t.display_name`).all(studentId);
      return sendJson(response, 200, { shares });
    }
    if (request.method === "POST" && !sharePath[2]) {
      assertSameOrigin(request);
      const body = await readJson(request);
      const identifier = requiredText(body.username, "Teacher name or username", 80);
      if (!["view", "edit"].includes(body.permission)) fail(400, "Choose view or edit access.");
      const targets = database.prepare(`SELECT id FROM teachers WHERE username = ? COLLATE NOCASE
        OR lower(trim(display_name)) = lower(trim(?))`).all(identifier, identifier);
      if (!targets.length) fail(404, "No teacher account matches that name or username.");
      if (targets.length > 1) fail(409, "More than one teacher has that name. Use their unique username instead.");
      const target = targets[0];
      if (target.id === teacher.id) fail(400, "You already have access to this student.");
      database.prepare(`INSERT INTO student_shares(student_id, teacher_id, permission, granted_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(student_id, teacher_id) DO UPDATE SET permission = excluded.permission, granted_by = excluded.granted_by`).run(studentId, target.id, body.permission, teacher.id);
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "DELETE" && sharePath[2]) {
      assertSameOrigin(request);
      database.prepare("DELETE FROM student_shares WHERE student_id = ? AND teacher_id = ?").run(studentId, Number(sharePath[2]));
      return sendJson(response, 200, { ok: true });
    }
  }

  if (request.method === "DELETE" && pathname.startsWith("/api/students/")) {
    assertSameOrigin(request);
    const id = decodeURIComponent(pathname.slice("/api/students/".length));
    const result = database.prepare("DELETE FROM students WHERE id = ? AND owner_id = ?").run(id, teacher.id);
    if (!result.changes) fail(404, "Student record not found.");
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "GET" && pathname === "/api/reports") {
    const rows = database.prepare(`SELECT r.* FROM reports r JOIN students s ON s.id = r.student_id
      LEFT JOIN student_shares sh ON sh.student_id = s.id AND sh.teacher_id = ?
      WHERE s.owner_id = ? OR sh.teacher_id = ? ORDER BY r.created_at DESC, r.id DESC`).all(teacher.id, teacher.id, teacher.id);
    return sendJson(response, 200, { reports: rows.map(reportDto) });
  }

  if (request.method === "POST" && pathname === "/api/reports") {
    assertSameOrigin(request);
    const body = await readJson(request);
    const studentId = requiredText(body.studentId, "Student", 50);
    requiredTeacherAccess(studentId, teacher.id);
    const student = database.prepare("SELECT * FROM students WHERE id = ?").get(studentId);
    const term = body.term;
    if (!["Term 1", "Term 2", "Term 3"].includes(term)) fail(400, "Choose a valid term.");
    const academicYear = requiredText(body.academicYear, "Academic year", 9);
    if (!/^\d{4}\/\d{4}$/.test(academicYear)) fail(400, "Academic year must use the format 2026/2027.");
		const teacherName = typeof body.teacherName === "string" && body.teacherName.trim() ? requiredText(body.teacherName, "Teacher name", 80) : teacher.displayName;
    const headTeacherName = requiredText(body.headTeacherName, "Head teacher name", 80);
    if (!Array.isArray(body.scores) || body.scores.length < 1 || body.scores.length > 20) fail(400, "A report must include between 1 and 20 subjects.");
    const subjects = new Set();
    const scores = body.scores.map(item => {
      const subject = requiredText(item?.subject, "Subject name", 60);
      if (subjects.has(subject.toLowerCase())) fail(400, "Subject names must be unique on a report.");
      subjects.add(subject.toLowerCase());
      const score = Number(item.score);
      if (!Number.isFinite(score) || score < 0 || score > 100) fail(400, "Each score must be between 0 and 100.");
      return { subject, score };
    });
    const total = scores.reduce((sum, item) => sum + item.score, 0);
    const average = total / scores.length;
    const id = `RC-${randomUUID()}`;
    database.prepare(`INSERT INTO reports(id, student_id, created_by, student_name, class_name, school, term, academic_year, scores_json, total, average, teacher_name, head_teacher_name)
  			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, studentId, teacher.id, student.student_name, student.class_name, student.school, term, academicYear, JSON.stringify(scores), total, average, teacherName, headTeacherName);
    return sendJson(response, 201, { report: reportDto(database.prepare("SELECT * FROM reports WHERE id = ?").get(id)) });
  }

  const reportPdfPath = pathname.match(/^\/api\/reports\/([^/]+)\/pdf$/);
  if (request.method === "GET" && reportPdfPath) {
    const reportId = decodeURIComponent(reportPdfPath[1]);
    const report = database.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
    if (!report) fail(404, "Report card not found.");
    studentAccess(report.student_id, teacher.id);
    const logo = database.prepare("SELECT mime_type, image_data FROM school_logos WHERE school_name = ? COLLATE NOCASE").get(report.school);
    const pdf = await createReportPdf(report, logo);
    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="salone-report-${report.id}.pdf"`,
      "Cache-Control": "no-store",
      "Content-Length": pdf.length
    });
    return response.end(pdf);
  }

  const reportPath = pathname.match(/^\/api\/reports\/([^/]+)$/);
  if (request.method === "DELETE" && reportPath) {
    assertSameOrigin(request);
    const id = decodeURIComponent(reportPath[1]);
    const report = database.prepare("SELECT student_id FROM reports WHERE id = ?").get(id);
    if (!report) fail(404, "Report card not found.");
    requiredTeacherAccess(report.student_id, teacher.id);
    database.prepare("DELETE FROM reports WHERE id = ?").run(id);
    return sendJson(response, 200, { ok: true });
  }

  return sendJson(response, 404, { error: "Route not found." });
}

function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
}

const staticAssets = new Map([
  ["/manifest.webmanifest", { file: "manifest.webmanifest", contentType: "application/manifest+json", cacheControl: "no-cache" }],
  ["/icon.svg", { file: "icon.svg", contentType: "image/svg+xml", cacheControl: "public, max-age=86400" }],
  ["/apple-touch-icon.png", { file: "apple-touch-icon.png", contentType: "image/png", cacheControl: "public, max-age=86400" }],
  ["/sw.js", { file: "sw.js", contentType: "text/javascript; charset=utf-8", cacheControl: "no-cache", serviceWorker: true }]
]);

const server = createServer(async (request, response) => {
  applySecurityHeaders(response);
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await routeApi(request, response, url);
    const staticAsset = staticAssets.get(url.pathname);
    if (request.method === "GET" && staticAsset) {
      const contents = await readFile(resolve(root, staticAsset.file));
      response.writeHead(200, {
        "Content-Type": staticAsset.contentType,
        "Cache-Control": staticAsset.cacheControl,
        ...(staticAsset.serviceWorker ? { "Service-Worker-Allowed": "/" } : {})
      });
      return response.end(contents);
    }
    if (request.method === "GET" && ["/", "/index.html"].includes(url.pathname)) {
      const html = await readFile(resolve(root, "index.html"));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return response.end(html);
    }
    return sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    if (response.headersSent) return response.destroy();
    if (!(error instanceof HttpError)) console.error("Request failed:", error.message);
    return sendJson(response, error.status || 500, { error: error.status ? error.message : "Server error." }, error.status === 401 ? { "Set-Cookie": clearCookie() } : {});
  }
});

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
server.listen(port, host, () => console.log(`Salone Register listening on http://${host}:${port}`));

setInterval(() => {
  database.prepare("DELETE FROM sessions WHERE last_activity < ?").run(Date.now() - sessionLifetime);
  const now = Date.now();
  for (const [key, attempt] of loginAttempts) if (attempt.lockedUntil < now && now - attempt.startedAt > 15 * 60 * 1000) loginAttempts.delete(key);
}, 60_000).unref();
