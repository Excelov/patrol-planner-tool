$ErrorActionPreference = 'Stop'
$iss = Get-Content (Join-Path $PSScriptRoot '..\release\installer\patrol-planner.iss') -Raw
foreach ($token in @('AppVersion={#AppVersion}','DefaultDirName=','PrivilegesRequired=lowest','[UninstallDelete]','patrol-planner.exe','LICENSE.txt')) {
  if ($iss -notmatch [regex]::Escape($token)) { throw "Inno Setup 脚本缺少配置: $token" }
}
Write-Output 'installer-script-static-check=passed'
