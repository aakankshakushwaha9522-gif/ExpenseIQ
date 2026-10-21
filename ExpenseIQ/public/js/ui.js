/**
 * ui.js — rendering for ExpenseIQ.
 * All user-supplied text goes through esc() before touching innerHTML.
 */
const $ = (id) => document.getElementById(id);

// ─── Screen routing ───────────────────────────────────────────────
const SCREEN_TITLES = {
  dashboard: 'Dashboard', add: 'Add Transaction', expenses: 'View Expenses', income: 'Income',
  budget: 'Budget Tracker', reports: 'Reports', assistant: 'AI Assistant', io: 'Save & Load',
};
let currentScreen = 'dashboard';

function showScreen(id) {
  if (!SCREEN_TITLES[id]) id = 'dashboard';
  currentScreen = id;
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach((l) => {
    const on = l.dataset.screen === id;
    l.classList.toggle('active', on);
    if (on) l.setAttribute('aria-current', 'page'); else l.removeAttribute('aria-current');
  });
  const el = $('screen-' + id);
  if (el) el.classList.add('active');
  $('topbar-title').textContent = SCREEN_TITLES[id];
  document.title = `${SCREEN_TITLES[id]} — ExpenseIQ`;

  if (id === 'budget') $('bud-month').value = thisMonth();
  if (id === 'add') { $('in-date').value = $('in-date').value || todayStr(); }
  renderCurrent();
  if (id === 'assistant' && typeof Chat !== 'undefined') Chat.onShow();

  if (window.innerWidth <= 820) closeSidebar();
}

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('hamburger').setAttribute('aria-expanded', 'false');
}

/** Re-render whatever is visible. Called on every realtime data change. */
function renderCurrent() {
  const ready = Store.isReady();
  $('data-loading').classList.toggle('hidden', ready || !!Store.error);
  $('main').classList.toggle('loading', !ready);
  const errEl = $('data-error');
  errEl.classList.toggle('hidden', !Store.error);
  errEl.textContent = Store.error ? '⚠️ ' + Store.error : '';

  renderSyncStatus();
  renderSidebarMini();
  $('topbar-month').textContent = fmtMonth(thisMonth());
  if (!ready) return;

  switch (currentScreen) {
    case 'dashboard': renderDashboard(); break;
    case 'expenses':  renderExpenses(); break;
    case 'income':    renderIncome(); break;
    case 'budget':    renderBudget(); break;
    case 'reports':   renderReports(); break;
    case 'io':        renderIO(); break;
    default: break;
  }
}

// ─── Sync / connectivity indicator ────────────────────────────────
function renderSyncStatus() {
  const pill = $('sync-pill');
  const c = Store.connected;
  pill.classList.toggle('online', c === true);
  pill.classList.toggle('offline', c === false);
  $('sync-text').textContent = c === true ? 'Live' : c === false ? 'Offline' : 'Connecting…';
  $('offline-banner').classList.toggle('hidden', c !== false);
}

