# North Command Center - persistent Windows probe worker.
#
# Spawned once and kept alive. Reads one JSON request per line from stdin and
# writes exactly one JSON response line to stdout.
#
# Why persistent: a fresh `powershell.exe` costs 200-400ms of startup, and the
# Add-Type below pays a C# compile on top of that. Polling every few seconds
# through a short-lived process would burn measurable CPU forever. A long-lived
# host makes each probe a few milliseconds.
#
# Everything here is read-only except the explicitly-gated `open`/`focus`/
# `close` operations.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Win32 calls for foreground-window detection and window focus.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NorthWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@

# Processes we never list and never act on. These are OS integrity and
# security components: showing them adds no insight and inviting a "close"
# button next to them would be actively hostile.
$Script:Protected = @(
  'system','idle','registry','smss','csrss','wininit','winlogon','services','lsass',
  'lsaiso','fontdrvhost','dwm','sihost','ctfmon','audiodg','svchost','spoolsv',
  'securityhealthservice','securityhealthsystray','msmpeng','nissrv','mpdefendercoreservice',
  'wudfhost','dllhost','conhost','taskhostw','runtimebroker','searchindexer',
  'memory compression','wsmprovhost','trustedinstaller','tiworker'
)

function Test-Protected([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return $true }
  return $Script:Protected -contains $name.ToLowerInvariant()
}

function Get-SystemSnapshot {
  $os = Get-CimInstance Win32_OperatingSystem

  # PerfFormattedData is far cheaper than Get-Counter, which blocks ~1s for a
  # sampling interval.
  $cpuPct = $null
  try {
    $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
    if ($cpu) { $cpuPct = [double]$cpu.PercentProcessorTime }
  } catch { $cpuPct = $null }

  $totalKb = [double]$os.TotalVisibleMemorySize
  $freeKb  = [double]$os.FreePhysicalMemory

  $disks = @()
  try {
    foreach ($d in Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3') {
      if ($null -eq $d.Size -or $d.Size -eq 0) { continue }
      $disks += [ordered]@{
        drive      = $d.DeviceID
        label      = $d.VolumeName
        totalBytes = [double]$d.Size
        freeBytes  = [double]$d.FreeSpace
      }
    }
  } catch {}

  # Absent on desktops. Null means "no battery", not "unknown".
  $battery = $null
  try {
    $b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($b) {
      $battery = [ordered]@{
        percent           = $b.EstimatedChargeRemaining
        # 2 = on AC power.
        charging          = ($b.BatteryStatus -eq 2)
        status            = $b.BatteryStatus
        runtimeMinutes    = if ($b.EstimatedRunTime -and $b.EstimatedRunTime -lt 71582788) { $b.EstimatedRunTime } else { $null }
      }
    }
  } catch {}

  $net = @()
  try {
    foreach ($a in Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' }) {
      $net += [ordered]@{
        name      = $a.Name
        type      = $a.MediaType
        linkMbps  = if ($a.LinkSpeed) { $a.LinkSpeed } else { $null }
        mac       = $null   # deliberately omitted: hardware identifier, no diagnostic value here
      }
    }
  } catch {}

  return [ordered]@{
    host        = $env:COMPUTERNAME
    os          = $os.Caption
    osVersion   = $os.Version
    cpuPercent  = $cpuPct
    cpuCount    = [int]$env:NUMBER_OF_PROCESSORS
    memory      = [ordered]@{
      totalBytes = $totalKb * 1024
      freeBytes  = $freeKb * 1024
      usedBytes  = ($totalKb - $freeKb) * 1024
    }
    disks       = $disks
    battery     = $battery
    network     = [ordered]@{
      online   = (Get-NetConnectionProfile -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
      adapters = $net
    }
    bootTime    = $os.LastBootUpTime.ToUniversalTime().ToString('o')
    uptimeMs    = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalMilliseconds)
  }
}

