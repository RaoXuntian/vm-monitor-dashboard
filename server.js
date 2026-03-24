const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS || 10000);
const OPENCLAW_STATUS_INTERVAL_MS = Number(process.env.OPENCLAW_STATUS_INTERVAL_MS || 20000);
const RETENTION_DAYS = 7;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

let lastCpuSample = null;
let latestSample = null;
let latestOpenClawStatus = null;

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

function utcDateStamp(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function dataFileFor(ts) {
  return path.join(DATA_DIR, `metrics-${utcDateStamp(ts)}.jsonl`);
}

function parseProcStat() {
  const first = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = first[3] + (first[4] || 0);
  const total = first.reduce((sum, n) => sum + n, 0);
  return { idle, total };
}

function computeCpuUsage(now, prev) {
  if (!prev) return null;
  const idleDelta = now.idle - prev.idle;
  const totalDelta = now.total - prev.total;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

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
    usagePercent: total ? used / total * 100 : 0,
  };
}

function parseNetDev() {
  const lines = fs.readFileSync('/proc/net/dev', 'utf8').trim().split('\n').slice(2);
  let rxBytes = 0;
  let txBytes = 0;
  for (const line of lines) {
    const [ifaceRaw, statsRaw] = line.split(':');
    if (!ifaceRaw || !statsRaw) continue;
    const iface = ifaceRaw.trim();
    if (iface === 'lo') continue;
    const stats = statsRaw.trim().split(/\s+/).map(Number);
    rxBytes += stats[0] || 0;
    txBytes += stats[8] || 0;
  }
  return { rxBytes, txBytes };
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
    usagePercent: total ? used / total * 100 : 0,
  };
}

async function getTopProcesses() {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,comm,%cpu,%mem', '--sort=-%cpu']);
    const lines = stdout.trim().split('\n').slice(1, 7);
    return lines.map((line) => {
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
      const mount = cols[5];
      return {
        filesystem: cols[0],
        mount,
        total,
        used,
        available,
        usagePercent: total ? used / total * 100 : 0,
      };
    }).filter((item) => item.mount && !item.mount.startsWith('/snap')).slice(0, 8);
  } catch {
    return [];
  }
}

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/home/xtrao/.nvm/versions/node/v22.22.1/bin/openclaw';
const OPENCLAW_EXEC_TIMEOUT_MS = 30000;

async function getOpenClawStatus() {
  try {
    const { stdout } = await execFileAsync(OPENCLAW_BIN, ['status', '--all'], { timeout: OPENCLAW_EXEC_TIMEOUT_MS });
    const gatewayRunning = stdout.includes('running (pid') || stdout.includes('state active') || /reachable\s+\d+ms/i.test(stdout);
    const sessionsMatch = stdout.match(/Agents\s+.*?(\d+)\s*sessions/i);
    const dashboardMatch = stdout.match(/Dashboard\s+│\s+(.*?)\s*│/i);
    const tailscaleMatch = stdout.match(/Tailscale\s+│\s+(.*?)\s*│/i);
    const versionMatch = stdout.match(/app\s+(20\d{2}\.\d+\.\d+[-\w]*)/i);
    const gatewayMatch = stdout.match(/Gateway\s+│\s+(.*?)\s*│/i);
    const heartbeatMatch = stdout.match(/Heartbeat\s+│\s+(.*?)\s*│/i);
    const updateMatch = stdout.match(/Update\s+│\s+(.*?)\s*│/i);
    const weixinMatch = stdout.match(/openclaw-weixin\s*│\s*(ON|OFF)\s*│\s*(OK|WARN|ERROR)\s*│\s*(.*?)\s*│/i);
    const accountRows = [...stdout.matchAll(/^│\s*([a-z0-9-]+-im-bot)\s*│\s*(OK|WARN|ERROR|UNKNOWN)\s*│\s*(.*?)\s*│$/gim)]
      .map((match) => ({
        account: match[1],
        status: match[2],
        notes: match[3],
      }));
    return {
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
        state: weixinMatch[2].toUpperCase(),
        detail: weixinMatch[3].trim(),
        accounts: accountRows,
      } : {
        state: 'UNKNOWN',
        detail: 'Channel status unavailable',
        accounts: [],
      },
    };
  } catch (err) {
    console.error('[openclaw-status] getOpenClawStatus failed:', String(err));
    return {
      gateway: { running: false, label: 'Unknown', detail: null },
      dashboard: null,
      tailscale: null,
      version: null,
      heartbeat: null,
      update: null,
      sessions: null,
      weixin: { state: 'UNKNOWN', detail: 'Channel status unavailable', accounts: [] },
    };
  }
}

async function refreshOpenClawStatus() {
  latestOpenClawStatus = await getOpenClawStatus();
  return latestOpenClawStatus;
}

