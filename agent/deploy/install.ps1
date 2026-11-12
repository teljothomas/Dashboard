#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs the TradeX Tally agent as a Windows Service on the Tally PC.

.DESCRIPTION
  Written and reviewed in WP-05.3. NOT executed on the Tally PC in that work package (owner approval and a Tally
  test company are needed first, see docs/TALLY_INTEGRATION.md section 3). Idempotent: running it again repairs the
  service definition, firewall rule and folder permissions but never touches journal.db, identity.json or agent.key.

  Two phases:
    1. Run this script. It copies the build, secures %ProgramData%\TradeXAgent, creates the service (not started),
       blocks inbound access to the Tally port and creates the Event Log source.
    2. Run, elevated:  TradeXAgent.exe register <code> --cloud https://<erp-host>
       then run this script again. Once identity.json and agent.key exist it grants the service account read access
       to the key and starts the service.

  Prerequisite: the .NET 10 Runtime (Microsoft.NETCore.App 10.x) installed machine-wide. The agent is framework
  dependent. Production use also needs the scripts to be Authenticode signed (Phase 14).

.PARAMETER SourceDir
  Folder holding the published agent (TradeXAgent.exe and its files). Default: the folder above this script's 'bin'.

.PARAMETER InstallDir
  Program files location. Default C:\Program Files\TradeXAgent.

.PARAMETER DataDir
  Data location (config, key, identity, journal, logs). Default C:\ProgramData\TradeXAgent. Must match the agent's
  default; the service uses %ProgramData%\TradeXAgent unless TRADEX_AGENT_HOME is set machine-wide.

.PARAMETER ServiceAccount
  Account the service runs as. Default NT AUTHORITY\LocalService (least privilege; no network identity needed
  because the agent talks to the cloud over HTTPS and to Tally on loopback).

.PARAMETER TallyPort
  Tally HTTP port to block for inbound connections (default 9000). Loopback traffic is not filtered by Windows
  Firewall, so the agent still reaches Tally on 127.0.0.1.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$SourceDir = (Join-Path $PSScriptRoot '..\bin\publish'),
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'TradeXAgent'),
  [string]$DataDir = (Join-Path $env:ProgramData 'TradeXAgent'),
  [string]$ServiceAccount = 'NT AUTHORITY\LocalService',
  [ValidateRange(1, 65535)][int]$TallyPort = 9000
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'TradeXAgent'
$FirewallRule = 'TradeX Agent - block inbound Tally port'
$exe = Join-Path $InstallDir 'TradeXAgent.exe'

function Test-DotNetRuntime {
  $runtimes = & dotnet --list-runtimes 2>$null
  return [bool]($runtimes | Where-Object { $_ -match '^Microsoft\.NETCore\.App 10\.' })
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue) -or -not (Test-DotNetRuntime)) {
  throw '.NET 10 Runtime (Microsoft.NETCore.App 10.x) is not installed machine-wide. Install it first.'
}
if (-not (Test-Path (Join-Path $SourceDir 'TradeXAgent.exe'))) {
  throw "TradeXAgent.exe not found in '$SourceDir'. Publish first: dotnet publish agent/src/TradeX.Agent.Service -c Release -o <dir>."
}

# 1. Program files (replaced wholesale; data lives elsewhere).
if ($PSCmdlet.ShouldProcess($InstallDir, 'Copy agent build')) {
  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Path (Join-Path $SourceDir '*') -Destination $InstallDir -Recurse -Force
  # Program files: read and execute for the service account, full control only for SYSTEM and Administrators.
  & icacls.exe $InstallDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "${ServiceAccount}:(OI)(CI)RX" | Out-Null
}

# 2. Data folder: SYSTEM and Administrators full, the service account modify, nobody else. No inheritance.
if ($PSCmdlet.ShouldProcess($DataDir, 'Create and secure data folder')) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  & icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "${ServiceAccount}:(OI)(CI)M" | Out-Null
}

# 3. Event Log source (errors from the agent are written to the Application log).
if ($PSCmdlet.ShouldProcess($ServiceName, 'Create Event Log source')) {
  if (-not [System.Diagnostics.EventLog]::SourceExists($ServiceName)) {
    New-EventLog -LogName Application -Source $ServiceName
  }
}

# 4. Service: delayed automatic start, restart after 1 minute, three times (counter resets after a day).
if ($PSCmdlet.ShouldProcess($ServiceName, 'Create or update service')) {
  $existing = Get-Service $ServiceName -ErrorAction SilentlyContinue
  if ($existing) {
    & sc.exe config $ServiceName binPath= "`"$exe`"" start= delayed-auto obj= $ServiceAccount | Out-Null
  } else {
    & sc.exe create $ServiceName binPath= "`"$exe`"" start= delayed-auto obj= $ServiceAccount DisplayName= 'TradeX Tally Agent' | Out-Null
  }
  & sc.exe description $ServiceName 'Connects the TradeX ERP to the local TallyPrime (read and verified posting). Loopback to Tally only.' | Out-Null
  & sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
  & sc.exe failureflag $ServiceName 1 | Out-Null   # also restart when the process exits with a non-zero code
}

# 5. Firewall: block inbound connections to the Tally port from other machines (never expose Tally, SECURITY section 1).
if ($PSCmdlet.ShouldProcess($FirewallRule, 'Create firewall rule')) {
  Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Action Block -Protocol TCP -LocalPort $TallyPort -Profile Any | Out-Null
}

# 6. Second phase: once registered, give the service account read access to the key and start.
$identity = Join-Path $DataDir 'identity.json'
$key = Join-Path $DataDir 'agent.key'
if ((Test-Path $identity) -and (Test-Path $key)) {
  if ($PSCmdlet.ShouldProcess($key, 'Grant service account read access and start service')) {
    & icacls.exe $key /grant "${ServiceAccount}:R" | Out-Null
    Start-Service $ServiceName
    Write-Host "Service $ServiceName started. Check: `"$exe`" status"
  }
} else {
  Write-Host 'Installed, service not started. Next, in an elevated prompt:'
  Write-Host "  `"$exe`" register <code> --cloud https://<erp-host>"
  Write-Host '  then run this script again.'
}
