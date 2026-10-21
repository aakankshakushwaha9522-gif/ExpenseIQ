'use strict';
/**
 * store.js — tiny file-backed database (a single JSON file), so the project needs no
 * database server. Every mutation updates memory and is then written atomically
 * (temp file + rename), serialised through a queue so writes never interleave.
 *
 *   users     : { [uid]: { id, email, name, passHash, createdAt } }
 *   sessions  : { [sha256(token)]: { uid, expires } }
 *   data      : { [uid]: { expenses:{id:rec}, income:{id:rec}, budgets:{'YYYY-MM':n}, chat:[], meta:{}, rev } }
 *
 * Every data method takes the uid explicitly and only ever touches data[uid], which is
 * how users are isolated from each other.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_PER_COLLECTION = 20000;
const MAX_CHAT = 200;

function createStore({ file, now = () => Date.now() }) {
  let db = { version: 1, users: {}, emails: {}, sessions: {}, data: {} };

  if (fs.existsSync(file)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`Data file ${file} is not valid JSON; refusing to overwrite it. Fix or move the file. (${e.message})`); }
    db = { ...db, ...parsed };
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  // ── persistence ──────────────────────────────────────────────
  let chain = Promise.resolve();
  function persist() {
    const p = chain.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(db), { mode: 0o600 });
      await fsp.rename(tmp, file);
    });
    chain = p.catch(() => {});
    return p;
  }

  // ── change notifications (used for live updates) ─────────────
  const listeners = new Map();      // uid -> Set<fn(type)>
  function subscribe(uid, fn) {
    if (!listeners.has(uid)) listeners.set(uid, new Set());
    listeners.get(uid).add(fn);
    return () => { const s = listeners.get(uid); if (s) { s.delete(fn); if (!s.size) listeners.delete(uid); } };
  }
  const subscriberCount = (uid) => (listeners.get(uid) ? listeners.get(uid).size : 0);
  function emit(uid, type) {
    (listeners.get(uid) || []).forEach((fn) => { try { fn(type); } catch { /* a dead stream must not break writers */ } });
  }

  const ud = (uid) => {
    if (!db.data[uid]) db.data[uid] = { expenses: {}, income: {}, budgets: {}, chat: [], meta: {}, rev: 0 };
    return db.data[uid];
  };
  const toList = (obj) => Object.entries(obj || {}).map(([id, v]) => ({ id, ...v }));

  // ── users & sessions ─────────────────────────────────────────
  async function createUser({ email, name, passHash }) {
    if (db.emails[email]) { const e = new Error('EMAIL_TAKEN'); e.code = 'EMAIL_TAKEN'; throw e; }
    const id = 'u_' + crypto.randomBytes(12).toString('hex');
    db.users[id] = { id, email, name: name || '', passHash, createdAt: now() };
    db.emails[email] = id;
    await persist();
    return publicUser(db.users[id]);
  }
  const publicUser = (u) => u && ({ id: u.id, email: u.email, name: u.name });
  const getUserByEmail = (email) => (db.emails[email] ? db.users[db.emails[email]] : null);
  const getUserById = (id) => publicUser(db.users[id]);

  async function createSession(uid, tokenHash, expires) {
    // opportunistic cleanup of expired sessions
    for (const [h, s] of Object.entries(db.sessions)) if (s.expires <= now()) delete db.sessions[h];
    db.sessions[tokenHash] = { uid, expires };
    await persist();
  }
  function getSession(tokenHash) {
    const s = db.sessions[tokenHash];
    if (!s) return null;
    if (s.expires <= now()) { delete db.sessions[tokenHash]; return null; }
    return s;
  }
  async function deleteSession(tokenHash) {
    if (db.sessions[tokenHash]) { delete db.sessions[tokenHash]; await persist(); }
  }

  // ── financial data ───────────────────────────────────────────
  function snapshot(uid) {
    const d = ud(uid);
    return { rev: d.rev, data: { expenses: d.expenses, income: d.income, budgets: d.budgets } };
  }
  async function commit(uid, type = 'data') {
    ud(uid).rev++;
    await persist();
    emit(uid, type);
    return snapshot(uid);
  }

  async function upsertTx(uid, coll, id, rec) {
    const c = ud(uid)[coll];
    if (!c[id] && Object.keys(c).length >= MAX_PER_COLLECTION) { const e = new Error('LIMIT'); e.code = 'LIMIT'; throw e; }
    c[id] = c[id] ? { ...rec, createdAt: c[id].createdAt, updatedAt: now() } : { ...rec, createdAt: now() };
    return commit(uid);
  }
  async function deleteTx(uid, coll, id) {
    delete ud(uid)[coll][id];
    return commit(uid);
  }
  async function importTx(uid, coll, records) {
    const c = ud(uid)[coll];
    const fresh = records.filter((r) => !c[r.id]).length;
    if (Object.keys(c).length + fresh > MAX_PER_COLLECTION) { const e = new Error('LIMIT'); e.code = 'LIMIT'; throw e; }
    let added = 0;
    for (const { id, createdAt, ...rec } of records) {
      if (!c[id]) added++;
      c[id] = c[id] ? { ...rec, createdAt: c[id].createdAt, updatedAt: now() } : { ...rec, createdAt: createdAt || now() };
    }
    const snap = await commit(uid);
    return { ...snap, added };
  }
  async function setBudget(uid, month, amount, { onlyIfMissing = false } = {}) {
    const b = ud(uid).budgets;
    if (onlyIfMissing && b[month]) return snapshot(uid);
    b[month] = amount;
    return commit(uid);
  }
  async function deleteBudget(uid, month) { delete ud(uid).budgets[month]; return commit(uid); }
  async function clearAll(uid) {
    const d = ud(uid);
    d.expenses = {}; d.income = {}; d.budgets = {};
    return commit(uid);
  }

  const getMeta = (uid, key) => ud(uid).meta[key];
  async function setMeta(uid, key, value) { ud(uid).meta[key] = value; await persist(); }

  // ── interface used by the chat handler ───────────────────────
  async function loadUserData(uid) {
    const d = ud(uid);
    return { expenses: toList(d.expenses), income: toList(d.income), budgets: { ...d.budgets } };
  }
  async function getChatHistory(uid, limit = 8) { return ud(uid).chat.slice(-limit).map((m) => ({ ...m })); }
  async function appendChat(uid, messages) {
    const d = ud(uid);
    d.chat.push(...messages);
    if (d.chat.length > MAX_CHAT) d.chat.splice(0, d.chat.length - MAX_CHAT);
    await persist();
    emit(uid, 'chat');
  }
  async function clearChat(uid) { ud(uid).chat = []; await persist(); emit(uid, 'chat'); }

  return {
    createUser, getUserByEmail, getUserById, createSession, getSession, deleteSession,
    snapshot, upsertTx, deleteTx, importTx, setBudget, deleteBudget, clearAll, getMeta, setMeta,
    loadUserData, getChatHistory, appendChat, clearChat, subscribe, subscriberCount,
    flush: () => chain, _db: () => db,
  };
}

module.exports = { createStore, MAX_PER_COLLECTION, MAX_CHAT };
