param([string]$Root = (Join-Path $PSScriptRoot '..'))
$ErrorActionPreference = 'Stop'
$patterns = @('BEGIN (RSA|OPENSSH|EC) PRIVATE KEY','AMAP_WEBSERVICE_KEY\s*=\s*[^$\s#]','VITE_AMAP_WEB_JS_KEY\s*=\s*[^$\s#]')
$publicPaths = @('frontend/patrol-planner','release/patrol-planner-v0.4.0-beta.1','scripts','docs','.github') | ForEach-Object { Join-Path $Root $_ }
$hits = rg -n --hidden -g '!*\.dxf' -g '!*\.dwg' ($patterns -join '|') $publicPaths 2>$null
if ($LASTEXITCODE -eq 0 -and $hits) { throw "发现疑似密钥或私钥：`n$($hits -join "`n")" }
Write-Output 'release-secret-scan=clean'
