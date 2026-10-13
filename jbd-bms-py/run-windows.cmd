@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Приложение не установлено. Сначала запустите install-windows.cmd
  pause
  exit /b 1
)
:run
".venv\Scripts\python.exe" -m jbd_bms %*
set CODE=%ERRORLEVEL%
if "%CODE%"=="10" goto run
if not "%CODE%"=="0" pause
exit /b %CODE%
