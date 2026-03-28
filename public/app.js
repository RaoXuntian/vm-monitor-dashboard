const state = {
  rangeHours: 24,
  payload: null,
  eventSource: null,
  pendingConfirmAction: null,
};

const $ = (id) => document.getElementById(id);
const fmtPct = (n) => n == null ? '--' : `${Number(n).toFixed(1)}%`;
const fmtNum = (n, digits = 2) => n == null ? '--' : Number(n).toFixed(digits);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
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

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function setActiveRange(hours) {
  state.rangeHours = hours;
  document.querySelectorAll('#range-picker button').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.hours) === hours);
  });
}

async function loadData() {
  const res = await fetch(`/api/metrics?hours=${state.rangeHours}`, { cache: 'no-store' });
  state.payload = await res.json();
  render();
}

function updateStreamStatus(label, healthy = false) {
  const el = $('stream-status');
  el.textContent = label;
  el.classList.toggle('healthy', healthy);
}

function getLatestNetworkPoint(series) {
  return [...(series || [])].reverse().find((point) => Number.isFinite(point.networkRxRateBps) || Number.isFinite(point.networkTxRateBps));
}

function render() {
  const payload = state.payload;
  if (!payload) return;
  const summary = payload.summary;
  const latest = summary?.latest;
  const services = payload.services || latest?.openclaw || {};
  const series = payload.series || [];
  const lastNet = getLatestNetworkPoint(series);
  const monthlyTraffic = payload.monthlyTraffic || latest?.monthlyTraffic || { inbound: 0, outbound: 0, month: '--' };
  const tcpConnections = payload.tcpConnections || latest?.tcpConnections || { total: 0, byPort: [] };

  setText('hostname-pill', `Hostname: ${latest?.hostname || '--'}`);
  setText('updated-pill', `Updated: ${latest ? new Date(latest.timestamp).toLocaleString() : '--'}`);
  setText('uptime-pill', `Uptime: ${formatDuration(latest?.uptimeSec)}`);
  setText('connections-pill', `TCP: ${tcpConnections.total ?? '--'}`);

  setText('cpu-now', fmtPct(latest?.cpu?.usagePercent ?? summary?.averages?.cpuUsagePercent));
  setText('cpu-meta', `Load ${fmtNum(latest?.cpu?.load1)} · ${latest?.cpu?.cores || '--'} cores`);
  setText('cpu-peak', fmtPct(summary?.peak?.cpuUsagePercent));
  setText('cpu-avg', fmtPct(summary?.averages?.cpuUsagePercent));

  setText('memory-now', fmtPct(latest?.memory?.usagePercent));
  setText('memory-meta', `${formatBytes(latest?.memory?.used)} / ${formatBytes(latest?.memory?.total)}`);
  setText('memory-used', formatBytes(latest?.memory?.used));
  setText('memory-total', formatBytes(latest?.memory?.total));

  setText('network-now', `${formatRate(lastNet?.networkRxRateBps)} ↓`);
  setText('network-meta', `RX ${formatRate(lastNet?.networkRxRateBps)} · TX ${formatRate(lastNet?.networkTxRateBps)}`);
  setText('tcp-total', String(tcpConnections.total ?? '--'));
  setText('monthly-in', formatBytes(monthlyTraffic.inbound));
  setText('monthly-out', formatBytes(monthlyTraffic.outbound));

  setText('disk-now', fmtPct(latest?.disk?.usagePercent));
  setText('disk-meta', `${formatBytes(latest?.disk?.used)} / ${formatBytes(latest?.disk?.total)}`);

  setText('availability-now', fmtPct(summary?.availabilityPercent));
  setText('availability-meta', `Uptime ${formatDuration(latest?.uptimeSec)}`);

  setText('hostname-value', latest?.hostname || '--');
  setText('platform-meta', `${latest?.platform || '--'} · ${latest?.arch || '--'}`);
  setText('tcp-card-total', `${tcpConnections.total ?? '--'}`);

  renderNodeInfo(payload.node);
  renderTcpPorts(tcpConnections.byPort || []);
  renderAlerts(payload.alerts || [], payload.serviceHealth || []);
  renderProcesses(payload.topProcesses || []);
  renderMounts(payload.mounts || []);
  renderServices(services);
  renderGauge(latest?.disk?.usagePercent, latest?.disk?.used, latest?.disk?.total);

  renderLineChart('chart-cpu', series, [
    { key: 'cpuUsagePercent', color: '#61a8ff', gradientId: 'cpuGradient', fillFrom: 'rgba(97,168,255,0.40)', fillTo: 'rgba(97,168,255,0.02)', label: 'CPU' },
  ], { yMin: 0, yMax: 100, ySuffix: '%' });

  renderLineChart('chart-memory', series, [
    { key: 'memoryUsagePercent', color: '#c28cff', gradientId: 'memoryGradient', fillFrom: 'rgba(194,140,255,0.38)', fillTo: 'rgba(194,140,255,0.02)', label: 'Memory' },
  ], { yMin: 0, yMax: 100, ySuffix: '%' });

  const allNetRates = series.flatMap((point) => [point.networkRxRateBps || 0, point.networkTxRateBps || 0]).filter((v) => v > 0);
  const dataMax = allNetRates.length > 0 ? Math.max(...allNetRates) : 1;
  // Round up to a clean number with 20% headroom
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(1, dataMax))));
  const networkMax = Math.ceil(dataMax * 1.2 / magnitude) * magnitude;
  renderLineChart('chart-network', series, [
    { key: 'networkRxRateBps', color: '#63e2c6', gradientId: 'rxGradient', fillFrom: 'rgba(99,226,198,0.36)', fillTo: 'rgba(99,226,198,0.02)', label: 'Inbound' },
    { key: 'networkTxRateBps', color: '#f6c760', gradientId: 'txGradient', fillFrom: 'rgba(246,199,96,0.26)', fillTo: 'rgba(246,199,96,0.02)', label: 'Outbound' },
  ], { yMin: 0, yMax: networkMax, formatter: formatRate });
}

