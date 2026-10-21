'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../server/finance');

const mk = (date, amount, category = 'Food', description = 'x') => ({ id: date + amount, date, amount, category, description });

test('addMonths handles year boundaries', () => {
  assert.equal(f.addMonths('2025-01', -1), '2024-12');
  assert.equal(f.addMonths('2024-12', 1), '2025-01');
  assert.equal(f.addMonths('2024-03', -14), '2023-01');
});

test('daysInMonth handles leap years', () => {
  assert.equal(f.daysInMonth('2024-02'), 29);
  assert.equal(f.daysInMonth('2025-02'), 28);
  assert.equal(f.daysInMonth('2025-04'), 30);
});

test('totalForMonth uses exact month prefix and avoids float drift', () => {
  const list = [mk('2025-03-01', 0.1), mk('2025-03-02', 0.2), mk('2025-04-01', 5)];
  assert.equal(f.totalForMonth(list, '2025-03'), 0.3);
  assert.equal(f.totalForMonth(list, '2025-04'), 5);
  assert.equal(f.totalForMonth(list, '2025-05'), 0);
});

test('byCategory sorts descending and filters by month', () => {
  const list = [mk('2025-03-01', 100, 'Food'), mk('2025-03-02', 500, 'Rent'), mk('2025-03-03', 50, 'Food'), mk('2025-02-03', 999, 'Travel')];
  assert.deepEqual(f.byCategory(list, '2025-03'), [{ category: 'Rent', total: 500 }, { category: 'Food', total: 150 }]);
  assert.equal(f.byCategory(list)[0].category, 'Travel'); // all-time
});

test('clean() drops corrupt records instead of crashing', () => {
  const out = f.clean([mk('2025-03-01', 10), { date: 'bad', amount: 5 }, { date: '2025-03-01', amount: -4 }, null, { date: '2025-03-01', amount: 'abc' }]);
  assert.equal(out.length, 1);
  assert.deepEqual(f.clean(undefined), []);
});

test('compareMonths computes difference and percent; flags missing previous data', () => {
  const list = [mk('2025-02-10', 200), mk('2025-03-10', 300)];
  const c = f.compareMonths(list, '2025-03');
  assert.equal(c.difference, 100);
  assert.equal(c.percentChange, 50);
  assert.equal(c.hasPreviousData, true);
  const none = f.compareMonths([mk('2025-03-10', 300)], '2025-03');
  assert.equal(none.percentChange, null);
  assert.equal(none.hasPreviousData, false);
});

test('forecast: insufficient with fewer than 2 historical months', () => {
  const r = f.forecastNextMonth([mk('2025-02-01', 100)], '2025-03');
  assert.equal(r.sufficient, false);
  assert.match(r.reason, /2 previous months/);
  // current (partial) month must NOT count as history
  const r2 = f.forecastNextMonth([mk('2025-03-01', 100), mk('2025-02-01', 100)], '2025-03');
  assert.equal(r2.sufficient, false);
});

test('forecast: two months -> plain average', () => {
  const r = f.forecastNextMonth([mk('2025-01-05', 100), mk('2025-02-05', 200)], '2025-03');
  assert.equal(r.sufficient, true);
  assert.equal(r.predicted, 150);
  assert.equal(r.targetMonth, '2025-04');
  assert.equal(r.method, 'average');
});

test('forecast: rising trend predicts above the plain mean, never negative', () => {
  const rising = [100, 200, 300, 400].map((v, i) => mk(`2025-0${i + 1}-05`, v));
  const r = f.forecastNextMonth(rising, '2025-05');
  assert.equal(r.sufficient, true);
  assert.ok(r.predicted > 250 && r.predicted <= 400, `predicted=${r.predicted}`);
  const falling = [400, 200, 50].map((v, i) => mk(`2025-0${i + 1}-05`, v));
  assert.ok(f.forecastNextMonth(falling, '2025-04').predicted >= 0);
});

test('projectCurrentMonth is pro-rata and null for other months', () => {
  const list = [mk('2025-03-02', 300)];
  const p = f.projectCurrentMonth(list, '2025-03', '2025-03-10');
  assert.equal(p.projected, 930); // 300/10*31
  assert.equal(f.projectCurrentMonth(list, '2025-03', '2025-04-10'), null);
});

test('buildSummary: budget, income, balance, top category', () => {
  const summary = f.buildSummary({
    expenses: [mk('2025-03-01', 1000, 'Rent'), mk('2025-03-02', 250, 'Food'), mk('2025-02-02', 400, 'Food')],
    income: [mk('2025-03-01', 5000, 'Salary')],
    budgets: { '2025-03': 2000 },
  }, { month: '2025-03', today: '2025-03-15' });
  const t = summary.thisMonth;
  assert.equal(t.totalSpent, 1250);
  assert.equal(t.totalIncome, 5000);
  assert.equal(t.balance, 3750);
  assert.equal(t.budget, 2000);
  assert.equal(t.budgetRemaining, 750);
  assert.equal(t.budgetUsedPercent, 62.5);
  assert.equal(t.overBudget, false);
  assert.equal(t.topCategory.category, 'Rent');
  assert.equal(summary.lastMonth.totalSpent, 400);
  assert.equal(summary.comparison.difference, 850);
});

test('buildSummary: over-budget and no-budget cases', () => {
  const over = f.buildSummary({ expenses: [mk('2025-03-01', 3000)], income: [], budgets: { '2025-03': 2000 } }, { month: '2025-03', today: '2025-03-02' });
  assert.equal(over.thisMonth.overBudget, true);
  assert.equal(over.thisMonth.budgetRemaining, -1000);
  const none = f.buildSummary({ expenses: [mk('2025-03-01', 3000)], income: [], budgets: {} }, { month: '2025-03', today: '2025-03-02' });
  assert.equal(none.thisMonth.budget, null);
  assert.equal(none.thisMonth.overBudget, null);
});

test('buildSummary: empty account is safe', () => {
  const s = f.buildSummary({ expenses: [], income: [], budgets: null }, { month: '2025-03', today: '2025-03-02' });
  assert.equal(s.thisMonth.totalSpent, 0);
  assert.equal(s.thisMonth.topCategory, null);
  assert.equal(s.forecast.sufficient, false);
  assert.match(f.fallbackDigest(s), /not recorded any expenses/);
});

test('fallbackDigest reports computed numbers and honest gaps', () => {
  const s = f.buildSummary({ expenses: [mk('2025-03-01', 1250, 'Rent')], income: [], budgets: { '2025-03': 1000 } }, { month: '2025-03', today: '2025-03-02' });
  const d = f.fallbackDigest(s);
  assert.match(d, /1,250\.00/);
  assert.match(d, /over by .*250\.00/);
  assert.match(d, /no comparison is possible/);
  assert.match(d, /Forecast: At least 2/);
});
