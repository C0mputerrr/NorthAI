<#
.SYNOPSIS
  Start North Command Center automatically when you log into Windows.

.DESCRIPTION
  Registers a Scheduled Task that launches the dashboard hidden at logon.

  A Scheduled Task is used rather than a Startup-folder shortcut because it
  runs without a console window, restarts the dashboard if it crashes, and can
  be inspected and removed with one command.

  The task runs as the current user with ordinary privileges -- it does not
  request elevation, and it does not change any OpenClaw or Windows setting.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1 -Uninstall
#>

[CmdletBinding()]
param(
  [switch]$Uninstall,
  [string]$TaskName = 'North Command Center'
)

$ErrorActionPreference = 'Stop'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "No scheduled task named '$TaskName' was found." -ForegroundColor Yellow
  }
  return
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectRoot 'server\index.js'

if (-not (Test-Path $entry)) {
  throw "Could not find $entry. Run this script from inside the project."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  throw 'Node.js is not on PATH. Install Node 20+ and try again.'
}

# -WindowStyle Hidden keeps the console off screen; the dashboard is a
# background service you reach through the browser.
$action = New-ScheduledTaskAction `
  -Execute $node `
  -Argument "`"$entry`"" `
  -WorkingDirectory $projectRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -Hidden

$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited          # deliberately not elevated

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Local dashboard for the North AI assistant. Binds to 127.0.0.1 only.' `
  -Force | Out-Null

Write-Host ""
Write-Host "Installed '$TaskName'." -ForegroundColor Green
Write-Host "  It will start at your next logon."
Write-Host "  Start it now:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Remove it:     powershell -File scripts\install-startup.ps1 -Uninstall"
Write-Host ""
