/**
 * VM Monitor Dashboard — Backend Server
 *
 * A lightweight Node.js HTTP server that collects system metrics from Linux
 * /proc files, manages OpenClaw gateway status, and serves a real-time
 * monitoring dashboard via SSE (Server-Sent Events).
 *
 * Port: 3000 (127.0.0.1 only; Caddy reverse-proxies it in production)
 * Dependencies: all built-in Node.js modules — no npm required
 * Data: metrics stored as JSONL files in ./data/, 7-day rolling retention
 */
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(zlib.gzip);

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Configuration Constants ──────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
const HOST = '127.0.0.1'; // Bind to loopback only; Caddy handles public TLS
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS || 10000); // /proc polling frequency
const OPENCLAW_STATUS_INTERVAL_MS = Number(process.env.OPENCLAW_STATUS_INTERVAL_MS || 60000); // openclaw status --all is expensive; poll less often
const SERVICE_CHECK_INTERVAL_MS = 30000; // systemctl is-active checks
const RETENTION_DAYS = 7; // Auto-prune JSONL files older than this
const SSE_INTERVAL_MS = 10000; // Redundant SSE broadcast period (ensure clients stay current)
const MONTHLY_TRAFFIC_FILE = 'monthly-traffic.json';
// ─── External Binary Paths ────────────────────────────────────────────────
const OPENCLAW_BIN = '/home/xtrao/.nvm/versions/node/v22.22.1/bin/openclaw';
const SYSTEMCTL_BIN = '/usr/bin/systemctl';
const JOURNALCTL_BIN = '/usr/bin/journalctl';
const BASH_BIN = '/bin/bash';
const WEIXIN_ACCOUNTS_DIR = path.join(os.homedir(), '.openclaw', 'openclaw-weixin', 'accounts');
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const MONTHLY_TRAFFIC_PATH = path.join(DATA_DIR, MONTHLY_TRAFFIC_FILE);
const PEER_ALIASES_PATH = path.join(DATA_DIR, 'peer-aliases.json');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// ─── Runtime State ───────────────────────────────────────────────────────
let lastCpuSample = null; // Previous /proc/stat snapshot for CPU delta
let lastNetworkSample = null; // Previous /proc/net/dev snapshot for rate calculation
let latestSample = null; // Most recent complete metrics sample
// Rolling buffers — 18 samples × 10 s = 3-minute window for alert averaging
const cpuHistory = [];
const memHistory = [];
const CPU_HISTORY_SIZE = 18; // 3 minutes at 10 s interval
let latestOpenClawStatus = null;
let latestServiceHealth = [];
let detectedGatewayServiceName = 'openclaw-gateway';
let monthlyTrafficState = null;
const sseClients = new Set(); // One entry per connected browser tab

// ─── Static File Cache ──────────────────────────────────────────────────
// In-memory cache for static assets: stores raw data, gzip-compressed data,
// ETag, and Content-Type.  Eliminates redundant disk reads and on-the-fly
// compression for every request.  Entries are invalidated by file mtime.
const staticCache = new Map();
const COMPRESSIBLE_TYPES = new Set(['.html', '.css', '.js', '.json', '.svg']);

async function getCachedStatic(absPath) {
  const ext = path.extname(absPath);
  const stat = await fsp.stat(absPath);
  const mtimeMs = stat.mtimeMs;
  const cached = staticCache.get(absPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const raw = await fsp.readFile(absPath);
  const etag = '"' + crypto.createHash('md5').update(raw).digest('hex') + '"';
  const contentType = MIME[ext] || 'application/octet-stream';
  const entry = { raw, etag, contentType, mtimeMs, gzipped: null };
  if (COMPRESSIBLE_TYPES.has(ext) && raw.length > 256) {
    entry.gzipped = await gzipAsync(raw, { level: zlib.constants.Z_BEST_COMPRESSION });
  }
  staticCache.set(absPath, entry);
  return entry;
}

// QR sessions are ephemeral WeChat login flows; TTL prevents stale sessions accumulating
const qrSessions = new Map();
const QR_SESSION_TTL_MS = 5 * 60 * 1000;
const QR_MAX_SESSIONS = 10;

const STATUS_MESSAGES = {
  wait: 'Waiting for scan...',
  scaned: 'Scanned! Please confirm on your phone...',
  confirmed: '✅ WeChat account linked successfully!',
  expired: 'QR code expired. Please generate a new one.',
};

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

function utcDateStamp(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function currentMonthStamp(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 7);
}

function dataFileFor(ts) {
  return path.join(DATA_DIR, `metrics-${utcDateStamp(ts)}.jsonl`);
}

/** Read /proc/stat and return aggregate CPU jiffies; caller diffs two snapshots for usage %. */
function parseProcStat() {
  const first = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = first[3] + (first[4] || 0);
  const total = first.reduce((sum, n) => sum + n, 0);
  return { idle, total };
}

/** Compute CPU usage % from two /proc/stat snapshots; returns null on first call (no prev). */
function computeCpuUsage(now, prev) {
  if (!prev) return null;
  const idleDelta = now.idle - prev.idle;
  const totalDelta = now.total - prev.total;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

/**
 * Parse /proc/meminfo. Uses MemAvailable (kernel 3.14+) which accounts for
 * reclaimable caches — more accurate than MemTotal - MemFree for real pressure.
 */
function parseMemInfo() {
  const text = fs.readFileSync('/proc/meminfo', 'utf8');
  const map = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)/);
    if (match) map[match[1]] = Number(match[2]) * 1024;
  }
  const total = map.MemTotal || 0;
  const available = map.MemAvailable || map.MemFree || 0;
  const used = Math.max(0, total - available);
  return {
    total,
    available,
    used,
    usagePercent: total ? (used / total) * 100 : 0,
  };
}

