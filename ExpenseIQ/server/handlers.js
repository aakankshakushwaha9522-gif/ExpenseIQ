'use strict';
/**
 * handlers.js — all API logic, independent of the HTTP layer.
 * Every handler takes plain inputs and returns { status, body, cookie? }.
 *
 * SECURITY MODEL
 *  • The user id comes ONLY from the server-side session found via the session cookie —
 *    never from the URL or request body — so one user cannot address another's data.
 *  • All input is validated here (and by the same shared validator the browser uses).
 */
const finance = require('./finance');
const auth = require('./auth');
const Shared = require('../public/js/shared.js');
const { askGemini, GeminiError } = require('./gemini');

const MAX_MESSAGE_LEN = 500;
const MAX_IMPORT_ROWS = 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const COLLECTIONS = { expenses: 'expense', income: 'income' };
const json = (status, body, extra = {}) => ({ status, body, ...extra });
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function createHandlers({ config, store, ask = askGemini, now = () => new Date(), throttle = new auth.LoginThrottle() }) {
  const sessionMs = config.sessionDays * 24 * 60 * 60 * 1000;
  const cookieOpts = { maxAgeSec: Math.floor(sessionMs / 1000), secure: config.cookieSecure };

  async function openSession(uid) {
    const token = auth.newToken();
    await store.createSession(uid, auth.hashToken(token), Date.now() + sessionMs);
    return { set: auth.sessionCookie(token, cookieOpts) };
  }
  const clearCookie = () => ({ set: auth.sessionCookie('', { ...cookieOpts, maxAgeSec: 0 }) });

  /** token (raw cookie value) → { uid, user } | { error } */
  async function authenticate(token) {
    if (!token || typeof token !== 'string' || token.length > 200) return { error: json(401, { error: 'Please sign in.' }) };
    const s = store.getSession(auth.hashToken(token));
    const user = s && store.getUserById(s.uid);
    if (!user) return { error: json(401, { error: 'Your session has expired. Please sign in again.' }, { cookie: clearCookie() }) };
    return { uid: user.id, user };
  }

  // ── authentication ─────────────────────────────────────────────
  async function register({ body }) {
    const b = isObj(body) ? body : {};
    const emailErr = auth.validateEmail(b.email);
    if (emailErr) return json(400, { error: emailErr });
    const passErr = auth.validatePassword(b.password);
    if (passErr) return json(400, { error: passErr });
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 60) : '';
    const email = auth.normalizeEmail(b.email);
    let user;
    try {
      user = await store.createUser({ email, name, passHash: await auth.hashPassword(b.password) });
    } catch (e) {
      if (e.code === 'EMAIL_TAKEN') return json(409, { error: 'An account with this email already exists. Try signing in.' });
      throw e;
    }
    return json(201, { user }, { cookie: await openSession(user.id) });
  }

  async function login({ body, ip }) {
    const b = isObj(body) ? body : {};
    const email = auth.normalizeEmail(b.email);
    const password = typeof b.password === 'string' ? b.password : '';
    if (!email || !password) return json(400, { error: 'Please enter your email and password.' });

    const t = throttle.check(ip, email);
    if (t.blocked) {
      return json(429, { error: `Too many failed attempts. Try again in ${Math.ceil(t.retryAfterSec / 60)} minute(s).` },
        { headers: { 'Retry-After': String(t.retryAfterSec) } });
    }
    const user = store.getUserByEmail(email);
    let ok = false;
    if (user) ok = await auth.verifyPassword(password.slice(0, auth.MAX_PASSWORD), user.passHash);
    else await auth.burnTime(password.slice(0, auth.MAX_PASSWORD));
    if (!ok) {
      throttle.fail(ip, email);
      return json(401, { error: 'Incorrect email or password.' });
    }
    throttle.success(ip, email);
    return json(200, { user: store.getUserById(user.id) }, { cookie: await openSession(user.id) });
  }

  async function logout({ token }) {
    if (token) await store.deleteSession(auth.hashToken(token));      // really invalidates the session server-side
    return json(200, { ok: true }, { cookie: clearCookie() });
  }

  async function me({ token }) {
    const a = await authenticate(token);
    if (a.error) return a.error;
    return json(200, { user: a.user });
  }

  // ── data ───────────────────────────────────────────────────────
  async function withUser(token, fn) {
    const a = await authenticate(token);
    if (a.error) return a.error;
    return fn(a.uid);
  }

  const getData = ({ token }) => withUser(token, async (uid) => json(200, store.snapshot(uid)));

  function cleanTx(b, kind) {
    const err = Shared.validateTransaction(isObj(b) ? b : {}, kind);
    if (err) return { error: err };
    return { rec: { date: String(b.date).trim(), category: String(b.category).trim(), amount: Shared.round2(b.amount), description: String(b.description).trim() } };
  }

  const putTx = ({ token, coll, id, body }) => withUser(token, async (uid) => {
    if (!COLLECTIONS[coll] || !ID_RE.test(id || '')) return json(400, { error: 'Invalid request.' });
    const { rec, error } = cleanTx(body, COLLECTIONS[coll]);
    if (error) return json(400, { error });
    try { return json(200, await store.upsertTx(uid, coll, id, rec)); }
    catch (e) { if (e.code === 'LIMIT') return json(400, { error: 'Storage limit reached for this account.' }); throw e; }
  });

  const deleteTx = ({ token, coll, id }) => withUser(token, async (uid) => {
    if (!COLLECTIONS[coll] || !ID_RE.test(id || '')) return json(400, { error: 'Invalid request.' });
    return json(200, await store.deleteTx(uid, coll, id));
  });

  const putBudget = ({ token, month, body }) => withUser(token, async (uid) => {
    const err = Shared.validateBudget(month, isObj(body) ? body.amount : undefined);
    if (err) return json(400, { error: err });
    return json(200, await store.setBudget(uid, month, Shared.round2(body.amount)));
  });

  const deleteBudget = ({ token, month }) => withUser(token, async (uid) => {
    if (!Shared.isMonth(month)) return json(400, { error: 'Invalid month.' });
    return json(200, await store.deleteBudget(uid, month));
  });

  const clearAll = ({ token }) => withUser(token, async (uid) => json(200, await store.clearAll(uid)));

  /** Validates a list of {id, date, category, amount, description}. All-or-nothing. */
  function cleanRows(rows) {
    if (!Array.isArray(rows) || rows.length > MAX_IMPORT_ROWS) return { error: `Provide at most ${MAX_IMPORT_ROWS} rows.` };
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!isObj(r) || !ID_RE.test(String(r.id || ''))) return { error: `Row ${i + 1}: invalid id.` };
      const { rec, error } = cleanTx(r, 'expense');
      if (error) return { error: `Row ${i + 1}: ${error}` };
      const createdAt = Number(r.createdAt);
      out.push({ id: r.id, ...rec, ...(Number.isFinite(createdAt) && createdAt > 0 ? { createdAt } : {}) });
    }
    return { rows: out };
  }

  /** CSV import. Ids are deterministic on the client, so repeating a request cannot duplicate rows. */
  const importExpenses = ({ token, body }) => withUser(token, async (uid) => {
    const { rows, error } = cleanRows(isObj(body) ? body.expenses : null);
    if (error) return json(400, { error });
    try { return json(200, await store.importTx(uid, 'expenses', rows)); }
    catch (e) { if (e.code === 'LIMIT') return json(400, { error: 'Storage limit reached for this account.' }); throw e; }
  });

  // ── one-time migration of the old localStorage data ─────────────
  const migrationStatus = ({ token }) => withUser(token, async (uid) => json(200, { done: Boolean(store.getMeta(uid, 'legacyMigration')) }));

  const migrate = ({ token, body }) => withUser(token, async (uid) => {
    if (store.getMeta(uid, 'legacyMigration')) return json(409, { error: 'Migration already completed for this account.' });
    const b = isObj(body) ? body : {};
    const { rows, error } = cleanRows(b.expenses || []);
    if (error) return json(400, { error });
    let imported = 0;
    if (rows.length) imported = (await store.importTx(uid, 'expenses', rows)).added;
    const budgets = isObj(b.budgets) ? b.budgets : {};
    for (const [m, v] of Object.entries(budgets)) {
      if (!Shared.validateBudget(m, v)) await store.setBudget(uid, m, Shared.round2(v), { onlyIfMissing: true });   // never overwrite
    }
    await store.setMeta(uid, 'legacyMigration', { at: Date.now(), imported });
    return json(200, { imported, ...store.snapshot(uid) });
  });

  const skipMigration = ({ token }) => withUser(token, async (uid) => {
    await store.setMeta(uid, 'legacyMigration', { at: Date.now(), imported: 0 });
    return json(200, { ok: true });
  });

  // ── AI assistant ───────────────────────────────────────────────
  function health() {
    return json(200, { status: 'ok', geminiConfigured: config.geminiConfigured });
  }

  async function chat({ token, body }) {
    const a = await authenticate(token);
    if (a.error) return a.error;

    const b = isObj(body) ? body : {};
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (!message) return json(400, { error: 'Message is required.' });
    if (message.length > MAX_MESSAGE_LEN) return json(400, { error: `Message is too long (max ${MAX_MESSAGE_LEN} characters).` });
    const t = now();
    const month = b.month !== undefined ? b.month : t.toISOString().slice(0, 7);
    const today = b.today !== undefined ? b.today : t.toISOString().slice(0, 10);
    if (!finance.isMonth(month) || !finance.isDate(today)) return json(400, { error: 'Invalid month or date.' });

    let data, history;
    try {
      // Data is ALWAYS read server-side for the logged-in user; the client cannot supply
      // financial data or another user's id.
      [data, history] = await Promise.all([store.loadUserData(a.uid), store.getChatHistory(a.uid, 8)]);
    } catch {
      return json(502, { error: 'Could not load your data. Please try again.' });
    }

    const summary = finance.buildSummary(data, { month, today });
    const userMsg = { role: 'user', text: message, ts: t.getTime() };

    let reply, degraded = false, notice = null;
    try {
      reply = await ask({ apiKey: config.gemini.apiKey, model: config.gemini.model, summary, history, message });
    } catch (err) {
      // Log only the error class/code — never prompt text or financial data.
      console.warn('[chat] AI error:', err instanceof GeminiError ? err.code : (err && err.name));
      degraded = true;
      notice = err instanceof GeminiError ? err.message : 'The AI service is unavailable.';
      reply = finance.fallbackDigest(summary);
    }

    const botMsg = { role: 'assistant', text: reply, ts: Math.max(Date.now(), userMsg.ts + 1), degraded };
    try { await store.appendChat(a.uid, [userMsg, botMsg]); } catch { /* answer is still returned */ }
    return json(200, { reply, degraded, notice, timestamp: botMsg.ts });
  }

  const chatHistory = ({ token }) => withUser(token, async (uid) => json(200, { messages: await store.getChatHistory(uid, 100) }));

  const clearHistory = ({ token }) => withUser(token, async (uid) => {
    try { await store.clearChat(uid); return json(200, { ok: true }); }
    catch { return json(502, { error: 'Could not clear chat history.' }); }
  });

  return {
    authenticate, register, login, logout, me, getData, putTx, deleteTx, putBudget, deleteBudget, clearAll,
    importExpenses, migrationStatus, migrate, skipMigration, health, chat, chatHistory, clearHistory,
  };
}

module.exports = { createHandlers, MAX_MESSAGE_LEN, MAX_IMPORT_ROWS, ID_RE };