function buildAlerts(sample) {
  const alerts = [];
  if (!sample) return alerts;
  if ((sample.cpu?.usagePercent || 0) >= 85) alerts.push({ level: 'critical', message: `CPU is high at ${sample.cpu.usagePercent.toFixed(1)}%` });
  if ((sample.memory?.usagePercent || 0) >= 90) alerts.push({ level: 'critical', message: `Memory is high at ${sample.memory.usagePercent.toFixed(1)}%` });
  if ((sample.disk?.usagePercent || 0) >= 90) alerts.push({ level: 'critical', message: `Disk is high at ${sample.disk.usagePercent.toFixed(1)}%` });
  if (!alerts.length) alerts.push({ level: 'healthy', message: 'No active capacity alerts detected' });
  return alerts;
}

async function collectSample() {
  const timestamp = Date.now();
  const cpuNow = parseProcStat();
  const memory = parseMemInfo();
  const network = parseNetDev();
  const disk = await getDiskInfo();
  const loadAverage = os.loadavg();
  const uptimeSec = os.uptime();

  const cpuUsagePercent = computeCpuUsage(cpuNow, lastCpuSample);
  lastCpuSample = cpuNow;

  const topProcesses = await getTopProcesses();
  const mounts = await getMounts();
  const openclaw = latestOpenClawStatus;

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
    uptimeSec,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    topProcesses,
    mounts,
    openclaw,
  };

  latestSample = sample;
  await appendSample(sample);
  await pruneOldData();
  return sample;
}

async function appendSample(sample) {
  await ensureDataDir();
  await fsp.appendFile(dataFileFor(sample.timestamp), JSON.stringify(sample) + '\n');
}

async function pruneOldData() {
  const files = await fsp.readdir(DATA_DIR).catch(() => []);
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  await Promise.all(files.map(async (file) => {
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
  const availabilityPercent = Math.max(0, Math.min(100, uptimeCoveredSec / availabilityWindowSec * 100));

  return {
    latest: last,
    availabilityPercent,
    averages: {
      cpuUsagePercent: average(samples.map((s) => s.cpu.usagePercent)),
      memoryUsagePercent: average(samples.map((s) => s.memory.usagePercent)),
      diskUsagePercent: average(samples.map((s) => s.disk.usagePercent)),
    },
    peak: {
      cpuUsagePercent: Math.max(...samples.map((s) => s.cpu.usagePercent || 0)),
      memoryUsagePercent: Math.max(...samples.map((s) => s.memory.usagePercent || 0)),
      diskUsagePercent: Math.max(...samples.map((s) => s.disk.usagePercent || 0)),
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
      cpuUsagePercent: sample.cpu.usagePercent,
      load1: sample.cpu.load1,
      memoryUsagePercent: sample.memory.usagePercent,
      memoryUsedBytes: sample.memory.used,
      memoryTotalBytes: sample.memory.total,
      diskUsagePercent: sample.disk.usagePercent,
      diskUsedBytes: sample.disk.used,
      diskTotalBytes: sample.disk.total,
      uptimeSec: sample.uptimeSec,
      networkRxBytes: sample.network.rxBytes,
      networkTxBytes: sample.network.txBytes,
      networkRxRateBps: null,
      networkTxRateBps: null,
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

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...extraHeaders });
  res.end(text);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

async function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^\.\.(\/|\\|$)/, '');
  const absPath = path.join(PUBLIC_DIR, filePath);
  if (!absPath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, 'Forbidden');
  }
  try {
    const data = await fsp.readFile(absPath);
    const ext = path.extname(absPath);
    return sendText(res, 200, data, MIME[ext] || 'application/octet-stream');
  } catch (err) {
    return sendText(res, 404, 'Not Found');
  }
}

async function handleApi(req, res, pathname, searchParams) {
  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, latestSampleAt: latestSample?.isoTime || null, authEnabled: false });
  }

  if (pathname === '/api/latest') {
    if (!latestSample) await collectSample();
    return sendJson(res, 200, latestSample);
  }

  if (pathname === '/api/metrics') {
    const hours = Number(searchParams.get('hours') || '1');
    const clampedHours = Math.max(1 / 6, Math.min(24 * 7, hours));
    const samples = await readSamples(clampedHours * 60 * 60 * 1000);
    const summary = summarize(samples);
    return sendJson(res, 200, {
      rangeHours: clampedHours,
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
      services: summary?.latest?.openclaw || null,
    });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

async function bootstrap() {
  await ensureDataDir();
  await refreshOpenClawStatus();
  await collectSample();

  setInterval(() => {
    collectSample().catch((err) => console.error('collector error', err));
  }, SAMPLE_INTERVAL_MS).unref();

  setInterval(() => {
    refreshOpenClawStatus().catch((err) => console.error('openclaw status error', err));
  }, OPENCLAW_STATUS_INTERVAL_MS).unref();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url.pathname, url.searchParams);
    }
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'Internal server error' });
  }
});

bootstrap()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`VM monitor dashboard running on http://${HOST}:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('failed to start', err);
    process.exit(1);
  });
