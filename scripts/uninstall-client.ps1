<#
.SYNOPSIS
    Uninstalls Watchtower Windows 11 Client using authenticated server payload.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$Password,
    
    [Parameter(Mandatory=$false)]
    [string]$ServerUrl = "https://watchtower-production-3b1e.up.railway.app"
)

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
    exit 1
}

Write-Host "🔐 Authenticating uninstallation with Watchtower server ($ServerUrl)..." -ForegroundColor Cyan

try {
    $body = @{ password = $Password } | ConvertTo-Json
    $res = Invoke-RestMethod -Uri "$ServerUrl/api/uninstall/execute" -Method Post -Body $body -ContentType "application/json" -ErrorAction Stop

    if ($res -and $res.success -and $res.script) {
        Invoke-Expression $res.script
    } else {
        Write-Host "❌ Failed to retrieve uninstaller payload." -ForegroundColor Red
        exit 1
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
    exit 1
}

