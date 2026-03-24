# VM Monitor Dashboard

A local-first VM monitoring and OpenClaw operations console for Linux, built on Node 22 with zero runtime npm dependencies.

## What it is now

This project started as a lightweight VM resource monitor and has been expanded into a more complete local ops dashboard with:

- VM telemetry
- process visibility
- filesystem visibility
- lightweight alerting
- local password-protected access
- OpenClaw gateway visibility
- openclaw-weixin channel visibility
- per-account Weixin status

It is designed for **single-operator use**, especially on a personal VPS / homelab / always-on OpenClaw node.

---

## Features

### VM monitoring

- Collects metrics locally from `/proc`, `df`, and `ps`
- Persists samples as newline-delimited JSON under `data/`
- Retains up to 7 days of history
- REST API for latest metrics and time-range queries
- Dashboard cards, charts, tables, and status panels

Tracks:

- CPU usage and load average
- Availability estimate and uptime
- Memory usage
- Network throughput
- Disk usage
- Top processes by CPU
- Mounted filesystem usage
- Node metadata (platform / arch / CPU model / cores)

### Alerting

Lightweight in-dashboard alerts for:

- high CPU
- high memory
- high disk usage

### Authentication

- Lightweight local password gate
- Login UI posts to `POST /api/auth/login`
- Successful login sets an HttpOnly session cookie
- Metrics APIs require authentication
- Logout clears the cookie via `POST /api/auth/logout`
- Failed logins are rate-limited per client IP / forwarded IP window

### OpenClaw / Weixin visibility

Uses local `openclaw status --all` output to surface:

- OpenClaw gateway status
- OpenClaw version
- OpenClaw sessions count
- dashboard URL
- Tailscale status
- heartbeat summary
- update channel summary
- openclaw-weixin overall status
- openclaw-weixin **per-account** status table

---

## Architecture

- `server.js`
  - Node built-ins only
  - background collector runs every 10 seconds by default
  - serves API and static frontend
  - collects VM, process, filesystem, and OpenClaw status data
- `data/metrics-YYYY-MM-DD.jsonl`
  - daily JSONL files containing collected samples
- `public/`
  - static frontend shell with login page + dashboard UI

No build step is required.

---

## Requirements

- Linux VM with `/proc`
- Node.js 22+
- `ps`, `df`
- `openclaw` CLI installed if you want OpenClaw / Weixin status panels to work

---

## Run

```bash
cd /home/xtrao/.openclaw/workspace/vm-monitor-dashboard
MONITOR_PASSWORD='replace-this-now' node server.js
```

Then open:

- Dashboard: `http://127.0.0.1:3000/`
- Health API: `http://127.0.0.1:3000/api/health`

If you are already exposing the VM through a tunnel / Tailscale Funnel / reverse proxy, make sure the password is set to something non-trivial.

---

## Configuration

Optional environment variables:

- `PORT` (default `3000`)
- `HOST` (default `0.0.0.0`)
- `SAMPLE_INTERVAL_MS` (default `10000`)
- `MONITOR_PASSWORD` (default `changeme`)

Example:

```bash
PORT=3000 \
HOST=0.0.0.0 \
SAMPLE_INTERVAL_MS=10000 \
MONITOR_PASSWORD='replace-this-now' \
node server.js
```

---

## Current UI / product scope

The dashboard now has these sections:

### Login shell

- modern product-style login page
- local password auth
- rate-limit-aware login errors

### VM overview

- core metric cards
- utilization charts
- disk gauge
- node information panel
- alert panel

### Ops panels

- top processes
- filesystem usage

### OpenClaw control plane

- gateway status
- sessions count
- dashboard URL
- tailscale summary
- update / heartbeat summary
- Weixin channel status
- per-account Weixin status table

---

## Security notes

This is intentionally a **lightweight** auth model, not a full multi-user app.

Good fit for:

- personal use
- self-hosted VPS
- trusted tunnel / local network
- single operator workflows

Not yet a full solution for:

- multi-user auth
- database-backed users
- RBAC / permissions
- 2FA
- full audit trails
- enterprise hardening

If exposed publicly, you should at minimum:

- set a strong `MONITOR_PASSWORD`
- prefer trusted tunnel access or reverse proxy auth in front
- avoid treating this as a public SaaS login system

---

## Delivery summary

This round of work added:

- product-style login UI
- real local password login
- HttpOnly session cookie auth
- login rate limiting
- session-expiry handling in frontend
- OpenClaw control-plane section
- Weixin per-account breakdown
- top-process table
- filesystem table
- alert blocks
- node information panel
- more complete README / handoff docs

---

## Suggested next improvements

If you want to keep evolving it, the next most valuable upgrades are:

1. systemd service checks (OpenClaw / Tailscale / nginx / sshd / docker)
2. per-service health badges and restart guidance
3. historical alert/event timeline
4. multi-node support
5. richer charting / downsampling for long retention
6. optional reverse-proxy auth integration
7. export/import config and password setup script

---

## Git / delivery workflow

Recommended release flow:

```bash
git status
git add README.md public/index.html public/styles.css public/app.js server.js
git commit -m "Upgrade VM monitor into OpenClaw ops console"
git push origin main
```

If your default branch is not `main`, push to the correct branch instead.
