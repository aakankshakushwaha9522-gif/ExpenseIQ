'use strict';
/** Integration tests over REAL HTTP against the real server (no mocks except the Gemini call). */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store');
const { createApp } = require('../server/app');
const { loadConfig } = require('../server/config');
const { LoginThrottle } = require('../server/auth');

const tx = (o = {}) => ({ date: '2025-03-02', category: 'Food', amount: 100, description: 'Lunch', ...o });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eiq-s-')), 'db.json');

async function boot({ env = {}, file = tmpFile(), ask } = {}) {
  const config = loadConfig({ AUTH_RATE_LIMIT_PER_MIN: '1000', API_RATE_LIMIT_PER_MIN: '10000', CHAT_RATE_LIMIT_PER_MIN: '1000', ...env });
  const store = createStore({ file });
  const app = createApp({ config, store, ask: ask || (async () => 'AI reply'), throttle: new LoginThrottle() });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { app, store, file, port, base, close: () => app.close() };
}

/** A tiny browser: keeps cookies, always sends the CSRF header unless told otherwise. */
function client(base) {
  let cookie = '';
  async function call(method, url, body, { headers = {}, raw = false, csrf = true } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-Requested-With': 'ExpenseIQ' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    let data = null; const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers, setCookie: sc };
  }
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}
async function signUp(base, email) {
  const c = client(base);
  const r = await c.call('POST', '/api/auth/register', { email, password: 'password123', name: email.split('@')[0] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return c;
}

/** Server-Sent-Events reader */
function openStream(base, cookie) {
  return new Promise((resolve, reject) => {
    const events = []; let buf = ''; const waiters = [];
    const req = http.get(base + '/api/events', { headers: { Cookie: cookie } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, events, close() {} }); }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block), d = /^data: (.*)$/m.exec(block);
          if (ev && d) { events.push({ event: ev[1], data: JSON.parse(d[1]) }); waiters.forEach((w) => w()); }
        }
      });
      resolve({
        status: 200, events,
        waitFor: (pred, ms = 3000) => new Promise((ok, no) => {
          const check = () => { const f = events.find(pred); if (f) { ok(f); return true; } return false; };
          if (check()) return;
          const t = setTimeout(() => no(new Error('timeout waiting for event; got ' + JSON.stringify(events.map((e) => e.event)))), ms);
          waiters.push(() => { if (check()) clearTimeout(t); });
        }),
        close: () => req.destroy(),
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}

// ── static files & headers ──────────────────────────────────────
test('serves the app and sets security headers; API responses are never cached', async () => {
  const s = await boot();
  try {
    const page = await fetch(s.base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ExpenseIQ/);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no inline scripts allowed');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('x-powered-by'), null);
    const js = await fetch(s.base + '/js/shared.js');
    assert.match(js.headers.get('content-type'), /javascript/);
    const api = await fetch(s.base + '/api/health');
    assert.equal(api.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await api.json(), { status: 'ok', geminiConfigured: false });
  } finally { await s.close(); }
});

test('static files: path traversal, dotfiles, source and data are not reachable', async () => {
  const s = await boot();
  try {
    for (const p of ['/../server/app.js', '/..%2fserver%2fapp.js', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json', '/js/../../package.json',
      '/.env', '/js/.hidden', '/server/app.js', '/package.json', '/data/expenseiq-data.json', '/%00', '/%E0%A4%A']) {
      const r = await fetch(s.base + p);
      assert.ok([400, 404].includes(r.status), `${p} → ${r.status}`);
      assert.doesNotMatch(await r.text(), /createServer|scrypt|"name": "expenseiq"/);
    }
    assert.equal((await fetch(s.base + '/', { method: 'POST', headers: { 'X-Requested-With': 'ExpenseIQ' } })).status, 405);
    assert.equal((await fetch(s.base + '/', { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(s.base + '/api/nope')).status, 404);
  } finally { await s.close(); }
});

// ── cookie login flow ───────────────────────────────────────────
test('register → me → logout → me over real HTTP, with a hardened cookie', async () => {
  const s = await boot();
  try {
    const c = client(s.base);
    assert.equal((await c.call('GET', '/api/auth/me')).status, 401);
    const reg = await c.call('POST', '/api/auth/register', { email: 'ann@example.com', password: 'password123', name: 'Ann' });
    assert.equal(reg.status, 201);
    assert.match(reg.setCookie, /^sid=[^;]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/);
    assert.equal(JSON.stringify(reg.data).includes('password'), false);
    assert.equal((await c.call('GET', '/api/auth/me')).data.user.email, 'ann@example.com');
    const old = c.cookie;
    const out = await c.call('POST', '/api/auth/logout');
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /Max-Age=0/);
    assert.equal((await c.call('GET', '/api/auth/me')).status, 401);
    c.cookie = old;
    assert.equal((await c.call('GET', '/api/auth/me')).status, 401, 'stolen/old cookie is dead after logout');
    const back = await c.call('POST', '/api/auth/login', { email: 'ANN@example.com', password: 'password123' });
    assert.equal(back.status, 200);
    assert.equal((await c.call('GET', '/api/data')).status, 200);
  } finally { await s.close(); }
});

test('Secure flag is set in production mode', async () => {
  const s = await boot({ env: { NODE_ENV: 'production' } });
  try {
    const r = await client(s.base).call('POST', '/api/auth/register', { email: 'a@x.io', password: 'password123' });
    assert.match(r.setCookie, /; Secure/);
    assert.match((await fetch(s.base + '/')).headers.get('strict-transport-security'), /max-age/);
  } finally { await s.close(); }
});

test('forged, tampered and empty session cookies are rejected', async () => {
  const s = await boot();
  try {
    const c = await signUp(s.base, 'a@x.io');
    for (const cookie of ['sid=forged', 'sid=', 'sid=' + c.cookie.slice(4, -2) + 'xx', 'other=' + c.cookie.slice(4), 'sid=' + 'A'.repeat(300)]) {
      const x = client(s.base); x.cookie = cookie;
      assert.equal((await x.call('GET', '/api/data')).status, 401, cookie.slice(0, 20));
    }
  } finally { await s.close(); }
});

// ── CSRF / content-type / size ──────────────────────────────────
test('CSRF defence: state-changing requests need the custom header and a same-origin Origin', async () => {
  const s = await boot();
  try {
    const c = await signUp(s.base, 'a@x.io');
    const put = (opts) => c.call('PUT', '/api/expenses/e1', tx(), opts);
    assert.equal((await put({ csrf: false })).status, 403, 'no header (a plain cross-site form post)');
    assert.equal((await put({ headers: { Origin: 'https://evil.example' } })).status, 403, 'foreign origin');
    assert.equal((await put({ headers: { Origin: s.base } })).status, 200, 'same origin');
    assert.equal((await c.call('DELETE', '/api/expenses/e1', undefined, { csrf: false })).status, 403);
    assert.equal((await c.call('POST', '/api/auth/logout', undefined, { csrf: false })).status, 403);
    assert.equal((await c.call('GET', '/api/data', undefined, { csrf: false })).status, 200, 'safe methods need no header');
    assert.equal((await c.call('GET', '/api/auth/me')).status, 200, 'still logged in: the blocked logout did nothing');
  } finally { await s.close(); }
});

test('content-type, JSON and size limits', async () => {
  const s = await boot();
  try {
    const c = await signUp(s.base, 'a@x.io');
    assert.equal((await c.call('PUT', '/api/expenses/e1', JSON.stringify(tx()), { raw: true, headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await c.call('PUT', '/api/expenses/e1', '{bad json', { raw: true, headers: { 'Content-Type': 'application/json' } })).status, 400);
    const big = await c.call('POST', '/api/chat', { message: 'x'.repeat(10 * 1024) });
    assert.equal(big.status, 413);
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: 'r' + i, ...tx({ description: 'row ' + i }) }));
    assert.ok(JSON.stringify({ expenses: rows }).length > 4096, 'import body is bigger than the small limit');
    const imp = await c.call('POST', '/api/import', { expenses: rows });
    assert.equal(imp.status, 200);
    assert.equal(imp.data.added, 1000);
    const huge = await c.call('POST', '/api/import', { expenses: [{ id: 'z', ...tx({ description: 'x'.repeat(600 * 1024) }) }] });
    assert.equal(huge.status, 413);
  } finally { await s.close(); }
});

// ── isolation over HTTP ─────────────────────────────────────────
test('HTTP isolation: users never see each other\'s data, whatever they send', async () => {
  const s = await boot();
  try {
    const alice = await signUp(s.base, 'alice@x.io');
    const bob = await signUp(s.base, 'bob@x.io');
    await alice.call('PUT', '/api/expenses/e1', tx({ description: 'ALICE-SECRET' }));
    await alice.call('PUT', '/api/budgets/2025-03', { amount: 1234 });
    const seen = JSON.stringify((await bob.call('GET', '/api/data')).data);
    assert.equal(seen.includes('ALICE-SECRET') || seen.includes('1234'), false);
    // Bob tries to address Alice's id via every channel
    await bob.call('PUT', '/api/expenses/e1', { ...tx({ description: 'BOB' }), uid: 'x', userId: 'x' });
    await bob.call('DELETE', '/api/expenses/e1');
    assert.equal((await alice.call('GET', '/api/data')).data.data.expenses.e1.description, 'ALICE-SECRET');
    const chat = await bob.call('POST', '/api/chat', { message: 'hi', uid: 'alice', userId: 'alice' });
    assert.equal(chat.status, 200);
    assert.equal((await alice.call('GET', '/api/chat/history')).data.messages.length, 0, "bob's chat is not in alice's history");
  } finally { await s.close(); }
});

// ── rate limits ─────────────────────────────────────────────────
test('rate limits: auth endpoints, chat, and the global API limit answer 429 with Retry-After', async () => {
  const s = await boot({ env: { AUTH_RATE_LIMIT_PER_MIN: '3', CHAT_RATE_LIMIT_PER_MIN: '2', API_RATE_LIMIT_PER_MIN: '60' } });
  try {
    const c = await signUp(s.base, 'a@x.io');                                   // auth hit #1
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await client(s.base).call('POST', '/api/auth/login', { email: 'nobody@x.io', password: 'whatever12' })).status);
    assert.deepEqual(statuses, [401, 401, 429, 429]);
    const chats = [];
    for (let i = 0; i < 3; i++) chats.push(await c.call('POST', '/api/chat', { message: 'hi' }));
    assert.deepEqual(chats.map((r) => r.status), [200, 200, 429]);
    assert.ok(Number(chats[2].headers.get('retry-after')) > 0);
    let last;
    for (let i = 0; i < 70; i++) last = await c.call('GET', '/api/health');
    assert.equal(last.status, 429);
  } finally { await s.close(); }
});

