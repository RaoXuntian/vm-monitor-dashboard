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
  $('cpu-meta').textContent = `Load ${fmtNum(latest?.cpu?.load1)} · ${latest?.cpu?.cores || '--'} cores`;

  $('availability-now').textContent = fmtPct(summary?.availabilityPercent);
  $('uptime-meta').textContent = `Uptime ${formatDuration(latest?.uptimeSec)}`;

  $('memory-now').textContent = fmtPct(latest?.memory?.usagePercent);
  $('memory-meta').textContent = `${formatBytes(latest?.memory?.used)} / ${formatBytes(latest?.memory?.total)}`;

  const lastNet = [...series].reverse().find((point) => Number.isFinite(point.networkRxRateBps) || Number.isFinite(point.networkTxRateBps));
  $('network-now').textContent = `${formatRate(lastNet?.networkRxRateBps)} ↓`;
  $('network-meta').textContent = `RX ${formatRate(lastNet?.networkRxRateBps)} · TX ${formatRate(lastNet?.networkTxRateBps)}`;

  $('disk-now').textContent = fmtPct(latest?.disk?.usagePercent);
  $('disk-meta').textContent = `${formatBytes(latest?.disk?.used)} / ${formatBytes(latest?.disk?.total)}`;

  renderNodeInfo(payload.node);
  renderAlerts(payload.alerts || []);
  renderServices(payload.services || null);
  renderOpenClawOverview(payload.services || null);
  renderOpenClawMetricCards(payload.services || null);
  renderProcesses(payload.topProcesses || []);
  renderMounts(payload.mounts || []);

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

