# WhatsApp Chatbot - Production Deployment Script
# Run this on Windows using PowerShell
#
# ⚠️  NEVER hardcode API keys in this file. Always generate or prompt for them.
# ──────────────────────────────────────────────────────────────────────────────

Write-Host "=== WhatsApp Chatbot Production Deployment ===" -ForegroundColor Cyan

# ── 1. Check Fly CLI ──────────────────────────────────────────────────────────
Write-Host "`n[1/7] Checking Fly CLI..." -ForegroundColor Yellow
$flyInstalled = Get-Command fly -ErrorAction SilentlyContinue
if (-not $flyInstalled) {
    Write-Host "Installing Fly CLI..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri https://fly.io/install.ps1 -UseBasicParsing | Invoke-Expression
}

# ── 2. Login ──────────────────────────────────────────────────────────────────
Write-Host "`n[2/7] Login to Fly.io..." -ForegroundColor Yellow
fly auth login

# ── 3. Navigate to project ────────────────────────────────────────────────────
Set-Location -Path $PSScriptRoot

# ── 4. Create Fly app (idempotent) ────────────────────────────────────────────
Write-Host "`n[3/7] Creating Fly app (skipped if it already exists)..." -ForegroundColor Yellow
fly apps create clinicchatbot 2>$null

# ── 5. Create volume (idempotent) ─────────────────────────────────────────────
Write-Host "`n[4/7] Creating persistent data volume..." -ForegroundColor Yellow
fly volumes create chatbot_data --size 3 --region ams 2>$null

# ── 6. Set secrets ────────────────────────────────────────────────────────────
Write-Host "`n[5/7] Setting production secrets..." -ForegroundColor Yellow

# Groq API Key — get a free key at https://console.groq.com
$groqKey = Read-Host "Enter your GROQ_API_KEY"
if ([string]::IsNullOrWhiteSpace($groqKey)) {
    Write-Host "ERROR: GROQ_API_KEY cannot be empty." -ForegroundColor Red
    exit 1
}
fly secrets set GROQ_API_KEY=$groqKey

# Admin API Key — generated securely at deploy time; never hardcoded
$adminKeyBytes = New-Object Byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($adminKeyBytes)
$adminKey = [Convert]::ToBase64String($adminKeyBytes)
fly secrets set ADMIN_API_KEY=$adminKey
Write-Host "Admin API Key set (save this): $adminKey" -ForegroundColor Green

# ── 7. Optional: Turso database ───────────────────────────────────────────────
Write-Host "`n[6/7] Turso database (optional — local SQLite used if skipped)..." -ForegroundColor Yellow
Write-Host "  To use Turso (recommended for production):" -ForegroundColor Cyan
Write-Host "    1. Sign up at https://turso.tech" -ForegroundColor White
Write-Host "    2. fly secrets set TURSO_DATABASE_URL=libsql://your-db.turso.io" -ForegroundColor White
Write-Host "    3. fly secrets set TURSO_AUTH_TOKEN=your-token" -ForegroundColor White

# ── 8. Deploy ─────────────────────────────────────────────────────────────────
Write-Host "`n[7/7] Deploying to production..." -ForegroundColor Yellow
fly deploy

Write-Host "`n=== Deployment Complete! ===" -ForegroundColor Green
Write-Host "App URL: https://clinicchatbot.fly.dev" -ForegroundColor Cyan
Write-Host "`nNext step: scan the QR code shown in 'fly logs' to connect WhatsApp." -ForegroundColor Yellow
