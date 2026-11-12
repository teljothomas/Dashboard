#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Upgrades the TradeX Tally agent in place. Written in WP-05.3, not executed on the Tally PC in that work package.

.DESCRIPTION
  Stops the service, keeps a copy of the current program files, copies the new build over them, checks that the new
  executable runs, and starts the service again. If the new build does not answer `version`, the old files are put back.
  Data (identity, key, journal, config) is never touched; the journal schema migrates on start and a journal that is
  newer than the agent is refused, so a downgrade cannot corrupt it.

.PARAMETER SourceDir
  Folder with the new published build.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'TradeXAgent')
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'TradeXAgent'
$exe = Join-Path $InstallDir 'TradeXAgent.exe'

if (-not (Test-Path (Join-Path $SourceDir 'TradeXAgent.exe'))) { throw "No TradeXAgent.exe in '$SourceDir'." }
if (-not (Get-Service $ServiceName -ErrorAction SilentlyContinue)) { throw 'The service is not installed. Run install.ps1.' }

$backup = "$InstallDir.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
if ($PSCmdlet.ShouldProcess($InstallDir, "Upgrade (backup: $backup)")) {
  Stop-Service $ServiceName -Force
  Copy-Item -Path $InstallDir -Destination $backup -Recurse
  try {
    Copy-Item -Path (Join-Path $SourceDir '*') -Destination $InstallDir -Recurse -Force
    $version = & $exe version
    if ($LASTEXITCODE -ne 0 -or -not $version) { throw 'The new build did not report a version.' }
    Start-Service $ServiceName
    Write-Host "Upgraded to $version. Previous files kept in $backup."
  } catch {
    Write-Warning "Upgrade failed: $_. Restoring the previous files."
    Remove-Item -Recurse -Force $InstallDir
    Copy-Item -Path $backup -Destination $InstallDir -Recurse
    Start-Service $ServiceName
    throw
  }
}
