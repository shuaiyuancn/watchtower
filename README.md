# 🛡️ Project Watchtower

> **Windows 11 Screen Time Monitoring, Analysis, and Parental Control Ecosystem**

Watchtower is a high-performance, tamper-resilient parental control system designed specifically for **Windows 11**. It combines an ultra-lean native **Rust** background daemon with a full-featured **Node.js (Fastify + TypeScript) + Next.js** backend deployable to **Railway**, **Podman**, or **Docker**.

---

## ✨ Features

- ⏱️ **Real-time Focus & Idle Tracking**: Accurately tracks active foreground applications, window titles, and idle state via native Win32 APIs (`GetForegroundWindow`, `GetLastInputInfo`).
- 🛑 **Enforcement & Instant Termination**: Forcefully terminates games/apps immediately when daily quotas are depleted (`TerminateProcess`).
- 🔒 **Global Quotas & Forced Logoff**: Forces immediate Windows session logout (`ExitWindowsEx` / `shutdown /l`) when daily total screen allowance or bedtime curfews are reached.
- ⚠️ **5-Minute Advance Warning**: Dispatches Windows toast warning banners to the child's screen at 5 minutes remaining.
- ⚡ **Near-Instant Sync (<200ms)**: Persistent WebSocket connection allows parents to adjust limits, grant bonus time (+15m, +30m, +1h), or trigger an **Instant Emergency Lock** remotely.
- 📺 **Native Deep Telemetry**:
  - **YouTube Watch History**: Captures YouTube video titles directly from browser tabs (Chrome, Edge, Firefox, Brave) without requiring browser extensions.
  - **IM Chat Telemetry**: Tracks active chat contexts and message metadata across Discord, Telegram, WeChat, WhatsApp, etc.
- 🛡️ **Tamper Resilience ("Hide, Persist, and Alert")**:
  - Inconspicuous binary and Windows Service names.
  - Runs under `NT AUTHORITY\SYSTEM` with auto-restart on failure.
  - Secondary watchdog scheduled task triggers on logon and boot.
  - Backend heartbeat monitoring raises instant alerts on parent dashboard if disconnected.
- ☁️ **Railway & Container Ready**: Multi-stage `Dockerfile` / `Containerfile` and `docker-compose.yml` for 1-click deployment.

---

## 🏗️ Architecture Overview

```
 ┌─────────────────────────────────────────────────────────┐
 │                   Windows 11 Host PC                    │
 │                                                         │
 │  ┌───────────────────────────────────────────────────┐  │
 │  │ Watchtower Rust Daemon (SYSTEM Service)           │  │
 │  │  • Win32 Activity & Idle Tracker                  │  │
 │  │  • Quota Enforcer (TerminateProcess / Logoff)     │  │
 │  │  • 5-Minute Warning Toast Dispatcher              │  │
 │  │  • YouTube & IM Telemetry Inspector               │  │
 │  │  • WebSocket Client (tokio-tungstenite)           │  │
 │  └──────────────────────────▲────────────────────────┘  │
 └─────────────────────────────┼───────────────────────────┘
                               │ Secure WebSocket (TLS)
                               ▼
 ┌─────────────────────────────────────────────────────────┐
 │               Railway / Cloud Backend                   │
 │                                                         │
 │  ┌───────────────────────────────────────────────────┐  │
 │  │ Node.js Server (Fastify + WebSockets)             │  │
 │  │  • Quota Ledger & Policy Sync Engine              │  │
 │  │  • Telemetry Aggregator                           │  │
 │  │  • REST API & Session Manager                     │  │
 │  └──────────────────────────▲────────────────────────┘  │
 │                             │                           │
 │  ┌──────────────────────────┴────────────────────────┐  │
 │  │ Next.js / React Web Dashboard (Parent Portal)     │  │
 │  │  • Real-time Live View & Remote App Killer        │  │
 │  │  • Daily Quota Sliders & Bedtime Curfew           │  │
 │  │  • Quick Time Grant (+15m / +30m / +1h)           │  │
 │  │  • YouTube & IM Telemetry Stream                  │  │
 │  └───────────────────────────────────────────────────┘  │
 └─────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start Guide

### 1. Run the Backend & Dashboard Locally

```bash
# In project root:
cd backend
npm install
npm run build:web       # Build React/Tailwind frontend
npm run build:server    # Compile TypeScript backend
npm start               # Starts server at http://localhost:4000
```

Open **`http://localhost:4000`** on your browser or mobile phone.

---

### 2. Run with Podman / Docker

```bash
# Build and run container
podman build -t watchtower-server .
podman run -d -p 4000:4000 -v watchtower-data:/app/data --name watchtower watchtower-server
```

---

### 3. Deploy to Railway

1. Push this repository to GitHub.
2. Link the repository in **Railway**.
3. Railway will automatically detect the `Dockerfile` and deploy the service.
4. Set environment variables if needed:
   - `PORT`: (automatically provided by Railway)
   - `DATA_DIR`: `/app/data`

---

### 4. Compile & Install the Windows 11 Client

```powershell
# 1. Compile Rust Client
cd client
cargo build --release

# 2. Run PowerShell Installer as Administrator
cd ..\scripts
.\install-client.ps1 -ServerUrl "wss://your-railway-app.up.railway.app/ws/client" -DeviceId "Son-Gaming-PC"
```

To run in foreground for testing:
```powershell
cd client
cargo run -- --config config.json
```

---

## 🧪 Testing & Verification

Run automated test suites:
```bash
cd backend
npm test
```
