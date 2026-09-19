param(
  [string]$Zip = 'release/patrol-planner-v0.4.0-beta.1-source.zip'
)
$ErrorActionPreference = 'Stop'
$sourcePath = Resolve-Path -LiteralPath $Zip -ErrorAction SilentlyContinue
$source = if ($sourcePath) { $sourcePath.Path } else { $null }
$original = (Get-Location).Path
if (-not $source) {
  node --test frontend/patrol-planner/test_geometry.mjs
  Push-Location frontend/patrol-planner
  python -m unittest -q test_server.py
  Pop-Location
  Write-Output 'public-bundle-verification=source-tree'
  exit 0
}
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('patrol-planner-public-' + [guid]::NewGuid().ToString('N'))
$entered = $false
try {
  Expand-Archive -LiteralPath $source -DestinationPath $stage
  Push-Location $stage
  $entered = $true
  foreach ($required in @('LICENSE.txt','data/gis/route5_scope/route5_scoped_pipeline_segments.csv','vendor/pig-ui/public/data/gis/dxf_pipeline_display_lines.geojson')) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Public bundle missing required file: $required" }
  }
  node --test frontend/patrol-planner/test_geometry.mjs
  Push-Location frontend/patrol-planner
  python -m unittest -q test_server.py
  Pop-Location
  Pop-Location
  Write-Output 'public-bundle-verification=passed'
} finally {
  if ($entered) { Set-Location $original }
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