// ─── Toast ───────────────────────────────────────────────────────
let _toastTimer;
function toast(msg, type = 'success') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ─── Overlays (focus management + Esc) ────────────────────────────
const _focusStack = [];
function openOverlay(overlay, focusEl) {
  _focusStack.push({ overlay, from: document.activeElement });
  overlay.classList.remove('hidden');
  const target = focusEl || overlay.querySelector('input,select,button');
  if (target) setTimeout(() => target.focus(), 0);
}
function closeOverlay(overlay) {
  overlay.classList.add('hidden');
  const idx = _focusStack.map((f) => f.overlay).lastIndexOf(overlay);
  if (idx >= 0) {
    const { from } = _focusStack.splice(idx, 1)[0];
    if (from && from.focus && document.contains(from)) from.focus();
  }
}
document.addEventListener('keydown', (e) => {
  const top = _focusStack[_focusStack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') { top.overlay.dispatchEvent(new CustomEvent('overlay-dismiss')); return; }
  if (e.key === 'Tab') {            // keep focus inside the dialog
    const f = [...top.overlay.querySelectorAll('button,input,select,textarea,[href]')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

// ─── Confirm modal ───────────────────────────────────────────────
let _modalCallback = null;
function showModal(title, body, onConfirm) {
  $('modal-title').textContent = title;
  $('modal-body').textContent = body;
  _modalCallback = onConfirm;
  openOverlay($('modal-overlay'), $('modal-cancel'));
}
function closeModal() { closeOverlay($('modal-overlay')); _modalCallback = null; }
function confirmModal() { const cb = _modalCallback; closeModal(); if (cb) cb(); }

// ─── Badges ──────────────────────────────────────────────────────
function catBadge(cat, kind) {
  const color = getCatColor(cat, kind);
  return `<span class="cat-badge" style="background:${color}28;color:${color}">${getCatEmoji(cat, kind)} ${esc(cat)}</span>`;
}
const catDot = (cat) => `<span class="exp-cat-dot" style="background:${getCatColor(cat)}"></span>`;

// ─── Dashboard ───────────────────────────────────────────────────
function renderDashboard() {
  const month = thisMonth();
  const allExp = getExpenses();
  const mExp = allExp.filter((e) => e.date && e.date.startsWith(month));
  const spent = totalForMonth(month);
  const earned = incomeForMonth(month);
  const balance = Shared.round2(earned - spent);
  const budget = getBudget(month);
  const remain = budget - spent;
  const highest = mExp.length ? Math.max(...mExp.map((e) => e.amount)) : 0;
  const days = new Set(mExp.map((e) => e.date)).size || 1;
  const avgDay = spent / days;

  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const who = currentUserName();
  $('dash-greeting').textContent = `${greet}${who ? ', ' + who : ''}! Here's your spending overview for ${fmtMonth(month)}.`;
  $('dash-month-label').textContent = fmtMonth(month);

  $('kpi-grid').innerHTML = `
    <div class="kpi"><div class="kpi-label">Income</div><div class="kpi-value green">${fmtAmt(earned)}</div><div class="kpi-sub">${incomeCount(month)} entr${incomeCount(month) === 1 ? 'y' : 'ies'} this month</div></div>
    <div class="kpi"><div class="kpi-label">Expenses</div><div class="kpi-value accent">${fmtAmt(spent)}</div><div class="kpi-sub">${mExp.length} transaction${mExp.length !== 1 ? 's' : ''}</div></div>
    <div class="kpi"><div class="kpi-label">Balance</div><div class="kpi-value ${balance < 0 ? 'red' : 'green'}">${balance < 0 ? '−' : ''}${fmtAmt(Math.abs(balance))}</div><div class="kpi-sub">Income − expenses</div></div>
    <div class="kpi"><div class="kpi-label">Monthly Budget</div><div class="kpi-value">${budget ? fmtAmt(budget) : '—'}</div><div class="kpi-sub">${budget ? fmtMonth(month) : 'Not set'}</div></div>
    <div class="kpi"><div class="kpi-label">${remain >= 0 ? 'Budget Remaining' : 'Over Budget'}</div><div class="kpi-value ${remain < 0 ? 'red' : 'green'}">${budget ? fmtAmt(Math.abs(remain)) : '—'}</div><div class="kpi-sub">${budget ? (remain < 0 ? '⚠️ Overspent' : `${(spent / budget * 100).toFixed(0)}% used`) : 'Set a budget'}</div></div>
    <div class="kpi"><div class="kpi-label">Avg / Active Day</div><div class="kpi-value yellow">${fmtAmt(avgDay)}</div><div class="kpi-sub">Largest: ${fmtAmt(highest)}</div></div>
  `;

  renderCategoryCharts(month);

  const recent = [...allExp].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 6);
  const recentEl = $('dash-recent-list');
  if (!recent.length) {
    recentEl.innerHTML = `<div class="empty-state"><div class="empty-icon" aria-hidden="true">📭</div><div class="empty-title">No expenses yet</div><div class="empty-sub">Add your first expense to get started.</div><button class="btn btn-primary" style="margin-top:14px" type="button" data-action="goto" data-arg="add">Add expense</button></div>`;
    return;
  }
  recentEl.innerHTML = recent.map((e) => `
    <div class="exp-row">
      ${catDot(e.category)}
      <div class="exp-info"><div class="exp-desc">${esc(e.description)}</div><div class="exp-meta">${esc(e.date)} · ${esc(e.category)}</div></div>
      <div class="exp-amount">${fmtAmt(e.amount)}</div>
    </div>`).join('');
}
const incomeCount = (month) => Store.income.filter((e) => e.date && e.date.startsWith(month)).length;

function renderSidebarMini() {
  const el = $('sidebar-budget-mini');
  if (!Store.isReady()) { el.textContent = ''; return; }
  const month = thisMonth();
  const budget = getBudget(month);
  const spent = totalForMonth(month);
  if (!budget) { el.textContent = 'No budget set'; return; }
  const pct = Math.min(100, spent / budget * 100);
  el.innerHTML = `
    <div style="font-size:11px;color:var(--text3);margin-bottom:4px">${esc(fmtMonth(month))}</div>
    <div class="budget-bar-wrap" style="height:5px"><div class="budget-bar" style="width:${pct.toFixed(1)}%;background:${spent > budget ? 'var(--red)' : 'var(--green)'}"></div></div>
    <div style="font-size:11px;color:var(--text3);margin-top:3px">${fmtAmt(spent)} / ${fmtAmt(budget)}</div>`;
}

// ─── Category selects ────────────────────────────────────────────
function fillCategorySelect(sel, kind, { placeholder, all } = {}) {
  const cats = Shared.catList(kind);
  sel.innerHTML = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
    (all ? `<option value="">All categories</option>` : '') +
    cats.map((c) => `<option value="${esc(c)}">${getCatEmoji(c, kind)} ${esc(c)}</option>`).join('');
}

// ─── Expenses list ───────────────────────────────────────────────
function filteredExpenses() {
  let list = getExpenses();
  const cat = $('filter-cat').value;
  const from = $('filter-from').value;
  const to = $('filter-to').value;
  const sort = $('filter-sort').value;
  const search = $('filter-search').value.toLowerCase().trim();
  if (cat) list = list.filter((e) => e.category === cat);
  if (from) list = list.filter((e) => e.date >= from);
  if (to) list = list.filter((e) => e.date <= to);
  if (search) list = list.filter((e) => (e.description || '').toLowerCase().includes(search) || e.category.toLowerCase().includes(search));
  const byNew = (a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0);
  if (sort === 'newest') list.sort(byNew);
  if (sort === 'oldest') list.sort((a, b) => -byNew(a, b));
  if (sort === 'highest') list.sort((a, b) => b.amount - a.amount);
  if (sort === 'lowest') list.sort((a, b) => a.amount - b.amount);
  return list;
}

function actionButtons(kind, id) {
  const i = esc(id);
  return `<button class="edit-btn" type="button" data-action="edit" data-kind="${kind}" data-id="${i}" title="Edit" aria-label="Edit">✏️</button>` +
         `<button class="del-btn" type="button" data-action="delete" data-kind="${kind}" data-id="${i}" title="Delete" aria-label="Delete">🗑️</button>`;
}

function renderExpenses() {
  const all = getExpenses();
  const list = filteredExpenses();
  const total = list.reduce((s, e) => s + e.amount, 0);
  $('expenses-count-label').textContent = `${list.length} expense${list.length !== 1 ? 's' : ''} · Total: ${fmtAmt(total)}`;

  const from = $('filter-from').value, to = $('filter-to').value;
  const tbody = $('expense-tbody'), emptyEl = $('expense-empty'), tableEl = $('expense-table');

  if (!list.length) {
    tbody.innerHTML = '';
    tableEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    const filtered = all.length > 0;
    $('expense-empty-title').textContent = filtered ? 'No expenses match your filters' : 'No expenses yet';
    $('expense-empty-sub').textContent = filtered ? 'Try adjusting or clearing the filters.' : 'Add your first expense to see it here in real time.';
    $('filter-summary').textContent = from && to && from > to ? '⚠️ “From” date is after “To” date.' : (filtered ? 'No results match your filters.' : '');
    return;
  }
  tableEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');
  $('filter-summary').textContent = `Showing ${list.length} of ${all.length} expenses`;

  tbody.innerHTML = list.map((e) => `
    <tr>
      <td class="nowrap muted">${esc(e.date)}</td>
      <td>${catBadge(e.category, 'expense')}</td>
      <td class="desc-cell">${esc(e.description)}</td>
      <td class="amt-cell">${fmtAmt(e.amount)}</td>
      <td class="nowrap">${actionButtons('expense', e.id)}</td>
    </tr>`).join('');
}

function renderIncome() {
  const list = getIncome().sort((a, b) => b.date.localeCompare(a.date));
  const total = list.reduce((s, e) => s + e.amount, 0);
  $('income-count-label').textContent = `${list.length} entr${list.length !== 1 ? 'ies' : 'y'} · Total: ${fmtAmt(total)}`;
  $('income-empty').classList.toggle('hidden', list.length > 0);
  $('income-tbody').closest('table').classList.toggle('hidden', list.length === 0);
  $('income-tbody').innerHTML = list.map((e) => `
    <tr>
      <td class="nowrap muted">${esc(e.date)}</td>
      <td>${catBadge(e.category, 'income')}</td>
      <td class="desc-cell">${esc(e.description)}</td>
      <td class="amt-cell" style="color:var(--green)">${fmtAmt(e.amount)}</td>
      <td class="nowrap">${actionButtons('income', e.id)}</td>
    </tr>`).join('');
}

// ─── Budget ───────────────────────────────────────────────────────
function renderBudget() {
  const month = Shared.isMonth($('bud-month').value) ? $('bud-month').value : thisMonth();
  const budget = getBudget(month);
  const total = totalForMonth(month);
  const remain = budget - total;
  const pct = budget ? Math.min(100, total / budget * 100) : 0;
  const over = remain < 0;
  $('budget-status-title').textContent = month === thisMonth() ? "This Month's Status" : `Status — ${fmtMonth(month)}`;

  $('budget-status-body').innerHTML = !budget
    ? `<div class="budget-alert no-bud">⚠️ No budget set for ${esc(fmtMonth(month))}. Set one on the left.</div>
       <div class="budget-row"><span>Spent so far</span><span>${fmtAmt(total)}</span></div>`
    : `<div class="budget-alert ${over ? 'over' : 'under'}">${over
        ? `🚨 You have exceeded your budget by ${fmtAmt(Math.abs(remain))}!`
        : `✅ You have ${fmtAmt(remain)} left for the month.`}</div>
       <div class="budget-row"><span>Spent</span><span>${fmtAmt(total)}</span></div>
       <div class="budget-row"><span>Budget</span><span>${fmtAmt(budget)}</span></div>
       <div class="budget-bar-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(0)}" aria-label="Budget used">
         <div class="budget-bar" style="width:${pct.toFixed(1)}%;background:${over ? 'var(--red)' : pct > 80 ? 'var(--yellow)' : 'var(--green)'}"></div>
       </div>
       <div class="budget-pct">${(budget ? total / budget * 100 : 0).toFixed(0)}% of budget used</div>`;

  const cats = Object.entries(spendingByCategory(month)).sort((a, b) => b[1] - a[1]);
  const maxAmt = cats.length ? cats[0][1] : 1;
  $('budget-cat-breakdown').innerHTML = !cats.length
    ? `<div class="empty-state" style="padding:1.5rem 0"><div class="empty-sub">No expenses in ${esc(fmtMonth(month))} yet.</div></div>`
    : cats.map(([cat, amt]) => `
      <div class="cat-row">
        <div class="cat-row-label">${getCatEmoji(cat)} ${esc(cat)}</div>
        <div class="cat-row-bar-wrap"><div class="cat-row-bar" style="width:${(amt / maxAmt * 100).toFixed(1)}%;background:${getCatColor(cat)}"></div></div>
        <div class="cat-row-amount" style="color:${getCatColor(cat)}">${fmtAmt(amt)}</div>
      </div>`).join('');

  const all = Object.entries(getAllBudgets()).sort((a, b) => b[0].localeCompare(a[0]));
  $('budget-list').innerHTML = !all.length
    ? `<div class="empty-sub" style="color:var(--text3)">No budgets saved yet.</div>`
    : all.map(([m, v]) => `
      <div class="io-summary-row"><span>${esc(fmtMonth(m))}</span>
        <span><span class="io-summary-val">${fmtAmt(v)}</span>
        <button class="del-btn" style="margin-left:10px" type="button" data-action="delete-budget" data-id="${esc(m)}" aria-label="Delete budget for ${esc(fmtMonth(m))}">🗑️</button></span></div>`).join('');
}

// ─── Reports ─────────────────────────────────────────────────────
function renderReports() {
  renderTrend();
  const days = topSpendingDays(5);
  $('top-days-list').innerHTML = !days.length
    ? `<div class="empty-sub" style="padding:1rem 0;color:var(--text3)">No expense data yet.</div>`
    : days.map((d) => `<div class="top-day-row"><span style="font-size:14px">${esc(d.date)}</span><span class="amt-accent">${fmtAmt(d.total)}</span></div>`).join('');

  const st = statistics();
  const stEl = $('stats-grid');
  if (!st) { stEl.innerHTML = `<div class="empty-sub" style="color:var(--text3)">Add expenses to see statistics.</div>`; return; }
  const sub = (t) => `<div class="stat-sub">${esc(t || '')}</div>`;
  stEl.innerHTML = `
    <div class="stat-item"><div class="stat-label">Total All-time</div><div class="stat-value">${fmtAmt(st.total)}</div></div>
    <div class="stat-item"><div class="stat-label">Avg per Transaction</div><div class="stat-value">${fmtAmt(st.avg)}</div></div>
    <div class="stat-item"><div class="stat-label">Highest Expense</div><div class="stat-value">${fmtAmt(st.max)}</div>${sub(st.maxExp && st.maxExp.description)}</div>
    <div class="stat-item"><div class="stat-label">Lowest Expense</div><div class="stat-value">${fmtAmt(st.min)}</div>${sub(st.minExp && st.minExp.description)}</div>
    <div class="stat-item"><div class="stat-label">Top Category</div><div class="stat-value">${st.topCat ? getCatEmoji(st.topCat[0]) + ' ' + esc(st.topCat[0]) : '—'}</div>${sub(st.topCat ? fmtAmt(st.topCat[1]) : '')}</div>
    <div class="stat-item"><div class="stat-label">Total Transactions</div><div class="stat-value">${st.count}</div></div>`;
}

// ─── Save/Load ───────────────────────────────────────────────────
function renderIO() {
  const exps = getExpenses();
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const dates = exps.map((e) => e.date).sort();
  $('io-summary').innerHTML = `
    <div class="io-summary-row"><span>Total expenses logged</span><span class="io-summary-val">${exps.length}</span></div>
    <div class="io-summary-row"><span>Income entries</span><span class="io-summary-val">${Store.income.length}</span></div>
    <div class="io-summary-row"><span>Total amount tracked</span><span class="io-summary-val">${fmtAmt(total)}</span></div>
    <div class="io-summary-row"><span>Monthly budgets set</span><span class="io-summary-val">${Object.keys(getAllBudgets()).length}</span></div>
    <div class="io-summary-row"><span>Date range</span><span class="io-summary-val">${exps.length ? esc(dates[0] + ' → ' + dates[dates.length - 1]) : '—'}</span></div>`;
}

// ─── Add form ────────────────────────────────────────────────────
let addKind = 'expense';
function setKind(kind) {
  addKind = kind === 'income' ? 'income' : 'expense';
  ['expense', 'income'].forEach((k) => {
    const b = $('seg-' + k);
    b.classList.toggle('active', k === addKind);
    b.setAttribute('aria-checked', String(k === addKind));
  });
  fillCategorySelect($('in-cat'), addKind, { placeholder: '— Select category —' });
  $('add-submit').textContent = addKind === 'income' ? 'Add Income' : 'Add Expense';
  $('in-desc').placeholder = addKind === 'income' ? 'e.g. October salary' : 'e.g. Lunch with friends';
  renderQuickCats();
}

function resetAddForm({ keepFeedback = false } = {}) {
  $('in-date').value = todayStr();
  $('in-cat').value = '';
  $('in-amount').value = '';
  $('in-desc').value = '';
  if (!keepFeedback) hideFeedback('add-feedback');
}

function renderQuickCats() {
  $('quick-cats').innerHTML = Shared.catList(addKind).map((cat) =>
    `<button class="quick-chip" type="button" data-action="quick-cat" data-arg="${esc(cat)}">${getCatEmoji(cat, addKind)} ${esc(cat)}</button>`).join('');
}

function showFeedback(elId, msg, type) {
  const el = $(elId);
  el.textContent = msg;
  el.className = `feedback ${type}`;
}
function hideFeedback(elId) { const el = $(elId); el.className = 'feedback hidden'; el.textContent = ''; }

// ─── Edit modal ──────────────────────────────────────────────────
let _editing = null;
function openEdit(kind, id) {
  const list = kind === 'income' ? Store.income : Store.expenses;
  const rec = list.find((e) => e.id === id);
  if (!rec) { toast('That item no longer exists.', 'error'); return; }
  _editing = { kind, id };
  $('edit-title').textContent = kind === 'income' ? 'Edit income' : 'Edit expense';
  fillCategorySelect($('ed-cat'), kind);
  $('ed-date').value = rec.date;
  $('ed-cat').value = rec.category;
  $('ed-amount').value = rec.amount;
  $('ed-desc').value = rec.description;
  hideFeedback('edit-feedback');
  openOverlay($('edit-overlay'), $('ed-amount'));
}
function closeEdit() { closeOverlay($('edit-overlay')); _editing = null; }
function submitEdit() {
  if (!_editing) return;
  const res = Store.updateTransaction(_editing.kind, _editing.id, {
    date: $('ed-date').value, category: $('ed-cat').value, amount: $('ed-amount').value, description: $('ed-desc').value,
  });
  if (!res.success) { showFeedback('edit-feedback', '⚠️ ' + res.error, 'error'); return; }
  closeEdit();
  toast('Changes saved', 'success');
}

function currentUserName() {
  const u = Session.user;
  if (!u) return '';
  return (u.name || '').split(' ')[0];
}
