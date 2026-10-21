/**
 * charts.js — Chart.js visualizations for ExpenseIQ
 */

let _barChart    = null;
let _donutChart  = null;
let _trendChart  = null;

const CHART_DEFAULTS = {
  color: '#9AA3BE',
  grid:  'rgba(255,255,255,0.05)',
  font:  "'Inter', sans-serif",
};

const HAS_CHART = typeof Chart !== 'undefined';
if (HAS_CHART) {
  Chart.defaults.color = CHART_DEFAULTS.color;
  Chart.defaults.font.family = CHART_DEFAULTS.font;
}

// ─── Category bar + donut ─────────────────────────────────────────
function renderCategoryCharts(month) {
  if (!HAS_CHART) return;
  const catMap = spendingByCategory(month);
  const cats   = Object.keys(catMap).sort((a, b) => catMap[b] - catMap[a]);
  const values = cats.map(c => catMap[c]);
  const colors = cats.map(c => getCatColor(c));

  // Bar chart
  const barCtx = document.getElementById('catBarChart');
  if (_barChart) { _barChart.destroy(); _barChart = null; }
  if (!cats.length) {
    barCtx.getContext('2d').clearRect(0, 0, barCtx.width, barCtx.height);
  } else {
    _barChart = new Chart(barCtx, {
      type: 'bar',
      data: {
        labels: cats.map(c => getCatEmoji(c) + ' ' + c),
        datasets: [{
          label: 'Spending',
          data: values,
          backgroundColor: colors.map(c => c + 'CC'),
          borderColor: colors,
          borderWidth: 1.5,
          borderRadius: 6,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ' ' + fmtAmt(ctx.parsed.y),
            }
          }
        },
        scales: {
          y: {
            grid: { color: CHART_DEFAULTS.grid },
            ticks: { callback: v => '₹' + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v) },
          },
          x: { grid: { display: false } }
        }
      }
    });
  }

  // Donut chart
  const donutCtx = document.getElementById('catDonutChart');
  if (_donutChart) { _donutChart.destroy(); _donutChart = null; }
  if (!cats.length) {
    donutCtx.getContext('2d').clearRect(0, 0, donutCtx.width, donutCtx.height);
  } else {
    _donutChart = new Chart(donutCtx, {
      type: 'doughnut',
      data: {
        labels: cats,
        datasets: [{
          data: values,
          backgroundColor: colors.map(c => c + 'CC'),
          borderColor: colors,
          borderWidth: 1.5,
          hoverOffset: 6,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: {
            position: 'right',
            labels: { font: { size: 11 }, boxWidth: 10, padding: 10 }
          },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.label}: ${fmtAmt(ctx.parsed)} (${(ctx.parsed / values.reduce((s, v) => s + v, 0) * 100).toFixed(1)}%)`,
            }
          }
        }
      }
    });
  }
}

// ─── Monthly trend ────────────────────────────────────────────────
function renderTrend() {
  if (!HAS_CHART) return;
  const n     = parseInt(document.getElementById('trend-months').value || '6', 10);
  const data  = monthlyTotals(n);
  const labels = data.map(d => {
    const [y, m] = d.month.split('-');
    return new Date(+y, +m - 1, 1).toLocaleString('default', { month: 'short', year: '2-digit' });
  });
  const totals  = data.map(d => d.total);
  const budgets = data.map(d => d.budget);

  const ctx = document.getElementById('trendChart');
  if (_trendChart) { _trendChart.destroy(); _trendChart = null; }

  _trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Spending',
          data: totals,
          borderColor: '#7C6FF7',
          backgroundColor: 'rgba(124,111,247,0.12)',
          fill: true,
          tension: 0.4,
          pointBackgroundColor: '#7C6FF7',
          pointRadius: 4,
          pointHoverRadius: 7,
          borderWidth: 2.5,
        },
        {
          label: 'Budget',
          data: budgets,
          borderColor: '#2DD4A4',
          backgroundColor: 'transparent',
          borderDash: [5, 4],
          tension: 0.3,
          pointRadius: 3,
          borderWidth: 1.8,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { font: { size: 12 }, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${fmtAmt(ctx.parsed.y)}`,
          }
        }
      },
      scales: {
        y: {
          grid: { color: CHART_DEFAULTS.grid },
          ticks: { callback: v => '₹' + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v) },
        },
        x: { grid: { display: false } }
      }
    }
  });
}
