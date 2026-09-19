param([int]$Port = 8787, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$PlannerRoot = Split-Path -Parent $PSScriptRoot
$PlannerScript = Join-Path $PlannerRoot 'frontend\patrol-planner\server.py'
$PlannerPython = (Get-Command python -ErrorAction Stop).Source
$PlannerLog = Join-Path $PlannerRoot 'logs'
$PlannerUrl = "http://127.0.0.1:$Port"
New-Item -ItemType Directory -Force -Path $PlannerLog | Out-Null
$PlannerListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($PlannerListening) {
    try {
        $PlannerResponse = Invoke-RestMethod "$PlannerUrl/api/config" -TimeoutSec 3
        if (-not $PlannerResponse.token) { throw 'Unexpected service' }
    } catch { throw "Port $Port is occupied by another service. Use -Port to choose another port." }
} else {
    Start-Process -FilePath $PlannerPython -ArgumentList @('"' + $PlannerScript + '"', '--port', "$Port") -WorkingDirectory $PlannerRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PlannerLog "patrol-planner-$Port.out.log") -RedirectStandardError (Join-Path $PlannerLog "patrol-planner-$Port.err.log")
    $PlannerReady = $false
    for ($PlannerAttempt = 0; $PlannerAttempt -lt 20; $PlannerAttempt++) {
        Start-Sleep -Milliseconds 250
        try { $null = Invoke-RestMethod "$PlannerUrl/api/config" -TimeoutSec 1; $PlannerReady = $true; break } catch {}
    }
    if (-not $PlannerReady) { throw "Planner failed to start. Check logs/patrol-planner-$Port.err.log" }
}
Write-Output "Patrol planner: $PlannerUrl"
if (-not $NoBrowser) { Start-Process $PlannerUrl }