function Get-AppSnapshot {
  $fgPid = 0
  $fgTitle = $null
  try {
    $h = [NorthWin]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) {
      [void][NorthWin]::GetWindowThreadProcessId($h, [ref]$fgPid)
    }
  } catch {}

  $windowed = @()
  $active = $null

  foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
    $name = $p.ProcessName
    if (Test-Protected $name) { continue }
    $title = $p.MainWindowTitle
    if ([string]::IsNullOrWhiteSpace($title)) { continue }

    $entry = [ordered]@{
      pid         = $p.Id
      name        = $name
      title       = $title
      memoryBytes = [double]$p.WorkingSet64
      startedAt   = $(try { $p.StartTime.ToUniversalTime().ToString('o') } catch { $null })
      isActive    = ($p.Id -eq $fgPid)
    }
    $windowed += $entry
    if ($entry.isActive) { $active = $entry }
  }

  # Top memory consumers, including non-windowed ones, minus protected names.
  # This is what answers "what is using the most memory?".
  $heavy = @()
  foreach ($p in (Get-Process -ErrorAction SilentlyContinue |
                  Where-Object { -not (Test-Protected $_.ProcessName) } |
                  Sort-Object WorkingSet64 -Descending |
                  Select-Object -First 12)) {
    $heavy += [ordered]@{
      pid         = $p.Id
      name        = $p.ProcessName
      memoryBytes = [double]$p.WorkingSet64
      cpuSeconds  = $(try { [math]::Round($p.CPU, 1) } catch { $null })
      hasWindow   = -not [string]::IsNullOrWhiteSpace($p.MainWindowTitle)
    }
  }

  return [ordered]@{
    activeWindow = $active
    windowed     = ($windowed | Sort-Object { $_.name })
    topMemory    = $heavy
    windowCount  = $windowed.Count
  }
}

function Invoke-AppAction($op, $params) {
  $target = $params.target
  switch ($op) {
    'open' {
      if ([string]::IsNullOrWhiteSpace($target)) { throw 'No target supplied.' }
      # Start-Process resolves PATH entries, registered app names and URIs.
      Start-Process -FilePath $target -ErrorAction Stop
      return @{ opened = $target }
    }
    'focus' {
      $p = Get-Process -Id ([int]$params.pid) -ErrorAction Stop
      if (Test-Protected $p.ProcessName) { throw "Refusing to act on protected process '$($p.ProcessName)'." }
      if ($p.MainWindowHandle -eq [IntPtr]::Zero) { throw 'That process has no window to focus.' }
      if ([NorthWin]::IsIconic($p.MainWindowHandle)) { [void][NorthWin]::ShowWindow($p.MainWindowHandle, 9) }
      [void][NorthWin]::SetForegroundWindow($p.MainWindowHandle)
      return @{ focused = $p.Id }
    }
    'close' {
      $p = Get-Process -Id ([int]$params.pid) -ErrorAction Stop
      if (Test-Protected $p.ProcessName) { throw "Refusing to act on protected process '$($p.ProcessName)'." }
      # CloseMainWindow is the polite request the title-bar X sends, so the app
      # can prompt to save. We never escalate to Stop-Process.
      if (-not $p.CloseMainWindow()) { throw 'The application did not accept a close request.' }
      return @{ closed = $p.Id }
    }
    default { throw "Unknown operation '$op'." }
  }
}

# ---- request loop ----------------------------------------------------------
# One JSON object in, one JSON object out, newline delimited.

[Console]::Out.WriteLine('{"ready":true}')

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }          # stdin closed: parent is gone
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $data = switch ($req.op) {
      'snapshot' { Get-SystemSnapshot }
      'apps'     { Get-AppSnapshot }
      'all'      { [ordered]@{ system = (Get-SystemSnapshot); apps = (Get-AppSnapshot) } }
      'ping'     { @{ pong = $true } }
      default    { Invoke-AppAction $req.op $req.params }
    }
    $payload = [ordered]@{ id = $id; ok = $true; data = $data }
  } catch {
    $payload = [ordered]@{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 8))
}