test('brute force: repeated wrong passwords lock the account/IP out, even for the correct password', async () => {
  const s = await boot();
  try {
    await signUp(s.base, 'a@x.io');
    const c = client(s.base);
    for (let i = 0; i < 5; i++) assert.equal((await c.call('POST', '/api/auth/login', { email: 'a@x.io', password: 'wrong-' + i + '-pass' })).status, 401);
    const r = await c.call('POST', '/api/auth/login', { email: 'a@x.io', password: 'password123' });
    assert.equal(r.status, 429);
    assert.match(r.data.error, /Too many failed attempts/);
  } finally { await s.close(); }
});

// ── live updates ────────────────────────────────────────────────
test('live stream: initial snapshot, pushes on every change (any tab/device), isolated per user, cleans up', async () => {
  const s = await boot();
  const streams = [];
  try {
    const alice = await signUp(s.base, 'alice@x.io');
    const bob = await signUp(s.base, 'bob@x.io');
    assert.equal((await openStream(s.base, '')).status, 401, 'no login → no stream');

    const sA = await openStream(s.base, alice.cookie); streams.push(sA);
    const sA2 = await openStream(s.base, alice.cookie); streams.push(sA2);         // alice's second tab/device
    const sB = await openStream(s.base, bob.cookie); streams.push(sB);
    const first = await sA.waitFor((e) => e.event === 'data');
    assert.deepEqual(first.data.data.expenses, {});
    await sA.waitFor((e) => e.event === 'chat');

    await alice.call('PUT', '/api/expenses/e1', tx({ description: 'LIVE-ONE' }));
    const pushed = await sA2.waitFor((e) => e.event === 'data' && e.data.data.expenses.e1);
    assert.equal(pushed.data.data.expenses.e1.description, 'LIVE-ONE');
    assert.ok(pushed.data.rev > first.data.rev);
    await alice.call('DELETE', '/api/expenses/e1');
    await sA2.waitFor((e) => e.event === 'data' && e.data.data.expenses.e1 === undefined && e.data.rev > pushed.data.rev);
    await alice.call('POST', '/api/chat', { message: 'hello' });
    await sA2.waitFor((e) => e.event === 'chat' && e.data.messages.length === 2);

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sB.events.some((e) => JSON.stringify(e).includes('LIVE-ONE') || (e.event === 'chat' && e.data.messages.length)), false, 'bob never receives alice\'s events');
    const aliceId = (await alice.call('GET', '/api/auth/me')).data.user.id;
    assert.equal(s.store.subscriberCount(aliceId), 2);

    sA.close(); sA2.close();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(s.store.subscriberCount(aliceId), 0, 'closed streams are released');
  } finally { streams.forEach((x) => x.close()); await s.close(); }
});

