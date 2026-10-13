$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Установите Node.js 20+: https://nodejs.org/' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm не найден. Переустановите Node.js.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Warning 'Git не найден: автообновление будет недоступно.' }
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw 'Нужен Node.js 20 или новее.' }

Write-Host 'Установка библиотек...'
& npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить библиотеки.' }
Write-Host 'Сборка приложения...'
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать приложение.' }

$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$link = $ws.CreateShortcut((Join-Path $desktop 'JBD BMS.lnk'))
$link.TargetPath = (Join-Path $PSScriptRoot 'run-windows.cmd')
$link.WorkingDirectory = $PSScriptRoot
$link.IconLocation = (Join-Path $PSScriptRoot 'public\favicon.png')
$link.Description = 'Диагностика и настройка аккумулятора JBD BMS'
$link.Save()

Write-Host 'Готово. Создан ярлык «JBD BMS» на рабочем столе.' -ForegroundColor Green
& (Join-Path $PSScriptRoot 'run-windows.cmd')
