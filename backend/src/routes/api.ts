import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { WatchtowerStore } from '../ledger/store.js';
import { WebSocketHub } from '../ws/hub.js';
import { DevicePolicy } from '../types.js';

const AUTH_LOCKOUT_MS = 5000; // 5-second cooldown between failed attempts
const failedAttemptsByIp = new Map<string, number>();

export function clearAllAuthRateLimits(): void {
  failedAttemptsByIp.clear();
}

function getClientIp(req: FastifyRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown-client';
}

function checkAuthRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
  const lastFailed = failedAttemptsByIp.get(ip);
  if (!lastFailed) {
    return { allowed: true, retryAfter: 0 };
  }
  const elapsed = Date.now() - lastFailed;
  if (elapsed < AUTH_LOCKOUT_MS) {
    const remainingSec = Math.ceil((AUTH_LOCKOUT_MS - elapsed) / 1000);
    return { allowed: false, retryAfter: remainingSec };
  }
  failedAttemptsByIp.delete(ip);
  return { allowed: true, retryAfter: 0 };
}

function recordFailedAttempt(ip: string): void {
  failedAttemptsByIp.set(ip, Date.now());
}

function clearRateLimit(ip: string): void {
  failedAttemptsByIp.delete(ip);
}

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
    const ip = getClientIp(req);
    const rateCheck = checkAuthRateLimit(ip);
    if (!rateCheck.allowed) {
      reply.header('Retry-After', rateCheck.retryAfter);
      return reply.code(429).send({
        success: false,
        error: `Too many password attempts. Please wait ${rateCheck.retryAfter}s before retrying.`,
        retryAfter: rateCheck.retryAfter
      });
    }

    const { password } = req.body || {};
    if (!password && password !== '') {
      return reply.code(400).send({ success: false, error: 'Password is required' });
    }

    const isValid = store.verifyPassword(password);
    if (!isValid) {
      recordFailedAttempt(ip);
      reply.header('Retry-After', 5);
      return reply.code(401).send({
        success: false,
        error: 'Incorrect password. Please wait 5s before retrying.',
        retryAfter: 5
      });
    }

    clearRateLimit(ip);
    const token = store.createSessionToken();
    return { success: true, token };
  });

  server.get('/api/auth/status', async (req) => {
    const token = extractToken(req);
    const authenticated = Boolean(token && store.verifySessionToken(token));
    return { authenticated };
  });

  server.post<{ Body: { currentPassword: string; newPassword: string } }>('/api/auth/change-password', async (req, reply) => {
    const ip = getClientIp(req);
    const rateCheck = checkAuthRateLimit(ip);
    if (!rateCheck.allowed) {
      reply.header('Retry-After', rateCheck.retryAfter);
      return reply.code(429).send({
        success: false,
        error: `Too many password attempts. Please wait ${rateCheck.retryAfter}s before retrying.`,
        retryAfter: rateCheck.retryAfter
      });
    }

    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return reply.code(400).send({ success: false, error: 'Current password and new password are required' });
    }

    if (!store.verifyPassword(currentPassword)) {
      recordFailedAttempt(ip);
      reply.header('Retry-After', 5);
      return reply.code(401).send({
        success: false,
        error: 'Current password is incorrect. Please wait 5s before retrying.',
        retryAfter: 5
      });
    }

    if (newPassword.length < 1) {
      return reply.code(400).send({ success: false, error: 'New password cannot be empty' });
    }

    clearRateLimit(ip);
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
  server.get<{ Params: { id: string }; Querystring: { limit?: string; type?: string; date?: string } }>('/api/devices/:id/telemetry', async (req) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    const date = req.query.date;
    const type = req.query.type;
    const logs = store.getTelemetry(req.params.id, limit, date, type);
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

$InstallDir = "$env:LOCALAPPDATA\\Watchtower"
if ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent().IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $InstallDir = "C:\\ProgramData\\Watchtower"
}
$BinaryPath = "$InstallDir\\watchtower.exe"
$ConfigPath = "$InstallDir\\config.json"
$ServiceName = "WindowsDiagnosticsHost"
$TaskName = "SystemDiagnosticsHostTask"
$WatchdogTaskName = "SystemDiagnosticsWatchdog"
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

# Method B: Scheduled Task at user logon (Power-resilient, no battery stop, no 72h limit, native Task Scheduler auto-restart)
try {
    # Clean up any legacy or watchdog tasks to prevent console window flashing
    Unregister-ScheduledTask -TaskName "SystemDiagnosticsWatchdog" -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "Microsoft\\Windows\\SystemDiagnosticsWatchdog" -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "Microsoft\\Windows\\SystemDiagnosticsHostTask" -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "SystemDiagnosticsHostTask" -Confirm:$false -ErrorAction SilentlyContinue

    $taskAction = New-ScheduledTaskAction -Execute $BinaryPath -Argument "--config \`"$ConfigPath\`""
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
    Register-ScheduledTask -TaskName "SystemDiagnosticsHostTask" -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -User $env:USERNAME -Force -ErrorAction SilentlyContinue | Out-Null
} catch {}

# 6. Immediately launch the process in background for the current user session
Start-Sleep -Milliseconds 300
$proc = Get-Process -Name "watchtower" -ErrorAction SilentlyContinue
if (-not $proc) {
    Start-Process -FilePath $BinaryPath -ArgumentList @("--config", "$ConfigPath")
}

Write-Host " Watchtower Client successfully installed, running in background, and protected by Task Scheduler!" -ForegroundColor Green
`;
    reply.type('text/plain; charset=utf-8');
    return script;
  });

  // Authenticated Uninstaller Payload Executor
  server.post<{ Body: { password: string } }>('/api/uninstall/execute', async (req, reply) => {
    const ip = getClientIp(req);
    const rateCheck = checkAuthRateLimit(ip);
    if (!rateCheck.allowed) {
      reply.header('Retry-After', rateCheck.retryAfter);
      return reply.code(429).send({
        success: false,
        error: `Too many password attempts. Please wait ${rateCheck.retryAfter}s before retrying.`,
        retryAfter: rateCheck.retryAfter
      });
    }

    const { password } = req.body || {};
    if (!password && password !== '') {
      return reply.code(400).send({ success: false, error: 'Password is required' });
    }

    const isValid = store.verifyPassword(password);
    if (!isValid) {
      recordFailedAttempt(ip);
      reply.header('Retry-After', 5);
      return reply.code(401).send({
        success: false,
        error: 'Incorrect password. Please wait 5s before retrying.',
        retryAfter: 5
      });
    }

    clearRateLimit(ip);

    const removalScript = `# Dynamic Watchtower Removal Payload
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$InstallDirs = @("$env:LOCALAPPDATA\\Watchtower", "C:\\ProgramData\\Watchtower")
$ServiceName = "WindowsDiagnosticsHost"
$TaskName = "SystemDiagnosticsHostTask"
$WatchdogTaskName = "SystemDiagnosticsWatchdog"

Write-Host "🛑 Executing Watchtower Client Uninstallation..." -ForegroundColor Yellow

# 1. Terminate running process
Stop-Process -Name "watchtower" -Force -ErrorAction SilentlyContinue

# 2. Remove scheduled tasks
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $WatchdogTaskName -Confirm:$false -ErrorAction SilentlyContinue
schtasks.exe /delete /tn $TaskName /f 2>$null | Out-Null
schtasks.exe /delete /tn $WatchdogTaskName /f 2>$null | Out-Null
schtasks.exe /delete /tn "Microsoft\\Windows\\SystemDiagnosticsHostTask" /f 2>$null | Out-Null
schtasks.exe /delete /tn "Microsoft\\Windows\\SystemDiagnosticsWatchdog" /f 2>$null | Out-Null

# 3. Remove legacy service if present
sc.exe delete $ServiceName 2>$null | Out-Null

# 4. Remove startup registry keys
Remove-ItemProperty -Path "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "WindowsDiagnosticsHost" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "WindowsDiagnosticsHost" -ErrorAction SilentlyContinue

# 5. Clean up installed binaries and configs
foreach ($dir in $InstallDirs) {
    if (Test-Path $dir) {
        Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host " Watchtower has been completely and cleanly uninstalled." -ForegroundColor Green
`;

    return {
      success: true,
      script: removalScript
    };
  });

  // Dynamic 1-line PowerShell uninstaller generator (Secure Wrapper)
  server.get('/api/uninstall.ps1', async (req, reply) => {
    const protocol = req.protocol || 'http';
    const host = req.headers.host || 'localhost:4000';
    const baseUrl = `${protocol}://${host}`;

    const script = `# Watchtower Secure 1-Click Client Uninstaller
param(
    [Parameter(Mandatory=$false)]
    [string]$Password
)

$ServerBase = "${baseUrl}"

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host " 🛡️  Project Watchtower Protected Uninstaller" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan

# 1. Prompt for password if not supplied
if (-not $Password) {
    $securePass = Read-Host -Prompt "Enter Watchtower Parent/Admin Password" -AsSecureString
    $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePass)
    $Password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
}

if (-not $Password) {
    Write-Host "❌ Password is required to uninstall Watchtower." -ForegroundColor Red
    return
}

Write-Host "🔐 Authenticating uninstallation with Watchtower server..." -ForegroundColor Cyan

# 2. Authenticate and retrieve dynamic removal script in-memory
try {
    $body = @{ password = $Password } | ConvertTo-Json
    $res = Invoke-RestMethod -Uri "$ServerBase/api/uninstall/execute" -Method Post -Body $body -ContentType "application/json" -ErrorAction Stop

    if ($res -and $res.success -and $res.script) {
        Invoke-Expression $res.script
    } else {
        Write-Host "❌ Failed to retrieve uninstaller payload." -ForegroundColor Red
    }
} catch {
    $errMsg = $_.Exception.Message
    if ($errMsg -match "401") {
        Write-Host "❌ Authentication failed: Incorrect Watchtower password. 5-second retry cooldown active." -ForegroundColor Red
    } elseif ($errMsg -match "429") {
        Write-Host "⚠️ Too many failed attempts. Please wait 5 seconds before retrying." -ForegroundColor Yellow
    } else {
        Write-Host "❌ Server error: $errMsg" -ForegroundColor Red
    }
}
`;
    reply.type('text/plain; charset=utf-8');
    return script;
  });
}



