# VM Monitor Dashboard

VM monitoring dashboard and OpenClaw management console. Built with Node.js 22+, zero npm dependencies at runtime. Frontend uses Tailwind CSS and Lucide icons via CDN. Real-time data via SSE.

## Pages

- **`/`** — VM metrics dashboard: CPU, memory, disk, network charts, processes, mounts, TCP connections, alerts
- **`/weixin`** — OpenClaw management: gateway status/control, WeChat channel, peer aliases, QR code login
- Both pages support EN/ZH language toggle

## Quick Start

```bash
git clone https://github.com/RaoXuntian/vm-monitor-dashboard.git
cd vm-monitor-dashboard
node server.js
# Open http://127.0.0.1:3000
```

## Systemd Service

```bash
sudo systemctl start vm-monitor-dashboard.service
sudo systemctl stop vm-monitor-dashboard.service
sudo systemctl restart vm-monitor-dashboard.service
systemctl status vm-monitor-dashboard.service
journalctl -u vm-monitor-dashboard.service -f
```

## Dependencies

- **Runtime:** Node.js 22+ (no `npm install` needed)
- **System:** Linux with `/proc` filesystem, `ps`, `df`, `systemctl`
- **Optional:** `openclaw` CLI for gateway/weixin panels
- **Optional:** Caddy or any reverse proxy for HTTPS + basicauth
- **Frontend CDN** (loaded in browser):
  - Tailwind CSS (`cdn.tailwindcss.com`)
  - Lucide icons (`unpkg.com/lucide@latest`)
  - QRCode.js (`cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js`)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `SAMPLE_INTERVAL_MS` | `10000` | Metrics collection interval |
| `OPENCLAW_STATUS_INTERVAL_MS` | `60000` | OpenClaw status polling interval |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/stream` | SSE real-time metrics |
| `GET` | `/api/latest` | Latest sample |
| `GET` | `/api/metrics?hours=24` | Historical metrics |
| `GET` | `/api/weixin/status` | WeChat channel status |
| `GET` | `/api/weixin/peers` | Connected users with aliases |
| `POST` | `/api/weixin/qr/start` | Generate QR code for WeChat binding |
| `GET` | `/api/weixin/qr/status?session=xxx` | Poll QR scan status |
| `POST` | `/api/weixin/peers/alias` | Set user alias |
| `POST` | `/api/actions/{action}` | Trigger actions (restart, logs) |

## Project Structure

```
├── server.js          # Backend: metrics collection, APIs, SSE
├── public/
│   ├── index.html     # Main dashboard (VM metrics)
│   ├── weixin.html    # OpenClaw management page
│   ├── app.js         # Chart rendering, SSE binding
│   └── styles.css     # Chart/gauge CSS (Tailwind via CDN)
├── data/
│   ├── metrics-YYYY-MM-DD.jsonl  # Daily metrics (7-day retention)
│   ├── monthly-traffic.json       # Monthly network traffic
│   └── peer-aliases.json          # WeChat user aliases
└── README.md
```

## Security

- No built-in auth — use Caddy basicauth or similar reverse proxy
- Peer aliases stored locally in `data/peer-aliases.json`
- WeChat account tokens at `~/.openclaw/openclaw-weixin/accounts/` (chmod 0600)
- QR generation calls Tencent API with 15s timeout