/** Parse /proc/net/dev cumulative byte counters across all non-loopback interfaces. */
function parseNetDev() {
  const lines = fs.readFileSync('/proc/net/dev', 'utf8').trim().split('\n').slice(2);
  let rxBytes = 0;
  let txBytes = 0;
  for (const line of lines) {
    const [ifaceRaw, statsRaw] = line.split(':');
    if (!ifaceRaw || !statsRaw) continue;
    const iface = ifaceRaw.trim();
    if (iface === 'lo') continue; // Skip loopback
    const stats = statsRaw.trim().split(/\s+/).map(Number);
    rxBytes += stats[0] || 0; // Column 0: receive bytes
    txBytes += stats[8] || 0; // Column 8: transmit bytes
  }
  return { rxBytes, txBytes };
}

/**
 * Parse /proc/net/tcp or /proc/net/tcp6.
 * Format: local_address is hex IP:hex_port; state 01 = ESTABLISHED.
 * We only count ESTABLISHED connections and group totals by local port.
 */
function parseTcpTable(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').slice(1);
    const counts = new Map();
    let total = 0;
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      const localAddress = cols[1];
      const state = cols[3];
      if (!localAddress || state !== '01') continue; // 01 = ESTABLISHED
      const hexPort = localAddress.split(':')[1];
      const port = Number.parseInt(hexPort, 16);
      if (!Number.isFinite(port)) continue;
      total += 1;
      counts.set(port, (counts.get(port) || 0) + 1);
    }
    return { total, counts };
  } catch {
    return { total: 0, counts: new Map() };
  }
}

function parseTcpConnections() {
  const tcp4 = parseTcpTable('/proc/net/tcp');
  const tcp6 = parseTcpTable('/proc/net/tcp6');
  const merged = new Map(tcp4.counts);
  for (const [port, count] of tcp6.counts.entries()) {
    merged.set(port, (merged.get(port) || 0) + count);
  }
  const byPort = [...merged.entries()]
    .map(([port, count]) => ({ port, count }))
    .sort((a, b) => b.count - a.count || a.port - b.port);
  return {
    total: tcp4.total + tcp6.total,
    byPort,
  };
}

async function getDiskInfo() {
  const { stdout } = await execFileAsync('df', ['-kP', '/']);
  const lines = stdout.trim().split('\n');
  const cols = lines[1].trim().split(/\s+/);
  const total = Number(cols[1]) * 1024;
  const used = Number(cols[2]) * 1024;
  const available = Number(cols[3]) * 1024;
  return {
    mount: cols[5],
    total,
    used,
    available,
    usagePercent: total ? (used / total) * 100 : 0,
  };
}

async function getTopProcesses() {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,comm,%cpu,%mem', '--sort=-%cpu']);
    return stdout.trim().split('\n').slice(1, 7).map((line) => {
      const cols = line.trim().split(/\s+/);
      return {
        pid: cols[0],
        command: cols[1],
        cpuPercent: Number(cols[2]) || 0,
        memoryPercent: Number(cols[3]) || 0,
      };
    });
  } catch {
    return [];
  }
}

async function getMounts() {
  try {
    const { stdout } = await execFileAsync('df', ['-kP']);
    return stdout.trim().split('\n').slice(1).map((line) => {
      const cols = line.trim().split(/\s+/);
      const total = Number(cols[1]) * 1024;
      const used = Number(cols[2]) * 1024;
      const available = Number(cols[3]) * 1024;
      return {
        filesystem: cols[0],
        mount: cols[5],
        total,
        used,
        available,
        usagePercent: total ? (used / total) * 100 : 0,
      };
    }).filter((item) => item.mount && !item.mount.startsWith('/snap')).slice(0, 8);
  } catch {
    return [];
  }
}

async function detectGatewayServiceName() {
  const candidates = ['openclaw-gateway.service', 'openclaw.service'];
  try {
    const { stdout } = await execFileAsync(SYSTEMCTL_BIN, ['list-unit-files', '--type=service', '--no-legend', '--no-pager'], { timeout: 10000 });
    const unitNames = stdout.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
    for (const candidate of candidates) {
      if (unitNames.includes(candidate)) {
        detectedGatewayServiceName = candidate.replace(/\.service$/, '');
        return detectedGatewayServiceName;
      }
    }
    const fuzzy = unitNames.find((name) => /openclaw/i.test(name));
    if (fuzzy) {
      detectedGatewayServiceName = fuzzy.replace(/\.service$/, '');
      return detectedGatewayServiceName;
    }
  } catch {}
  return detectedGatewayServiceName;
}

/**
 * Run `openclaw status --all` and parse its bordered table output with regex.
 * Runs under `nice -n 10` because on 2 vCPU VMs this command can starve the
 * main event loop if it competes for CPU at full priority.
 */
