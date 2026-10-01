# 🛡️ Project Watchtower

> **Windows 11 Screen Time Monitoring, Analysis, and Parental Control Ecosystem**

Watchtower is a parental-control system for **Windows 11**. It pairs a lean native **Rust** background daemon on the child's PC with a **Node.js (Fastify + TypeScript)** backend and a **React + Tailwind** parent dashboard, deployable to **Railway**, **Podman**, or **Docker**.

---

## ✨ Features

### Monitoring & analytics
- ⏱️ **Real-time focus & idle tracking** — active foreground app, window title, and idle state via native Win32 APIs (`GetForegroundWindow`, `GetLastInputInfo`).
- 📊 **Usage analytics** — per-day totals, 24-hour distribution, multi-day history, and a **granular activity timeline**.
- 🏷️ **Editable categories** — reassign any app's category inline in the timeline; the override is saved on the device policy and **re-labels history** and category totals.
- 📺 **Deep telemetry** — YouTube video titles from browser tabs and IM chat context (Discord, Telegram, WeChat, WhatsApp, …) without browser extensions. *(Telemetry content stays in the dashboard and is never sent to Slack.)*

### Enforcement
- 🔒 **Forced logoff** on bedtime curfew, daily-limit exhaustion, emergency lock, or remote lock — a real `ExitWindowsEx` logoff (not a lock screen the user can reopen), **re-issued every heartbeat** so a re-login is kicked within seconds.
- 🖥️ **Applies everywhere** — session controls fire even at the desktop / lock screen / with no window focused (not only inside apps).
- 🛑 **Per-app & per-category limits** and always-blocked apps (`TerminateProcess`).
- 🌍 **Timezone-correct** — bedtime, daily reset, and hour buckets are evaluated in the **device's local time** (the client reports its UTC offset), independent of where the server runs.
- ⚠️ **5-minute warning** toast before time runs out.

### Remote control (parent dashboard)
- ⚡ **Near-instant sync** over a persistent WebSocket.
- ➕➖ **Bonus time** — grant (+15m / +30m / +1h) or **remove** bonus (−15m / Clear Bonus).
- 🚨 **Instant emergency lock / unlock** and remote **app kill**.
- 🗓️ **Daily quota + bedtime curfew** configuration.

### Security
- 🔑 **No hardcoded password** — a strong random dashboard password is generated on first boot (or set via `ADMIN_PASSWORD`).
- 🔐 **Session tokens** that expire and can be revoked; **header-only** (never in URLs); dashboard WebSocket uses short-lived single-use tickets.
- ✋ **Re-authentication for sensitive actions** — granting/removing bonus, unlocking, and changing quotas require the parent password again, so a stolen session token alone can't use them.
- 🚦 **Brute-force protection** — proxy-spoof-resistant rate limiting with exponential backoff + lockout.
- 🪪 **Optional device authentication** — per-device enrollment tokens (`REQUIRE_DEVICE_AUTH`).
- 🧱 Helmet security headers, CORS allowlist, validated/size-capped WebSocket messages.

### Operations
- 🔄 **Client self-update** — the daemon periodically checks the published release checksum and hot-swaps itself (SHA-256 verified, atomic, rollback on failure).
- 🔔 **Slack logging** — security & activity events to a channel via webhook (see below).
- ☁️ **Container/Railway ready** with GitHub auto-deploy.

---

## 🏗️ Architecture Overview

