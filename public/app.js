const state = {
  rangeHours: 24,
  payload: null,
};

const $ = (id) => document.getElementById(id);
const fmtPct = (n) => n == null ? '--' : `${n.toFixed(1)}%`;
const fmtNum = (n, digits = 2) => n == null ? '--' : Number(n).toFixed(digits);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatRate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec)) return '--';
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '--';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function setActiveRange(hours) {
  state.rangeHours = hours;
  document.querySelectorAll('#range-picker button').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.hours) === hours);
  });
}

async function loadData() {
  const res = await fetch(`/api/metrics?hours=${state.rangeHours}`);
  state.payload = await res.json();
  render();
}

function render() {
  const payload = state.payload;
  const summary = payload.summary;
  const latest = summary?.latest;
  const series = payload.series || [];
  $('hostname-pill').textContent = `Hostname: ${latest?.hostname || '--'}`;
  $('updated-pill').textContent = `Updated: ${latest ? new Date(latest.timestamp).toLocaleString() : '--'}`;

  $('cpu-now').textContent = fmtPct(latest?.cpu?.usagePercent ?? summary?.averages?.cpuUsagePercent);
  $('cpu-meta').textContent = `Load average ${fmtNum(latest?.cpu?.load1)} · ${latest?.cpu?.cores || '--'} cores`;

  $('availability-now').textContent = fmtPct(summary?.availabilityPercent);
  $('uptime-meta').textContent = `Uptime ${formatDuration(latest?.uptimeSec)}`;

  $('memory-now').textContent = fmtPct(latest?.memory?.usagePercent);
  $('memory-meta').textContent = `${formatBytes(latest?.memory?.used)} / ${formatBytes(latest?.memory?.total)}`;

  const lastNet = [...series].reverse().find((point) => Number.isFinite(point.networkRxRateBps) || Number.isFinite(point.networkTxRateBps));
  $('network-now').textContent = `${formatRate(lastNet?.networkRxRateBps)} ↓`;
  $('network-meta').textContent = `RX ${formatRate(lastNet?.networkRxRateBps)} · TX ${formatRate(lastNet?.networkTxRateBps)}`;

  $('disk-now').textContent = fmtPct(latest?.disk?.usagePercent);
  $('disk-meta').textContent = `${formatBytes(latest?.disk?.used)} / ${formatBytes(latest?.disk?.total)}`;

  renderLineChart('chart-utilization', series, [
    { key: 'cpuUsagePercent', color: '#61a8ff', fill: 'rgba(97,168,255,.18)' },
    { key: 'memoryUsagePercent', color: '#c28cff', fill: 'rgba(194,140,255,.14)' },
  ], { yMin: 0, yMax: 100, ySuffix: '%' });

  const networkMax = Math.max(1, ...series.flatMap((point) => [point.networkRxRateBps || 0, point.networkTxRateBps || 0]));
  renderLineChart('chart-network', series, [
    { key: 'networkRxRateBps', color: '#63e2c6', fill: 'rgba(99,226,198,.14)' },
    { key: 'networkTxRateBps', color: '#f6c760', fill: 'rgba(246,199,96,.10)' },
  ], { yMin: 0, yMax: networkMax, formatter: formatRate });

  renderGauge(latest?.disk?.usagePercent, latest?.disk?.used, latest?.disk?.total);
}

function renderGauge(value = 0, used, total) {
  const pct = Math.max(0, Math.min(100, value || 0));
  const gauge = $('disk-gauge');
  gauge.innerHTML = `
    <div class="gauge-ring" style="background: conic-gradient(#ff7a8a 0 ${pct}%, rgba(255,255,255,.08) ${pct}% 100%);">
      <div class="gauge-content">
        <div class="gauge-value">${fmtPct(pct)}</div>
        <div class="gauge-meta">${formatBytes(used)} used of ${formatBytes(total)}</div>
      </div>
    </div>
  `;
}

function renderLineChart(id, series, defs, options) {
  const svg = $(id);
  const width = svg.clientWidth || 800;
  const height = svg.clientHeight || 260;
  const pad = { top: 12, right: 14, bottom: 26, left: 14 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const minTs = series[0]?.timestamp || Date.now();
  const maxTs = series.at(-1)?.timestamp || minTs + 1;
  const yMin = options.yMin ?? 0;
  const yMax = options.yMax ?? 100;

  const x = (ts) => pad.left + ((ts - minTs) / Math.max(1, maxTs - minTs)) * innerW;
  const y = (v) => pad.top + innerH - ((v - yMin) / Math.max(1, yMax - yMin)) * innerH;

  const grid = [0, .25, .5, .75, 1].map((p) => {
    const yy = pad.top + innerH * p;
    const val = yMax - (yMax - yMin) * p;
    const label = options.ySuffix ? `${val.toFixed(0)}${options.ySuffix}` : (options.formatter ? options.formatter(val) : val.toFixed(0));
    return `
      <line class="chart-grid" x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" />
      <text class="chart-label" x="${width - pad.right}" y="${yy - 4}" text-anchor="end">${label}</text>
    `;
  }).join('');

  const timeLabels = [0, 0.5, 1].map((p) => {
    const ts = minTs + (maxTs - minTs) * p;
    return `<text class="chart-label" x="${pad.left + innerW * p}" y="${height - 6}" text-anchor="middle">${new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</text>`;
  }).join('');

  const lines = defs.map((def) => {
    const points = series.filter((point) => Number.isFinite(point[def.key]));
    if (!points.length) return '';
    const d = points.map((point, i) => `${i ? 'L' : 'M'} ${x(point.timestamp)} ${y(point[def.key])}`).join(' ');
    const area = `${d} L ${x(points.at(-1).timestamp)} ${pad.top + innerH} L ${x(points[0].timestamp)} ${pad.top + innerH} Z`;
    return `
      <path class="chart-area" d="${area}" fill="${def.fill}" />
      <path class="chart-path" d="${d}" stroke="${def.color}" />
    `;
  }).join('');

  svg.innerHTML = `${grid}${lines}${timeLabels}`;
}

document.querySelectorAll('#range-picker button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const hours = Number(btn.dataset.hours);
    setActiveRange(hours);
    await loadData();
  });
});

$('refresh-btn').addEventListener('click', loadData);
window.addEventListener('resize', () => state.payload && render());
setActiveRange(state.rangeHours);
loadData().catch((err) => console.error(err));
