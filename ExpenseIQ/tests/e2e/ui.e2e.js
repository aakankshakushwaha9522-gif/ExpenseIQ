'use strict';
/**
 * End-to-end UI tests (real Chromium via Playwright) against:
 *   - the REAL frontend (public/) and the REAL server (own login, storage, live updates)
 *   - only the Gemini call is stubbed; Chart.js (a CDN script) is replaced by an empty script
 * Two browser pages act as two devices of one account.
 *
 * Run:  NODE_PATH=$(npm root -g) node --test tests/e2e/ui.e2e.js
 *   (or `npm run test:e2e` if playwright is a local devDependency)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { startHarness, GeminiError } = require('./harness');

let h, browser;
const problems = [];       // console errors / page errors across ALL pages
let askMode = 'ok';

// Google Fonts are unreachable in the sandbox and irrelevant to behaviour: abort them so `load` fires.
async function newCtx(extra = {}) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', locale: 'en-IN', viewport: { width: 1280, height: 900 }, acceptDownloads: true, ...extra });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.route(/cdn\.jsdelivr\.net/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '/* Chart.js stubbed for tests */' }));
  return ctx;
}

async function device(opts = {}) {
  const ctx = opts.ctx || await newCtx();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  page.on('dialog', (d) => { problems.push('unexpected dialog: ' + d.message()); d.dismiss(); });
  await page.goto(h.url);
  return page;
}
const nav = (page, screen) => page.locator(`.nav-link[data-screen="${screen}"]`).click();
const kpi = async (page, label) => {
  const card = page.locator('#kpi-grid .kpi', { has: page.locator('.kpi-label', { hasText: label }) }).first();
  return (await card.locator('.kpi-value').innerText()).trim();
};
async function register(page, email, pass = 'secret123', name = '') {
  await page.locator('#auth-link-register').click();
  if (name) await page.fill('#auth-name', name);
  await page.fill('#auth-email', email);
  await page.fill('#auth-pass', pass);
  await page.click('#auth-submit');
  await page.waitForSelector('#auth-overlay.hidden', { state: 'attached' });
  await page.waitForSelector('#main:not(.loading)');
}
async function addTx(page, kind, { cat, amount, desc, date }) {
  await nav(page, 'add');
  await page.click(`#seg-${kind}`);
  if (date) await page.fill('#in-date', date);
  await page.selectOption('#in-cat', cat);
  await page.fill('#in-amount', String(amount));
  await page.fill('#in-desc', desc);
  await page.click('#add-submit');
}

test.before(async () => {
  h = await startHarness({
    ask: async (o) => {
      if (askMode === 'slow') { await new Promise((r) => setTimeout(r, 700)); }
      if (askMode === 'fail') throw new GeminiError('The AI service timed out.', 'TIMEOUT', 504);
      return `You spent **₹${o.summary.thisMonth.totalSpent}** this month.\n- Top: ${o.summary.thisMonth.topCategory ? o.summary.thisMonth.topCategory.category : 'none'}`;
    },
  });
  browser = await chromium.launch();
});
test.after(async () => { await browser.close(); await h.close(); });

let A, A2, email = 'alice@example.com';

test('boot: unauthenticated users see the sign-in screen, not data', async () => {
  A = await device();
  await A.waitForSelector('#auth-overlay:not(.hidden)');
  assert.equal(await A.locator('#auth-title').innerText(), 'Sign in');
  assert.ok(await A.locator('#auth-overlay').isVisible());
});

test('auth: wrong password and weak password are rejected with clear messages', async () => {
  await A.fill('#auth-email', 'nobody@example.com');
  await A.fill('#auth-pass', 'whatever1');
  await A.click('#auth-submit');
  await A.waitForSelector('#auth-feedback.error');
  assert.match(await A.locator('#auth-feedback').innerText(), /Incorrect email or password/);

  await A.click('#auth-link-register');
  await A.fill('#auth-email', email);
  await A.fill('#auth-pass', '1234567');
  await A.click('#auth-submit');
  assert.match(await A.locator('#auth-feedback').innerText(), /at least 8/);
});

test('registration signs the user in and shows an empty-state dashboard', async () => {
  await A.fill('#auth-name', 'Alice Doe');
  await A.fill('#auth-pass', 'secret123');
  await A.click('#auth-submit');
  await A.waitForSelector('#auth-overlay.hidden', { state: 'attached' });
  await A.waitForSelector('#main:not(.loading)');
  assert.match(await A.locator('#dash-greeting').innerText(), /Alice/);
  assert.match(await A.locator('#dash-recent-list').innerText(), /No expenses yet/);
  assert.equal(await kpi(A, 'Expenses'), '₹0.00');
  assert.equal(await A.locator('#user-email').innerText(), email);
});