function renderNodeInfo(node) {
  const el = $('node-info');
  const rows = [
    ['Platform', node?.platform || '--'],
    ['Architecture', node?.arch || '--'],
    ['CPU model', node?.cpuModel || '--'],
    ['Cores', node?.cores ?? '--'],
  ];
  el.innerHTML = rows.map(([label, value]) => `<div class="info-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}

function renderTcpPorts(byPort) {
  const el = $('tcp-ports');
  const topFive = byPort.slice(0, 5);
  el.innerHTML = topFive.length
    ? topFive.map((item) => `<div class="port-pill">:${item.port} <strong>${item.count}</strong></div>`).join('')
    : '<div class="muted">No established TCP connections</div>';
}

function renderAlerts(alerts, serviceHealth) {
  const el = $('alert-list');
  const rows = [];

  // Capacity alerts from backend (CPU, memory, disk)
  for (const alert of alerts) {
    const label = alert.category || 'System';
    rows.push(`<div class="alert-item ${alert.level}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(alert.message)}</span></div>`);
  }

  // Per-service health rows
  if (Array.isArray(serviceHealth)) {
    for (const svc of serviceHealth) {
      let level, label;
      if (svc.active) {
        level = 'online';
        label = '● Online';
      } else if (svc.state === 'not-found' || svc.state === 'not-installed') {
        level = 'unconfigured';
        label = '○ Not Configured';
      } else {
        level = 'critical';
        label = '✕ DOWN (' + (svc.state || 'inactive') + ')';
      }
      rows.push(`<div class="alert-item ${level}"><strong>${escapeHtml(svc.name)}</strong><span>${label}</span></div>`);
    }
  }

  el.innerHTML = rows.join('');
}

function badgeClassForGateway(services) {
  return services?.gateway?.running ? 'healthy' : 'critical';
}

function badgeClassForWeixin(services) {
  if (services?.weixin?.state === 'OK') return 'healthy';
  if (services?.weixin?.state === 'WARN') return 'warn';
  return 'critical';
}

function renderServices(services) {
  const gatewayBadge = $('gateway-badge');
  const weixinBadge = $('weixin-badge');
  if (!gatewayBadge || !weixinBadge) return;
  const gatewayClass = badgeClassForGateway(services);
  const weixinClass = badgeClassForWeixin(services);
  gatewayBadge.className = `status-badge ${gatewayClass}`;
  gatewayBadge.textContent = services?.gateway?.running ? 'Running' : 'Offline';
  weixinBadge.className = `status-badge ${weixinClass}`;
  weixinBadge.textContent = services?.weixin?.state || 'UNKNOWN';
  setText('gateway-detail', services?.gateway?.detail || services?.gateway?.label || '--');
  setText('weixin-detail', services?.weixin?.detail || '--');
  setText('gateway-service-name', services?.gatewayService || '--');
  setText('gateway-sessions', String(services?.sessions ?? '--'));
  setText('gateway-version', services?.version || '--');
}

function renderProcesses(processes) {
  const el = $('process-table');
  el.innerHTML = processes.map((proc) => `
    <tr>
      <td>${escapeHtml(proc.pid)}</td>
      <td>${escapeHtml(proc.command)}</td>
      <td>${fmtPct(proc.cpuPercent)}</td>
      <td>${fmtPct(proc.memoryPercent)}</td>
    </tr>
  `).join('') || '<tr><td colspan="4">No process data</td></tr>';
}

