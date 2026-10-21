/**
 * shared.js — pure helpers used by the browser UI *and* by the Node test-suite
 * (UMD: attaches to `window.Shared` in the browser, `module.exports` in Node).
 * No DOM, no network, no globals — everything here is unit-tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─── Categories ─────────────────────────────────────────────────
  const CATEGORIES = {
    Food:          { emoji: '🍕', color: '#F97316' },
    Travel:        { emoji: '✈️', color: '#3B82F6' },
    Shopping:      { emoji: '🛍️', color: '#EC4899' },
    Entertainment: { emoji: '🎬', color: '#A855F7' },
    Health:        { emoji: '💊', color: '#10B981' },
    Utilities:     { emoji: '💡', color: '#6B7280' },
    Education:     { emoji: '📚', color: '#EAB308' },
    Rent:          { emoji: '🏠', color: '#14B8A6' },
    Other:         { emoji: '📦', color: '#8B5CF6' },
  };
  const INCOME_CATEGORIES = {
    Salary:      { emoji: '💼', color: '#2DD4A4' },
    Freelance:   { emoji: '💻', color: '#38BDF8' },
    Investments: { emoji: '📈', color: '#A3E635' },
    Gift:        { emoji: '🎁', color: '#F472B6' },
    Other:       { emoji: '📦', color: '#8B5CF6' },
  };
  const MAX_AMOUNT = 100000000;
  const MAX_DESC = 120;

  function catList(kind) { return Object.keys(kind === 'income' ? INCOME_CATEGORIES : CATEGORIES); }
  function getCat(cat, kind) {
    const table = kind === 'income' ? INCOME_CATEGORIES : CATEGORIES;
    return table[cat] || { emoji: '📦', color: '#8B5CF6' };
  }

  // ─── Escaping (prevents XSS when rendering user text) ───────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ─── Dates (LOCAL time — the original used UTC and was a day off in IST) ───
  const pad = (n) => String(n).padStart(2, '0');
  function localDateStr(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function localMonthStr(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }

  function isRealDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return y >= 1970 && y <= 2100 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  function isMonth(s) { return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s); }

  // ─── Validation ─────────────────────────────────────────────────
  /** Returns null when valid, else a human-readable error. kind: 'expense' | 'income' */
  function validateTransaction({ date, category, amount, description }, kind = 'expense') {
    if (!date) return 'Date is required.';
    if (!isRealDate(date)) return 'Date must be a real date in YYYY-MM-DD format.';
    if (!category) return 'Category is required.';
    if (!catList(kind).includes(category)) return 'Unknown category.';
    const n = Number(amount);
    if (amount === '' || amount == null || !Number.isFinite(n) || n <= 0) return 'Amount must be a positive number.';
    if (n > MAX_AMOUNT) return 'Amount is too large.';
    if (!description || !String(description).trim()) return 'Description is required.';
    if (String(description).trim().length > MAX_DESC) return `Description must be at most ${MAX_DESC} characters.`;
    return null;
  }
  function validateBudget(month, amount) {
    if (!isMonth(month)) return 'Choose a valid month.';
    const n = Number(amount);
    if (amount === '' || !Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return 'Enter a positive budget amount.';
    return null;
  }
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  // ─── Formatting ─────────────────────────────────────────────────
  function fmtAmt(n) {
    return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtMonth(m) {
    if (!isMonth(m)) return '';
    const [y, mo] = m.split('-');
    return new Date(+y, +mo - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  }

  // ─── CSV ────────────────────────────────────────────────────────
  /** RFC-4180 style parser: quoted fields, escaped quotes, commas/newlines inside quotes, BOM. */
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    const s = String(text).replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some((f) => f.trim() !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    return rows;
  }

  /** Spreadsheet formula-injection guard for exported text cells. */
  function safeCell(v) {
    const s = String(v == null ? '' : v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }
  function csvQuote(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }

  function toCSV(list) {
    const header = 'date,category,amount,description';
    const rows = list.map((e) => [e.date, csvQuote(safeCell(e.category)), Number(e.amount).toFixed(2), csvQuote(safeCell(e.description))].join(','));
    return [header, ...rows].join('\n');
  }

  /**
   * Parse CSV text into validated rows.
   * returns { rows:[{date,category,amount,description}], errors:[string], fatal?:string }
   */
  function parseTransactionsCSV(text, { maxRows = 1000 } = {}) {
    const table = parseCSV(text);
    if (table.length < 2) return { rows: [], errors: [], fatal: 'File is empty or has only a header.' };
    const header = table[0].map((h) => h.trim().toLowerCase());
    const iDate = header.indexOf('date');
    const iAmt = header.indexOf('amount');
    const iCat = header.indexOf('category');
    const iDesc = header.findIndex((h) => h.startsWith('desc'));
    if (iDate < 0 || iAmt < 0) return { rows: [], errors: [], fatal: 'Invalid CSV: missing "date" or "amount" column.' };
    if (table.length - 1 > maxRows) return { rows: [], errors: [], fatal: `Too many rows (max ${maxRows}).` };

    const rows = [], errors = [];
    const catNames = catList('expense');
    table.slice(1).forEach((r, idx) => {
      const get = (i) => (i >= 0 && r[i] != null ? r[i].trim() : '');
      let category = get(iCat);
      const match = catNames.find((c) => c.toLowerCase() === category.toLowerCase());
      category = match || 'Other';
      const rec = {
        date: get(iDate),
        category,
        amount: get(iAmt).replace(/^'/, '').replace(/[₹,\s]/g, ''),
        description: (get(iDesc) || 'Imported').replace(/^'(?=[=+\-@])/, ''),
      };
      const err = validateTransaction(rec, 'expense');
      if (err) errors.push(`Row ${idx + 2}: ${err}`);
      else rows.push({ ...rec, amount: round2(rec.amount), description: rec.description.trim() });
    });
    return { rows, errors };
  }

  // 53-bit string hash (cyrb53) — used for deterministic ids so re-uploads cannot duplicate
  function hash53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  const signature = (e) => [e.date, e.category, Number(e.amount).toFixed(2), String(e.description).trim().toLowerCase()].join('|');

  /**
   * Decide which parsed rows are new. A row is a duplicate if the account already
   * holds at least as many identical rows (multiset comparison), so uploading the
   * same file twice — or re-importing your own export — adds nothing.
   * returns { fresh:[{id, ...row}], duplicates:number }
   */
  function planImport(rows, existing) {
    const have = {};
    existing.forEach((e) => { const k = signature(e); have[k] = (have[k] || 0) + 1; });
    const seen = {};
    const fresh = [];
    let duplicates = 0;
    rows.forEach((r) => {
      const k = signature(r);
      seen[k] = (seen[k] || 0) + 1;
      if (seen[k] <= (have[k] || 0)) { duplicates++; return; }
      fresh.push({ ...r, id: 'csv_' + hash53(k + '#' + seen[k]).toString(36) });
    });
    return { fresh, duplicates };
  }

  /** Legacy (localStorage) ids were floats like 1726656000000.123 — make them valid, stable record ids. */
  function legacyKey(id) { return ('m_' + String(id).replace(/[^A-Za-z0-9_-]/g, '_')).slice(0, 40); }

  return {
    CATEGORIES, INCOME_CATEGORIES, MAX_AMOUNT, MAX_DESC, catList, getCat, esc,
    localDateStr, localMonthStr, isRealDate, isMonth, validateTransaction, validateBudget, round2,
    fmtAmt, fmtMonth, parseCSV, toCSV, safeCell, parseTransactionsCSV, hash53, signature, planImport, legacyKey,
  };
}));
