#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Removes the TradeX Tally agent service. Written in WP-05.3, not executed on the Tally PC in that work package.

.DESCRIPTION
  Stops and deletes the service, the firewall rule and the Event Log source, then removes the program files. The data
  folder (identity, private key, journal, logs) is KEPT unless -RemoveData is given: the journal may hold posts that
  are not yet reconciled (TALLY_INTEGRATION section 7). Before removing data the script refuses if the journal still has
  pending posts, unless -Force is also given. Revoke the agent in the ERP afterwards (Tally status > agents).

.PARAMETER RemoveData
  Also delete %ProgramData%\TradeXAgent (including agent.key and journal.db). Cannot be undone.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'TradeXAgent'),
  [string]$DataDir = (Join-Path $env:ProgramData 'TradeXAgent'),
  [switch]$RemoveData,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'TradeXAgent'
$FirewallRule = 'TradeX Agent - block inbound Tally port'
$exe = Join-Path $InstallDir 'TradeXAgent.exe'

if ($RemoveData -and -not $Force -and (Test-Path $exe)) {
  $status = & $exe status 2>&1 | Out-String
  if ($status -match 'pending\s+([1-9]\d*)') {
    throw "The journal has pending entries. Let the agent reconcile them (or pass -Force to discard).`n$status"
  }
}

if ($PSCmdlet.ShouldProcess($ServiceName, 'Stop and delete service')) {
  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $ServiceName | Out-Null
  }
}
if ($PSCmdlet.ShouldProcess($FirewallRule, 'Remove firewall rule')) {
  Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}
if ($PSCmdlet.ShouldProcess($ServiceName, 'Remove Event Log source')) {
  if ([System.Diagnostics.EventLog]::SourceExists($ServiceName)) {
    Remove-EventLog -Source $ServiceName
  }
}
if ($PSCmdlet.ShouldProcess($InstallDir, 'Remove program files')) {
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
}
if ($RemoveData) {
  if ($PSCmdlet.ShouldProcess($DataDir, 'DELETE data folder including the private key and journal')) {
    if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }
  }
} else {
  Write-Host "Data kept in $DataDir (identity, key, journal, logs). Use -RemoveData to delete it."
}