test('realtime: adding an expense updates the dashboard immediately, without reload', async () => {
  await addTx(A, 'expense', { cat: 'Food', amount: 250, desc: 'Lunch at café' });
  await A.waitForSelector('#add-feedback.success');
  await nav(A, 'dashboard');
  await A.waitForFunction(() => document.querySelector('#kpi-grid').innerText.includes('250.00'));
  assert.equal(await kpi(A, 'Expenses'), '₹250.00');
  assert.match(await A.locator('#dash-recent-list').innerText(), /Lunch at café/);
});

test('income + balance KPIs; budget progress and remaining update live', async () => {
  await addTx(A, 'income', { cat: 'Salary', amount: 5000, desc: 'October salary' });
  await nav(A, 'budget');
  await A.fill('#bud-month', await A.evaluate(() => thisMonth()));
  await A.fill('#bud-amount', '1000');
  await A.click('#budget-form button[type=submit]');
  await A.waitForSelector('#budget-feedback.success');
  await A.waitForFunction(() => document.querySelector('#budget-status-body').innerText.includes('left for the month'));
  assert.match(await A.locator('#budget-status-body').innerText(), /750\.00 left/);
  assert.equal(await A.locator('#budget-status-body .budget-bar-wrap').getAttribute('aria-valuenow'), '25');
  await nav(A, 'dashboard');
  assert.equal(await kpi(A, 'Income'), '₹5,000.00');
  assert.equal(await kpi(A, 'Balance'), '₹4,750.00');
  assert.equal(await kpi(A, 'Budget Remaining'), '₹750.00');
});

test('validation: bad inputs are rejected with messages and nothing is saved', async () => {
  const uidA = await A.evaluate(() => Store.getUid());
  const before = Object.keys(h.store.snapshot(uidA).data.expenses).length;
  await nav(A, 'add');
  await A.click('#seg-expense');
  await A.fill('#in-amount', '-5');
  await A.click('#add-submit');
  assert.match(await A.locator('#add-feedback').innerText(), /Date|Category|Amount/);
  await A.selectOption('#in-cat', 'Food');
  await A.fill('#in-desc', 'x');
  await A.click('#add-submit');
  assert.match(await A.locator('#add-feedback').innerText(), /positive/);
  await A.fill('#in-amount', '0');
  await A.click('#add-submit');
  assert.match(await A.locator('#add-feedback').innerText(), /positive/);
  const after = Object.keys(h.store.snapshot(uidA).data.expenses).length;
  assert.equal(after, before);
});

test('edit and delete (with confirm modal, Esc to cancel, focus restored)', async () => {
  await nav(A, 'expenses');
  await A.locator('[data-action="edit"]').first().click();
  await A.fill('#ed-amount', '300');
  await A.fill('#ed-desc', 'Lunch (edited)');
  await A.click('#edit-form button[type=submit]');
  await A.waitForFunction(() => document.querySelector('#expense-tbody').innerText.includes('Lunch (edited)'));
  assert.match(await A.locator('#expense-tbody').innerText(), /300\.00/);

  const del = A.locator('[data-action="delete"]').first();
  await del.focus();
  await del.click();
  await A.waitForSelector('#modal-overlay:not(.hidden)');
  await A.keyboard.press('Escape');
  await A.waitForSelector('#modal-overlay.hidden', { state: 'attached' });
  assert.match(await A.locator('#expense-tbody').innerText(), /Lunch \(edited\)/, 'Esc must cancel');
  assert.equal(await A.evaluate(() => document.activeElement.dataset.action), 'delete', 'focus returns to trigger');

  await del.click();
  await A.click('#modal-confirm');
  await A.waitForSelector('#expense-empty:not(.hidden)');
});

test('SECURITY: HTML in descriptions is escaped, never executed', async () => {
  await addTx(A, 'expense', { cat: 'Other', amount: 10, desc: '<img src=x onerror="window.__xss=1">' });
  await nav(A, 'expenses');
  await A.waitForSelector('#expense-tbody tr');
  assert.equal(await A.evaluate(() => window.__xss), undefined);
  assert.equal(await A.locator('#expense-tbody img').count(), 0);
  assert.match(await A.locator('#expense-tbody').innerText(), /<img src=x/);
});

