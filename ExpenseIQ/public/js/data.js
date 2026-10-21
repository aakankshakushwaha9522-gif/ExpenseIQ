/**
 * data.js — data layer for ExpenseIQ
 *
 * The browser keeps an in-memory cache of the signed-in user's data. It is fed by
 *   1. GET /api/data                  (initial load)
 *   2. GET /api/events                (Server-Sent Events: the server pushes a fresh snapshot
 *                                      whenever data changes — from this tab, another tab or another device)
 * and every screen renders from that cache, so all views update automatically.
 *
 * Writes are OPTIMISTIC: they are applied to the cache immediately and queued; the queue is sent
 * to the server in order. If the network is down the queue waits and is retried automatically when
 * the connection returns. If the server rejects a write, it is dropped, the view rolls back, and the
 * user is told. Snapshots carry a revision number so stale ones are ignored.
 */

/** Minimal fetch wrapper. Throws TypeError on network failure; otherwise returns { ok, status, data }. */
async function apiFetch(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ExpenseIQ' },   // required by the server (CSRF defence)
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty / non-JSON body */ }
  return { ok: res.ok, status: res.status, data };
}

const Store = (function () {
  const { validateTransaction, validateBudget, round2, planImport, legacyKey } = Shared;

  let active = false;
  let uid = null;
  let server = { expenses: {}, income: {}, budgets: {} };   // last snapshot from the server
  let rev = -1;
  let pending = [];                                         // queued writes not yet confirmed by the server
  let cache = { expenses: [], income: [], budgets: {} };    // server snapshot + pending writes
  let ready = false;
  let connected = null;                                     // null = unknown, true/false after first signal
  let lastError = null;
  let es = null;
  let flushing = false;
  let retryTimer = null;
  const subs = new Set();
  const chatSubs = new Set();
  let onWriteError = () => {};
  let onSessionExpired = () => {};

  const toArray = (obj) => Object.entries(obj || {}).map(([id, v]) => ({ id, ...v }));
  function emit() { subs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }
  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
  const onChat = (fn) => { chatSubs.add(fn); return () => chatSubs.delete(fn); };
  const setWriteErrorHandler = (fn) => { onWriteError = fn; };
  const setSessionExpiredHandler = (fn) => { onSessionExpired = fn; };

  // ─── view = server snapshot + queued writes ─────────────────────
  function recompute() {
    const view = { expenses: { ...server.expenses }, income: { ...server.income }, budgets: { ...server.budgets } };
    for (const op of pending) {
      if (op.type === 'put') view[op.coll][op.id] = { ...(view[op.coll][op.id] || {}), ...op.rec, createdAt: (view[op.coll][op.id] || {}).createdAt || op.at };
      else if (op.type === 'del') delete view[op.coll][op.id];
      else if (op.type === 'budget') view.budgets[op.month] = op.amount;
      else if (op.type === 'budgetDel') delete view.budgets[op.month];
    }
    cache = { expenses: toArray(view.expenses), income: toArray(view.income), budgets: view.budgets };
    emit();
  }

  function applySnapshot(snap) {
    if (!snap || typeof snap.rev !== 'number' || snap.rev < rev) return;      // stale
    rev = snap.rev;
    server = { expenses: snap.data.expenses || {}, income: snap.data.income || {}, budgets: snap.data.budgets || {} };
    ready = true;
    lastError = null;
    recompute();
  }

  function sessionExpired() {
    if (!active) return;
    pending = [];
    onSessionExpired();
  }

  // ─── sending queued writes ──────────────────────────────────────
  const opRequest = (op) => {
    if (op.type === 'put') return ['PUT', `/api/${op.coll}/${op.id}`, op.rec];
    if (op.type === 'del') return ['DELETE', `/api/${op.coll}/${op.id}`];
    if (op.type === 'budget') return ['PUT', `/api/budgets/${op.month}`, { amount: op.amount }];
    return ['DELETE', `/api/budgets/${op.month}`];
  };

  async function flush() {
    if (flushing || !active) return;
    flushing = true;
    clearTimeout(retryTimer);
    try {
      while (pending.length && active) {
        const op = pending[0];
        let res;
        try { res = await apiFetch(...opRequest(op)); }
        catch {                                         // network down: keep the queue, retry later
          connected = false; emit();
          retryTimer = setTimeout(flush, 3000);
          return;
        }
        if (!active) return;
        if (res.status === 401) { sessionExpired(); return; }
        pending.shift();
        if (res.ok) applySnapshot(res.data);
        else { onWriteError(res.data.error || 'A change could not be saved.'); recompute(); }
      }
    } finally { flushing = false; }
  }

  // ─── live stream ────────────────────────────────────────────────
  function openStream() {
    if (!active) return;
    es = new EventSource('/api/events');
    es.onopen = () => { connected = true; emit(); flush(); };
    es.addEventListener('data', (e) => { try { applySnapshot(JSON.parse(e.data)); } catch { /* ignore */ } });
    es.addEventListener('chat', (e) => { try { const { messages } = JSON.parse(e.data); chatSubs.forEach((fn) => fn(messages)); } catch { /* ignore */ } });
    es.addEventListener('signout', () => sessionExpired());
    es.onerror = async () => {
      connected = false; emit();
      if (es && es.readyState === EventSource.CLOSED) {      // the browser gave up (e.g. HTTP 401) — find out why
        es = null;
        try {
          const r = await apiFetch('GET', '/api/auth/me');
          if (r.status === 401) return sessionExpired();
        } catch { /* offline */ }
        setTimeout(openStream, 3000);
      }
    };
  }

  async function loadInitial() {
    try {
      const res = await apiFetch('GET', '/api/data');
      if (res.status === 401) return sessionExpired();
      if (res.ok) applySnapshot(res.data);
      else { lastError = 'Could not load your data from the server.'; ready = true; emit(); }
    } catch {
      lastError = 'Could not reach the server. Retrying…';
      emit();
      setTimeout(() => { if (active && !ready) loadInitial(); }, 3000);
    }
  }

  const onlineHandler = () => flush();
  function start(userId) {
    stop();
    active = true;
    uid = userId;
    window.addEventListener('online', onlineHandler);
    loadInitial();
    openStream();
  }

  function stop() {
    active = false;
    if (es) { es.close(); es = null; }
    clearTimeout(retryTimer);
    window.removeEventListener('online', onlineHandler);
    uid = null; server = { expenses: {}, income: {}, budgets: {} }; rev = -1; pending = [];
    cache = { expenses: [], income: [], budgets: {} };
    ready = false; connected = null; lastError = null; flushing = false;
    emit();
  }

  const isReady = () => ready;
  const getUid = () => uid;

  // ─── Mutations ─────────────────────────────────────────────────
  const collection = (kind) => (kind === 'income' ? 'income' : 'expenses');
  const newId = () => {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  };
  function clean(fields) {
    return {
      date: String(fields.date).trim(),
      category: String(fields.category).trim(),
      amount: round2(fields.amount),
      description: String(fields.description).trim(),
    };
  }
  function enqueue(op) { pending.push({ ...op, at: Date.now() }); recompute(); flush(); }

  function addTransaction(kind, fields) {
    if (!active) return { success: false, error: 'You are not signed in.' };
    const err = validateTransaction(fields, kind);
    if (err) return { success: false, error: err };
    const id = newId();
    const rec = clean(fields);
    enqueue({ type: 'put', coll: collection(kind), id, rec });
    return { success: true, id, record: rec };
  }

  function updateTransaction(kind, id, fields) {
    if (!active) return { success: false, error: 'You are not signed in.' };
    const exists = (kind === 'income' ? cache.income : cache.expenses).some((e) => e.id === id);
    if (!exists) return { success: false, error: 'This item no longer exists (it may have been deleted on another device).' };
    const err = validateTransaction(fields, kind);
    if (err) return { success: false, error: err };
    enqueue({ type: 'put', coll: collection(kind), id, rec: clean(fields) });
    return { success: true };
  }

  function deleteTransaction(kind, id) {
    if (!active) return false;
    enqueue({ type: 'del', coll: collection(kind), id });
    return true;
  }

  function setBudget(month, amount) {
    const err = validateBudget(month, amount);
    if (err) return { success: false, error: err };
    enqueue({ type: 'budget', month, amount: round2(amount) });
    return { success: true };
  }

  function deleteBudget(month) { enqueue({ type: 'budgetDel', month }); }

  async function call(method, url, body) {
    const res = await apiFetch(method, url, body);
    if (res.status === 401) { sessionExpired(); throw new Error('Session expired'); }
    if (!res.ok) throw new Error(res.data.error || 'Request failed');
    return res.data;
  }

  /** CSV import: skips rows already in the account; ids are deterministic so repeats cannot duplicate. */
  async function importExpenses(rows) {
    const plan = planImport(rows, cache.expenses);
    if (!plan.fresh.length) return { added: 0, duplicates: plan.duplicates };
    const data = await call('POST', '/api/import', {
      expenses: plan.fresh.map((r) => ({ id: r.id, date: r.date, category: r.category, amount: r.amount, description: r.description })),
    });
    applySnapshot(data);
    return { added: data.added, duplicates: plan.duplicates + (plan.fresh.length - data.added) };
  }

  async function clearAll() {
    pending = [];
    applySnapshot(await call('DELETE', '/api/data'));
  }

  // ─── Legacy localStorage migration ─────────────────────────────
  const LEGACY_EXP = 'expenseiq_expenses_v2';
  const LEGACY_BUD = 'expenseiq_budgets_v2';

  function readLegacy() {
    try {
      const e = JSON.parse(localStorage.getItem(LEGACY_EXP) || '[]');
      const b = JSON.parse(localStorage.getItem(LEGACY_BUD) || '{}');
      const expenses = (Array.isArray(e) ? e : []).filter((x) => x && !validateTransaction(x, 'expense'));
      const budgets = {};
      Object.entries(b && typeof b === 'object' ? b : {}).forEach(([m, v]) => { if (!validateBudget(m, v)) budgets[m] = Number(v); });
      return { expenses, budgets };
    } catch { return { expenses: [], budgets: {} }; }
  }
  const clearLegacy = () => { localStorage.removeItem(LEGACY_EXP); localStorage.removeItem(LEGACY_BUD); };

  /** Returns legacy data if present AND this account has not been migrated/skipped yet. */
  async function pendingMigration() {
    const legacy = readLegacy();
    if (!legacy.expenses.length && !Object.keys(legacy.budgets).length) return null;
    const res = await apiFetch('GET', '/api/migration');
    if (!res.ok) throw new Error('migration status unavailable');
    return res.data.done ? null : legacy;
  }

  /** Idempotent: keys derive from legacy ids, and the server refuses a second migration. */
  async function migrate(legacy) {
    const data = await call('POST', '/api/migration', {
      expenses: legacy.expenses.map((e) => ({
        id: legacyKey(e.id), ...clean(e), createdAt: Date.parse(e.createdAt) || undefined,
      })),
      budgets: legacy.budgets,
    });
    applySnapshot(data);
    clearLegacy();
    return data.imported;
  }

  async function skipMigration() {
    await call('POST', '/api/migration/skip');
    clearLegacy();
  }

  return {
    subscribe, onChat, start, stop, isReady, getUid, setWriteErrorHandler, setSessionExpiredHandler,
    notifySessionExpired: sessionExpired,
    addTransaction, updateTransaction, deleteTransaction, setBudget, deleteBudget,
    importExpenses, clearAll, pendingMigration, migrate, skipMigration,
    get expenses() { return cache.expenses; },
    get income() { return cache.income; },
    get budgets() { return cache.budgets; },
    get connected() { return connected; },
    get error() { return lastError; },
    get pendingCount() { return pending.length; },
  };
}());

