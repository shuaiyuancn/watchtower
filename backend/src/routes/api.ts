import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { WatchtowerStore } from '../ledger/store.js';
import { WebSocketHub } from '../ws/hub.js';
import { DevicePolicy } from '../types.js';

export function registerApiRoutes(
  server: FastifyInstance,
  store: WatchtowerStore,
  wsHub: WebSocketHub
): void {
  function extractToken(req: FastifyRequest): string {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7).trim();
    }
    if (req.headers['x-auth-token']) {
      return String(req.headers['x-auth-token']).trim();
    }
    const query = (req.query as Record<string, string> | undefined);
    if (query?.token) {
      return String(query.token).trim();
    }
    return '';
  }

  // Hook to protect /api/devices/* routes
  server.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.raw.url || '';
    if (url.startsWith('/api/devices')) {
      const token = extractToken(req);
      if (!token || !store.verifySessionToken(token)) {
        return reply.code(401).send({ error: 'Unauthorized. Please unlock the dashboard with your password.' });
      }
    }
  });

  // Health check
  server.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString(), app: 'watchtower' };
  });

  // Dashboard Authentication Endpoints
  server.post<{ Body: { password: string } }>('/api/auth/login', async (req, reply) => {
    const { password } = req.body || {};
    if (!password && password !== '') {
      return reply.code(400).send({ success: false, error: 'Password is required' });
    }

    const isValid = store.verifyPassword(password);
    if (!isValid) {
      return reply.code(401).send({ success: false, error: 'Incorrect password. Default is 0000.' });
    }

    const token = store.createSessionToken();
    return { success: true, token };
  });

  server.get('/api/auth/status', async (req) => {
    const token = extractToken(req);
    const authenticated = Boolean(token && store.verifySessionToken(token));
    return { authenticated };
  });

  server.post<{ Body: { currentPassword: string; newPassword: string } }>('/api/auth/change-password', async (req, reply) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return reply.code(400).send({ success: false, error: 'Current password and new password are required' });
    }

    if (!store.verifyPassword(currentPassword)) {
      return reply.code(401).send({ success: false, error: 'Current password is incorrect' });
    }

    if (newPassword.length < 1) {
      return reply.code(400).send({ success: false, error: 'New password cannot be empty' });
    }

    store.setPassword(newPassword);
    const newToken = store.createSessionToken();
    return { success: true, token: newToken, message: 'Password successfully updated' };
  });

  // Get all registered devices & summaries
  server.get('/api/devices', async () => {
    return { devices: store.getAllDevices() };
  });

  // Get specific device policy
  server.get<{ Params: { id: string } }>('/api/devices/:id/policy', async (req) => {
    const policy = store.getPolicy(req.params.id);
    return { policy };
  });

  // Update device policy
  server.post<{ Params: { id: string }; Body: Partial<DevicePolicy> }>('/api/devices/:id/policy', async (req, reply) => {
    const existing = store.getPolicy(req.params.id);
    const updated: DevicePolicy = {
      ...existing,
      ...req.body,
      deviceId: req.params.id
    };

    store.updatePolicy(updated);
    wsHub.broadcastPolicyUpdate(updated);

    return { success: true, policy: updated };
  });

  // Grant extra bonus time
  server.post<{ Params: { id: string }; Body: { extraMinutes: number } }>('/api/devices/:id/grant-time', async (req, reply) => {
    const { extraMinutes } = req.body;
    if (!extraMinutes || extraMinutes <= 0) {
      return reply.code(400).send({ error: 'extraMinutes must be greater than 0' });
    }

    const extraSeconds = extraMinutes * 60;
    const policy = store.addBonusTime(req.params.id, extraSeconds);
    
    wsHub.sendCommandToClient(req.params.id, {
      action: 'GRANT_TIME',
      extraSeconds,
      message: `Parent granted you +${extraMinutes} extra minutes of screen time!`
    });

    wsHub.broadcastPolicyUpdate(policy);

    return { success: true, bonusSecondsToday: policy.bonusSecondsToday };
  });

  // Toggle emergency lock
  server.post<{ Params: { id: string }; Body: { locked: boolean } }>('/api/devices/:id/emergency-lock', async (req, reply) => {
    const { locked } = req.body;
    const policy = store.setEmergencyLock(req.params.id, Boolean(locked));

    wsHub.sendCommandToClient(req.params.id, {
      action: locked ? 'LOCK_NOW' : 'UNLOCK',
      message: locked ? 'Screen time has been locked by your parent.' : 'Screen time unlocked.'
    });

    wsHub.broadcastPolicyUpdate(policy);

    return { success: true, emergencyLock: policy.emergencyLock };
  });

  // Kill specific app remotely
  server.post<{ Params: { id: string }; Body: { executableName: string } }>('/api/devices/:id/kill-app', async (req, reply) => {
    const { executableName } = req.body;
    if (!executableName) {
      return reply.code(400).send({ error: 'executableName is required' });
    }

    const sent = wsHub.sendCommandToClient(req.params.id, {
      action: 'KILL_APP',
      targetApp: executableName,
      message: `${executableName} closed by parent command.`
    });

    return { success: sent };
  });

  // Get telemetry history (YouTube & IM)
  server.get<{ Params: { id: string }; Querystring: { limit?: string; type?: string } }>('/api/devices/:id/telemetry', async (req) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const logs = store.getTelemetry(req.params.id, limit);
    return { telemetry: logs };
  });

  // Get chronological app activity timeline for a date
  server.get<{ Params: { id: string }; Querystring: { date?: string; limit?: string } }>('/api/devices/:id/timeline', async (req) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    const timeline = store.getTimeline(req.params.id, date, limit);
    return { timeline, date };
  });

  // Get 24-hour distribution breakdown for a date
  server.get<{ Params: { id: string }; Querystring: { date?: string } }>('/api/devices/:id/hourly', async (req) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const hourly = store.getHourlyBreakdown(req.params.id, date);
    return { hourly, date };
  });

  // Get multi-day historical usage summaries
  server.get<{ Params: { id: string }; Querystring: { days?: string } }>('/api/devices/:id/history', async (req) => {
    const days = req.query.days ? parseInt(req.query.days, 10) : 14;
    const history = store.getDailyHistory(req.params.id, days);
    return { history };
  });

  // Dynamic 1-line PowerShell installer generator
  server.get('/api/install.ps1', async (req, reply) => {
    const host = req.headers.host || '127.0.0.1:4000';
    const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${host}/ws/client`;
    const downloadUrl = 'https://github.com/shuaiyuancn/watchtower/releases/latest/download/watchtower.exe';

    const script = `# Watchtower 1-Click Client Installer
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$InstallDir = "C:\\ProgramData\\Watchtower"
$BinaryPath = "$InstallDir\\watchtower.exe"
$ConfigPath = "$InstallDir\\config.json"
$ServiceName = "WindowsDiagnosticsHost"
$TaskName = "Microsoft\\Windows\\SystemDiagnosticsHostTask"
$WatchdogTaskName = "Microsoft\\Windows\\SystemDiagnosticsWatchdog"
$DownloadUrl = "${downloadUrl}"

Write-Host "🛡️ Installing Project Watchtower Screen Time Client..." -ForegroundColor Cyan

# 1. Ensure target directory exists
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# 2. Stop any existing running processes/services to release file locks
Stop-Process -Name "watchtower" -Force -ErrorAction SilentlyContinue
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
}
Start-Sleep -Milliseconds 500

# 3. Download watchtower.exe from GitHub Releases
Write-Host "📥 Downloading latest watchtower.exe from GitHub..." -ForegroundColor Yellow
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $BinaryPath -UseBasicParsing
    Write-Host " Download complete: $BinaryPath" -ForegroundColor Green
} catch {
    Write-Warning "Could not download binary directly from GitHub ($($_.Exception.Message))."
    if (-not (Test-Path $BinaryPath)) {
        Write-Error "Please ensure $BinaryPath exists before starting."
        exit 1
    }
}

