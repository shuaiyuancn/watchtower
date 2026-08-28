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

# 1. Stop running processes
Stop-Process -Name "watchtower" -Force -ErrorAction SilentlyContinue

# 2. Stop and delete service if present
Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
sc.exe delete $ServiceName 2>$null | Out-Null

# 3. Delete scheduled task
schtasks.exe /delete /tn "Microsoft\Windows\SystemDiagnosticsHostTask" /f 2>$null | Out-Null

# 4. Remove startup registry keys
Remove-ItemProperty -Path "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "WindowsDiagnosticsHost" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "WindowsDiagnosticsHost" -ErrorAction SilentlyContinue

# 5. Clean files
if (Test-Path $InstallDir) {
    Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host " Watchtower uninstalled cleanly." -ForegroundColor Green