function renderMounts(mounts) {
  const el = $('mounts-table');
  el.innerHTML = mounts.map((mount) => `
    <tr>
      <td>${escapeHtml(mount.mount)}</td>
      <td>${formatBytes(mount.used)}</td>
      <td>${formatBytes(mount.total)}</td>
      <td>${fmtPct(mount.usagePercent)}</td>
    </tr>
  `).join('') || '<tr><td colspan="4">No filesystem data</td></tr>';
}

function renderGauge(value = 0, used, total) {
  const pct = Math.max(0, Math.min(100, value || 0));
  $('disk-gauge').innerHTML = `
    <div class="gauge-ring" style="background: conic-gradient(#fb7185 0 ${pct}%, rgba(255,255,255,.08) ${pct}% 100%);">
      <div class="gauge-content">
        <div class="gauge-value">${fmtPct(pct)}</div>
        <div class="gauge-meta">${formatBytes(used)} used of ${formatBytes(total)}</div>
      </div>
    </div>
  `;
}

function downsampleSeries(series) {
  const BUCKET_MS = 5 * 60 * 1000;
  if (!series.length) return [];
  const downsampled = [];
  let bucketStart = series[0].timestamp;
  let bucket = [];
  for (const point of series) {
    if (point.timestamp - bucketStart >= BUCKET_MS && bucket.length) {
      downsampled.push(bucket[bucket.length - 1]);
      bucket = [];
      bucketStart = point.timestamp;
    }
    bucket.push(point);
  }
  if (bucket.length) downsampled.push(bucket[bucket.length - 1]);
  return downsampled;
}

function toSplinePath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function renderLineChart(id, series, defs, options) {
  const svg = $(id);
  const container = svg.parentElement;
  const width = container.clientWidth || 800;
  const height = svg.clientHeight || container.clientHeight || 260;
  const pad = { top: 14, right: 62, bottom: 28, left: 14 };
  const plotSeries = downsampleSeries(series);
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const minTs = plotSeries[0]?.timestamp || Date.now();
  const maxTs = plotSeries.at(-1)?.timestamp || minTs + 1;
  const yMin = options.yMin ?? 0;
  const yMax = options.yMax ?? 100;

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  const x = (ts) => pad.left + ((ts - minTs) / Math.max(1, maxTs - minTs)) * innerW;
  const y = (v) => pad.top + innerH - ((v - yMin) / Math.max(1, yMax - yMin)) * innerH;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((p) => {
    const yy = pad.top + innerH * p;
    const val = yMax - (yMax - yMin) * p;
    const label = options.ySuffix ? `${val.toFixed(0)}${options.ySuffix}` : (options.formatter ? options.formatter(val) : val.toFixed(0));
    return `
      <line class="chart-grid" x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" />
      <text class="chart-label" x="${width - 4}" y="${yy + 4}" text-anchor="end">${label}</text>
    `;
  }).join('');

  const labelCount = Math.max(3, Math.min(10, Math.floor(width / 120)));
  const timeLabels = Array.from({ length: labelCount }, (_, i) => {
    const p = labelCount === 1 ? 0 : i / (labelCount - 1);
    const ts = minTs + (maxTs - minTs) * p;
    return `<text class="chart-label" x="${pad.left + innerW * p}" y="${height - 6}" text-anchor="middle">${new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</text>`;
  }).join('');

  const gradients = defs.map((def) => `
    <linearGradient id="${def.gradientId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${def.fillFrom}" />
      <stop offset="100%" stop-color="${def.fillTo}" />
    </linearGradient>
  `).join('');

  const lineMarkup = defs.map((def) => {
    const points = plotSeries.filter((point) => Number.isFinite(point[def.key])).map((point) => ({ x: x(point.timestamp), y: y(point[def.key]), source: point }));
    if (!points.length) return '';
    const pathD = toSplinePath(points);
    const areaD = `${pathD} L ${points.at(-1).x} ${pad.top + innerH} L ${points[0].x} ${pad.top + innerH} Z`;
    return `
      <path class="chart-area" d="${areaD}" fill="url(#${def.gradientId})" />
      <path class="chart-path" d="${pathD}" stroke="${def.color}" />
    `;
  }).join('');

  svg.innerHTML = `<defs>${gradients}</defs>${grid}${lineMarkup}${timeLabels}`;

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

  const dots = defs.map((def) => {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '4');
    dot.setAttribute('fill', def.color);
    dot.setAttribute('stroke', 'rgba(11,16,32,1)');
    dot.setAttribute('stroke-width', '2');
    dot.style.display = 'none';
    svg.appendChild(dot);
    return dot;
  });

  let tooltip = container.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    container.style.position = 'relative';
    container.appendChild(tooltip);
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
        closest = point;
        closestDist = dist;
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
    defs.forEach((def, index) => {
      const v = point[def.key];
      if (Number.isFinite(v)) {
        dots[index].setAttribute('cx', cx);
        dots[index].setAttribute('cy', y(v));
        dots[index].style.display = '';
      } else {
        dots[index].style.display = 'none';
      }
    });
    const time = new Date(point.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const vals = defs.map((def) => {
      const v = point[def.key];
      const formatted = options.formatter ? options.formatter(v) : (options.ySuffix ? `${(v ?? 0).toFixed(1)}${options.ySuffix}` : (v ?? 0).toFixed(1));
      return `<span style="color:${def.color}">${def.label}: ${formatted}</span>`;
    }).join('<br>');
    tooltip.innerHTML = `<div class="tooltip-time">${time}</div>${vals}`;
    tooltip.style.display = 'block';
    tooltip.style.left = `${cx > innerW * 0.7 ? cx - 150 : cx + 12}px`;
    tooltip.style.top = `${pad.top + 8}px`;
  }

  function hideTooltip() {
    cursorLine.style.display = 'none';
    tooltip.style.display = 'none';
    dots.forEach((dot) => { dot.style.display = 'none'; });
  }

  overlayRect.addEventListener('mousemove', (e) => showTooltip(e.clientX));
  overlayRect.addEventListener('mouseleave', hideTooltip);
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
    setTimeout(hideTooltip, 1200);
  });
  overlayRect.addEventListener('touchcancel', () => {
    touching = false;
    hideTooltip();
  });
}

