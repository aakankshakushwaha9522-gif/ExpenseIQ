'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store');
const { createHandlers, MAX_MESSAGE_LEN } = require('../server/handlers');
const { LoginThrottle } = require('../server/auth');
const { GeminiError } = require('../server/gemini');
const { loadConfig } = require('../server/config');

const tokenOf = (r) => decodeURIComponent(/sid=([^;]*)/.exec(r.cookie.set)[1]);
const tx = (o = {}) => ({ date: '2025-03-02', category: 'Food', amount: 100, description: 'Lunch', ...o });

function setup({ ask, throttle } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eiq-h-')), 'db.json');
  const store = createStore({ file });
  const calls = { asks: [] };
  const h = createHandlers({
    config: loadConfig({ GEMINI_API_KEY: 'k' }), store,
    ask: ask || (async (o) => { calls.asks.push(o); return 'AI says hi'; }),
    now: () => new Date('2025-03-15T10:00:00Z'),
    throttle: throttle || new LoginThrottle(),
  });
  return { h, store, calls };
}
async function signUp(h, email, name = '') {
  const r = await h.register({ body: { email, password: 'password123', name }, ip: '1.1.1.1' });
  assert.equal(r.status, 201);
  return tokenOf(r);
}

// ── registration / login / logout ───────────────────────────────
test('register: validates input, normalises email, rejects duplicates, sets a hardened cookie', async () => {
  const { h, store } = setup();
  assert.equal((await h.register({ body: {} })).status, 400);
  assert.equal((await h.register({ body: { email: 'nope', password: 'password123' } })).status, 400);
  assert.equal((await h.register({ body: { email: 'a@x.io', password: 'short' } })).status, 400);
  assert.equal((await h.register({ body: null })).status, 400);
  const ok = await h.register({ body: { email: '  Ann@Example.COM ', password: 'password123', name: ' Ann '.padEnd(200, 'x') } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.email, 'ann@example.com');
  assert.ok(ok.body.user.name.length <= 60);
  assert.equal(JSON.stringify(ok.body).includes('passHash'), false);
  for (const flag of ['HttpOnly', 'SameSite=Strict']) assert.ok(ok.cookie.set.includes(flag));
  assert.equal((await h.register({ body: { email: 'ANN@example.com', password: 'password123' } })).status, 409);
  const stored = store.getUserByEmail('ann@example.com');
  assert.ok(stored.passHash.startsWith('scrypt$') && !stored.passHash.includes('password123'));
});

test('the session token is never stored in the clear', async () => {
  const { h, store } = setup();
  const token = await signUp(h, 'a@x.io');
  assert.equal(JSON.stringify(store._db().sessions).includes(token), false);
});

test('login: success, wrong password, unknown email give the SAME message; missing fields are 400', async () => {
  const { h } = setup();
  await signUp(h, 'a@x.io');
  const ok = await h.login({ body: { email: 'A@x.io', password: 'password123' }, ip: 'i' });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie.set.startsWith('sid='));
  const wrong = await h.login({ body: { email: 'a@x.io', password: 'wrongpass1' }, ip: 'i' });
  const unknown = await h.login({ body: { email: 'nobody@x.io', password: 'wrongpass1' }, ip: 'i' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body, 'no account enumeration');
  assert.equal(wrong.cookie, undefined);
  assert.equal((await h.login({ body: { email: 'a@x.io' }, ip: 'i' })).status, 400);
  assert.equal((await h.login({ body: { email: { $ne: 1 }, password: { $ne: 1 } }, ip: 'i' })).status, 400, 'object injection is not coerced');
});

test('login is throttled after repeated failures, and the right password is also refused while blocked', async () => {
  const { h } = setup({ throttle: new LoginThrottle({ perIpEmail: 3 }) });
  await signUp(h, 'a@x.io');
  for (let i = 0; i < 3; i++) assert.equal((await h.login({ body: { email: 'a@x.io', password: 'badbadbad' + i }, ip: 'x' })).status, 401);
  const blocked = await h.login({ body: { email: 'a@x.io', password: 'password123' }, ip: 'x' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
  assert.equal((await h.login({ body: { email: 'a@x.io', password: 'password123' }, ip: 'y' })).status, 200, 'a different IP is unaffected');
});

test('logout really invalidates the session on the server', async () => {
  const { h } = setup();
  const token = await signUp(h, 'a@x.io');
  assert.equal((await h.me({ token })).status, 200);
  const out = await h.logout({ token });
  assert.equal(out.status, 200);
  assert.match(out.cookie.set, /Max-Age=0/);
  assert.equal((await h.me({ token })).status, 401, 'the old cookie no longer works');
  assert.equal((await h.getData({ token })).status, 401);
  assert.equal((await h.logout({ token: undefined })).status, 200, 'logout is harmless without a session');
});

test('every protected handler rejects missing, malformed and unknown tokens', async () => {
  const { h } = setup();
  for (const token of [undefined, '', 'x', 'a'.repeat(500), 'unknown-token-value', 123, {}]) {
    assert.equal((await h.me({ token })).status, 401);
    assert.equal((await h.getData({ token })).status, 401);
    assert.equal((await h.putTx({ token, coll: 'expenses', id: 'a', body: tx() })).status, 401);
    assert.equal((await h.chat({ token, body: { message: 'hi' } })).status, 401);
    assert.equal((await h.clearAll({ token })).status, 401);
    assert.equal((await h.importExpenses({ token, body: { expenses: [] } })).status, 401);
    assert.equal((await h.migrate({ token, body: {} })).status, 401);
  }
});

test('an expired session is rejected', async () => {
  const { h, store } = setup();
  const token = await signUp(h, 'a@x.io');
  const hash = Object.keys(store._db().sessions)[0];
  store._db().sessions[hash].expires = Date.now() - 1;
  assert.equal((await h.me({ token })).status, 401);
});

// ── data ────────────────────────────────────────────────────────
test('CRUD: create, edit (createdAt kept), delete, budgets, clear', async () => {
  const { h } = setup();
  const token = await signUp(h, 'a@x.io');
  const put = await h.putTx({ token, coll: 'expenses', id: 'e1', body: tx({ amount: '99.999' }) });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.expenses.e1.amount, 100, 'rounded to 2 decimals');
  const created = put.body.data.expenses.e1.createdAt;
  const edit = await h.putTx({ token, coll: 'expenses', id: 'e1', body: tx({ amount: 5, description: 'Edited' }) });
  assert.equal(edit.body.data.expenses.e1.description, 'Edited');
  assert.equal(edit.body.data.expenses.e1.createdAt, created);
  assert.equal((await h.putTx({ token, coll: 'income', id: 'i1', body: tx({ category: 'Salary', amount: 5000 }) })).status, 200);
  assert.equal((await h.putBudget({ token, month: '2025-03', body: { amount: 2000 } })).body.data.budgets['2025-03'], 2000);
  assert.equal((await h.deleteBudget({ token, month: '2025-03' })).body.data.budgets['2025-03'], undefined);
  assert.deepEqual(Object.keys((await h.deleteTx({ token, coll: 'expenses', id: 'e1' })).body.data.expenses), []);
  assert.equal(Object.keys((await h.clearAll({ token })).body.data.income).length, 0);
});

test('validation: bad records, ids, collections, months and budgets are rejected with 400', async () => {
  const { h } = setup();
  const token = await signUp(h, 'a@x.io');
  const put = (id, body, coll = 'expenses') => h.putTx({ token, coll, id, body });
  for (const bad of [tx({ amount: -1 }), tx({ amount: 0 }), tx({ amount: 'abc' }), tx({ amount: 1e12 }), tx({ date: '2025-02-31' }),
    tx({ date: '03/02/2025' }), tx({ category: 'Gadgets' }), tx({ description: '' }), tx({ description: 'x'.repeat(121) }), null, 'str', []]) {
    assert.equal((await put('ok1', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await put('../../etc', tx())).status, 400);
  assert.equal((await put('a b', tx())).status, 400);
  assert.equal((await put('x'.repeat(41), tx())).status, 400);
  assert.equal((await put('ok1', tx(), 'users')).status, 400, 'unknown collection');
  assert.equal((await put('ok1', tx({ category: 'Food' }), 'income')).status, 400, 'income categories differ from expense categories');
  assert.equal((await h.putBudget({ token, month: '2025-13', body: { amount: 5 } })).status, 400);
  assert.equal((await h.putBudget({ token, month: '2025-03', body: { amount: -5 } })).status, 400);
  assert.equal((await h.putBudget({ token, month: '2025-03', body: null })).status, 400);
  assert.equal((await h.getData({ token })).body.data.expenses.ok1, undefined, 'nothing was stored');
  const extra = await put('ok2', { ...tx(), isAdmin: true, createdAt: 1 });
  assert.equal(extra.body.data.expenses.ok2.isAdmin, undefined, 'unknown fields are dropped');
  assert.notEqual(extra.body.data.expenses.ok2.createdAt, 1, 'client cannot set createdAt');
});

test('CROSS-USER ISOLATION: a user can only ever see and change their own data', async () => {
  const { h } = setup();
  const alice = await signUp(h, 'alice@x.io');
  const bob = await signUp(h, 'bob@x.io');
  await h.putTx({ token: alice, coll: 'expenses', id: 'shared', body: tx({ description: 'ALICE-SECRET' }) });
  await h.putTx({ token: bob, coll: 'expenses', id: 'shared', body: tx({ description: 'BOB-DATA' }) });   // same id, different owner
  const a = JSON.stringify((await h.getData({ token: alice })).body);
  const b = JSON.stringify((await h.getData({ token: bob })).body);
  assert.ok(a.includes('ALICE-SECRET') && !a.includes('BOB-DATA'));
  assert.ok(b.includes('BOB-DATA') && !b.includes('ALICE-SECRET'));
  await h.deleteTx({ token: bob, coll: 'expenses', id: 'shared' });
  assert.ok(JSON.stringify((await h.getData({ token: alice })).body).includes('ALICE-SECRET'), "bob's delete did not touch alice");
  await h.clearAll({ token: bob });
  assert.ok(JSON.stringify((await h.getData({ token: alice })).body).includes('ALICE-SECRET'));
  assert.equal((await h.chatHistory({ token: bob })).body.messages.length, 0);
});

test('import: all-or-nothing validation, idempotent, capped', async () => {
  const { h } = setup();
  const token = await signUp(h, 'a@x.io');
  const rows = [{ id: 'r1', ...tx() }, { id: 'r2', ...tx({ amount: 5 }) }];
  const r1 = await h.importExpenses({ token, body: { expenses: rows } });
  assert.equal(r1.body.added, 2);
  assert.equal((await h.importExpenses({ token, body: { expenses: rows } })).body.added, 0, 'repeat adds nothing');
  const bad = await h.importExpenses({ token, body: { expenses: [{ id: 'r3', ...tx() }, { id: 'r4', ...tx({ amount: -1 }) }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Row 2/);
  assert.equal(Object.keys((await h.getData({ token })).body.data.expenses).length, 2, 'the valid row r3 was NOT stored either');
  assert.equal((await h.importExpenses({ token, body: { expenses: Array.from({ length: 1001 }, (_, i) => ({ id: 'x' + i, ...tx() })) } })).status, 400);
  assert.equal((await h.importExpenses({ token, body: { expenses: 'nope' } })).status, 400);
  assert.equal((await h.importExpenses({ token, body: { expenses: [{ ...tx() }] } })).status, 400, 'ids are required');
});

test('legacy migration: once only, never overwrites an existing budget, can be skipped', async () => {
  const { h } = setup();
  const token = await signUp(h, 'a@x.io');
  await h.putBudget({ token, month: '2025-03', body: { amount: 777 } });
  assert.equal((await h.migrationStatus({ token })).body.done, false);
  const m = await h.migrate({ token, body: { expenses: [{ id: 'm_1_5', ...tx() }], budgets: { '2025-03': 1, '2025-04': 2, 'bad': 3 } } });
  assert.equal(m.status, 200);
  assert.equal(m.body.imported, 1);
  assert.equal(m.body.data.budgets['2025-03'], 777, 'existing budget kept');
  assert.equal(m.body.data.budgets['2025-04'], 2);
  assert.equal(m.body.data.budgets.bad, undefined);
  assert.equal((await h.migrationStatus({ token })).body.done, true);
  assert.equal((await h.migrate({ token, body: { expenses: [{ id: 'm_9_9', ...tx() }] } })).status, 409, 'second run refused');
  const other = await signUp(h, 'b@x.io');
  assert.equal((await h.skipMigration({ token: other })).status, 200);
  assert.equal((await h.migrationStatus({ token: other })).body.done, true);
});

// ── AI assistant ────────────────────────────────────────────────
test('chat validates the message', async () => {
  const { h } = setup();
  const token = await signUp(h, 'a@x.io');
  for (const body of [undefined, null, {}, { message: '' }, { message: '   ' }, { message: 42 }, { message: ['x'] }, 'str']) {
    assert.equal((await h.chat({ token, body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await h.chat({ token, body: { message: 'x'.repeat(MAX_MESSAGE_LEN + 1) } })).status, 400);
  assert.equal((await h.chat({ token, body: { message: 'hi', month: '2025-3' } })).status, 400);
  assert.equal((await h.chat({ token, body: { message: 'hi', today: 'yesterday' } })).status, 400);
  assert.equal((await h.chat({ token, body: { message: 'x'.repeat(MAX_MESSAGE_LEN) } })).status, 200);
});

test('CROSS-USER ISOLATION (AI): the model only ever receives the logged-in user\'s data', async () => {
  const { h, calls } = setup();
  const alice = await signUp(h, 'alice@x.io');
  const bob = await signUp(h, 'bob@x.io');
  await h.putTx({ token: alice, coll: 'expenses', id: 'a1', body: tx({ category: 'Rent', amount: 8000, description: 'ALICE-SECRET-RENT' }) });
  await h.putTx({ token: bob, coll: 'expenses', id: 'b1', body: tx({ amount: 111, description: 'BOB-SECRET-LUNCH' }) });
  await h.chat({ token: alice, body: { message: 'what did I spend?', month: '2025-03', today: '2025-03-15' } });
  await h.chat({ token: bob, body: { message: 'what did I spend?', month: '2025-03', today: '2025-03-15' } });
  const toAlice = JSON.stringify(calls.asks[0].summary), toBob = JSON.stringify(calls.asks[1].summary);
  assert.ok(toAlice.includes('ALICE-SECRET-RENT') && !toAlice.includes('BOB-SECRET'));
  assert.ok(toBob.includes('BOB-SECRET-LUNCH') && !toBob.includes('ALICE-SECRET'));
  assert.equal(calls.asks[0].summary.thisMonth.totalSpent, 8000);
  assert.equal(calls.asks[1].summary.thisMonth.totalSpent, 111);
});

test('the client cannot smuggle in data or another user id; totals come from backend arithmetic', async () => {
  const { h, calls } = setup();
  const token = await signUp(h, 'a@x.io');
  await h.putTx({ token, coll: 'expenses', id: 'e1', body: tx({ amount: 10.1 }) });
  await h.putTx({ token, coll: 'expenses', id: 'e2', body: tx({ amount: 20.2 }) });
  await h.chat({ token, body: { message: 'total?', month: '2025-03', today: '2025-03-15', uid: 'someone-else', expenses: [{ amount: 1e9 }], summary: { thisMonth: { totalSpent: 1 } } } });
  assert.equal(calls.asks[0].summary.thisMonth.totalSpent, 30.3, 'exact decimal arithmetic, not 30.299999');
});

test('chat success saves both messages and returns reply + timestamp; history is per user', async () => {
  const { h } = setup();
  const token = await signUp(h, 'a@x.io');
  const other = await signUp(h, 'b@x.io');
  const r = await h.chat({ token, body: { message: 'hello' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.reply, 'AI says hi');
  assert.equal(r.body.degraded, false);
  assert.ok(r.body.timestamp > 0);
  const hist = (await h.chatHistory({ token })).body.messages;
  assert.deepEqual(hist.map((m) => [m.role, m.text]), [['user', 'hello'], ['assistant', 'AI says hi']]);
  assert.equal((await h.chatHistory({ token: other })).body.messages.length, 0);
  assert.equal((await h.clearHistory({ token })).status, 200);
  assert.equal((await h.chatHistory({ token })).body.messages.length, 0);
});

test('AI failure degrades to a computed digest (200, degraded) and never leaks internals', async () => {
  for (const err of [new GeminiError('The AI service timed out.', 'TIMEOUT', 504), new TypeError('SECRET-INTERNAL-DETAIL')]) {
    const { h } = setup({ ask: async () => { throw err; } });
    const token = await signUp(h, 'a@x.io');
    await h.putTx({ token, coll: 'expenses', id: 'e1', body: tx({ date: '2025-03-05', amount: 250 }) });
    const r = await h.chat({ token, body: { message: 'summary', month: '2025-03', today: '2025-03-15' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.degraded, true);
    assert.match(r.body.reply, /250\.00/);
    assert.equal(JSON.stringify(r.body).includes('SECRET-INTERNAL-DETAIL'), false);
  }
});

test('logs never contain financial data or message text', async () => {
  const lines = [];
  const orig = [console.warn, console.error, console.log];
  console.warn = console.error = console.log = (...a) => lines.push(a.join(' '));
  try {
    const { h } = setup({ ask: async () => { throw new GeminiError('boom', 'NETWORK'); } });
    const token = await signUp(h, 'a@x.io');
    await h.putTx({ token, coll: 'expenses', id: 'e1', body: tx({ description: 'PRIVATE-DESC', amount: 4242 }) });
    await h.chat({ token, body: { message: 'PRIVATE-QUESTION' } });
    await h.login({ body: { email: 'a@x.io', password: 'PRIVATE-PASSWORD' }, ip: 'z' });
  } finally { [console.warn, console.error, console.log] = orig; }
  const out = lines.join('\n');
  for (const secret of ['PRIVATE-DESC', '4242', 'PRIVATE-QUESTION', 'PRIVATE-PASSWORD', 'a@x.io']) assert.equal(out.includes(secret), false, secret);
});

test('health reports configuration without exposing secrets', () => {
  const { h } = setup();
  const r = h.health();
  assert.deepEqual(r.body, { status: 'ok', geminiConfigured: true });
});