test('filters: category, search, date range, clear', async () => {
  const today = await A.evaluate(() => todayStr());
  await addTx(A, 'expense', { cat: 'Travel', amount: 800, desc: 'Uber to airport', date: today });
  await addTx(A, 'expense', { cat: 'Travel', amount: 40, desc: 'Old bus ticket', date: '2020-01-15' });
  await nav(A, 'expenses');
  const rows = () => A.locator('#expense-tbody tr').count();
  assert.equal(await rows(), 3);
  await A.selectOption('#filter-cat', 'Travel');
  assert.equal(await rows(), 2);
  await A.fill('#filter-search', 'uber');
  assert.equal(await rows(), 1);
  await A.fill('#filter-search', '');
  await A.fill('#filter-from', '2020-01-01'); await A.fill('#filter-to', '2020-12-31');
  assert.equal(await rows(), 1);
  assert.match(await A.locator('#expense-tbody').innerText(), /Old bus ticket/);
  await A.fill('#filter-from', '2021-01-01');
  assert.match(await A.locator('#filter-summary').innerText(), /after/);
  await A.click('[data-action="clear-filters"]');
  assert.equal(await rows(), 3);
  await A.selectOption('#filter-sort', 'highest');
  assert.match(await A.locator('#expense-tbody tr').first().innerText(), /800\.00/);
  await A.selectOption('#filter-sort', 'newest');
});

test('MULTI-DEVICE: a second page for the same account syncs both ways and on delete', async () => {
  A2 = await device({ ctx: A.context() });
  await A2.waitForSelector('#main:not(.loading)');
  await nav(A2, 'expenses');
  assert.equal(await A2.locator('#expense-tbody tr').count(), 3, 'second device loads existing data');

  const today = await A.evaluate(() => todayStr());     // the add form deliberately keeps the last date, so be explicit
  await addTx(A, 'expense', { cat: 'Health', amount: 900, desc: 'Doctor consultation', date: today });
  await A2.waitForFunction(() => document.querySelector('#expense-tbody').innerText.includes('Doctor consultation'));

  await addTx(A2, 'expense', { cat: 'Rent', amount: 8000, desc: 'Monthly rent', date: today });
  await nav(A, 'dashboard');
  await A.waitForFunction(() => document.querySelector('#kpi-grid').innerText.includes('9,'));   // 800+10+900+8000 → 9,710
  assert.equal(await kpi(A, 'Expenses'), '₹9,710.00');

  await nav(A2, 'expenses');
  await A2.locator('#expense-tbody tr', { hasText: 'Doctor consultation' }).locator('[data-action="delete"]').click();
  await A2.click('#modal-confirm');
  await nav(A, 'dashboard');
  await A.waitForFunction(() => document.querySelector('#kpi-grid').innerText.includes('8,810.00'));
  assert.equal(await kpi(A, 'Expenses'), '₹8,810.00');
});

test('persistence: data survives a page reload', async () => {
  await A.reload();
  await A.waitForSelector('#main:not(.loading)');
  assert.equal(await kpi(A, 'Expenses'), '₹8,810.00');
});

test('OFFLINE: banner appears, changes are queued, shown immediately, and sync when the connection returns', async () => {
  const ctx = A.context();
  const uidA = await A.evaluate(() => Store.getUid());
  const before = Object.keys(h.store.snapshot(uidA).data.expenses).length;
  await ctx.setOffline(true);
  h.dropConnections();                                           // cut the live stream like a real outage would
  await A.waitForSelector('#offline-banner:not(.hidden)');
  assert.equal(await A.locator('#sync-text').innerText(), 'Offline');

  const today = await A.evaluate(() => todayStr());
  await addTx(A, 'expense', { cat: 'Other', amount: 33, desc: 'Added while offline', date: today });
  assert.equal(await A.evaluate(() => Store.pendingCount), 1, 'queued, not lost');
  assert.ok(await A.evaluate(() => Store.expenses.some((e) => e.description === 'Added while offline')), 'visible immediately (optimistic)');
  assert.equal(Object.keys(h.store.snapshot(uidA).data.expenses).length, before, 'server has not seen it yet');

  await ctx.setOffline(false);
  await A.waitForFunction(() => Store.pendingCount === 0, null, { timeout: 15000 });
  assert.equal(Object.keys(h.store.snapshot(uidA).data.expenses).length, before + 1, 'delivered after reconnect');
  await A.waitForSelector('#offline-banner.hidden', { state: 'attached', timeout: 15000 });
  assert.equal(await A.locator('#sync-text').innerText(), 'Live');
  // tidy up so later totals are unchanged
  await A.evaluate(() => { const e = Store.expenses.find((x) => x.description === 'Added while offline'); Store.deleteTransaction('expense', e.id); });
  await A.waitForFunction(() => !Store.expenses.some((e) => e.description === 'Added while offline') && Store.pendingCount === 0);
});

