'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, MAX_CHAT } = require('../server/store');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eiq-')), 'sub', 'db.json');
const rec = (o = {}) => ({ date: '2026-10-05', category: 'Food', amount: 10, description: 'x', ...o });

test('creates the data folder, persists, and reloads everything after a restart', async () => {
  const file = tmp();
  const s1 = createStore({ file });
  const u = await s1.createUser({ email: 'a@x.io', name: 'A', passHash: 'H' });
  await s1.upsertTx(u.id, 'expenses', 'e1', rec());
  await s1.setBudget(u.id, '2026-10', 500);
  await s1.appendChat(u.id, [{ role: 'user', text: 'hi', ts: 1 }]);
  await s1.flush();

  const s2 = createStore({ file });                       // "restart"
  assert.equal(s2.getUserByEmail('a@x.io').id, u.id);
  const snap = s2.snapshot(u.id);
  assert.equal(snap.data.expenses.e1.amount, 10);
  assert.equal(snap.data.budgets['2026-10'], 500);
  assert.equal((await s2.getChatHistory(u.id)).length, 1);
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'data file is private to the owner (0600)');
});

test('emails are unique; user lookup never leaks the password hash', async () => {
  const s = createStore({ file: tmp() });
  const u = await s.createUser({ email: 'a@x.io', name: '', passHash: 'SECRET-HASH' });
  await assert.rejects(s.createUser({ email: 'a@x.io', name: '', passHash: 'H' }), { code: 'EMAIL_TAKEN' });
  assert.equal(JSON.stringify(u).includes('SECRET-HASH'), false);
  assert.equal(JSON.stringify(s.getUserById(u.id)).includes('SECRET-HASH'), false);
});

test('sessions: expire, can be deleted, and are stored only as given (hashes)', async () => {
  let t = 1000;
  const s = createStore({ file: tmp(), now: () => t });
  await s.createSession('u1', 'hash1', 5000);
  assert.equal(s.getSession('hash1').uid, 'u1');
  t = 5000;
  assert.equal(s.getSession('hash1'), null, 'expired');
  await s.createSession('u1', 'hash2', 9000);
  await s.deleteSession('hash2');
  assert.equal(s.getSession('hash2'), null);
});

test('USER ISOLATION: every operation is scoped to its own uid', async () => {
  const s = createStore({ file: tmp() });
  await s.upsertTx('alice', 'expenses', 'e1', rec({ description: 'ALICE' }));
  await s.upsertTx('bob', 'expenses', 'e1', rec({ description: 'BOB' }));     // same id, different user
  assert.equal(s.snapshot('alice').data.expenses.e1.description, 'ALICE');
  assert.equal(s.snapshot('bob').data.expenses.e1.description, 'BOB');
  await s.deleteTx('bob', 'expenses', 'e1');
  assert.ok(s.snapshot('alice').data.expenses.e1, 'bob deleting does not touch alice');
  await s.clearAll('bob');
  assert.equal(Object.keys(s.snapshot('alice').data.expenses).length, 1);
  assert.equal((await s.loadUserData('bob')).expenses.length, 0);
});

test('upsert keeps createdAt on edit and bumps the revision on every change', async () => {
  let t = 100;
  const s = createStore({ file: tmp(), now: () => t });
  const r1 = await s.upsertTx('u', 'expenses', 'e1', rec());
  t = 200;
  const r2 = await s.upsertTx('u', 'expenses', 'e1', rec({ amount: 99 }));
  assert.ok(r2.rev > r1.rev);
  assert.equal(r2.data.expenses.e1.createdAt, 100);
  assert.equal(r2.data.expenses.e1.updatedAt, 200);
  assert.equal(r2.data.expenses.e1.amount, 99);
});

test('importTx is an idempotent upsert and reports how many were new', async () => {
  const s = createStore({ file: tmp() });
  const rows = [{ id: 'a', ...rec() }, { id: 'b', ...rec({ amount: 2 }) }];
  assert.equal((await s.importTx('u', 'expenses', rows)).added, 2);
  assert.equal((await s.importTx('u', 'expenses', rows)).added, 0);
  assert.equal(Object.keys(s.snapshot('u').data.expenses).length, 2);
});

test('budgets: set, onlyIfMissing never overwrites, delete', async () => {
  const s = createStore({ file: tmp() });
  await s.setBudget('u', '2026-10', 100);
  await s.setBudget('u', '2026-10', 999, { onlyIfMissing: true });
  assert.equal(s.snapshot('u').data.budgets['2026-10'], 100);
  await s.deleteBudget('u', '2026-10');
  assert.equal(s.snapshot('u').data.budgets['2026-10'], undefined);
});

test('chat history is capped and clearable', async () => {
  const s = createStore({ file: tmp() });
  const msgs = Array.from({ length: MAX_CHAT + 20 }, (_, i) => ({ role: 'user', text: String(i), ts: i }));
  await s.appendChat('u', msgs);
  const all = await s.getChatHistory('u', 1000);
  assert.equal(all.length, MAX_CHAT);
  assert.equal(all.at(-1).text, String(MAX_CHAT + 19));
  await s.clearChat('u');
  assert.equal((await s.getChatHistory('u')).length, 0);
});

test('subscribers are notified, can unsubscribe, and a throwing subscriber cannot break a write', async () => {
  const s = createStore({ file: tmp() });
  const seen = [];
  const off = s.subscribe('u', (t) => seen.push(t));
  s.subscribe('u', () => { throw new Error('dead stream'); });
  await s.upsertTx('u', 'expenses', 'e1', rec());
  await s.appendChat('u', [{ role: 'user', text: 'x', ts: 1 }]);
  assert.deepEqual(seen, ['data', 'chat']);
  assert.equal(s.subscriberCount('u'), 2);
  off();
  await s.upsertTx('u', 'expenses', 'e2', rec());
  assert.deepEqual(seen, ['data', 'chat']);
  const other = [];
  s.subscribe('v', (t) => other.push(t));
  await s.upsertTx('u', 'expenses', 'e3', rec());
  assert.deepEqual(other, [], 'other users are never notified');
});

test('a corrupt data file is refused (never silently overwritten)', () => {
  const file = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => createStore({ file }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('concurrent writes all land and leave valid JSON on disk (atomic, serialised)', async () => {
  const file = tmp();
  const s = createStore({ file });
  await Promise.all(Array.from({ length: 50 }, (_, i) => s.upsertTx('u', 'expenses', 'e' + i, rec({ amount: i + 1 }))));
  await s.flush();
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(disk.data.u.expenses).length, 50);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
});
