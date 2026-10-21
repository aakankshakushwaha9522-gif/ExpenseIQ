'use strict';
/**
 * finance.js — all financial arithmetic lives here (never delegated to the AI).
 *
 * Pure functions: they take plain arrays/objects and return plain objects, which
 * makes them trivially unit-testable.
 *
 *   expenses / income : [{ id, date:'YYYY-MM-DD', category, amount, description }]
 *   budgets           : { 'YYYY-MM': number }
 */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function isMonth(s) { return typeof s === 'string' && MONTH_RE.test(s); }
function isDate(s) { return typeof s === 'string' && DATE_RE.test(s); }

/** Keep only well-formed records so one corrupt row can never break a report. */
function clean(list) {
  return (Array.isArray(list) ? list : []).filter(
    (e) => e && isDate(e.date) && Number.isFinite(Number(e.amount)) && Number(e.amount) > 0
  ).map((e) => ({
    id: e.id,
    date: e.date,
    category: String(e.category || 'Other'),
    amount: Number(e.amount),
    description: String(e.description || ''),
  }));
}

function addMonths(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function totalForMonth(list, month) {
  return round2(list.filter((e) => e.date.startsWith(month)).reduce((s, e) => s + e.amount, 0));
}

function byCategory(list, month) {
  const map = {};
  for (const e of list) {
    if (month && !e.date.startsWith(month)) continue;
    map[e.category] = (map[e.category] || 0) + e.amount;
  }
  return Object.entries(map)
    .map(([category, total]) => ({ category, total: round2(total) }))
    .sort((a, b) => b.total - a.total);
}

function monthlySeries(list, endMonth, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const month = addMonths(endMonth, -i);
    out.push({ month, total: totalForMonth(list, month) });
  }
  return out;
}

function compareMonths(list, month) {
  const prev = addMonths(month, -1);
  const current = totalForMonth(list, month);
  const previous = totalForMonth(list, prev);
  const difference = round2(current - previous);
  return {
    currentMonth: month,
    previousMonth: prev,
    current,
    previous,
    difference,
    percentChange: previous > 0 ? round2((difference / previous) * 100) : null,
    // honest flag: with no previous spend a % change is undefined
    hasPreviousData: previous > 0,
  };
}

/**
 * Forecast next month's spend from *complete* historical months only.
 * - needs at least 2 months that actually contain expenses
 * - 2 months  -> average
 * - 3+ months -> blend of recent average and a least-squares trend (clamped >= 0)
 */
function forecastNextMonth(list, currentMonth, lookback = 6) {
  const history = monthlySeries(list, addMonths(currentMonth, -1), lookback)
    .filter((m) => m.total > 0);
  const target = addMonths(currentMonth, 1);
  if (history.length < 2) {
    return {
      sufficient: false,
      targetMonth: target,
      monthsUsed: history.length,
      reason: 'At least 2 previous months with expenses are needed to make a forecast.',
    };
  }
  const values = history.map((h) => h.total);
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  let predicted = mean;
  let method = 'average';
  if (n >= 3) {
    const xs = values.map((_, i) => i);
    const xMean = xs.reduce((s, v) => s + v, 0) / n;
    const denom = xs.reduce((s, x) => s + (x - xMean) ** 2, 0);
    const slope = denom === 0 ? 0 : xs.reduce((s, x, i) => s + (x - xMean) * (values[i] - mean), 0) / denom;
    const trendPoint = mean + slope * (n - xMean); // regression value at index n
    predicted = 0.5 * mean + 0.5 * Math.max(0, trendPoint);
    method = 'average blended with linear trend';
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    sufficient: true,
    targetMonth: target,
    predicted: round2(Math.max(0, predicted)),
    rangeLow: round2(min),
    rangeHigh: round2(max),
    monthsUsed: n,
    method,
    confidence: n >= 5 ? 'moderate' : 'low',
  };
}

/** Pro-rata projection of the current month from spend so far. */
function projectCurrentMonth(list, month, today) {
  const dim = daysInMonth(month);
  if (!isDate(today) || !today.startsWith(month)) return null;
  const day = Number(today.slice(8, 10));
  const spent = totalForMonth(list, month);
  if (day < 1) return null;
  return { daysElapsed: day, daysInMonth: dim, spentSoFar: spent, projected: round2((spent / day) * dim) };
}

/**
 * Build the complete, trusted fact sheet that is handed to the AI.
 * Everything numeric is computed here.
 */