test('live stream: at most 10 open connections per user', async () => {
  const s = await boot();
  const open = [];
  try {
    const a = await signUp(s.base, 'a@x.io');
    for (let i = 0; i < 10; i++) { const st = await openStream(s.base, a.cookie); assert.equal(st.status, 200); open.push(st); }
    assert.equal((await openStream(s.base, a.cookie)).status, 429);
  } finally { open.forEach((x) => x.close()); await s.close(); }
});

// ── persistence ─────────────────────────────────────────────────
test('everything survives a full server restart (users, password, data, chat); sessions too', async () => {
  const file = tmpFile();
  let s = await boot({ file });
  const c = await signUp(s.base, 'ann@example.com');
  await c.call('PUT', '/api/expenses/e1', tx({ description: 'PERSISTED' }));
  await c.call('POST', '/api/chat', { message: 'remember me' });
  const cookie = c.cookie;
  await s.store.flush(); await s.close();

  s = await boot({ file });
  try {
    const same = client(s.base); same.cookie = cookie;
    assert.equal((await same.call('GET', '/api/data')).data.data.expenses.e1.description, 'PERSISTED', 'old cookie still valid');
    const fresh = client(s.base);
    assert.equal((await fresh.call('POST', '/api/auth/login', { email: 'ann@example.com', password: 'password123' })).status, 200);
    assert.equal((await fresh.call('GET', '/api/chat/history')).data.messages.length, 2);
    const onDisk = fs.readFileSync(file, 'utf8');
    assert.equal(onDisk.includes('password123'), false);
    assert.equal(onDisk.includes(cookie.slice(4)), false, 'raw session token is not on disk');
  } finally { await s.close(); }
});

test('concurrent requests from one user all succeed and are all stored', async () => {
  const s = await boot();
  try {
    const c = await signUp(s.base, 'a@x.io');
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => c.call('PUT', '/api/expenses/c' + i, tx({ amount: i + 1 }))));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(Object.keys((await c.call('GET', '/api/data')).data.data.expenses).length, 40);
  } finally { await s.close(); }
});
