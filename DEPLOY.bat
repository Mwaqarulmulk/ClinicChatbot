@echo off
setlocal
cd /d "%~dp0"

echo Starting Fly.io deployment helper...
echo.
echo To use remote Turso, run:
echo   powershell -ExecutionPolicy Bypass -File deploy.ps1 -UseTurso
echo.

powershell -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
exit /b %errorlevel%
