<#
.SYNOPSIS
    Uninstalls Watchtower Windows 11 Client Service and Scheduled Task.
#>

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Please run this PowerShell script as Administrator!"
    exit 1
}

$ServiceName = "WindowsDiagnosticsHost"
$InstallDir = "C:\ProgramData\Watchtower"

Write-Host "🛑 Uninstalling Watchtower Service..." -ForegroundColor Yellow

# 1. Stop and delete service
Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
sc.exe delete $ServiceName | Out-Null

# 2. Delete watchdog scheduled task
schtasks.exe /delete /tn "Microsoft\Windows\SystemDiagnosticsHostTask" /f | Out-Null

# 3. Clean files (optional)
if (Test-Path $InstallDir) {
    Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host " Watchtower uninstalled cleanly." -ForegroundColor Green
