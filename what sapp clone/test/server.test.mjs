import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startApp(t) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'syx-test-'));
  const port = await availablePort();
  const app = spawn(process.execPath, ['server.js'], {
    cwd: projectDirectory,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDirectory, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = `server process ${app.pid}, expected port ${port}\n`;
  app.on('error', error => { output += `${error.message}\n`; });
  app.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  app.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    if (app.exitCode === null && app.signalCode === null) {
      app.kill();
      await once(app, 'exit');
    }
    await rm(dataDirectory, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`SYX server exited with code ${app.exitCode}.\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/login.html`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return baseUrl;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`SYX server did not start in time (exit ${app.exitCode}, signal ${app.signalCode}).\n${output}`);
}

function sessionCookie(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'signup should establish a login session');
  return cookie.split(';', 1)[0];
}

async function signup(baseUrl, fullName, username, email) {
  const response = await fetch(`${baseUrl}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName, username, contact: email, password: 'test-password-123' }),
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  return { cookie: sessionCookie(response), user: data.user };
}

test('serves the frontend and persists authenticated messages in SQLite', async t => {
  const baseUrl = await startApp(t);

  const page = await fetch(`${baseUrl}/login.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Welcome back/);
  const frontend = await fetch(`${baseUrl}/app.js`);
  assert.equal(frontend.status, 200);
  assert.match(await frontend.text(), /\/api\/messages/);

  const alice = await signup(baseUrl, 'Alice Test', 'alice-test', 'alice@example.test');
  const bob = await signup(baseUrl, 'Bob Test', 'bob-test', 'bob@example.test');

  const sent = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
    body: JSON.stringify({ recipientId: bob.user.id, content: 'Hello from the SYX integration test.' }),
  });
  assert.equal(sent.status, 201);
  assert.equal((await sent.json()).content, 'Hello from the SYX integration test.');

  const conversations = await fetch(`${baseUrl}/api/conversations`, { headers: { Cookie: bob.cookie } });
  assert.equal(conversations.status, 200);
  assert.equal((await conversations.json())[0].lastMessage, 'Hello from the SYX integration test.');

  const history = await fetch(`${baseUrl}/api/conversations/${alice.user.id}/messages`, { headers: { Cookie: bob.cookie } });
  assert.equal(history.status, 200);
  const { messages } = await history.json();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].senderId, alice.user.id);
  assert.equal(messages[0].recipientId, bob.user.id);
  assert.equal(messages[0].content, 'Hello from the SYX integration test.');
});
