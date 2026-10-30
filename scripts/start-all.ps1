<#
.SYNOPSIS
  Builds and starts the complete Async File Server application on Windows + WSL.

.DESCRIPTION
  1. Compiles the C backend inside WSL (make).
  2. Installs bridge / frontend npm dependencies if missing.
  3. Builds the dashboard (unless -Dev).
  4. Starts, each in its own window:
       - C server       (WSL, port 8080)
       - bridge         (Node, port 7070, serves the built dashboard)
       - Vite dev server (port 5173, only with -Dev)
  5. Waits until the backend is online and opens the dashboard.

.EXAMPLE
  .\scripts\start-all.ps1
  .\scripts\start-all.ps1 -IoDelayMs 300      # visible queueing for demos
  .\scripts\start-all.ps1 -Dev                # hot-reloading frontend on :5173
#>
param(
  [int]$IoDelayMs = 0,
  [switch]$Dev,
  [switch]$Rebuild,
  [string]$Distro = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$wslArgs = @()
if ($Distro) { $wslArgs = @('-d', $Distro) }

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

# ---------------------------------------------------------------- C backend
Step 'Compiling C backend in WSL'
# D:\OS_Project\backend -> /mnt/d/OS_Project/backend (default WSL automount)
$full = (Resolve-Path "$root\backend").Path
$wslBackend = '/mnt/' + $full.Substring(0, 1).ToLower() + ($full.Substring(2) -replace '\\', '/')
& wsl @wslArgs --cd $wslBackend -- make
if ($LASTEXITCODE -ne 0) { throw 'C build failed (is gcc/make installed in WSL? sudo apt install build-essential)' }

# ---------------------------------------------------------------- npm deps
foreach ($dir in 'bridge', 'frontend') {
  if (-not (Test-Path "$root\$dir\node_modules")) {
    Step "Installing $dir dependencies"
    Push-Location "$root\$dir"; npm install --no-fund --no-audit; Pop-Location
  }
}

if (-not $Dev -and ($Rebuild -or -not (Test-Path "$root\frontend\dist\index.html"))) {
  Step 'Building dashboard'
  Push-Location "$root\frontend"; npm run build; Pop-Location
}

# ---------------------------------------------------------------- start
$serverArgs = if ($IoDelayMs -gt 0) { "--io-delay-ms $IoDelayMs" } else { '' }
$distroFlag = if ($Distro) { "-d $Distro " } else { '' }

Step 'Starting C server (WSL, port 8080)'
Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle='AFS C server'; wsl $distroFlag--cd $wslBackend -- ./server $serverArgs"

Step 'Starting bridge (port 7070)'
Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle='AFS bridge'; cd '$root\bridge'; node src/index.js"

$url = 'http://127.0.0.1:7070'
if ($Dev) {
  Step 'Starting Vite dev server (port 5173)'
  Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle='AFS dashboard (vite)'; cd '$root\frontend'; npm run dev"
  $url = 'http://127.0.0.1:5173'
}

Step 'Waiting for the backend to come online'
$online = $false
for ($i = 0; $i -lt 40 -and -not $online; $i++) {
  Start-Sleep -Milliseconds 500
  try { $online = (Invoke-RestMethod 'http://127.0.0.1:7070/api/status' -TimeoutSec 2).backend.online } catch { }
}

if ($online) { Write-Host 'Backend online.' -ForegroundColor Green }
else { Write-Host 'Backend not online yet - check the "AFS C server" window.' -ForegroundColor Yellow }

Write-Host "Dashboard: $url" -ForegroundColor Green
Start-Process $url
