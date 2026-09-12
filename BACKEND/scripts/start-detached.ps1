$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$healthUrl = "http://127.0.0.1:4242/health"

try {
  $health = Invoke-RestMethod $healthUrl -TimeoutSec 2
  Write-Output "Manager already running on 127.0.0.1:4242 pid=$($health.pid)"
  exit 0
} catch {
}

Start-Process -FilePath "node" -ArgumentList @("dist\index.js") -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Seconds 2

try {
  $health = Invoke-RestMethod $healthUrl -TimeoutSec 5
  Write-Output "Manager started on 127.0.0.1:4242 pid=$($health.pid)"
} catch {
  Write-Error "Manager did not start. Run 'node dist\index.js' inside BACKEND to see the startup error."
}