```
 ┌─────────────────────────────────────────────────────────┐
 │                   Windows 11 Host PC                     │
 │  ┌───────────────────────────────────────────────────┐  │
 │  │ Watchtower Rust Daemon (Scheduled Task, user       │  │
 │  │  session; auto-restart + self-update)              │  │
 │  │  • Win32 activity & idle tracker                   │  │
 │  │  • Enforcer (TerminateProcess / forced logoff)     │  │
 │  │  • 5-minute warning toasts                         │  │
 │  │  • YouTube & IM telemetry inspector                │  │
 │  │  • WebSocket client (tokio-tungstenite, wss)       │  │
 │  └──────────────────────────▲────────────────────────┘  │
 └─────────────────────────────┼───────────────────────────┘
                               │ Secure WebSocket (wss/TLS)
                               ▼
 ┌─────────────────────────────────────────────────────────┐
 │               Railway / Cloud Backend                    │
 │  ┌───────────────────────────────────────────────────┐  │
 │  │ Node.js Server (Fastify + WebSockets, SQLite)      │  │
 │  │  • Quota ledger & policy sync (device-local time)  │  │
 │  │  • Enforcement engine · telemetry aggregator       │  │
 │  │  • Auth/session manager · device enrollment        │  │
 │  │  • Slack notifier                                  │  │
 │  └──────────────────────────▲────────────────────────┘  │
 │  ┌──────────────────────────┴────────────────────────┐  │
 │  │ React / Tailwind Web Dashboard (Parent Portal)     │  │
 │  │  • Live view · remote kill · emergency lock        │  │
 │  │  • Quota & bedtime · bonus add/remove              │  │
 │  │  • Analytics, timeline & editable categories       │  │
 │  └───────────────────────────────────────────────────┘  │
 └─────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### 1. Run the backend & dashboard locally

```bash
cd backend
npm install
npm run build:web       # Build React/Tailwind frontend
npm run build:server    # Compile TypeScript backend
npm start               # http://localhost:4000
```

### 2. Run with Podman / Docker

```bash
podman build -t watchtower-server .
podman run -d -p 4000:4000 -v watchtower-data:/app/data --name watchtower watchtower-server
```

### 3. Deploy to Railway

1. Push this repository to GitHub.
2. In **Railway**, connect the service to the GitHub repo (**Settings → Source**) so pushes to `main` auto-deploy. (CLI: `railway service source connect --repo <owner>/<repo> --branch main`.)
3. Railway detects the `Dockerfile` and deploys.
4. Set the environment variables below as needed.

---

## 🔐 Security configuration

On first boot Watchtower seeds the dashboard password from `ADMIN_PASSWORD` (if set, ≥ 8 chars); otherwise it **generates a random password and prints it once to the server logs** (and to Slack if configured). Grab it, then change it from the dashboard.

| Env var | Purpose | Default |
|---|---|---|
| `ADMIN_PASSWORD` | Dashboard password on first boot (min 8 chars) | random (logged once) |
| `RESET_PASSWORD=true` | Re-seed the password on next boot, then remove it | off |
| `SESSION_TTL_HOURS` | Dashboard session token lifetime | `4` |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist for the dashboard origin(s) | reflect (no credentials) |
| `TRUST_PROXY` | `false` if the server is exposed directly with no proxy | on (Railway proxy) |
| `TRUST_PROXY_HOPS` | Trusted proxy hops for client-IP resolution (rate limiting) | `1` |
| `DEVICE_ENROLLMENT_SECRET` | Secret required to enroll a client device (min 16 chars); authoritative when set | random |
| `REQUIRE_DEVICE_AUTH=true` | Reject client WebSocket connections without a valid device token | off |
| `SLACK_WEBHOOK_URL` | Incoming-webhook URL for event logging (see below) | off |

Sensitive dashboard actions (grant/remove bonus, unlock, quota/bedtime changes) require the parent password to be re-entered even with a valid session.

### Device authentication (optional, recommended)

Set `REQUIRE_DEVICE_AUTH=true` and a `DEVICE_ENROLLMENT_SECRET`, then install clients with the enrollment key so each device gets a device-bound token:

```powershell
irm "https://<your-server>/api/install.ps1?key=<DEVICE_ENROLLMENT_SECRET>" | iex
```

With `REQUIRE_DEVICE_AUTH` off (default) the classic one-liner still works and existing clients keep connecting — enable enforcement only after devices are re-enrolled with a key.

### 🔔 Slack logging

Set `SLACK_WEBHOOK_URL` to an incoming-webhook URL to receive events in a channel:

- 🔑 first-boot/reset dashboard password · 🛰️ server start
- ✅ successful login · ⚠️ failed login · 🔒 auth lockout · 🔧 password change · 🗑️ uninstall issued
- ⚙️ quota/bedtime change · ➕/➖ bonus granted/removed · 🔒/🔓 emergency lock · 🗡️ kill-app
- 🟢/🔴 device connect/disconnect · 🚫 rejected unauthenticated device
- 🌙 **in use during curfew** · 🕗 reported timezone-offset change · ⚠️ client auto-update disabled

Telemetry *content* (YouTube titles, chat text) is never sent to Slack.

---

## 💻 Windows client

### Install (1-line)

```powershell
irm https://watchtower-production-3b1e.up.railway.app/api/install.ps1 | iex
```

What it does:
1. Downloads the latest `watchtower.exe` from GitHub Releases.
2. Writes `config.json` (server URL, device id = `$env:COMPUTERNAME`; auto-upgrades `ws://` → `wss://` for remote hosts).
3. Registers a **Scheduled Task** (at-logon trigger, auto-restart) in the interactive user session, and starts the process hidden.
4. With `?key=<DEVICE_ENROLLMENT_SECRET>`, enrolls the device and stores a device token.

After a device runs this build once, it **self-updates** from future releases — no reinstall needed.

### Uninstall (password-protected)

```powershell
irm https://watchtower-production-3b1e.up.railway.app/api/uninstall.ps1 | iex
```
The removal payload is fetched in-memory only after the parent password is verified. (Pass it directly with `-Password "<your-password>"`.)

### Client config (`config.json`)

```json
{
  "server_url": "wss://<your-server>/ws/client",
  "device_id": "CHILD-PC",
  "auth_token": "<set automatically when enrolled>",
  "allow_insecure": false,
  "auto_update": true,
  "update_check_interval_secs": 21600,
  "heartbeat_interval_secs": 3
}
```

### Build from source (developers)

```powershell
cd client
cargo build --release
cargo run -- --config config.json --foreground
```

---

## 🛡️ Tamper resilience — what it does and doesn't do

Watchtower makes casual bypass harder and, more importantly, **visible**:

- Disguised binary/task names, hidden window, single-instance guard.
- Scheduled-task **auto-restart** (and restart at each logon).
- **Detection**: device connect/disconnect, in-use-during-curfew, offset-change, and auto-update-disabled alerts to Slack.

**It is not tamper-proof against a local administrator.** A child with admin rights can stop the process, edit config, block the server, or uninstall. For genuine enforcement against an admin user:

1. **Remove the child's admin rights** (make them a Standard user) — the single most effective step.
2. Enforce curfew **below the app**: Microsoft **Family Safety** (account-level screen time) and/or a **router/DNS** schedule — a local admin can't override the router.

Treat Watchtower's on-device enforcement as a strong default plus an alerting layer, not an admin-proof lock.

---

## 🧪 Testing

```bash
cd backend && npm test      # Vitest: auth, store, rules engine
cd client  && cargo test    # updater helpers, path handling
```

CI (GitHub Actions) builds + tests the backend and compiles/tests the Windows client on every pull request.
