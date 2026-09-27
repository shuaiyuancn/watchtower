import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { WatchtowerStore } from '../ledger/store.js';
import { WebSocketHub } from '../ws/hub.js';
import { DevicePolicy } from '../types.js';
import { notifySlack } from '../notify/slack.js';

// Rate limiting: exponential backoff plus a hard lockout after repeated failures.
const BASE_COOLDOWN_MS = 5000;      // cooldown after the first failure
const MAX_COOLDOWN_MS = 15 * 60 * 1000; // cap backoff at 15 minutes
const HARD_LOCKOUT_THRESHOLD = 10;  // failures before an extended lockout
const HARD_LOCKOUT_MS = 30 * 60 * 1000; // 30-minute lockout once threshold is hit
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000; // forget failures older than 1h

interface AttemptRecord {
  count: number;
  lastFailedAt: number;
  lockedUntil: number;
}

const attemptsByIp = new Map<string, AttemptRecord>();

export function clearAllAuthRateLimits(): void {
  attemptsByIp.clear();
}

// Key rate limiting on the hop appended by our own trusted proxy, not the
// client-controlled left-most X-Forwarded-For entry (H1). req.ips is
// [socketPeer, ...XFF right-to-left], so index TRUST_PROXY_HOPS (default 1) is
// the address the nearest trusted proxy reported — which an attacker cannot
// forge by prepending fake entries. Falls back to the socket when no proxy.
function getClientIp(req: FastifyRequest): string {
  const rawHops = parseInt(process.env.TRUST_PROXY_HOPS || '1', 10);
  const hops = Number.isFinite(rawHops) && rawHops >= 0 ? rawHops : 1;
  const ips = req.ips;
  if (Array.isArray(ips) && ips.length > 0) {
    const idx = Math.min(hops, ips.length - 1);
    return ips[idx] || 'unknown-client';
  }
  return req.ip || req.socket.remoteAddress || 'unknown-client';
}

function cooldownFor(count: number): number {
  // 5s, 10s, 20s, 40s ... capped.
  const ms = BASE_COOLDOWN_MS * Math.pow(2, Math.max(0, count - 1));
  return Math.min(ms, MAX_COOLDOWN_MS);
}

function checkAuthRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
  const rec = attemptsByIp.get(ip);
  if (!rec) return { allowed: true, retryAfter: 0 };

  // Expire stale records so honest users aren't punished forever.
  if (Date.now() - rec.lastFailedAt > ATTEMPT_WINDOW_MS) {
    attemptsByIp.delete(ip);
    return { allowed: true, retryAfter: 0 };
  }

  const now = Date.now();
  if (rec.lockedUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

function recordFailedAttempt(ip: string): number {
  const now = Date.now();
  const existing = attemptsByIp.get(ip);
  const count = existing && now - existing.lastFailedAt <= ATTEMPT_WINDOW_MS ? existing.count + 1 : 1;
  const cooldown = count >= HARD_LOCKOUT_THRESHOLD ? HARD_LOCKOUT_MS : cooldownFor(count);
  attemptsByIp.set(ip, { count, lastFailedAt: now, lockedUntil: now + cooldown });
  if (count === HARD_LOCKOUT_THRESHOLD) {
    notifySlack(`🔒 Watchtower auth lockout: ${count} failed attempts from ${ip} — locked for ${Math.ceil(cooldown / 60000)} min.`);
  }
  return Math.ceil(cooldown / 1000);
}

function clearRateLimit(ip: string): void {
  attemptsByIp.delete(ip);
}

export function registerApiRoutes(
  server: FastifyInstance,
  store: WatchtowerStore,
  wsHub: WebSocketHub
): void {
  // Tokens are only accepted in headers — never query strings, which leak into
  // access logs, proxies and browser history (H3).
  function extractToken(req: FastifyRequest): string {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7).trim();
    }
    if (req.headers['x-auth-token']) {
      return String(req.headers['x-auth-token']).trim();
    }
    return '';
  }

  // Hook to protect /api/devices/* routes. Device enrollment is exempt: it
  // authenticates with the enrollment secret, not a dashboard session token.
  server.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = (req.raw.url || '').split('?')[0];
    if (url.startsWith('/api/devices') && url !== '/api/devices/enroll') {
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
      const retryAfter = recordFailedAttempt(ip);
      notifySlack(`⚠️ Failed Watchtower dashboard login from ${ip}.`);
      reply.header('Retry-After', retryAfter);
      return reply.code(401).send({
        success: false,
        error: `Incorrect password. Please wait ${retryAfter}s before retrying.`,
        retryAfter
      });
    }

    clearRateLimit(ip);
    notifySlack(`✅ Watchtower dashboard login from ${ip}.`);
    const token = store.createSessionToken();
    return { success: true, token };
  });

  server.get('/api/auth/status', async (req) => {
    const token = extractToken(req);
    const authenticated = Boolean(token && store.verifySessionToken(token));
    return { authenticated };
  });

  // Logout: revoke every existing session token (H2).
  server.post('/api/auth/logout', async (req, reply) => {
    const token = extractToken(req);
    if (!token || !store.verifySessionToken(token)) {
      return reply.code(401).send({ success: false, error: 'Unauthorized' });
    }
    store.revokeAllSessions();
    return { success: true };
  });

  // Exchange a valid session token for a short-lived, single-use WS ticket (H3).
  server.post('/api/auth/ws-ticket', async (req, reply) => {
    const token = extractToken(req);
    if (!token || !store.verifySessionToken(token)) {
      return reply.code(401).send({ success: false, error: 'Unauthorized' });
    }
    return { success: true, ticket: store.createWsTicket() };
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
      const retryAfter = recordFailedAttempt(ip);
      reply.header('Retry-After', retryAfter);
      return reply.code(401).send({
        success: false,
        error: `Current password is incorrect. Please wait ${retryAfter}s before retrying.`,
        retryAfter
      });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return reply.code(400).send({ success: false, error: 'New password must be at least 8 characters' });
    }

    clearRateLimit(ip);
    store.setPassword(newPassword);
    // Invalidate all existing sessions, then issue a fresh token for this client.
    store.revokeAllSessions();
    notifySlack(`🔧 Watchtower dashboard password changed from ${ip}. All sessions were logged out.`);
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

    const limitMin = Math.round((updated.dailyGlobalLimitSeconds || 0) / 60);
    const bedtime = updated.bedtime?.enabled
      ? `, bedtime ${String(updated.bedtime.startHour).padStart(2, '0')}:${String(updated.bedtime.startMinute).padStart(2, '0')}–${String(updated.bedtime.endHour).padStart(2, '0')}:${String(updated.bedtime.endMinute).padStart(2, '0')}`
      : '';
    notifySlack(`⚙️ Watchtower quotas updated for *${req.params.id}* (daily limit ${limitMin}m${bedtime}).`);

    return { success: true, policy: updated };
  });

  // Grant extra bonus time
  server.post<{ Params: { id: string }; Body: { extraMinutes: number } }>('/api/devices/:id/grant-time', async (req, reply) => {
    const { extraMinutes } = req.body;
    if (typeof extraMinutes !== 'number' || !Number.isFinite(extraMinutes) || extraMinutes <= 0) {
      return reply.code(400).send({ error: 'extraMinutes must be a positive number' });
    }
    if (extraMinutes > 1440) {
      return reply.code(400).send({ error: 'extraMinutes cannot exceed 1440 (24h)' });
    }

    const extraSeconds = Math.round(extraMinutes * 60);
    const policy = store.addBonusTime(req.params.id, extraSeconds);
    
    wsHub.sendCommandToClient(req.params.id, {
      action: 'GRANT_TIME',
      extraSeconds,
      message: `Parent granted you +${extraMinutes} extra minutes of screen time!`
    });

    wsHub.broadcastPolicyUpdate(policy);
    notifySlack(`➕ Watchtower granted +${extraMinutes}m to *${req.params.id}* (bonus today: ${Math.round((policy.bonusSecondsToday || 0) / 60)}m).`);

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
    notifySlack(`${locked ? '🔒' : '🔓'} Watchtower emergency lock ${locked ? 'ENABLED' : 'disabled'} for *${req.params.id}*.`);

    return { success: true, emergencyLock: policy.emergencyLock };
  });

  // Kill specific app remotely
  server.post<{ Params: { id: string }; Body: { executableName: string } }>('/api/devices/:id/kill-app', async (req, reply) => {
    const { executableName } = req.body;
    if (typeof executableName !== 'string' || !executableName.trim() || executableName.length > 260) {
      return reply.code(400).send({ error: 'executableName must be a non-empty string (max 260 chars)' });
    }

    const sent = wsHub.sendCommandToClient(req.params.id, {
      action: 'KILL_APP',
      targetApp: executableName,
      message: `${executableName} closed by parent command.`
    });
    notifySlack(`🗡️ Watchtower kill-app *${executableName}* sent to *${req.params.id}* (${sent ? 'delivered' : 'device offline'}).`);

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
  server.get<{ Params: { id: string }; Querystring: { date?: string; limit?: string; hour?: string } }>('/api/devices/:id/timeline', async (req) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 1000;
    const hour = req.query.hour !== undefined ? parseInt(req.query.hour, 10) : undefined;
    const parsedHour = hour !== undefined && !isNaN(hour) ? hour : undefined;
    const timeline = store.getTimeline(req.params.id, date, limit, parsedHour);
    return { timeline, date, hour: parsedHour };
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

  // Device enrollment: exchange the deployment enrollment secret for a
  // long-lived, device-bound token (C1). Rate-limited like the auth endpoints.
  server.post<{ Body: { deviceId?: string; enrollmentSecret?: string } }>('/api/devices/enroll', async (req, reply) => {
    const ip = getClientIp(req);
    const rateCheck = checkAuthRateLimit(ip);
    if (!rateCheck.allowed) {
      reply.header('Retry-After', rateCheck.retryAfter);
      return reply.code(429).send({ success: false, error: 'Too many attempts', retryAfter: rateCheck.retryAfter });
    }

    const deviceId = (req.body?.deviceId || '').trim();
    const enrollmentSecret = req.body?.enrollmentSecret || '';
    if (!deviceId || deviceId.length > 128) {
      return reply.code(400).send({ success: false, error: 'deviceId is required (max 128 chars)' });
    }
    if (!store.verifyEnrollmentSecret(enrollmentSecret)) {
      const retryAfter = recordFailedAttempt(ip);
      reply.header('Retry-After', retryAfter);
      return reply.code(401).send({ success: false, error: 'Invalid enrollment secret', retryAfter });
    }

    clearRateLimit(ip);
    const token = store.createDeviceToken(deviceId);
    return { success: true, token };
  });

  // Dynamic 1-line PowerShell installer generator
  server.get<{ Querystring: { key?: string } }>('/api/install.ps1', async (req, reply) => {
    const host = req.headers.host || '127.0.0.1:4000';
    const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
    const httpProtocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const wsUrl = `${protocol}://${host}/ws/client`;
    const httpBase = `${httpProtocol}://${host}`;
    // The parent supplies the enrollment secret as ?key=... ; we only echo back
    // what the caller provided (never the server's stored secret).
    const enrollKey = (req.query?.key || '').replace(/[`"$]/g, '');
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

# Clean up alternative installation directory and legacy tasks to avoid duplicate instances
$otherDir = "C:\\ProgramData\\Watchtower"
if ($InstallDir -eq "C:\\ProgramData\\Watchtower") {
    $otherDir = "$env:LOCALAPPDATA\\Watchtower"
}
if (Test-Path $otherDir) {
    Remove-Item -Path $otherDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Clean up startup registry run keys to avoid dual-launch with Scheduled Tasks
Remove-ItemProperty -Path "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "WindowsDiagnosticsHost" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "WindowsDiagnosticsHost" -ErrorAction SilentlyContinue

# Clean up any legacy or watchdog tasks
Unregister-ScheduledTask -TaskName "SystemDiagnosticsWatchdog" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "Microsoft\\Windows\\SystemDiagnosticsWatchdog" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "Microsoft\\Windows\\SystemDiagnosticsHostTask" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "SystemDiagnosticsHostTask" -Confirm:$false -ErrorAction SilentlyContinue
schtasks.exe /delete /tn "Microsoft\\Windows\\SystemDiagnosticsHostTask" /f 2>$null | Out-Null
schtasks.exe /delete /tn "SystemDiagnosticsHostTask" /f 2>$null | Out-Null

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

# 4. Enroll this device to obtain a device-bound auth token (C1)
$EnrollKey = "${enrollKey}"
$AuthToken = ""
if ($EnrollKey) {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
        $enrollBody = @{ deviceId = $env:COMPUTERNAME; enrollmentSecret = $EnrollKey } | ConvertTo-Json
        $enrollRes = Invoke-RestMethod -Uri "${httpBase}/api/devices/enroll" -Method Post -Body $enrollBody -ContentType "application/json" -ErrorAction Stop
        if ($enrollRes -and $enrollRes.success -and $enrollRes.token) {
            $AuthToken = $enrollRes.token
            Write-Host " Device enrolled successfully." -ForegroundColor Green
        }
    } catch {
        Write-Warning "Device enrollment failed ($($_.Exception.Message)). If REQUIRE_DEVICE_AUTH is enabled on the server, the client will not be able to connect."
    }
} else {
    Write-Warning "No enrollment key provided (?key=...). If REQUIRE_DEVICE_AUTH is enabled on the server, this client will be rejected."
}

# 5. Save device configuration
$Config = @{
    server_url = "${wsUrl}"
    device_id = $env:COMPUTERNAME
    auth_token = $AuthToken
    heartbeat_interval_secs = 3
} | ConvertTo-Json -Depth 5

Set-Content -Path $ConfigPath -Value $Config -Force
Write-Host " Configuration saved: Connected to ${wsUrl}" -ForegroundColor Green

# 5. Configure Windows Scheduled Task (Runs at user logon with battery/restart resilience)
try {
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
      const retryAfter = recordFailedAttempt(ip);
      notifySlack(`⚠️ Failed Watchtower uninstall authentication from ${ip}.`);
      reply.header('Retry-After', retryAfter);
      return reply.code(401).send({
        success: false,
        error: `Incorrect password. Please wait ${retryAfter}s before retrying.`,
        retryAfter
      });
    }

    clearRateLimit(ip);
    notifySlack(`🗑️ Watchtower uninstall payload issued to ${ip}.`);

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



