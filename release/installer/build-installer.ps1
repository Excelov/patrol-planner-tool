# Build the Windows installer with Inno Setup 6.
$baseDir = (Get-Location).Path + '\release\installer'
$scriptPath = $baseDir + '\patrol-planner.iss'
$versionFile = $baseDir + '\..\patrol-planner-v0.4.0-beta.1\VERSION.json'
$version = '0.4.0-beta.1'
if (Test-Path -LiteralPath $versionFile) {
  try { $version = (Get-Content -LiteralPath $versionFile -Raw -Encoding utf8 | ConvertFrom-Json).version } catch { throw 'VERSION.json parse failed' }
}
$compilerPath = $null
$command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if ($command) { $compilerPath = [string]$command.Source }
if (-not $compilerPath) {
  $candidates = @(
    ($env:ProgramFiles + '\Inno Setup 6\ISCC.exe'),
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    ($env:LOCALAPPDATA + '\Programs\Inno Setup 6\ISCC.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { $compilerPath = [string]$candidate; break }
  }
}
if (-not $compilerPath) { throw 'ISCC.exe not found; install Inno Setup 6 and retry' }
& $compilerPath "/DAppVersion=$version" "$scriptPath"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed: $LASTEXITCODE" }
$setup = (Join-Path $baseDir "..\patrol-planner-$version-setup.exe")
if (-not (Test-Path -LiteralPath $setup)) { throw "Installer was not generated: $setup" }
$hash = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLower()
$hashFile = Join-Path $baseDir "..\SHA256SUMS-$version-setup.txt"
Set-Content -LiteralPath $hashFile -Encoding ascii -Value "$hash  release/patrol-planner-$version-setup.exe"
Write-Output "installer-created=$setup"
Write-Output "installer-sha256=$hash"
