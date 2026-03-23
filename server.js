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
const HOST = process.env.HOST || '0.0.0.0';
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS || 10000);
const RETENTION_DAYS = 7;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

let lastCpuSample = null;
let latestSample = null;

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

  const sample = {
    timestamp,
    isoTime: new Date(timestamp).toISOString(),
    cpu: {
      usagePercent: cpuUsagePercent,
      load1: loadAverage[0],
      load5: loadAverage[1],
      load15: loadAverage[2],
      cores: os.cpus().length,
    },
    memory,
    network,
    disk,
    uptimeSec,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
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

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
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
    return sendJson(res, 200, { ok: true, latestSampleAt: latestSample?.isoTime || null });
  }

  if (pathname === '/api/latest') {
    if (!latestSample) await collectSample();
    return sendJson(res, 200, latestSample);
  }

  if (pathname === '/api/metrics') {
    const hours = Number(searchParams.get('hours') || '1');
    const clampedHours = Math.max(1 / 6, Math.min(24 * 7, hours));
    const samples = await readSamples(clampedHours * 60 * 60 * 1000);
    return sendJson(res, 200, {
      rangeHours: clampedHours,
      summary: summarize(samples),
      series: buildTimeseries(samples),
    });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

async function bootstrap() {
  await ensureDataDir();
  await collectSample();
  setInterval(() => {
    collectSample().catch((err) => console.error('collector error', err));
  }, SAMPLE_INTERVAL_MS).unref();
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