async function getOpenClawStatus() {
  try {
    const { stdout } = await execFileAsync('/usr/bin/nice', ['-n', '10', OPENCLAW_BIN, 'status', '--all'], { timeout: 30000 });
    const gatewayRunning = stdout.includes('running (pid') || stdout.includes('state active') || /reachable\s+\d+ms/i.test(stdout);
    const sessionsMatch = stdout.match(/Agents\s+.*?(\d+)\s*sessions/i);
    const dashboardMatch = stdout.match(/Dashboard\s+│\s+(.*?)\s*│/i);
    const tailscaleMatch = stdout.match(/Tailscale\s+│\s+(.*?)\s*│/i);
    const versionMatch = stdout.match(/app\s+(20\d{2}\.\d+\.\d+[-\w]*)/i);
    const gatewayMatch = stdout.match(/Gateway\s+│\s+(.*?)\s*│/i);
    const heartbeatMatch = stdout.match(/Heartbeat\s+│\s+(.*?)\s*│/i);
    const updateMatch = stdout.match(/Update\s+│\s+(.*?)\s*│/i);
    const weixinMatch = stdout.match(/openclaw-weixin\s*│\s*(ON|OFF)\s*│\s*(OK|WARN|ERROR)\s*│\s*(.*?)\s*│/i);
    const accountRows = [...stdout.matchAll(/^│\s*([a-z0-9-]+-im-bot)\s*│\s*(OK|WARN|ERROR|UNKNOWN)\s*│\s*(.*?)\s*│$/gim)].map((match) => ({
      account: match[1],
      id: match[1],
      name: match[1],
      status: match[2] === 'OK' ? 'online' : match[2].toLowerCase(),
      notes: match[3].trim(),
    }));
    return {
      collectedAt: new Date().toISOString(),
      gatewayService: detectedGatewayServiceName,
      gateway: {
        running: gatewayRunning,
        label: gatewayRunning ? 'Running' : 'Not running',
        detail: gatewayMatch ? gatewayMatch[1].trim() : null,
      },
      dashboard: dashboardMatch ? dashboardMatch[1].trim() : null,
      tailscale: tailscaleMatch ? tailscaleMatch[1].trim() : null,
      version: versionMatch ? versionMatch[1].trim() : null,
      heartbeat: heartbeatMatch ? heartbeatMatch[1].trim() : null,
      update: updateMatch ? updateMatch[1].trim() : null,
      sessions: sessionsMatch ? Number(sessionsMatch[1]) : null,
      weixin: weixinMatch ? {
        enabled: weixinMatch[1].toUpperCase() === 'ON',
        state: weixinMatch[2].toUpperCase(),
        detail: weixinMatch[3].trim(),
        accounts: accountRows,
      } : {
        enabled: false,
        state: 'UNKNOWN',
        detail: 'Channel status unavailable',
        accounts: [],
      },
    };
  } catch (err) {
    return {
      collectedAt: new Date().toISOString(),
      gatewayService: detectedGatewayServiceName,
      gateway: { running: false, label: 'Unknown', detail: String(err.message || err) },
      dashboard: null,
      tailscale: null,
      version: null,
      heartbeat: null,
      update: null,
      sessions: null,
      weixin: { enabled: false, state: 'UNKNOWN', detail: 'Channel status unavailable', accounts: [] },
    };
  }
}

async function refreshOpenClawStatus() {
  latestOpenClawStatus = await getOpenClawStatus();
  if (latestSample) {
    latestSample.openclaw = latestOpenClawStatus;
  }
  return latestOpenClawStatus;
}

async function loadMonthlyTrafficState() {
  await ensureDataDir();
  try {
    const parsed = JSON.parse(await fsp.readFile(MONTHLY_TRAFFIC_PATH, 'utf8'));
    monthlyTrafficState = {
      month: typeof parsed.month === 'string' ? parsed.month : currentMonthStamp(),
      inbound: Number(parsed.inbound) || 0,
      outbound: Number(parsed.outbound) || 0,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
    };
  } catch {
    monthlyTrafficState = {
      month: currentMonthStamp(),
      inbound: 0,
      outbound: 0,
      updatedAt: new Date().toISOString(),
    };
    await saveMonthlyTrafficState();
  }
  return monthlyTrafficState;
}

async function saveMonthlyTrafficState() {
  await fsp.writeFile(MONTHLY_TRAFFIC_PATH, JSON.stringify(monthlyTrafficState, null, 2));
}

async function updateMonthlyTraffic(network, timestamp) {
  if (!monthlyTrafficState) await loadMonthlyTrafficState();
  const month = currentMonthStamp(timestamp);
  if (monthlyTrafficState.month !== month) {
    monthlyTrafficState = { month, inbound: 0, outbound: 0, updatedAt: new Date(timestamp).toISOString() };
  }
  if (lastNetworkSample) {
    const deltaIn = network.rxBytes - lastNetworkSample.rxBytes;
    const deltaOut = network.txBytes - lastNetworkSample.txBytes;
    if (deltaIn >= 0) monthlyTrafficState.inbound += deltaIn;
    if (deltaOut >= 0) monthlyTrafficState.outbound += deltaOut;
  }
  monthlyTrafficState.updatedAt = new Date(timestamp).toISOString();
  lastNetworkSample = network;
  await saveMonthlyTrafficState();
  return {
    month: monthlyTrafficState.month,
    inbound: monthlyTrafficState.inbound,
    outbound: monthlyTrafficState.outbound,
  };
}

const MONITORED_SERVICES = [
  { name: 'OpenClaw Gateway', unit: null, label: 'openclaw-gateway', userService: true },
  { name: 'Caddy', unit: 'caddy', label: 'caddy', userService: false },
  { name: 'V2ray', unit: 'v2ray', label: 'v2ray', userService: false },
  { name: 'Xray', unit: 'xray', label: 'xray', userService: false },
];

