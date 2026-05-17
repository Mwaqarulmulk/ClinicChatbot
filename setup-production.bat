@echo off
setlocal
cd /d "%~dp0"

echo Production setup is handled by deploy.ps1.
echo.
echo Default Fly volume SQLite:
echo   powershell -ExecutionPolicy Bypass -File deploy.ps1
echo.
echo Remote Turso:
echo   powershell -ExecutionPolicy Bypass -File deploy.ps1 -UseTurso
echo.

powershell -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
exit /b %errorlevel%
