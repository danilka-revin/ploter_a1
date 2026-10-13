$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$python = Get-Command py -ErrorAction SilentlyContinue
if ($python) { & py -3 -m venv .venv } elseif (Get-Command python -ErrorAction SilentlyContinue) { & python -m venv .venv } else { throw 'Установите Python 3.10+: https://www.python.org/downloads/windows/' }
if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать виртуальное окружение Python.' }

& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить библиотеки.' }

$ws = New-Object -ComObject WScript.Shell
$link = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'JBD BMS Python.lnk'))
$link.TargetPath = (Join-Path $PSScriptRoot 'run-windows.cmd')
$link.WorkingDirectory = $PSScriptRoot
$link.Description = 'Настольное приложение JBD BMS'
$link.Save()
Write-Host 'Готово. Создан ярлык «JBD BMS Python».' -ForegroundColor Green
& (Join-Path $PSScriptRoot 'run-windows.cmd')
