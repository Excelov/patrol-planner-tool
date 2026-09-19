$ErrorActionPreference = 'Stop'
Write-Output '== geometry tests =='
node --test frontend/patrol-planner/test_geometry.mjs
Write-Output '== server tests =='
Push-Location (Join-Path $PSScriptRoot '..\frontend\patrol-planner')
python -m unittest -v test_server.py
Pop-Location
Write-Output '== frozen DXF import =='
python (Join-Path $PSScriptRoot 'verify_frozen_dxf.py')
Write-Output '== portable runtime =='
& (Join-Path $PSScriptRoot 'verify_portable.ps1')
Write-Output '== release integrity =='
& (Join-Path $PSScriptRoot 'verify_release.ps1')
Write-Output '== release secrets =='
& (Join-Path $PSScriptRoot 'verify_release_secrets.ps1')
Write-Output 'beta-verification=passed'