test('CSV: export content, import with quoted commas, duplicate-safe re-import', async () => {
  await nav(A, 'io');
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('[data-action="export-csv"]')]);
  const exported = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(exported, /^date,category,amount,description/);
  assert.match(exported, /Monthly rent/);

  // re-importing our own export must add nothing
  const f1 = path.join(os.tmpdir(), 'own.csv'); fs.writeFileSync(f1, exported);
  await A.setInputFiles('#csv-file', f1);
  await A.waitForSelector('#import-feedback:not(.hidden)');
  assert.match(await A.locator('#import-feedback').innerText(), /Imported 0 expenses, 4 duplicates skipped/);
  assert.equal(await A.evaluate(() => Store.expenses.length), 4, 'no rows added by re-importing our own export');

  const f2 = path.join(os.tmpdir(), 'new.csv');
  fs.writeFileSync(f2, 'date,category,amount,description\n2024-09-18,Food,250.00,"Dinner, with ""friends"""\n2024-09-19,Gadgets,99,Cable\n2024-02-31,Food,5,bad date\n');
  await A.setInputFiles('#csv-file', f2);
  await A.waitForFunction(() => document.querySelector('#import-feedback').innerText.includes('Imported 2'));
  assert.match(await A.locator('#import-feedback').innerText(), /1 invalid row/);
  await A.setInputFiles('#csv-file', f2);                       // same file again
  await A.waitForFunction(() => document.querySelector('#import-feedback').innerText.includes('Imported 0'));
  assert.match(await A.locator('#import-feedback').innerText(), /2 duplicates skipped/);
  const desc = await A.evaluate(() => Store.expenses.map((e) => e.description));
  assert.ok(desc.includes('Dinner, with "friends"'));
  assert.equal(desc.filter((d) => d === 'Cable').length, 1);
  await A.setInputFiles('#csv-file', []);
});

test('AI assistant: typing indicator, answer from backend-computed data, timestamp, persistence', async () => {
  askMode = 'slow';
  await nav(A, 'assistant');
  assert.equal(await A.locator('#chat-suggestions .quick-chip').count(), 6);
  await A.fill('#chat-input', 'How much did I spend this month?');
  await A.click('#chat-send');
  await A.waitForSelector('.typing');
  assert.ok(await A.locator('#chat-send').isDisabled(), 'input locked while waiting');
  await A.waitForSelector('.msg-bot:not(:has(.typing))');
  const log = await A.locator('#chat-log').innerText();
  assert.match(log, /How much did I spend this month\?/);
  assert.match(log, /You spent ₹8810 this month/);
  assert.equal(await A.locator('.msg-bot strong').first().innerText(), '₹8810', 'markdown bold rendered');
  assert.ok(await A.locator('.msg-time').count() >= 2, 'timestamps shown');
  askMode = 'ok';

  // server received only this user's data
  const sent = h.calls.ask.at(-1);
  assert.equal(sent.summary.thisMonth.totalSpent, 8810);

  await A.reload();
  await nav(A, 'assistant');
  await A.waitForFunction(() => document.querySelector('#chat-log').innerText.includes('You spent'));
  // second device sees the same history in real time
  await nav(A2, 'assistant');
  await A2.waitForFunction(() => document.querySelector('#chat-log').innerText.includes('You spent'));
});

test('AI assistant: provider failure degrades to a computed summary with a visible notice', async () => {
  askMode = 'fail';
  await nav(A, 'assistant');
  await A.click('[data-action="chat-suggest"][data-arg="Which category has the highest expenses?"]');
  await A.waitForSelector('.bubble-note');
  assert.match(await A.locator('.bubble-note').last().innerText(), /AI unavailable/);
  assert.match(await A.locator('.msg-bot').last().innerText(), /Total spent: ₹8,810\.00/);
  askMode = 'ok';
});

