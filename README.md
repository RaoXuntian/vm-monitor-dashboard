# VM Monitor Dashboard

A local-only VM monitoring web app for Linux, built for Node 22 with zero runtime npm dependencies.

## Features

- Collects metrics locally from `/proc` and `df`
- Persists samples as newline-delimited JSON under `data/`
- Retains up to 7 days of history
- REST API for latest metrics and time-range queries
- Static frontend dashboard with cloud-style overview cards and charts
- Tracks:
  - CPU usage and load average
  - Availability estimate and uptime
  - Memory usage
  - Network throughput
  - Disk usage

## Architecture

- `server.js`
  - HTTP server using Node built-ins only
  - background collector runs every 10 seconds by default
  - serves API and static frontend
- `data/metrics-YYYY-MM-DD.jsonl`
  - daily JSONL files containing collected samples
- `public/`
  - polished static frontend with responsive layout and SVG charts

## Requirements

- Linux VM with `/proc`
- Node.js 22+

## Run

```bash
cd /home/xtrao/.openclaw/workspace/vm-monitor-dashboard
node server.js
```

Then open:

- Dashboard: `http://127.0.0.1:3000/`
- Health API: `http://127.0.0.1:3000/api/health`
- Metrics API: `http://127.0.0.1:3000/api/metrics?hours=24`

## Configuration

Optional environment variables:

- `PORT` (default `3000`)
- `HOST` (default `0.0.0.0`)
- `SAMPLE_INTERVAL_MS` (default `10000`)

Example:

```bash
PORT=3000 SAMPLE_INTERVAL_MS=10000 node server.js
```

## Notes

- Availability is estimated from uptime relative to the selected sample window, so after a reboot the recent window will reflect reduced availability.
- Network throughput is calculated from deltas between consecutive samples.
- The first CPU sample has no prior baseline, so CPU usage may be `null` until the second sample is collected.

## Development

No `npm install` is required.

## Suggested next improvements

- Add per-filesystem views
- Add process-level top consumers
- Add long-term downsampling for >7 day retention
- Add systemd unit/service example