/**
 * Check active state of each monitored service via systemctl.
 * OpenClaw Gateway uses --user because it runs as a user-level systemd
 * service; omitting --user makes systemctl look in the wrong scope.
 */
async function checkServiceHealth() {
  const results = [];
  for (const svc of MONITORED_SERVICES) {
    const unit = svc.unit || detectedGatewayServiceName;
    try {
      const args = svc.userService ? ['--user', 'is-active', unit] : ['is-active', unit];
      const { stdout } = await execFileAsync(SYSTEMCTL_BIN, args, { timeout: 5000 });
      results.push({ name: svc.name, unit, active: stdout.trim() === 'active' });
    } catch (err) {
      const stdout = (err.stdout || '').trim();
      const state = stdout === 'inactive' ? 'inactive' : stdout === 'failed' ? 'failed' : (err.code === 4 || stdout === '') ? 'not-found' : (stdout || 'unknown');
      results.push({ name: svc.name, unit, active: false, state });
    }
  }
  return results;
}

/**
 * Build alert list from a metrics sample.
 * CPU/memory use a 3-minute rolling average to avoid false alarms from
 * transient spikes.  Thresholds: CPU ≥ 85% critical, memory ≥ 85% critical,
 * disk ≥ 90% critical.
 */
function buildAlerts(sample) {
  const alerts = [];
  if (!sample) return alerts;

  // CPU: rolling average smooths one-off spikes from short batch jobs
  const cpuAvg = cpuHistory.length > 0 ? cpuHistory.reduce((a, b) => a + b, 0) / cpuHistory.length : (sample.cpu?.usagePercent || 0);
  if (cpuAvg >= 85) {
    alerts.push({ level: 'critical', message: `3-min avg ${cpuAvg.toFixed(1)}%` , category: 'System - CPU' });
  } else {
    alerts.push({ level: 'healthy', message: `3-min avg ${cpuAvg.toFixed(1)}%`, category: 'System - CPU' });
  }

  // Memory: same approach — transient page cache churn shouldn't page anyone
  const memAvg = memHistory.length > 0 ? memHistory.reduce((a, b) => a + b, 0) / memHistory.length : (sample.memory?.usagePercent || 0);
  if (memAvg >= 85) {
    alerts.push({ level: 'critical', message: `3-min avg ${memAvg.toFixed(1)}%`, category: 'System - Memory' });
  } else {
    alerts.push({ level: 'healthy', message: `3-min avg ${memAvg.toFixed(1)}%`, category: 'System - Memory' });
  }

  if ((sample.disk?.usagePercent || 0) >= 90) alerts.push({ level: 'critical', message: `Disk is high at ${sample.disk.usagePercent.toFixed(1)}%`, category: 'System - Disk' });

  if (Array.isArray(sample.serviceHealth)) {
    for (const svc of sample.serviceHealth) {
      if (!svc.active) {
        alerts.push({ level: 'critical', message: `${svc.name} service is DOWN (${svc.unit}: ${svc.state || 'inactive'})` });
      }
    }
  }

  if (sample.openclaw?.gateway && !sample.openclaw.gateway.running) {
    const alreadyCovered = alerts.some(a => a.message.includes('OpenClaw'));
    if (!alreadyCovered) {
      alerts.push({ level: 'critical', message: 'OpenClaw Gateway is not responding' });
    }
  }

  if (sample.openclaw?.weixin?.state === 'ERROR') {
    alerts.push({ level: 'critical', message: `WeChat channel error: ${sample.openclaw.weixin.detail || 'unknown'}` });
  } else if (sample.openclaw?.weixin?.state === 'WARN') {
    alerts.push({ level: 'warning', message: `WeChat channel warning: ${sample.openclaw.weixin.detail || 'check accounts'}` });
  }

  if (!alerts.length) alerts.push({ level: 'healthy', message: 'All systems operational — no active alerts' });
  return alerts;
}

/**
 * Main metrics collection pipeline — called every SAMPLE_INTERVAL_MS.
 * Reads /proc files synchronously (fast), runs async I/O in parallel,
 * maintains rolling history buffers, writes JSONL, and broadcasts SSE.
 */
async function collectSample() {
  const timestamp = Date.now();
  const cpuNow = parseProcStat();
  const memory = parseMemInfo();
  const network = parseNetDev();
  const tcpConnections = parseTcpConnections();
  const [disk, topProcesses, mounts, monthlyTraffic] = await Promise.all([
    getDiskInfo(),
    getTopProcesses(),
    getMounts(),
    updateMonthlyTraffic(network, timestamp),
  ]);
  const loadAverage = os.loadavg();
  const uptimeSec = os.uptime();
  const cpuUsagePercent = computeCpuUsage(cpuNow, lastCpuSample);
  lastCpuSample = cpuNow;
  if (cpuUsagePercent !== null) {
    cpuHistory.push(cpuUsagePercent);
  }
  if (memory?.usagePercent != null) {
    memHistory.push(memory.usagePercent);
    if (memHistory.length > CPU_HISTORY_SIZE) memHistory.shift();
    if (cpuHistory.length > CPU_HISTORY_SIZE) cpuHistory.shift();
  }

  const sample = {
    timestamp,
    isoTime: new Date(timestamp).toISOString(),
    cpu: {
      usagePercent: cpuUsagePercent,
      load1: loadAverage[0],
      load5: loadAverage[1],
      load15: loadAverage[2],
      cores: os.cpus().length,
      model: os.cpus()?.[0]?.model || null,
    },
    memory,
    network,
    disk,
    tcpConnections,
    monthlyTraffic,
    uptimeSec,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    topProcesses,
    mounts,
    openclaw: latestOpenClawStatus,
    serviceHealth: latestServiceHealth,
  };

  latestSample = sample;
  await appendSample(sample);
  await pruneOldData();
  broadcastSse(sample);
  return sample;
}

