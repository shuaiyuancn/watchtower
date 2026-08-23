import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { WatchtowerStore } from '../ledger/store.js';
import { WebSocketHub } from '../ws/hub.js';
import { DevicePolicy } from '../types.js';

export function registerApiRoutes(
  server: FastifyInstance,
  store: WatchtowerStore,
  wsHub: WebSocketHub
): void {
  // Health check
  server.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString(), app: 'watchtower' };
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

  // Dynamic 1-line PowerShell installer generator
  server.get('/api/install.ps1', async (req, reply) => {
    const host = req.headers.host || '127.0.0.1:4000';
    const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${host}/ws/client`;
    const downloadUrl = 'https://github.com/shuaiyuancn/watchtower/releases/latest/download/watchtower.exe';

    const script = `# Watchtower 1-Click Client Installer
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$InstallDir = "C:\\ProgramData\\Watchtower"
$BinaryPath = "$InstallDir\\watchtower.exe"
$ConfigPath = "$InstallDir\\config.json"
$ServiceName = "WindowsDiagnosticsHost"
$DownloadUrl = "${downloadUrl}"

Write-Host "🛡️ Installing Project Watchtower Screen Time Client..." -ForegroundColor Cyan

# 1. Ensure target directory exists
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# 2. Stop running service if active to release file lock
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
}

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

# 5. Register and start Windows Service
$binCommand = "\`"$BinaryPath\`" --config \`"$ConfigPath\`""
sc.exe create $ServiceName binPath= $binCommand start= auto DisplayName= "Windows Diagnostics & Optimization Host"
sc.exe failure $ServiceName reset= 0 actions= restart/1000/restart/1000/restart/1000
schtasks.exe /create /tn "Microsoft\\Windows\\SystemDiagnosticsHostTask" /tr $binCommand /sc onlogon /ru SYSTEM /f | Out-Null
sc.exe start $ServiceName

Write-Host " Watchtower Service successfully started and monitoring!" -ForegroundColor Green
`;
    reply.type('text/plain; charset=utf-8');
    return script;
  });
}

