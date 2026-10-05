import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer as createPortServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function availablePort() {
  const portServer = createPortServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const { port } = portServer.address();
  await new Promise((resolveClose, rejectClose) => portServer.close(error => error ? rejectClose(error) : resolveClose()));
  return port;
}

test("teacher records stay private unless shared; idle sessions expire", { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "salone-register-test-"));
  const databasePath = join(directory, "test.sqlite");
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const setupToken = "test-only-bootstrap-token-with-more-than-32-characters";
  const child = spawn(process.execPath, [resolve("server.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), APP_ORIGIN: origin, NODE_ENV: "test", SALONE_DB_PATH: databasePath, SETUP_TOKEN: setupToken },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let serverErrors = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { serverErrors += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await rm(directory, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${origin}/api/setup-status`);
      if (response.ok) { ready = true; break; }
    } catch { /* Wait briefly for the child process to bind its port. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  assert.equal(ready, true, `server did not start: ${serverErrors}`);

  for (const [path, contentType] of [["/manifest.webmanifest", "application/manifest+json"], ["/icon.svg", "image/svg+xml"], ["/apple-touch-icon.png", "image/png"], ["/sw.js", "text/javascript"]]) {
    const asset = await fetch(`${origin}${path}`);
    assert.equal(asset.status, 200, `${path} should load`);
    assert.equal(asset.headers.get("content-type").split(";")[0], contentType);
    if (path === "/sw.js") assert.equal(asset.headers.get("cache-control"), "no-cache");
  }

  async function api(path, { method = "GET", body, cookie, requestOrigin = origin } = {}) {
    const headers = {};
    if (method !== "GET") headers.Origin = requestOrigin;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0], setCookie: response.headers.get("set-cookie") || "" };
  }

	const guest = await api("/api/auth/me");
	assert.equal(guest.status, 200);
	assert.equal(guest.data.authenticated, false);

  const setupBody = { displayName: "Jonathan Decker", username: "jonathan.decker", password: "TestPassword!2026" };
  const missingSetupToken = await api("/api/auth/setup", { method: "POST", body: setupBody });
  assert.equal(missingSetupToken.status, 403);
  const wrongSetupToken = await api("/api/auth/setup", { method: "POST", body: { ...setupBody, setupToken: "incorrect-token" } });
  assert.equal(wrongSetupToken.status, 403);
  const setup = await api("/api/auth/setup", { method: "POST", body: { ...setupBody, setupToken } });
  assert.equal(setup.status, 201);
  assert.match(setup.setCookie, /HttpOnly/);
  assert.match(setup.setCookie, /SameSite=Strict/);
  const ownerCookie = setup.cookie;
  const logoDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j73sAAAAASUVORK5CYII=";
  const logoUpload = await api("/api/schools/logos", { method: "POST", cookie: ownerCookie, body: { schoolName: "Example School", logoDataUrl } });
  assert.equal(logoUpload.status, 201);
  assert.match(logoUpload.data.school.logo, /^data:image\/png;base64,/);
  const logoSearch = await api("/api/schools?q=Example", { cookie: ownerCookie });
  assert.equal(logoSearch.data.schools[0].name, "Example School");
  const invalidLogo = await api("/api/schools/logos", { method: "POST", cookie: ownerCookie, body: { schoolName: "Unsafe School", logoDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" } });
  assert.equal(invalidLogo.status, 400);
	const invalidSchoolDomain = await api("/api/schools/logos/lookup", { method: "POST", cookie: ownerCookie, body: { schoolName: "Example School", domain: "127.0.0.1" } });
	assert.equal(invalidSchoolDomain.status, 400);

  const blockedCsrf = await api("/api/students", { method: "POST", cookie: ownerCookie, requestOrigin: "https://untrusted.example", body: { school: "Example School" } });
  assert.equal(blockedCsrf.status, 403);

  const created = await api("/api/students", { method: "POST", cookie: ownerCookie, body: {
    school: "Example School", studentName: "Test Learner", age: 10, className: "Class 4", district: "Bo", guardianName: "Test Guardian", guardianPhone: "+232 76 000 000", guardianEmail: "guardian@example.org"
  } });
  assert.equal(created.status, 201);
  const studentId = created.data.student.id;
  assert.equal(created.data.student.access, "owner");
	assert.equal(created.data.student.guardianEmail, "guardian@example.org");

  const ownerReport = await api("/api/reports", { method: "POST", cookie: ownerCookie, body: {
    studentId, term: "Term 1", academicYear: "2026/2027", teacherName: "Jonathan Decker", headTeacherName: "Aminata Jalloh", scores: [{ subject: "English Language", score: 80 }, { subject: "Mathematics", score: 60 }]
  } });
  assert.equal(ownerReport.status, 201);
  assert.equal(ownerReport.data.report.total, 140);
  assert.equal(ownerReport.data.report.average, 70);
  assert.equal(ownerReport.data.report.teacherName, "Jonathan Decker");
  assert.equal(ownerReport.data.report.headTeacherName, "Aminata Jalloh");
  const ownerPdf = await fetch(`${origin}/api/reports/${ownerReport.data.report.id}/pdf`, { headers: { Cookie: ownerCookie } });
  assert.equal(ownerPdf.status, 200);
  assert.equal(ownerPdf.headers.get("content-type"), "application/pdf");
  assert.equal(ownerPdf.headers.get("cache-control"), "no-store");
  const ownerPdfBytes = Buffer.from(await ownerPdf.arrayBuffer());
  assert.equal(ownerPdfBytes.length > 500, true);
  assert.equal(ownerPdfBytes.includes(Buffer.from("/Subtype /Image")), true);

  await api("/api/auth/logout", { method: "POST", cookie: ownerCookie });
  const ownerLogin = await api("/api/auth/login", { method: "POST", body: { username: "jonathan.decker", password: "TestPassword!2026" } });
  assert.equal(ownerLogin.status, 200);
  const returningOwnerCookie = ownerLogin.cookie;
  assert.equal((await api("/api/students", { cookie: returningOwnerCookie })).data.students.length, 1);

  const longHyphenatedUsername = "fatmata-kamara-teacher-123456789";
	assert.equal(longHyphenatedUsername.length, 32);
	const secondSignup = await api("/api/auth/signup", { method: "POST", body: { displayName: "Fatmata Kamara", username: longHyphenatedUsername, password: "AnotherPassword!2026" } });
  assert.equal(secondSignup.status, 201);
  const secondCookie = secondSignup.cookie;
	const teacherSearch = await api("/api/teachers?q=Fatmata", { cookie: returningOwnerCookie });
	assert.equal(teacherSearch.data.teachers[0].displayName, "Fatmata Kamara");
  const sharedLogoSearch = await api("/api/schools?q=Example", { cookie: secondCookie });
  assert.equal(sharedLogoSearch.data.schools.length, 1);
  const overwriteLogo = await api("/api/schools/logos", { method: "POST", cookie: secondCookie, body: { schoolName: "Example School", logoDataUrl } });
  assert.equal(overwriteLogo.status, 409);
  assert.equal((await api("/api/students", { cookie: secondCookie })).data.students.length, 0);
  assert.equal((await api("/api/reports", { cookie: secondCookie })).data.reports.length, 0);
  const deniedPdf = await fetch(`${origin}/api/reports/${ownerReport.data.report.id}/pdf`, { headers: { Cookie: secondCookie } });
  assert.equal(deniedPdf.status, 404);

  const viewShare = await api(`/api/students/${studentId}/shares`, { method: "POST", cookie: returningOwnerCookie, body: { username: "Fatmata Kamara", permission: "view" } });
  assert.equal(viewShare.status, 200);
  assert.equal((await api("/api/students", { cookie: secondCookie })).data.students.length, 1);
  assert.equal((await api("/api/reports", { cookie: secondCookie })).data.reports.length, 1);
	const sharedPdf = await fetch(`${origin}/api/reports/${ownerReport.data.report.id}/pdf`, { headers: { Cookie: secondCookie } });
	assert.equal(sharedPdf.status, 200);
  const deniedReport = await api("/api/reports", { method: "POST", cookie: secondCookie, body: {
    studentId, term: "Term 2", academicYear: "2026/2027", scores: [{ subject: "English Language", score: 80 }]
  } });
  assert.equal(deniedReport.status, 403);

  await api(`/api/students/${studentId}/shares`, { method: "POST", cookie: returningOwnerCookie, body: { username: longHyphenatedUsername, permission: "edit" } });
  const editorReport = await api("/api/reports", { method: "POST", cookie: secondCookie, body: {
		studentId, term: "Term 2", academicYear: "2026/2027", teacherName: "Fatmata Kamara", headTeacherName: "Aminata Jalloh", scores: [{ subject: "English Language", score: 90 }]
  } });
  assert.equal(editorReport.status, 201);
  assert.equal(editorReport.data.report.average, 90);

  const revoke = await api(`/api/students/${studentId}/shares/${secondSignup.data.teacher.id}`, { method: "DELETE", cookie: returningOwnerCookie });
  assert.equal(revoke.status, 200);
  assert.equal((await api("/api/students", { cookie: secondCookie })).data.students.length, 0);
  assert.equal((await api("/api/reports", { cookie: secondCookie })).data.reports.length, 0);

  const rawToken = secondCookie.slice("salone_session=".length);
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE sessions SET last_activity = ? WHERE token_hash = ?").run(Date.now() - 30 * 60 * 1000 - 1, tokenHash);
  database.close();
  const expiredSession = await api("/api/auth/me", { cookie: secondCookie });
  assert.equal(expiredSession.status, 401);
  assert.match(expiredSession.setCookie, /Max-Age=0/);
});