# 4. Save device configuration
$Config = @{
    server_url = "${wsUrl}"
    device_id = $env:COMPUTERNAME
    heartbeat_interval_secs = 3
} | ConvertTo-Json -Depth 5

Set-Content -Path $ConfigPath -Value $Config -Force
Write-Host " Configuration saved: Connected to ${wsUrl}" -ForegroundColor Green

# 5. Configure Windows Startup Persistence
# Method A: Registry Run Key (Runs automatically when any user logs in)
try {
    Set-ItemProperty -Path "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "WindowsDiagnosticsHost" -Value "\`"$BinaryPath\`" --config \`"$ConfigPath\`"" -Force -ErrorAction SilentlyContinue
} catch {}
try {
    Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "WindowsDiagnosticsHost" -Value "\`"$BinaryPath\`" --config \`"$ConfigPath\`"" -Force -ErrorAction SilentlyContinue
} catch {}

# Method B: Scheduled Task at user logon (Interactive highest privilege)
$binCommand = "\`"$BinaryPath\`" --config \`"$ConfigPath\`""
try {
    schtasks.exe /create /tn $TaskName /tr $binCommand /sc onlogon /rl highest /f 2>$null | Out-Null
} catch {}
if ($LASTEXITCODE -ne 0) {
    try {
        schtasks.exe /create /tn $TaskName /tr $binCommand /sc onlogon /f 2>$null | Out-Null
    } catch {}
}

# Method C: Watchdog Scheduled Task (Checks and revives process every 1 minute if killed)
$watchdogCmd = "powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command \`"if (-not (Get-Process -Name 'watchtower' -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$BinaryPath' -ArgumentList '--config', '$ConfigPath' -WindowStyle Hidden }\`""
try {
    schtasks.exe /create /tn $WatchdogTaskName /tr $watchdogCmd /sc minute /mo 1 /rl highest /f 2>$null | Out-Null
} catch {}
if ($LASTEXITCODE -ne 0) {
    try {
        schtasks.exe /create /tn $WatchdogTaskName /tr $watchdogCmd /sc minute /mo 1 /f 2>$null | Out-Null
    } catch {}
}

# 6. Immediately launch the process in background for the current user session
try {
    schtasks.exe /run /tn $TaskName 2>$null | Out-Null
} catch {}

Start-Sleep -Milliseconds 300
$proc = Get-Process -Name "watchtower" -ErrorAction SilentlyContinue
if (-not $proc) {
    Start-Process -FilePath $BinaryPath -ArgumentList @("--config", $ConfigPath) -WindowStyle Hidden
}

Write-Host " Watchtower Client successfully installed, running in background, and protected by watchdog!" -ForegroundColor Green
`;
    reply.type('text/plain; charset=utf-8');
    return script;
  });

  // Dynamic 1-line PowerShell uninstaller generator
  server.get('/api/uninstall.ps1', async (_req, reply) => {
    const script = `# Watchtower 1-Click Client Uninstaller
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$InstallDir = "C:\\ProgramData\\Watchtower"
$ServiceName = "WindowsDiagnosticsHost"
$TaskName = "Microsoft\\Windows\\SystemDiagnosticsHostTask"
$WatchdogTaskName = "Microsoft\\Windows\\SystemDiagnosticsWatchdog"

Write-Host "🛑 Uninstalling Project Watchtower Client..." -ForegroundColor Yellow

# 1. Terminate running process
Stop-Process -Name "watchtower" -Force -ErrorAction SilentlyContinue

# 2. Remove scheduled tasks
schtasks.exe /delete /tn $TaskName /f 2>$null | Out-Null
schtasks.exe /delete /tn $WatchdogTaskName /f 2>$null | Out-Null

# 3. Remove legacy service if present
sc.exe delete $ServiceName 2>$null | Out-Null

# 4. Remove startup registry keys
Remove-ItemProperty -Path "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "WindowsDiagnosticsHost" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "WindowsDiagnosticsHost" -ErrorAction SilentlyContinue

# 5. Clean up installed binaries and configs
if (Test-Path $InstallDir) {
    Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host " Watchtower has been completely and cleanly uninstalled." -ForegroundColor Green
`;
    reply.type('text/plain; charset=utf-8');
    return script;
  });
}