async function appendSample(sample) {
  await ensureDataDir();
  await fsp.appendFile(dataFileFor(sample.timestamp), `${JSON.stringify(sample)}\n`);
}

async function pruneOldData() {
  const files = await fsp.readdir(DATA_DIR).catch(() => []);
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  await Promise.all(files.map(async (file) => {
    if (file === MONTHLY_TRAFFIC_FILE) return;
    const match = file.match(/^metrics-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!match) return;
    const ts = Date.parse(`${match[1]}T00:00:00Z`);
    if (Number.isFinite(ts) && ts < cutoff) {
      await fsp.unlink(path.join(DATA_DIR, file)).catch(() => {});
    }
  }));
}

async function readSamples(rangeMs) {
  await ensureDataDir();
  const cutoff = Date.now() - rangeMs;
  const files = (await fsp.readdir(DATA_DIR))
    .filter((name) => name.startsWith('metrics-') && name.endsWith('.jsonl'))
    .sort();
  const samples = [];
  for (const file of files) {
    const text = await fsp.readFile(path.join(DATA_DIR, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const sample = JSON.parse(line);
        if (sample.timestamp >= cutoff) samples.push(sample);
      } catch {}
    }
  }
  return samples.sort((a, b) => a.timestamp - b.timestamp);
}

function average(values) {
  const filtered = values.filter((v) => Number.isFinite(v));
  if (!filtered.length) return null;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

function summarize(samples) {
  if (!samples.length) return null;
  const last = samples[samples.length - 1];
  const firstTs = samples[0].timestamp;
  const lastTs = last.timestamp;
  const availabilityWindowSec = Math.max(1, (lastTs - firstTs) / 1000);
  const uptimeCoveredSec = Math.min(last.uptimeSec, availabilityWindowSec);
  const availabilityPercent = Math.max(0, Math.min(100, (uptimeCoveredSec / availabilityWindowSec) * 100));
  return {
    latest: last,
    availabilityPercent,
    averages: {
      cpuUsagePercent: average(samples.map((s) => s.cpu?.usagePercent)),
      memoryUsagePercent: average(samples.map((s) => s.memory?.usagePercent)),
      diskUsagePercent: average(samples.map((s) => s.disk?.usagePercent)),
    },
    peak: {
      cpuUsagePercent: Math.max(...samples.map((s) => s.cpu?.usagePercent || 0)),
      memoryUsagePercent: Math.max(...samples.map((s) => s.memory?.usagePercent || 0)),
      diskUsagePercent: Math.max(...samples.map((s) => s.disk?.usagePercent || 0)),
    },
    samples: samples.length,
  };
}

function buildTimeseries(samples) {
  const series = [];
  let prev = null;
  for (const sample of samples) {
    const point = {
      timestamp: sample.timestamp,
      isoTime: sample.isoTime,
      cpuUsagePercent: sample.cpu?.usagePercent,
      load1: sample.cpu?.load1,
      memoryUsagePercent: sample.memory?.usagePercent,
      memoryUsedBytes: sample.memory?.used,
      memoryTotalBytes: sample.memory?.total,
      diskUsagePercent: sample.disk?.usagePercent,
      diskUsedBytes: sample.disk?.used,
      diskTotalBytes: sample.disk?.total,
      uptimeSec: sample.uptimeSec,
      networkRxBytes: sample.network?.rxBytes,
      networkTxBytes: sample.network?.txBytes,
      networkRxRateBps: null,
      networkTxRateBps: null,
      tcpConnectionsTotal: sample.tcpConnections?.total ?? null,
      monthlyInboundBytes: sample.monthlyTraffic?.inbound ?? null,
      monthlyOutboundBytes: sample.monthlyTraffic?.outbound ?? null,
    };
    if (prev) {
      const dt = (sample.timestamp - prev.timestamp) / 1000;
      if (dt > 0) {
        point.networkRxRateBps = Math.max(0, (sample.network.rxBytes - prev.network.rxBytes) / dt);
        point.networkTxRateBps = Math.max(0, (sample.network.txBytes - prev.network.txBytes) / dt);
      }
    }
    prev = sample;
    series.push(point);
  }
  return series;
}

function buildMetricsPayload(samples, rangeHours) {
  const summary = summarize(samples);
  return {
    rangeHours,
    summary,
    series: buildTimeseries(samples),
    alerts: buildAlerts(summary?.latest),
    node: summary?.latest ? {
      hostname: summary.latest.hostname,
      platform: summary.latest.platform,
      arch: summary.latest.arch,
      cpuModel: summary.latest.cpu?.model,
      cores: summary.latest.cpu?.cores,
      uptimeSec: summary.latest.uptimeSec,
    } : null,
    topProcesses: summary?.latest?.topProcesses || [],
    mounts: summary?.latest?.mounts || [],
    services: summary?.latest?.openclaw || latestOpenClawStatus || null,
    monthlyTraffic: summary?.latest?.monthlyTraffic || monthlyTrafficState,
    tcpConnections: summary?.latest?.tcpConnections || { total: 0, byPort: [] },
    serviceHealth: summary?.latest?.serviceHealth || [],
  };
}

function sendJson(res, status, data, extraHeaders = {}, req = null) {
  const body = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };

  // Gzip-compress large JSON responses (>1 KB) when the client supports it.
  // The /api/metrics endpoint can return hundreds of KB of samples.
  const acceptEncoding = req?.headers?.['accept-encoding'] || '';
  if (acceptEncoding.includes('gzip') && body.length > 1024) {
    zlib.gzip(body, { level: zlib.constants.Z_DEFAULT_COMPRESSION }, (err, compressed) => {
      if (err) {
        headers['Content-Length'] = Buffer.byteLength(body);
        res.writeHead(status, headers);
        res.end(body);
        return;
      }
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = compressed.length;
      headers.Vary = 'Accept-Encoding';
      res.writeHead(status, headers);
      res.end(compressed);
    });
    return;
  }

  headers['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...extraHeaders });
  res.end(text);
}

async function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^\.\.(\/|\\|$)/, '');
  const absPath = path.join(PUBLIC_DIR, filePath);
  if (!absPath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  try {
    const entry = await getCachedStatic(absPath);

    // 304 Not Modified: skip body entirely when browser already has current version
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, { ETag: entry.etag });
      res.end();
      return;
    }

    const headers = {
      'Content-Type': entry.contentType,
      ETag: entry.etag,
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=600',
    };

    // Prefer gzip when the client supports it and we have a pre-compressed copy
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (entry.gzipped && acceptEncoding.includes('gzip')) {
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = entry.gzipped.length;
      headers.Vary = 'Accept-Encoding';
      res.writeHead(200, headers);
      res.end(entry.gzipped);
    } else {
      headers['Content-Length'] = entry.raw.length;
      res.writeHead(200, headers);
      res.end(entry.raw);
    }
  } catch {
    return sendText(res, 404, 'Not Found');
  }
}

function sendSseEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Register a new SSE client.  Sends headers, an immediate comment frame
 * (for proxy compatibility), the latest sample, then 15-second keepalive
 * comments so reverse-proxy idle-timeouts don't close the connection.
 */
function registerSseClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Prevent nginx/Caddy from buffering SSE frames
  });
  res.write(': connected\n\n');
  if (latestSample) sendSseEvent(res, latestSample);
  const client = { res };
  sseClients.add(client);
  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {}
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
}

function broadcastSse(sample) {
  for (const client of sseClients) {
    try {
      sendSseEvent(client.res, sample);
    } catch {
      sseClients.delete(client);
    }
  }
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  }
}

async function requireConfirm(req) {
  const body = await readRequestBody(req);
  if (body?.confirm !== true) {
    throw Object.assign(new Error('Confirmation required'), { statusCode: 400 });
  }
  return body;
}

async function runCommand(file, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout: options.timeout || 30000, maxBuffer: 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || '',
      stderr: error.stderr || String(error.message || error),
      code: error.code ?? null,
    };
  }
}

function normalizeAccountId(raw) {
  return raw.trim().toLowerCase().replace(/@.*$/, '').replace(/[^a-z0-9-]/g, '-');
}

/**
 * Persist WeChat bot credentials to ~/.openclaw/openclaw-weixin/accounts/<id>.json.
 * chmod 0600 restricts access to owner only — the file contains a live bot token.
 */
async function saveWeixinAccount(accountId, { token, baseUrl, userId }) {
  await fsp.mkdir(WEIXIN_ACCOUNTS_DIR, { recursive: true });
  const filePath = path.join(WEIXIN_ACCOUNTS_DIR, `${accountId}.json`);
  const data = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  await fsp.chmod(filePath, 0o600).catch(() => {}); // Restrict to owner — contains bot token
}

/**
 * Trigger the weixin channel to reload newly-saved account files.
 * Strategy: prefer a lightweight `openclaw config set` which nudges the
 * channel without a full restart.  Falls back to `openclaw gateway restart`
 * if the config path fails.
 */
async function triggerOpenClawReload() {
  const configResult = await runCommand(OPENCLAW_BIN, [
    'config', 'set', 'channels.openclaw-weixin.accounts', '{}', '--strict-json'
  ], { timeout: 15000 });

  if (configResult.ok) {
    console.log('[weixin] Triggered channel reload via config update');
    setTimeout(() => refreshOpenClawStatus().catch(() => {}), 3000);
    return;
  }

  console.log('[weixin] Config update failed, triggering gateway restart...');
  const restartResult = await runCommand(OPENCLAW_BIN, ['gateway', 'restart'], { timeout: 30000 });
  if (!restartResult.ok) {
    console.warn('[weixin] Gateway restart also failed:', restartResult.stderr);
  }
  setTimeout(() => refreshOpenClawStatus().catch(() => {}), 5000);
}

function cleanupQrSessions() {
  const now = Date.now();
  for (const [id, session] of qrSessions) {
    if (now - session.startedAt > QR_SESSION_TTL_MS) qrSessions.delete(id);
  }
}