test('API rejects unauthenticated, forged-cookie and cross-site requests', async () => {
  const call = (method, url, headers = {}) => fetch(h.url + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ExpenseIQ', ...headers }, body: method === 'POST' ? JSON.stringify({ message: 'hi' }) : undefined });
  assert.equal((await call('POST', '/api/chat')).status, 401);
  assert.equal((await call('POST', '/api/chat', { Cookie: 'sid=forged-forged-forged-forged-1234' })).status, 401);
  assert.equal((await call('GET', '/api/data')).status, 401);
  assert.equal((await call('DELETE', '/api/chat/history')).status, 401);
  assert.equal((await fetch(h.url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'missing CSRF header');
});

test('chat can be cleared', async () => {
  await nav(A, 'assistant');
  await A.click('[data-action="chat-clear"]');
  await A.click('#modal-confirm');
  await A.waitForSelector('#chat-log .chat-empty');
});

test('ISOLATION: a different account sees none of Alice\'s data, and AI gets only its own', async () => {
  const ctxB = await newCtx();
  const B = await device({ ctx: ctxB });
  await register(B, 'bob@example.com');
  assert.equal(await kpi(B, 'Expenses'), '₹0.00');
  await nav(B, 'expenses');
  assert.equal(await B.locator('#expense-tbody tr').count(), 0);
  await addTx(B, 'expense', { cat: 'Food', amount: 111, desc: 'BOB-ONLY' });
  await nav(B, 'assistant');
  await B.fill('#chat-input', 'summary please');
  await B.click('#chat-send');
  await B.waitForFunction(() => document.querySelector('#chat-log').innerText.includes('You spent'));
  const sent = JSON.stringify(h.calls.ask.at(-1).summary);
  assert.match(sent, /BOB-ONLY/);
  assert.doesNotMatch(sent, /Monthly rent|Lunch|Uber/);
  assert.match(await B.locator('#chat-log').innerText(), /₹111/);
  // and Alice does not see Bob's expense
  await nav(A, 'expenses');
  assert.doesNotMatch(await A.locator('#expense-tbody').innerText(), /BOB-ONLY/);
  await ctxB.close();
});

test('MIGRATION: legacy localStorage data is offered once, imported idempotently, cloud budget not overwritten', async () => {
  const ctx = await newCtx();
  const pre = await ctx.newPage();
  await pre.goto(h.url);
  await pre.evaluate(() => {
    localStorage.setItem('expenseiq_expenses_v2', JSON.stringify([
      { id: 1726656000000.123, date: '2024-09-18', category: 'Food', amount: 250, description: 'Lunch at café', createdAt: '2024-09-18T12:00:00.000Z' },
      { id: 1726656000001.456, date: '2024-09-19', category: 'Travel', amount: 800, description: 'Uber', createdAt: '2024-09-19T12:00:00.000Z' },
      { id: 5, date: 'garbage', category: 'Food', amount: 1, description: 'invalid row is skipped' },
    ]));
    localStorage.setItem('expenseiq_budgets_v2', JSON.stringify({ '2024-09': 20000 }));
  });
  await pre.close();
  const C = await device({ ctx });
  await register(C, 'carol@example.com');
  await C.waitForSelector('#migrate-overlay:not(.hidden)');
  assert.match(await C.locator('#migrate-body').innerText(), /2 expenses and 1 budget/);
  await C.click('#migrate-import');
  await C.waitForSelector('#migrate-overlay.hidden', { state: 'attached' });
  assert.equal(await C.evaluate(() => Store.expenses.length), 2);
  assert.equal(await C.evaluate(() => getBudget('2024-09')), 20000);
  assert.equal(await C.evaluate(() => localStorage.getItem('expenseiq_expenses_v2')), null, 'legacy keys cleared after success');

  // simulate a second tab/device re-running the migration with the same legacy data: no duplicates
  const second = await C.evaluate(async () => {
    let error = null;
    try { await Store.migrate({ expenses: [{ id: 1726656000000.123, date: '2024-09-18', category: 'Food', amount: 250, description: 'Lunch at café' }], budgets: {} }); }
    catch (e) { error = e.message; }
    return { error, count: Store.expenses.length };
  });
  assert.match(second.error, /already completed/, 'the server refuses a second migration');
  assert.equal(second.count, 2);
  await C.reload();
  await C.waitForSelector('#main:not(.loading)');
  await C.waitForTimeout(400);
  assert.ok(await C.locator('#migrate-overlay.hidden').count(), 'not offered again');
  await ctx.close();
});

test('sign out hides data; signing back in restores it', async () => {
  await A.click('[data-action="logout"]');
  await A.waitForSelector('#auth-overlay:not(.hidden)');
  assert.equal(await A.evaluate(() => Store.expenses.length), 0, 'in-memory data wiped on sign-out');
  await A.fill('#auth-email', email);
  await A.fill('#auth-pass', 'secret123');
  await A.click('#auth-submit');
  await A.waitForSelector('#auth-overlay.hidden', { state: 'attached' });
  await A.waitForFunction(() => document.querySelector('#main:not(.loading)') && Store.expenses.length > 0);
  assert.equal(await kpi(A, 'Expenses'), '₹8,810.00');
});

test('responsive: no horizontal overflow on a phone; sidebar toggles; screenshot saved', async () => {
  await A.setViewportSize({ width: 375, height: 800 });
  await A.waitForTimeout(450);                      // .layout animates margin-left for 250ms when the sidebar collapses
  for (const s of ['dashboard', 'add', 'expenses', 'income', 'budget', 'reports', 'assistant', 'io']) {
    await A.evaluate((id) => showScreen(id), s);
    const overflow = await A.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const offenders = overflow > 1 ? await A.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > vw + 1 && el.getBoundingClientRect().width > 0)
        .slice(0, 6).map((el) => `${el.tagName}#${el.id}.${el.className}`).join(' | ');
    }) : '';
    assert.ok(overflow <= 1, `${s} overflows by ${overflow}px: ${offenders}`);
  }
  await A.evaluate(() => showScreen('dashboard'));
  await A.click('#hamburger');
  assert.equal(await A.locator('#sidebar.open').count(), 1);
  assert.equal(await A.getAttribute('#hamburger', 'aria-expanded'), 'true');
  const out = process.env.E2E_SHOTS;
  if (out) { fs.mkdirSync(out, { recursive: true }); await A.screenshot({ path: path.join(out, 'mobile.png') }); }
});