// ─── Synchronous helpers kept from the original API ───────────────
const getExpenses   = () => [...Store.expenses];
const getIncome     = () => [...Store.income];
const getBudget     = (month) => Store.budgets[month] || 0;
const getAllBudgets = () => ({ ...Store.budgets });
const { fmtAmt, fmtMonth, getCat, esc } = Shared;
const getCatColor = (cat, kind) => getCat(cat, kind).color;
const getCatEmoji = (cat, kind) => getCat(cat, kind).emoji;
const todayStr  = () => Shared.localDateStr();
const thisMonth = () => Shared.localMonthStr();

function sumMonth(list, month) {
  return Shared.round2(list.filter((e) => e.date && e.date.startsWith(month)).reduce((s, e) => s + (e.amount || 0), 0));
}
const totalForMonth = (month) => sumMonth(Store.expenses, month);
const incomeForMonth = (month) => sumMonth(Store.income, month);

function spendingByCategory(month) {
  const map = {};
  Store.expenses
    .filter((e) => !month || (e.date && e.date.startsWith(month)))
    .forEach((e) => { map[e.category] = (map[e.category] || 0) + e.amount; });
  return map;
}

function monthlyTotals(lastN = 6) {
  const result = [];
  const now = new Date();
  for (let i = lastN - 1; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = Shared.localMonthStr(dt);
    result.push({ month: m, total: totalForMonth(m), budget: getBudget(m) });
  }
  return result;
}

function topSpendingDays(n = 5) {
  const map = {};
  Store.expenses.forEach((e) => { map[e.date] = (map[e.date] || 0) + e.amount; });
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n).map(([date, total]) => ({ date, total }));
}

function statistics() {
  const list = Store.expenses;
  if (!list.length) return null;
  const amounts = list.map((e) => e.amount);
  const total = amounts.reduce((s, a) => s + a, 0);
  const max = Math.max(...amounts);
  const min = Math.min(...amounts);
  const topCat = Object.entries(spendingByCategory()).sort((a, b) => b[1] - a[1])[0];
  return {
    total, avg: total / amounts.length, max, min,
    maxExp: list.find((e) => e.amount === max), minExp: list.find((e) => e.amount === min),
    count: list.length, topCat,
  };
}

function exportToCSV() { return Store.expenses.length ? Shared.toCSV(Store.expenses) : null; }
function exportBudgetsJSON() { return JSON.stringify(Store.budgets, null, 2); }

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