function openModal(title, content) {
  $('modal-title').textContent = title;
  $('log-output').textContent = content;
  $('log-modal').classList.remove('hidden');
}

function closeModal() {
  $('log-modal').classList.add('hidden');
}

async function runAction(action, button) {
  button.disabled = true;
  const original = button.dataset.originalText || button.textContent;
  button.dataset.originalText = original;
  button.textContent = 'Working…';
  try {
    const res = await fetch(`/api/actions/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const data = await res.json();
    if (action.endsWith('logs')) {
      openModal(action.includes('weixin') ? 'Weixin logs' : 'OpenClaw Gateway logs', data.output || 'No log output');
    } else if (!data.ok) {
      openModal('Action failed', data.output || 'Unknown error');
    }
    await loadData();
  } catch (err) {
    openModal('Action failed', String(err));
  } finally {
    state.pendingConfirmAction = null;
    document.querySelectorAll('.action-btn').forEach((btn) => {
      btn.disabled = false;
      btn.textContent = btn.dataset.originalText || (btn.classList.contains('secondary') ? 'View Logs' : 'Restart');
    });
  }
}

function bindActionButtons() {
  document.querySelectorAll('.action-btn').forEach((button) => {
    if (button.dataset.bound === 'true') return;
    button.dataset.bound = 'true';
    button.dataset.originalText = button.textContent;
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      const needsConfirm = action.endsWith('restart');
      if (!needsConfirm) return runAction(action, button);
      if (state.pendingConfirmAction !== action) {
        state.pendingConfirmAction = action;
        document.querySelectorAll('.action-btn').forEach((btn) => {
          if (btn !== button && btn.dataset.action?.endsWith('restart')) {
            btn.textContent = btn.dataset.originalText || 'Restart';
          }
        });
        button.textContent = 'Are you sure?';
        setTimeout(() => {
          if (state.pendingConfirmAction === action && !button.disabled) {
            state.pendingConfirmAction = null;
            button.textContent = button.dataset.originalText || 'Restart';
          }
        }, 3500);
        return;
      }
      return runAction(action, button);
    });
  });
}

function connectStream() {
  if (state.eventSource) state.eventSource.close();
  const es = new EventSource('/api/stream');
  state.eventSource = es;
  es.onopen = () => updateStreamStatus('Live stream connected', true);
  es.onmessage = async () => {
    updateStreamStatus('Live stream connected', true);
    try {
      await loadData();
    } catch (err) {
      console.error(err);
    }
  };
  es.onerror = () => updateStreamStatus('Stream reconnecting…', false);
}

document.querySelectorAll('#range-picker button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const hours = Number(btn.dataset.hours);
    setActiveRange(hours);
    await loadData();
  });
});

$('refresh-btn').addEventListener('click', loadData);
$('modal-close').addEventListener('click', closeModal);
$('log-modal').addEventListener('click', (event) => {
  if (event.target.dataset.close === 'modal') closeModal();
});
window.addEventListener('resize', () => state.payload && render());
setActiveRange(state.rangeHours);

(async function init() {
  try {
    await loadData();
    bindActionButtons();
    connectStream();
  } catch (err) {
    console.error(err);
    updateStreamStatus('Initial load failed', false);
  }
})();
