param(
  [string]$Zip = (Join-Path $PSScriptRoot '..\release\patrol-planner-v0.4.0-beta.1-portable.zip'),
  [string]$Sums = (Join-Path $PSScriptRoot '..\release\SHA256SUMS-v0.4.0-beta.1.txt')
)
$ErrorActionPreference = 'Stop'
foreach ($p in @($Zip, $Sums)) { if (-not (Test-Path -LiteralPath $p)) { throw "找不到发布文件: $p" } }
$lines = Get-Content -LiteralPath $Sums
foreach ($line in $lines) {
  if ($line -match '^([0-9a-fA-F]{64})\s+(.+)$') {
    $path = $Matches[2].Trim(); if (-not (Test-Path -LiteralPath $path)) { throw "校验目标不存在: $path" }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Matches[1].ToLowerInvariant()) { throw "SHA256 不匹配: $path" }
  }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Zip))
try {
  $names = @($archive.Entries | ForEach-Object Name)
  foreach ($required in @('patrol-planner.exe','README.md','CHANGELOG.md','VERSION.json','LICENSE.txt')) {
    if ($names -notcontains $required) { throw "ZIP 缺少必需文件: $required" }
  }
} finally { $archive.Dispose() }
Write-Output 'release-integrity-ok'
