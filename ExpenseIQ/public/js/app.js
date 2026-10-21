/**
 * app.js — controller: boot, session lifecycle, event wiring.
 */
let _migrationChecked = false;
let _renderQueued = false;

function scheduleRender() {
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => { _renderQueued = false; renderCurrent(); });
}

// ─── Actions (delegated; no inline handlers → strict CSP) ─────────
const actions = {
  goto: (d) => showScreen(d.arg),
  'auth-mode': (d) => AuthUI.setMode(d.arg),
  logout: () => AuthUI.logout(),
  'set-kind': (d) => setKind(d.arg),
  'reset-add': () => resetAddForm(),
  'quick-cat': (d) => { $('in-cat').value = d.arg; $('in-amount').focus(); },
  'preset-month': () => {
    const m = thisMonth();
    $('filter-from').value = m + '-01';
    $('filter-to').value = m + '-' + String(new Date(+m.slice(0, 4), +m.slice(5), 0).getDate()).padStart(2, '0');
    renderExpenses();
  },
  'clear-filters': () => {
    ['filter-cat', 'filter-from', 'filter-to', 'filter-search'].forEach((id) => { $(id).value = ''; });
    $('filter-sort').value = 'newest';
    renderExpenses();
  },
  edit: (d) => openEdit(d.kind, d.id),
  'edit-cancel': () => closeEdit(),
  delete: (d) => showModal(
    d.kind === 'income' ? 'Delete income' : 'Delete expense',
    'Are you sure you want to delete this item? This action cannot be undone.',
    () => { Store.deleteTransaction(d.kind, d.id); toast('Deleted', 'success'); }
  ),
  'delete-budget': (d) => showModal('Delete budget', `Delete the budget for ${fmtMonth(d.id)}?`, () => { Store.deleteBudget(d.id); toast('Budget deleted', 'success'); }),
  'modal-cancel': () => closeModal(),
  'export-csv': () => {
    const csv = exportToCSV();
    if (!csv) return toast('No expenses to export.', 'error');
    downloadBlob(csv, 'expenses.csv', 'text/csv;charset=utf-8;');
    toast('CSV downloaded ✓', 'success');
  },
  'export-budgets': () => { downloadBlob(exportBudgetsJSON(), 'budgets.json', 'application/json'); toast('Budget data downloaded ✓', 'success'); },
  'clear-all': () => showModal(
    'Clear All Data',
    'This permanently deletes all expenses, income and budgets from your account on every device. This cannot be undone.',
    async () => {
      try { await Store.clearAll(); toast('All data cleared.', 'success'); }
      catch { toast('Could not clear data.', 'error'); }
    }
  ),
  'chat-clear': () => showModal('Clear chat', 'Delete the whole conversation history?', () => Chat.clear()),
  'chat-suggest': (d) => Chat.send(d.arg),
  'migrate-skip': async () => {
    try { await Store.skipMigration(); } catch { /* will be offered again next time */ }
    closeOverlay($('migrate-overlay'));
    toast('Skipped. Local data on this browser was left untouched.', 'success');
  },
  'migrate-import': async () => {
    const btn = $('migrate-import');
    btn.disabled = true;
    try {
      const legacy = await Store.pendingMigration();
      const n = legacy ? await Store.migrate(legacy) : 0;
      closeOverlay($('migrate-overlay'));
      toast(`Imported ${n} expense${n !== 1 ? 's' : ''} from this browser ✓`, 'success');
    } catch {
      toast('Import failed. Nothing was lost — please try again.', 'error');
    } finally { btn.disabled = false; }
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});

document.querySelectorAll('.nav-link').forEach((link) => {
  link.addEventListener('click', (e) => { e.preventDefault(); showScreen(link.dataset.screen); });
});
$('hamburger').addEventListener('click', () => {
  const open = $('sidebar').classList.toggle('open');
  $('hamburger').setAttribute('aria-expanded', String(open));
});

// ─── Forms ────────────────────────────────────────────────────────
$('auth-form').addEventListener('submit', (e) => { e.preventDefault(); AuthUI.submit(); });

$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const fields = { date: $('in-date').value, category: $('in-cat').value, amount: $('in-amount').value, description: $('in-desc').value };
  const res = Store.addTransaction(addKind, fields);
  if (!res.success) return showFeedback('add-feedback', '⚠️ ' + res.error, 'error');
  showFeedback('add-feedback', `✅ ${addKind === 'income' ? 'Income' : 'Expense'} added: ${fields.description.trim()} — ${fmtAmt(fields.amount)}`, 'success');
  const keepDate = fields.date;
  resetAddForm({ keepFeedback: true });
  $('in-date').value = keepDate;       // handy when entering several items for the same day
  $('in-amount').focus();
  toast(`${addKind === 'income' ? 'Income' : 'Expense'} added`, 'success');
  setTimeout(() => hideFeedback('add-feedback'), 3500);
});

$('edit-form').addEventListener('submit', (e) => { e.preventDefault(); submitEdit(); });

$('budget-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const month = $('bud-month').value, amount = $('bud-amount').value;
  const res = Store.setBudget(month, amount);
  if (!res.success) return showFeedback('budget-feedback', '⚠️ ' + res.error, 'error');
  showFeedback('budget-feedback', `✅ Budget saved: ${fmtAmt(amount)} for ${fmtMonth(month)}`, 'success');
  $('bud-amount').value = '';
  toast('Budget saved!', 'success');
});
$('bud-month').addEventListener('change', () => renderBudget());