/** POST /api/weixin/qr/start — generate a new WeChat login QR code session. */
async function handleWeixinQrStart(_req, res) {
  cleanupQrSessions();

  if (qrSessions.size >= QR_MAX_SESSIONS) {
    return sendJson(res, 429, { error: 'Too many active QR sessions. Please wait.' });
  }

  try {
    const qrResponse = await fetchWithTimeout('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3', {}, 15000);
    const qrData = await qrResponse.json();

    if (!qrData.qrcode || !qrData.qrcode_img_content) {
      return sendJson(res, 502, { error: 'Invalid response from WeChat API' });
    }

    const sessionId = crypto.randomUUID();
    qrSessions.set(sessionId, {
      qrcode: qrData.qrcode,
      qrUrl: qrData.qrcode_img_content,
      startedAt: Date.now(),
    });

    return sendJson(res, 200, { sessionId, qrUrl: qrData.qrcode_img_content });
  } catch (error) {
    return sendJson(res, 502, { error: error.message || 'Failed to contact WeChat API' });
  }
}

/**
 * GET /api/weixin/qr/status?session=<id> — poll QR scan state.
 * On 'confirmed': saves credentials, triggers channel reload, removes session.
 * On 'expired': removes session so the client can generate a new one.
 */
async function handleWeixinQrStatus(res, searchParams) {
  cleanupQrSessions();
  const sessionId = searchParams.get('session');
  const session = sessionId ? qrSessions.get(sessionId) : null;
  if (!session) {
    return sendJson(res, 404, { error: 'Session not found or expired' });
  }

  try {
    const statusResponse = await fetchWithTimeout(
      `https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`,
      { headers: { 'iLink-App-ClientVersion': '1' } },
      35000
    );
    const statusData = await statusResponse.json();

    if (statusData.status === 'confirmed' && statusData.bot_token && statusData.ilink_bot_id) {
      const accountId = normalizeAccountId(statusData.ilink_bot_id);
      await saveWeixinAccount(accountId, {
        token: statusData.bot_token,
        baseUrl: statusData.baseurl || 'https://ilinkai.weixin.qq.com',
        userId: statusData.ilink_user_id,
      });
      await triggerOpenClawReload();
      qrSessions.delete(sessionId);

      return sendJson(res, 200, {
        status: 'confirmed',
        message: '✅ WeChat account linked successfully!',
        accountId,
      });
    }

    if (statusData.status === 'expired') {
      qrSessions.delete(sessionId);
    }

    return sendJson(res, 200, {
      status: statusData.status,
      message: STATUS_MESSAGES[statusData.status] || 'Unknown status',
    });
  } catch (error) {
    return sendJson(res, 502, { error: error.message || 'Failed to check QR status' });
  }
}

