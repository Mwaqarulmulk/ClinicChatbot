@echo off
REM WhatsApp Chatbot - Quick Setup for Production
REM Run this in Command Prompt (not PowerShell)
REM
REM  NEVER hardcode API keys in this file.
REM  Keys are prompted at runtime.

echo ====================================
echo WhatsApp Chatbot - Production Setup
echo ====================================

REM Install Fly CLI
echo.
echo [1/4] Checking Fly CLI...
where fly >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing Fly CLI...
    powershell -Command "Invoke-WebRequest -Uri https://fly.io/install.ps1 -UseBasicParsing | Invoke-Expression"
)

REM Login
echo.
echo [2/4] Login to Fly.io...
fly auth login

REM Create app and volume
echo.
echo [3/4] Creating app and volume...
cd /d "%~dp0"
fly apps create clinicchatbot --org personal 2>nul
fly volumes create chatbot_data --size 3 --region ams 2>nul

REM Set secrets (prompted - never hardcoded)
echo.
echo [4/4] Setting secrets...
set /p GROQ_KEY="Enter your GROQ_API_KEY (from https://console.groq.com): "
if "%GROQ_KEY%"=="" (
    echo ERROR: GROQ_API_KEY is required.
    pause
    exit /b 1
)
fly secrets set GROQ_API_KEY=%GROQ_KEY%

REM Generate a cryptographically random admin key
for /f "delims=" %%K in ('powershell -Command "[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))"') do set ADMIN_KEY=%%K
fly secrets set ADMIN_API_KEY=%ADMIN_KEY%
echo Admin key set: %ADMIN_KEY%

REM Deploy
echo.
echo Deploying...
fly deploy

echo.
echo ====================================
echo Done! Bot deployed at:
echo https://clinicchatbot.fly.dev
echo.
echo Next: run  fly logs  and scan the QR
echo code with WhatsApp to connect.
echo ====================================
pause
