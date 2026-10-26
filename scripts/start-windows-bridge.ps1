$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'startup.json') -Raw | ConvertFrom-Json
$logPath = Join-Path $PSScriptRoot 'startup.log'

function Write-StartupLog([string] $Message) {
    Add-Content -LiteralPath $logPath -Value ('{0:o} {1}' -f (Get-Date), $Message)
}

function Test-Bridge {
    try {
        $health = Invoke-RestMethod -Uri $config.HealthUrl -TimeoutSec 3
        return $health.status -eq 'ok' -and $health.extensionConnected -eq $true
    } catch {
        return $false
    }
}

try {
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1MB) {
        Move-Item -LiteralPath $logPath -Destination ($logPath + '.previous') -Force
    }
    if (Test-Bridge) {
        Write-StartupLog 'Bridge already connected; no browser launch needed.'
        exit 0
    }

    # The extension owns the native messaging pipe. Starting Node directly cannot
    # connect to the signed-in browser. Start its profile without opening a window.
    Start-Process -FilePath $config.BrowserPath -ArgumentList @(
        '--no-startup-window',
        ('--profile-directory="{0}"' -f $config.ProfileDirectory)
    ) -WindowStyle Hidden
    Write-StartupLog ('Started browser profile {0} in the background.' -f $config.ProfileDirectory)

    $deadline = (Get-Date).AddSeconds(120)
    do {
        if (Test-Bridge) {
            Write-StartupLog 'Bridge healthy; extensionConnected=true.'
            exit 0
        }
        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)
    throw 'Bridge did not connect within 120 seconds. Check extension auto-connect and native host logs.'
} catch {
    Write-StartupLog ('Startup failed: ' + $_.Exception.Message)
    exit 1
}