function buildSummary({ expenses, income, budgets }, { month, today }) {
  const exp = clean(expenses);
  const inc = clean(income);
  const bud = budgets && typeof budgets === 'object' ? budgets : {};
  const budget = Number(bud[month]) > 0 ? Number(bud[month]) : 0;
  const spent = totalForMonth(exp, month);
  const earned = totalForMonth(inc, month);
  const cats = byCategory(exp, month);
  const prevMonth = addMonths(month, -1);

  const recent = [...exp]
    .filter((e) => e.date.startsWith(month))
    .sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount)
    .slice(0, 15)
    .map((e) => ({ date: e.date, category: e.category, amount: e.amount, description: e.description.slice(0, 60) }));

  return {
    month,
    currency: 'INR',
    transactionCount: { expenses: exp.length, income: inc.length },
    thisMonth: {
      totalSpent: spent,
      totalIncome: earned,
      balance: round2(earned - spent),
      expenseCount: exp.filter((e) => e.date.startsWith(month)).length,
      budget: budget || null,
      budgetRemaining: budget ? round2(budget - spent) : null,
      budgetUsedPercent: budget ? round2((spent / budget) * 100) : null,
      overBudget: budget ? spent > budget : null,
      topCategory: cats[0] || null,
      byCategory: cats.map((c) => ({
        ...c,
        percentOfSpend: spent > 0 ? round2((c.total / spent) * 100) : 0,
      })),
      recentExpenses: recent,
    },
    lastMonth: {
      month: prevMonth,
      totalSpent: totalForMonth(exp, prevMonth),
      byCategory: byCategory(exp, prevMonth),
      budget: Number(bud[prevMonth]) > 0 ? Number(bud[prevMonth]) : null,
    },
    comparison: compareMonths(exp, month),
    categoryChanges: categoryChanges(exp, month),
    forecast: forecastNextMonth(exp, month),
    currentMonthProjection: projectCurrentMonth(exp, month, today),
    monthlyHistory: monthlySeries(exp, month, 6),
    allBudgets: Object.entries(bud)
      .filter(([k, v]) => isMonth(k) && Number(v) > 0)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 12)
      .map(([m, v]) => ({ month: m, budget: Number(v) })),
  };
}

function categoryChanges(list, month) {
  const cur = Object.fromEntries(byCategory(list, month).map((c) => [c.category, c.total]));
  const prev = Object.fromEntries(byCategory(list, addMonths(month, -1)).map((c) => [c.category, c.total]));
  const cats = new Set([...Object.keys(cur), ...Object.keys(prev)]);
  return [...cats]
    .map((category) => ({
      category,
      current: cur[category] || 0,
      previous: prev[category] || 0,
      difference: round2((cur[category] || 0) - (prev[category] || 0)),
    }))
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
}

const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Deterministic plain-text digest built only from computed numbers. Used when the
 * AI service is unavailable, so the user still gets correct figures.
 */
function fallbackDigest(summary) {
  const t = summary.thisMonth;
  if (summary.transactionCount.expenses === 0) {
    return 'You have not recorded any expenses yet, so there is nothing to analyse. Add a few expenses and ask again.';
  }
  const lines = [`Here is a summary computed from your data for ${summary.month}:`];
  lines.push(`• Total spent: ${inr(t.totalSpent)} across ${t.expenseCount} expense(s).`);
  if (t.budget) {
    lines.push(`• Budget: ${inr(t.budget)} — ${t.overBudget
      ? `over by ${inr(Math.abs(t.budgetRemaining))}`
      : `${inr(t.budgetRemaining)} remaining`} (${t.budgetUsedPercent}% used).`);
  } else {
    lines.push('• No budget is set for this month.');
  }
  if (t.topCategory) lines.push(`• Highest category: ${t.topCategory.category} (${inr(t.topCategory.total)}).`);
  const c = summary.comparison;
  lines.push(c.hasPreviousData
    ? `• Versus ${c.previousMonth}: ${inr(c.previous)} → ${inr(c.current)} (${c.difference >= 0 ? '+' : '-'}${inr(Math.abs(c.difference))}, ${c.percentChange}%).`
    : `• No spending recorded for ${c.previousMonth}, so no comparison is possible.`);
  const f = summary.forecast;
  lines.push(f.sufficient
    ? `• Forecast for ${f.targetMonth}: about ${inr(f.predicted)} (range ${inr(f.rangeLow)}–${inr(f.rangeHigh)}, ${f.confidence} confidence).`
    : `• Forecast: ${f.reason}`);
  return lines.join('\n');
}

module.exports = {
  MONTH_RE, DATE_RE, isMonth, isDate, round2, clean, addMonths, daysInMonth,
  totalForMonth, byCategory, monthlySeries, compareMonths, forecastNextMonth,
  projectCurrentMonth, categoryChanges, buildSummary, fallbackDigest,
};