['filter-cat', 'filter-from', 'filter-to', 'filter-sort'].forEach((id) => $(id).addEventListener('change', () => renderExpenses()));
$('filter-search').addEventListener('input', () => renderExpenses());
$('trend-months').addEventListener('change', () => renderTrend());

$('chat-form').addEventListener('submit', (e) => { e.preventDefault(); Chat.send($('chat-input').value); });

$('csv-file').addEventListener('change', async (e) => {
  const input = e.target;
  const file = input.files[0];
  if (!file) return;
  hideFeedback('import-feedback');
  try {
    if (file.size > 1024 * 1024) throw new Error('File is too large (max 1 MB).');
    const parsed = Shared.parseTransactionsCSV(await file.text());
    if (parsed.fatal) throw new Error(parsed.fatal);
    if (!parsed.rows.length) throw new Error(parsed.errors[0] || 'No valid rows found.');
    const { added, duplicates } = await Store.importExpenses(parsed.rows);
    const bits = [`Imported ${added} expense${added !== 1 ? 's' : ''}`];
    if (duplicates) bits.push(`${duplicates} duplicate${duplicates !== 1 ? 's' : ''} skipped`);
    if (parsed.errors.length) bits.push(`${parsed.errors.length} invalid row${parsed.errors.length !== 1 ? 's' : ''} ignored (${parsed.errors[0]})`);
    showFeedback('import-feedback', (added ? '✅ ' : 'ℹ️ ') + bits.join(', ') + '.', added ? 'success' : 'warning');
    toast(bits[0] + (duplicates ? ` (${duplicates} duplicates skipped)` : ''), added ? 'success' : 'error');
  } catch (err) {
    showFeedback('import-feedback', '⚠️ ' + (err.message || 'Import failed.'), 'error');
  } finally { input.value = ''; }
});

// ─── Overlay plumbing ─────────────────────────────────────────────
$('modal-confirm').addEventListener('click', confirmModal);
$('modal-overlay').addEventListener('overlay-dismiss', closeModal);
$('edit-overlay').addEventListener('overlay-dismiss', closeEdit);
$('migrate-overlay').addEventListener('overlay-dismiss', () => closeOverlay($('migrate-overlay')));
[['modal-overlay', closeModal], ['edit-overlay', closeEdit]].forEach(([id, fn]) =>
  $(id).addEventListener('click', (e) => { if (e.target === $(id)) fn(); }));

// ─── Keyboard shortcuts ───────────────────────────────────────────
const SHORTCUTS = { d: 'dashboard', a: 'add', e: 'expenses', i: 'income', b: 'budget', r: 'reports', c: 'assistant', s: 'io' };
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (document.querySelector('.modal-overlay:not(.hidden), .fullscreen-overlay:not(.hidden)')) return;
  if (SHORTCUTS[e.key]) { e.preventDefault(); showScreen(SHORTCUTS[e.key]); }
});

// ─── Session lifecycle ────────────────────────────────────────────
function startSession(user) {
  _migrationChecked = false;
  Session.user = user;
  Store.setWriteErrorHandler((m) => toast(m, 'error'));
  Store.setSessionExpiredHandler(() => { toast('Your session expired. Please sign in again.', 'error'); endSession(); });
  Store.start(user.id);
  Chat.start();
  $('user-email').textContent = user.email || '';
  $('user-email').title = user.email || '';
  AuthUI.hide();
  resetAddForm();
  showScreen('dashboard');
}

function endSession() {
  Session.user = null;
  Store.stop();
  Chat.stop();
  closeModal();
  closeEdit();
  $('migrate-overlay').classList.add('hidden');
  $('user-email').textContent = '';
  $('auth-form').reset();
  AuthUI.setMode('login');
  AuthUI.show();
}

async function maybeOfferMigration() {
  if (_migrationChecked || !Store.isReady() || Store.connected !== true) return;
  _migrationChecked = true;
  try {
    const legacy = await Store.pendingMigration();
    if (!legacy) return;
    const n = legacy.expenses.length, b = Object.keys(legacy.budgets).length;
    $('migrate-body').textContent =
      `Found ${n} expense${n !== 1 ? 's' : ''} and ${b} budget${b !== 1 ? 's' : ''} saved in this browser by the old version of ExpenseIQ. ` +
      'Import them to your account? Importing twice never creates duplicates, and data already in your account is never overwritten.';
    openOverlay($('migrate-overlay'), $('migrate-import'));
  } catch { _migrationChecked = false; /* retry on next connection event */ }
}

Store.subscribe(() => { scheduleRender(); maybeOfferMigration(); });

// ─── Boot ─────────────────────────────────────────────────────────
function showSetup(msg, list = []) {
  $('boot-overlay').classList.add('hidden');
  $('setup-msg').textContent = msg;
  $('setup-list').innerHTML = list.map((x) => `<li><code>${esc(x)}</code></li>`).join('');
  $('setup-overlay').classList.remove('hidden');
}

(async function boot() {
  fillCategorySelect($('filter-cat'), 'expense', { all: true });
  setKind('expense');
  $('in-date').value = todayStr();
  $('bud-month').value = thisMonth();
  renderCurrent();

  // Is there already a valid login cookie from an earlier visit?
  try {
    const res = await apiFetch('GET', '/api/auth/me');
    $('boot-overlay').classList.add('hidden');
    if (res.ok) startSession(res.data.user); else endSession();
  } catch {
    return showSetup('Could not reach the ExpenseIQ server. Start it with “npm start” and reload this page.');
  }

  console.log('%c💰 ExpenseIQ loaded', 'background:#7C6FF7;color:#fff;padding:4px 10px;border-radius:4px;font-weight:700');
})();