test('screenshots (desktop) when E2E_SHOTS is set', async () => {
  const out = process.env.E2E_SHOTS;
  if (!out) return;
  await A.setViewportSize({ width: 1280, height: 860 });
  for (const s of ['dashboard', 'expenses', 'budget', 'assistant']) {
    await A.evaluate((id) => showScreen(id), s);
    await A.waitForTimeout(250);
    await A.screenshot({ path: path.join(out, `${s}.png`) });
  }
});

test('server unreachable shows a clear setup screen instead of a blank page', async () => {
  const ctx = await newCtx();
  const p = await ctx.newPage();
  await p.route('**/api/auth/me', (r) => r.abort());
  await p.goto(h.url);
  await p.waitForSelector('#setup-overlay:not(.hidden)');
  assert.match(await p.locator('#setup-msg').innerText(), /Could not reach the ExpenseIQ server/);
  await ctx.close();
});

test('SESSION: logout kills the cookie server-side; an expired session returns the user to the sign-in screen', async () => {
  const ctx = await newCtx();
  const D = await device({ ctx });
  await register(D, 'dave@example.com');
  const cookie = (await ctx.cookies()).find((c) => c.name === 'sid');
  assert.ok(cookie.httpOnly && cookie.sameSite === 'Strict', 'cookie is HttpOnly + SameSite=Strict');
  assert.equal(await D.evaluate(() => document.cookie.includes('sid')), false, 'JavaScript cannot read the session cookie');

  // 1) logging out invalidates the token on the server: replaying it fails
  await D.click('[data-action="logout"]');
  await D.waitForSelector('#auth-overlay:not(.hidden)');
  const replay = await fetch(h.url + '/api/auth/me', { headers: { Cookie: `sid=${cookie.value}` } });
  assert.equal(replay.status, 401);

  // 2) session expires while the app is open
  await D.fill('#auth-email', 'dave@example.com');
  await D.fill('#auth-pass', 'secret123');
  await D.click('#auth-submit');
  await D.waitForSelector('#auth-overlay.hidden', { state: 'attached' });
  await D.waitForSelector('#main:not(.loading)');
  Object.keys(h.store._db().sessions).forEach((k) => { delete h.store._db().sessions[k]; });   // server forgets all sessions
  await addTx(D, 'expense', { cat: 'Food', amount: 5, desc: 'after expiry' });
  await D.waitForSelector('#auth-overlay:not(.hidden)');
  assert.equal(await D.evaluate(() => Store.expenses.length), 0, 'data wiped from the screen');
  await ctx.close();
});

test('no unexpected browser console errors or exceptions in any flow', async () => {
  // The only expected console errors are the 401 responses we provoked on purpose.
  const unexpected = problems.filter((p) => !/401|Failed to load resource|Unauthorized/.test(p));
  assert.deepEqual(unexpected, []);
});
