param(
  [string]$Exe = (Join-Path $PSScriptRoot '..\dist\patrol-planner.exe'),
  [int]$Port = 8799
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Exe)) { throw "EXE not found: $Exe" }
$proc = Start-Process -FilePath $Exe -ArgumentList @('--port', "$Port") -PassThru
try {
  $base = "http://127.0.0.1:$Port"
  $ok = $false
  for ($i = 0; $i -lt 20; $i++) {
    try { $cfg = Invoke-RestMethod "$base/api/config" -TimeoutSec 2; $ok = $true; break } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $ok) { throw 'EXE config endpoint did not respond' }
  if (-not $cfg.token) { throw 'Config endpoint did not return page token' }
  $index = Invoke-WebRequest "$base/" -UseBasicParsing -TimeoutSec 5
  if ($index.StatusCode -ne 200) { throw 'Static page check failed' }
  foreach ($control in @('import-crs','import-zone','import-meridian')) {
    if ($index.Content -notmatch ('id="' + $control + '"')) { throw "Static page missing coordinate control: $control" }
  }
  Write-Output ("portable-start-ok port={0} routingConfigured={1} coordinateControls=ok" -f $Port, $cfg.routingConfigured)
}
finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