function renderNodeInfo(node) {
  const el = $('node-info');
  if (!el) return;
  const rows = [
    ['Hostname', node?.hostname || '--'],
    ['Platform', node?.platform || '--'],
    ['Architecture', node?.arch || '--'],
    ['CPU model', node?.cpuModel || '--'],
    ['Cores', node?.cores ?? '--'],
    ['Uptime', formatDuration(node?.uptimeSec)],
  ];
  el.innerHTML = rows.map(([label, value]) => `<div class="info-row"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function renderAlerts(alerts) {
  const el = $('alert-list');
  if (!el) return;
  el.innerHTML = alerts.map((alert) => `
    <div class="alert-item ${alert.level}">
      <strong>${alert.level === 'healthy' ? 'Healthy' : 'Alert'}</strong>
      <span>${alert.message}</span>
    </div>
  `).join('');
}

function renderServices(services) {
  const el = $('services-list');
  const accountsEl = $('weixin-accounts-table');
  if (!el) return;
  const gatewayLevel = services?.gateway?.running ? 'healthy' : 'critical';
  const weixinLevel = services?.weixin?.state === 'OK' ? 'healthy' : (services?.weixin?.state === 'WARN' ? 'warn' : 'critical');
  el.innerHTML = `
    <div class="alert-item ${gatewayLevel}">
      <strong>OpenClaw Gateway</strong>
      <span class="status-badge ${gatewayLevel}">${services?.gateway?.label || 'Unknown'}</span>
    </div>
    <div class="alert-item healthy">
      <strong>OpenClaw Sessions</strong>
      <span>${services?.sessions ?? '--'} active</span>
    </div>
    <div class="alert-item ${weixinLevel}">
      <strong>Weixin Channel</strong>
      <span class="status-badge ${weixinLevel}">${services?.weixin?.state || 'UNKNOWN'}</span>
    </div>
  `;

  if (accountsEl) {
    accountsEl.innerHTML = (services?.weixin?.accounts || []).map((account) => {
      const level = account.status === 'OK' ? 'healthy' : (account.status === 'WARN' ? 'warn' : 'critical');
      return `
        <tr>
          <td>${account.account}</td>
          <td><span class="status-badge ${level}">${account.status}</span></td>
          <td>${account.notes}</td>
        </tr>
      `;
    }).join('') || '<tr><td colspan="3">No account data</td></tr>';
  }
}

function renderOpenClawOverview(services) {
  const el = $('openclaw-overview');
  if (!el) return;
  const rows = [
    ['Version', services?.version || '--'],
    ['Gateway', services?.gateway?.detail || services?.gateway?.label || '--'],
    ['Dashboard', services?.dashboard || '--'],
    ['Tailscale', services?.tailscale || '--'],
    ['Update', services?.update || '--'],
    ['Heartbeat', services?.heartbeat || '--'],
    ['Sessions', services?.sessions ?? '--'],
    ['Weixin', services?.weixin?.state || '--'],
  ];
  el.innerHTML = rows.map(([label, value]) => `<div class="info-row"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function renderOpenClawMetricCards(services) {
  $('oc-sessions').textContent = services?.sessions ?? '--';
  $('oc-heartbeat').textContent = `Heartbeat ${services?.heartbeat || '--'}`;
  $('wx-accounts').textContent = services?.weixin?.accounts?.length ?? 0;
  $('wx-state-meta').textContent = `State ${services?.weixin?.state || '--'}`;
  $('gateway-status').textContent = services?.gateway?.running ? 'Online' : 'Offline';
  $('gateway-meta').textContent = services?.version || '--';
}

function renderProcesses(processes) {
  const el = $('process-table');
  if (!el) return;
  el.innerHTML = processes.map((proc) => `
    <tr>
      <td>${proc.pid}</td>
      <td>${proc.command}</td>
      <td>${fmtPct(proc.cpuPercent)}</td>
      <td>${fmtPct(proc.memoryPercent)}</td>
    </tr>
  `).join('') || '<tr><td colspan="4">No process data</td></tr>';
}

function renderMounts(mounts) {
  const el = $('mounts-table');
  if (!el) return;
  el.innerHTML = mounts.map((mount) => `
    <tr>
      <td>${mount.mount}</td>
      <td>${formatBytes(mount.used)}</td>
      <td>${formatBytes(mount.total)}</td>
      <td>${fmtPct(mount.usagePercent)}</td>
    </tr>
  `).join('') || '<tr><td colspan="4">No filesystem data</td></tr>';
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
  const container = svg.parentElement;
  const containerWidth = container.clientWidth || 800;
  const height = svg.clientHeight || 260;
  const pad = { top: 12, right: 14, bottom: 26, left: 14 };

  // Downsample to ~5 minute buckets for readability
  const BUCKET_MS = 5 * 60 * 1000;
  const downsampled = [];
  if (series.length) {
    let bucketStart = series[0].timestamp;
    let bucket = [];
    for (const point of series) {
      if (point.timestamp - bucketStart >= BUCKET_MS && bucket.length) {
        downsampled.push(bucket[bucket.length - 1]); // take last point in bucket
        bucket = [];
        bucketStart = point.timestamp;
      }
      bucket.push(point);
    }
    if (bucket.length) downsampled.push(bucket[bucket.length - 1]);
  }
  const plotSeries = downsampled.length ? downsampled : series;

  // Fixed width: fit container, no horizontal scroll
  const width = containerWidth;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.style.minWidth = '';

  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const minTs = plotSeries[0]?.timestamp || Date.now();
  const maxTs = plotSeries.at(-1)?.timestamp || minTs + 1;
  const yMin = options.yMin ?? 0;
  const yMax = options.yMax ?? 100;

  const x = (ts) => pad.left + ((ts - minTs) / Math.max(1, maxTs - minTs)) * innerW;
  const y = (v) => pad.top + innerH - ((v - yMin) / Math.max(1, yMax - yMin)) * innerH;

  // Grid lines span full scrollable width
  const grid = [0, .25, .5, .75, 1].map((p) => {
    const yy = pad.top + innerH * p;
    const val = yMax - (yMax - yMin) * p;
    const label = options.ySuffix ? `${val.toFixed(0)}${options.ySuffix}` : (options.formatter ? options.formatter(val) : val.toFixed(0));
    return `
      <line class="chart-grid" x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" />
      <text class="chart-label" x="${width - pad.right}" y="${yy - 4}" text-anchor="end">${label}</text>
    `;
  }).join('');

  // Time labels: show more labels for wider charts
  const labelCount = Math.max(3, Math.min(12, Math.floor(width / 120)));
  const timeLabels = Array.from({ length: labelCount }, (_, i) => {
    const p = i / (labelCount - 1);
    const ts = minTs + (maxTs - minTs) * p;
    return `<text class="chart-label" x="${pad.left + innerW * p}" y="${height - 6}" text-anchor="middle">${new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</text>`;
  }).join('');

  const lines = defs.map((def) => {
    const points = plotSeries.filter((point) => Number.isFinite(point[def.key]));
    if (!points.length) return '';
    const d = points.map((point, i) => `${i ? 'L' : 'M'} ${x(point.timestamp)} ${y(point[def.key])}`).join(' ');
    const area = `${d} L ${x(points.at(-1).timestamp)} ${pad.top + innerH} L ${x(points[0].timestamp)} ${pad.top + innerH} Z`;
    return `
      <path class="chart-area" d="${area}" fill="${def.fill}" />
      <path class="chart-path" d="${d}" stroke="${def.color}" />
    `;
  }).join('');

  svg.innerHTML = `${grid}${lines}${timeLabels}`;

  // Interactive tooltip (mouse + touch)
  const overlayRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  overlayRect.setAttribute('x', pad.left);
  overlayRect.setAttribute('y', pad.top);
  overlayRect.setAttribute('width', innerW);
  overlayRect.setAttribute('height', innerH);
  overlayRect.setAttribute('fill', 'transparent');
  overlayRect.style.cursor = 'crosshair';
  overlayRect.style.touchAction = 'none';
  svg.appendChild(overlayRect);

  const cursorLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  cursorLine.setAttribute('y1', pad.top);
  cursorLine.setAttribute('y2', pad.top + innerH);
  cursorLine.setAttribute('stroke', 'rgba(255,255,255,0.25)');
  cursorLine.setAttribute('stroke-dasharray', '4 3');
  cursorLine.style.display = 'none';
  svg.appendChild(cursorLine);

  // Data point dots
  const dots = defs.map((def) => {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '4');
    dot.setAttribute('fill', def.color);
    dot.setAttribute('stroke', 'var(--background)');
    dot.setAttribute('stroke-width', '2');
    dot.style.display = 'none';
    svg.appendChild(dot);
    return dot;
  });

  let tooltip = svg.parentElement.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    svg.parentElement.style.position = 'relative';
    svg.parentElement.appendChild(tooltip);
  }

  function findClosestPoint(clientX) {
    const rect = svg.getBoundingClientRect();
    const mouseX = clientX - rect.left;
    const ts = minTs + ((mouseX - pad.left) / Math.max(1, innerW)) * (maxTs - minTs);
    let closest = null;
    let closestDist = Infinity;
    for (const point of plotSeries) {
      const dist = Math.abs(point.timestamp - ts);
      if (dist < closestDist) {
        closestDist = dist;
        closest = point;
      }
    }
    return closest;
  }

  function showTooltip(clientX) {
    const point = findClosestPoint(clientX);
    if (!point) return;
    const cx = x(point.timestamp);
    cursorLine.setAttribute('x1', cx);
    cursorLine.setAttribute('x2', cx);
    cursorLine.style.display = '';

    defs.forEach((def, i) => {
      const v = point[def.key];
      if (Number.isFinite(v)) {
        dots[i].setAttribute('cx', cx);
        dots[i].setAttribute('cy', y(v));
        dots[i].style.display = '';
      } else {
        dots[i].style.display = 'none';
      }
    });

    const time = new Date(point.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const vals = defs.map((def) => {
      const v = point[def.key];
      const formatted = options.formatter ? options.formatter(v) : (options.ySuffix ? `${(v ?? 0).toFixed(1)}${options.ySuffix}` : (v ?? 0).toFixed(1));
      return `<span style="color:${def.color}">${def.key.replace(/Percent|Bps/g, '').replace(/([A-Z])/g, ' $1').trim()}: ${formatted}</span>`;
    }).join('<br>');

    tooltip.innerHTML = `<div class="tooltip-time">${time}</div>${vals}`;
    tooltip.style.display = 'block';

    const tooltipX = cx + pad.left > innerW * 0.7 ? cx - 160 : cx + 12;
    tooltip.style.left = `${tooltipX}px`;
    tooltip.style.top = `${pad.top + 8}px`;
  }

  function hideTooltip() {
    cursorLine.style.display = 'none';
    tooltip.style.display = 'none';
    dots.forEach((dot) => { dot.style.display = 'none'; });
  }

  // Mouse events
  overlayRect.addEventListener('mousemove', (e) => showTooltip(e.clientX));
  overlayRect.addEventListener('mouseleave', hideTooltip);

  // Touch events
  let touching = false;
  overlayRect.addEventListener('touchstart', (e) => {
    touching = true;
    e.preventDefault();
    if (e.touches[0]) showTooltip(e.touches[0].clientX);
  }, { passive: false });
  overlayRect.addEventListener('touchmove', (e) => {
    if (!touching) return;
    e.preventDefault();
    if (e.touches[0]) showTooltip(e.touches[0].clientX);
  }, { passive: false });
  overlayRect.addEventListener('touchend', () => {
    touching = false;
    setTimeout(hideTooltip, 1500);
  });
  overlayRect.addEventListener('touchcancel', () => {
    touching = false;
    hideTooltip();
  });
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

(async function init() {
  try {
    await loadData();
  } catch (err) {
    console.error(err);
  }
})();
