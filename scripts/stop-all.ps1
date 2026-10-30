<#
.SYNOPSIS
  Stops the C server (graceful SIGINT, prints the performance summary),
  the bridge and the Vite dev server of this project.
#>
param([string]$Distro = '')

$wslArgs = @()
if ($Distro) { $wslArgs = @('-d', $Distro) }

& wsl @wslArgs -- pkill -INT -x server
if ($LASTEXITCODE -eq 0) { Write-Host 'C server stopped.' } else { Write-Host 'C server was not running.' }

# Only stop node processes started from this project (bridge / vite),
# never unrelated programs that happen to listen on the same ports.
$root = Split-Path -Parent $PSScriptRoot
$bridgeDir = Join-Path $root 'bridge'
$frontendDir = Join-Path $root 'frontend'

$candidates = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine }

foreach ($proc in $candidates) {
  $cmd = $proc.CommandLine
  $isBridge = $cmd -match 'src[\\/]index\.js' -and (
    $cmd -like "*$bridgeDir*" -or
    (Get-NetTCPConnection -OwningProcess $proc.ProcessId -LocalPort 7070 -State Listen -ErrorAction SilentlyContinue)
  )
  $isVite = $cmd -like "*$frontendDir*" -and $cmd -match 'vite'

  if ($isBridge -or $isVite) {
    Stop-Process -Id $proc.ProcessId -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Stopped $($proc.ProcessId): $cmd"
  }
}
