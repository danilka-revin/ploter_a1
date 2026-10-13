$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Require-Command($Name, $Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name не найден. $Hint"
    }
}

Require-Command 'node' 'Установите Node.js 20 или новее: https://nodejs.org/'
Require-Command 'npm.cmd' 'Переустановите Node.js вместе с npm.'

$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw 'Нужен Node.js 20 или новее.' }

if (-not (Test-Path 'node_modules')) {
    Write-Host 'Установка библиотек...'
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci завершился с ошибкой.' }
}
if (-not (Test-Path 'dist\index.html')) {
    Write-Host 'Сборка приложения...'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Сборка завершилась с ошибкой.' }
}

if (-not $env:BMS_APP_PORT) { $env:BMS_APP_PORT = '8585' }
$url = "http://127.0.0.1:$($env:BMS_APP_PORT)"
Write-Host "JBD BMS запущен: $url"
Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 2; Start-Process $u } -ArgumentList $url | Out-Null

do {
    & node 'scripts/server.mjs'
    $code = $LASTEXITCODE
    if ($code -eq 10) { Write-Host 'Перезапуск после обновления...' }
} while ($code -eq 10)
exit $code
