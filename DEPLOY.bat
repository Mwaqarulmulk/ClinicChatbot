@echo off
setlocal enabledelayedexpansion

echo ============================================
echo   WhatsApp Chatbot - Auto Deploy
echo ============================================
echo.
echo  NEVER hardcode API keys in this script.
echo  Keys are prompted or generated at runtime.
echo ============================================
echo.

REM Check for admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Please run as Administrator
    pause
    exit /b 1
)

REM Install Fly CLI
echo [1/5] Checking Fly CLI...
where fly >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing Fly CLI...
    powershell -Command "& {iwr https://fly.io/install.ps1 -UseBasicParsing | iex}"
)

REM Navigate to project directory
set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

REM Login to Fly (will prompt)
echo.
echo [2/5] Please login to Fly.io...
call fly auth login

REM Create app
echo.
echo [3/5] Creating Fly app (skipped if already exists)...
call fly apps create clinicchatbot --org personal 2>nul
echo   App created or already exists.

REM Create volume
echo.
echo [4/5] Creating data volume (skipped if already exists)...
call fly volumes create chatbot_data --size 3 --region ams 2>nul
echo   Volume created or already exists.

REM Set secrets — NO hardcoded values allowed
echo.
echo [5/5] Setting production secrets...

REM Prompt for Groq API key (get a free key at https://console.groq.com)
set /p GROQ_KEY="Enter your GROQ_API_KEY: "
if "!GROQ_KEY!"=="" (
    echo ERROR: GROQ_API_KEY cannot be empty.
    pause
    exit /b 1
)
call fly secrets set GROQ_API_KEY=!GROQ_KEY!

REM Generate a random admin key using PowerShell crypto — never a fixed string
for /f "delims=" %%K in ('powershell -Command "[Convert]::ToBase64String((New-Object Byte[] 32 | %% { [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($_); $_ }))"') do (
    set "ADMIN_KEY=%%K"
)

REM Fallback: use a timestamp-based random if PowerShell unavailable
if "!ADMIN_KEY!"=="" (
    set "ADMIN_KEY=auto-%RANDOM%-%RANDOM%-%RANDOM%"
)

call fly secrets set ADMIN_API_KEY=!ADMIN_KEY!
echo   ADMIN_API_KEY set. Save this value: !ADMIN_KEY!

REM Deploy
echo.
echo ============================================
echo   Deploying to production...
echo ============================================
call fly deploy

echo.
echo ============================================
echo   DEPLOYMENT COMPLETE!
echo ============================================
echo.
echo App URL: https://clinicchatbot.fly.dev
echo.
echo Next step: run  fly logs  and scan the QR code with your phone.
echo.

pause