async function readWeixinAccountIds() {
  try {
    const entries = await fsp.readdir(WEIXIN_ACCOUNTS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.sync.json') && !entry.name.endsWith('.context-tokens.json'))
      .map((entry) => entry.name.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

async function getCombinedWeixinStatus() {
  const status = latestOpenClawStatus?.weixin || { enabled: false, state: 'UNKNOWN', detail: 'Channel status unavailable', accounts: [] };
  const knownIds = await readWeixinAccountIds();
  const reportedAccounts = Array.isArray(status.accounts) ? status.accounts : [];
  const merged = new Map();

  for (const item of reportedAccounts) {
    if (item?.account) merged.set(item.account, { ...item, id: item.id || item.account, name: item.name || item.account });
  }

  for (const accountId of knownIds) {
    if (!merged.has(accountId)) {
      merged.set(accountId, {
        account: accountId,
        id: accountId,
        name: accountId,
        status: 'offline',
        notes: 'Account file present but not currently reported as online.',
      });
    }
  }

  return {
    ...status,
    accounts: [...merged.values()]
      .filter((a) => !String(a.account).includes('.context-tokens') && !String(a.account).includes('.sync'))
      .sort((a, b) => String(a.account).localeCompare(String(b.account))),
  };
}

/**
 * Map action name to the underlying command.
 *   openclaw-restart — systemctl restart (full service restart)
 *   openclaw-logs    — last 100 lines from journalctl
 *   weixin-restart   — openclaw gateway restart (reloads channels only)
 *   weixin-logs      — grep today's log file for weixin entries
 */
async function runOpenClawAction(kind) {
  if (kind === 'openclaw-restart') {
    return runCommand(SYSTEMCTL_BIN, ['--user', 'restart', detectedGatewayServiceName], { timeout: 30000 });
  }
  if (kind === 'openclaw-logs') {
    return runCommand(JOURNALCTL_BIN, ['--user', '-u', detectedGatewayServiceName, '-n', '100', '--no-pager'], { timeout: 30000 });
  }
  if (kind === 'weixin-restart') {
    return runCommand(OPENCLAW_BIN, ['gateway', 'restart'], { timeout: 30000 });
  }
  if (kind === 'weixin-logs') {
    return runCommand(BASH_BIN, ['-lc', "grep -i weixin /tmp/openclaw/openclaw-$(date +%F).log | tail -100"], { timeout: 30000 });
  }
  return { ok: false, stderr: 'Unknown action', code: null };
}

/** Handle POST /api/actions/<action> — requires { confirm: true } in the body. */
async function handleAction(req, res, pathname) {
  await requireConfirm(req);
  const action = pathname.replace('/api/actions/', '');
  const result = await runOpenClawAction(action);
  await refreshOpenClawStatus();
  if (!latestSample) await collectSample();
  else latestSample.openclaw = latestOpenClawStatus;
  const text = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : '');
  const status = result.ok ? 200 : 500;
  return sendJson(res, status, {
    ok: result.ok,
    action,
    service: detectedGatewayServiceName,
    output: text,
  });
}

async function loadPeerAliases() {
  try {
    return JSON.parse(await fsp.readFile(PEER_ALIASES_PATH, 'utf8'));
  } catch { return {}; }
}

async function savePeerAliases(aliases) {
  await fsp.writeFile(PEER_ALIASES_PATH, JSON.stringify(aliases, null, 2), 'utf8');
}

async function getWeixinPeers() {
  const aliases = await loadPeerAliases();
  const peers = [];
  try {
    const files = await fsp.readdir(WEIXIN_ACCOUNTS_DIR);
    for (const file of files) {
      if (!file.endsWith('.context-tokens.json')) continue;
      const accountId = file.replace('.context-tokens.json', '');
      try {
        const data = JSON.parse(await fsp.readFile(path.join(WEIXIN_ACCOUNTS_DIR, file), 'utf8'));
        for (const peerId of Object.keys(data)) {
          peers.push({ peerId, accountId, alias: aliases[peerId] || null });
        }
      } catch {}
    }
  } catch {}
  return peers;
}

async function handleApi(req, res, pathname, searchParams) {
  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      host: HOST,
      latestSampleAt: latestSample?.isoTime || null,
      sseClients: sseClients.size,
      gatewayService: detectedGatewayServiceName,
    });
  }

  if (pathname === '/api/stream') {
    return registerSseClient(req, res);
  }

  if (pathname === '/api/latest') {
    return sendJson(res, 200, latestSample || { timestamp: Date.now(), isoTime: new Date().toISOString() }, {}, req);
  }

  if (pathname === '/api/weixin/status') {
    return sendJson(res, 200, await getCombinedWeixinStatus(), {}, req);
  }

  if (pathname === '/api/weixin/qr/start') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
    return handleWeixinQrStart(req, res);
  }

  if (pathname === '/api/weixin/qr/status') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
    return handleWeixinQrStatus(res, searchParams);
  }

  if (pathname === '/api/weixin/peers') {
    return sendJson(res, 200, { peers: await getWeixinPeers() }, {}, req);
  }

  if (pathname === '/api/weixin/peers/alias') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const body = await readRequestBody(req);
    if (!body.peerId || typeof body.peerId !== 'string') {
      return sendJson(res, 400, { error: 'peerId is required' });
    }
    const aliases = await loadPeerAliases();
    if (body.alias && typeof body.alias === 'string' && body.alias.trim()) {
      aliases[body.peerId] = body.alias.trim();
    } else {
      delete aliases[body.peerId];
    }
    await savePeerAliases(aliases);
    return sendJson(res, 200, { ok: true, peerId: body.peerId, alias: aliases[body.peerId] || null });
  }

  if (pathname === '/api/metrics') {
    const hours = Number(searchParams.get('hours') || '24');
    const clampedHours = Math.max(1 / 6, Math.min(24 * 7, hours));
    const samples = await readSamples(clampedHours * 60 * 60 * 1000);
    return sendJson(res, 200, buildMetricsPayload(samples, clampedHours), {}, req);
  }

  if (pathname.startsWith('/api/actions/')) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
    return handleAction(req, res, pathname);
  }

  return sendJson(res, 404, { error: 'Not found' });
}

/**
 * Application bootstrap.
 *
 * The HTTP server starts BEFORE data collection so the page is reachable
 * immediately — the initial `openclaw status --all` can take 10-30 s on cold
 * start and would otherwise block the port from binding.  All slow operations
 * are fire-and-forget.
 */
async function bootstrap() {
  await ensureDataDir();
  await loadMonthlyTrafficState();

  // Server first: clients see a loading state instead of a connection error
  server.listen(PORT, HOST, () => {
    console.log(`VM monitor dashboard running on http://${HOST}:${PORT}`);
  });

  // Background init: gateway detection, openclaw status, first sample, service health
  detectGatewayServiceName().catch(() => {});
  refreshOpenClawStatus().catch((err) => console.error('initial openclaw status error', err));
  collectSample().catch((err) => console.error('initial sample error', err));
  checkServiceHealth().then(h => { latestServiceHealth = h; }).catch(() => {});

  setInterval(() => {
    collectSample().catch((err) => console.error('collector error', err));
  }, SAMPLE_INTERVAL_MS).unref();

  setInterval(() => {
    refreshOpenClawStatus().catch((err) => console.error('openclaw status error', err));
  }, OPENCLAW_STATUS_INTERVAL_MS).unref();

  setInterval(() => {
    checkServiceHealth().then(h => { latestServiceHealth = h; }).catch(() => {});
  }, SERVICE_CHECK_INTERVAL_MS).unref();

  setInterval(() => {
    if (latestSample) broadcastSse(latestSample);
  }, SSE_INTERVAL_MS).unref();

  setInterval(() => {
    cleanupQrSessions();
  }, 60000).unref();

}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url.pathname, url.searchParams);
    }
    if (url.pathname === '/weixin' || url.pathname === '/weixin/') {
      return await serveStatic(req, res, '/weixin.html');
    }
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.statusCode || 500;
    return sendJson(res, status, { error: err.message || 'Internal server error' });
  }
});

bootstrap()
  .catch((err) => {
    console.error('failed to start', err);
    process.exit(1);
  });
