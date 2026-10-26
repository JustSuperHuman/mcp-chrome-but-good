[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $BrowserPath,
    [ValidatePattern('^[a-zA-Z0-9 _-]+$')]
    [string] $ProfileDirectory = 'Default',
    [ValidateRange(1, 65535)]
    [int] $Port = 12306
)

$ErrorActionPreference = 'Stop'
$BrowserPath = (Resolve-Path -LiteralPath $BrowserPath).Path
$installDirectory = Join-Path $env:LOCALAPPDATA 'JustBrowseMCP'
$taskName = 'JustBrowseMCP Startup'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-windows-bridge.ps1') -Destination $installDirectory -Force
@{
    BrowserPath = $BrowserPath
    ProfileDirectory = $ProfileDirectory
    HealthUrl = 'http://127.0.0.1:{0}/ping' -f $Port
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installDirectory 'startup.json') -Encoding UTF8

$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $installDirectory 'start-windows-bridge.ps1')
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $installDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$trigger.Delay = 'PT10S'
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    $backupDirectory = Join-Path $installDirectory 'backups'
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $backupDirectory ('startup-task-{0}.xml' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))) -Encoding Unicode
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start the JustBrowse browser profile invisibly at sign-in and verify the native MCP bridge connection.' -Force | Out-Null
Write-Output ('Installed task "{0}" for {1}. Logs: {2}' -f $taskName, $identity.Name, (Join-Path $installDirectory 'startup.log'))
Write-Output ('Run now: Start-ScheduledTask -TaskName "{0}"' -f $taskName)
