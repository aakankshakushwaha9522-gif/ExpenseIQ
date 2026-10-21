'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/js/shared');

test('REGRESSION: CSV with quoted comma keeps columns aligned (original regex produced phantom fields)', () => {
  const r = S.parseTransactionsCSV('date,category,amount,description\n2024-09-18,Food,250.00,"Lunch, at café"');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows, [{ date: '2024-09-18', category: 'Food', amount: 250, description: 'Lunch, at café' }]);
});

test('CSV parser: escaped quotes, CRLF, BOM, newline inside quotes, blank lines', () => {
  const t = S.parseCSV('﻿a,b\r\n"x ""q"" y","l1\nl2"\r\n\r\n3,4');
  assert.deepEqual(t, [['a', 'b'], ['x "q" y', 'l1\nl2'], ['3', '4']]);
});

test('import: unknown category -> Other, case-insensitive match, currency symbols stripped, bad rows reported', () => {
  const r = S.parseTransactionsCSV('Date,Category,Amount,Description\n2025-01-05,food,"₹1,200.50",Groceries\n2025-01-06,Gadgets,10,Thing\n2025-02-30,Food,5,bad date\n2025-01-07,Food,-3,neg\n2025-01-08,Food,abc,nan');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].category, 'Food');
  assert.equal(r.rows[0].amount, 1200.5);
  assert.equal(r.rows[1].category, 'Other');
  assert.equal(r.errors.length, 3);
  assert.match(r.errors[0], /^Row 4:/);
});

test('import: fatal errors for empty file, missing columns, too many rows', () => {
  assert.match(S.parseTransactionsCSV('').fatal, /empty/);
  assert.match(S.parseTransactionsCSV('date,category\n2025-01-01,Food').fatal, /missing/);
  const big = 'date,amount\n' + Array.from({ length: 11 }, () => '2025-01-01,5').join('\n');
  assert.match(S.parseTransactionsCSV(big, { maxRows: 10 }).fatal, /Too many rows/);
});

test('missing description defaults to "Imported"', () => {
  const r = S.parseTransactionsCSV('date,amount\n2025-01-01,5');
  assert.equal(r.rows[0].description, 'Imported');
  assert.equal(r.rows[0].category, 'Other');
});

test('export neutralises spreadsheet formula injection and round-trips through import', () => {
  const list = [
    { date: '2025-01-01', category: 'Food', amount: 10, description: '=HYPERLINK("http://evil","x")' },
    { date: '2025-01-02', category: 'Other', amount: 2.5, description: 'Plain, with comma' },
  ];
  const csv = S.toCSV(list);
  assert.match(csv, /"'=HYPERLINK/);
  const back = S.parseTransactionsCSV(csv);
  assert.deepEqual(back.errors, []);
  assert.equal(back.rows[0].description, '=HYPERLINK("http://evil","x")');
  assert.equal(back.rows[1].description, 'Plain, with comma');
  assert.equal(back.rows[1].amount, 2.5);
});

test('DUPLICATE PREVENTION: same file twice, and re-importing own export, add nothing', () => {
  const rows = [
    { date: '2025-01-01', category: 'Food', amount: 10, description: 'Tea' },
    { date: '2025-01-01', category: 'Food', amount: 10, description: 'Tea' }, // two genuine identical purchases
    { date: '2025-01-02', category: 'Rent', amount: 500, description: 'Rent' },
  ];
  const first = S.planImport(rows, []);
  assert.equal(first.fresh.length, 3);
  assert.equal(first.duplicates, 0);
  assert.equal(new Set(first.fresh.map((r) => r.id)).size, 3, 'ids unique, incl. identical rows');
  // pretend those are now in the account (with unrelated push ids)
  const existing = first.fresh.map((r, i) => ({ ...r, id: '-Nabc' + i }));
  const second = S.planImport(rows, existing);
  assert.equal(second.fresh.length, 0);
  assert.equal(second.duplicates, 3);
  // a third identical row IS new
  const third = S.planImport([...rows, rows[0]], existing);
  assert.equal(third.fresh.length, 1);
});

test('ids are deterministic (safe against double-click / two tabs)', () => {
  const rows = [{ date: '2025-01-01', category: 'Food', amount: 10, description: 'Tea' }];
  assert.equal(S.planImport(rows, []).fresh[0].id, S.planImport(rows, []).fresh[0].id);
});

test('legacy ids become valid, stable record ids', () => {
  const k = S.legacyKey(1726656000000.123);
  assert.equal(k, 'm_1726656000000_123');
  assert.match(k, /^[A-Za-z0-9_-]{1,40}$/);
  assert.equal(S.legacyKey(1726656000000.123), k);
  assert.match(S.legacyKey(1.5e+21), /^[A-Za-z0-9_-]{1,40}$/, 'exponent notation is sanitised');
  assert.ok(S.legacyKey('x'.repeat(100)).length <= 40);
});

test('validateTransaction covers every field and real calendar dates', () => {
  const ok = { date: '2025-02-28', category: 'Food', amount: '10.5', description: 'x' };
  assert.equal(S.validateTransaction(ok), null);
  assert.match(S.validateTransaction({ ...ok, date: '2025-02-30' }), /real date/);
  assert.match(S.validateTransaction({ ...ok, date: '' }), /Date is required/);
  assert.match(S.validateTransaction({ ...ok, category: 'Nope' }), /Unknown category/);
  assert.match(S.validateTransaction({ ...ok, amount: '0' }), /positive/);
  assert.match(S.validateTransaction({ ...ok, amount: '-5' }), /positive/);
  assert.match(S.validateTransaction({ ...ok, amount: 'abc' }), /positive/);
  assert.match(S.validateTransaction({ ...ok, amount: 1e9 }), /too large/);
  assert.match(S.validateTransaction({ ...ok, description: '   ' }), /Description is required/);
  assert.match(S.validateTransaction({ ...ok, description: 'x'.repeat(121) }), /at most 120/);
  assert.equal(S.validateTransaction({ ...ok, category: 'Salary' }, 'income'), null);
  assert.match(S.validateTransaction({ ...ok, category: 'Food' }, 'income'), /Unknown category/);
});

test('validateBudget', () => {
  assert.equal(S.validateBudget('2025-03', '20000'), null);
  assert.ok(S.validateBudget('2025-3', '20000'));
  assert.ok(S.validateBudget('2025-03', '0'));
  assert.ok(S.validateBudget('2025-03', ''));
});

test('REGRESSION: date helpers use LOCAL time (UTC version was a day behind in IST mornings)', () => {
  // 01:00 local on the 1st of a month: toISOString() would give the previous day/month for UTC+ zones
  const d = new Date(2025, 2, 1, 1, 0, 0);
  assert.equal(S.localDateStr(d), '2025-03-01');
  assert.equal(S.localMonthStr(d), '2025-03');
});

test('esc() neutralises HTML', () => {
  assert.equal(S.esc('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
  assert.equal(S.esc(null), '');
});

test('round2 / fmtAmt', () => {
  assert.equal(S.round2(0.1 + 0.2), 0.3); // 0.30000000000000004 without rounding
  assert.equal(S.round2(1.105), 1.11);
  assert.equal(S.fmtAmt(1234567.8), '₹12,34,567.80');
});
