param(
  [string]$AppName = "clinicchatbot",
  [string]$Region = "ams",
  [int]$VolumeSizeGb = 3,
  [switch]$UseTurso
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Require-Command($Name, $InstallHint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is not installed. $InstallHint"
  }
}

Write-Host "== Clinic chatbot Fly.io deploy ==" -ForegroundColor Cyan

Require-Command "node" "Install Node.js 22 LTS."
Require-Command "npm" "Install Node.js/npm."
Require-Command "fly" "Install Fly CLI from https://fly.io/docs/flyctl/install/."

Write-Host "`n[1/8] Verifying local project" -ForegroundColor Yellow
npm ci
npm run build
npm test

Write-Host "`n[2/8] Fly login" -ForegroundColor Yellow
fly auth whoami *> $null
if ($LASTEXITCODE -ne 0) {
  fly auth login
}

Write-Host "`n[3/8] Creating Fly app if needed" -ForegroundColor Yellow
fly apps create $AppName --org personal 2>$null

Write-Host "`n[4/8] Creating persistent volume if needed" -ForegroundColor Yellow
fly volumes create chatbot_data --size $VolumeSizeGb --region $Region --app $AppName 2>$null

Write-Host "`n[5/8] Setting required secrets" -ForegroundColor Yellow
$groqKey = Read-Host "Enter GROQ_API_KEY"
if ([string]::IsNullOrWhiteSpace($groqKey)) {
  throw "GROQ_API_KEY is required."
}
fly secrets set --app $AppName "GROQ_API_KEY=$groqKey"

$adminKeyBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$adminKey = [Convert]::ToBase64String($adminKeyBytes)
fly secrets set --app $AppName "ADMIN_API_KEY=$adminKey"
Write-Host "ADMIN_API_KEY generated. Save this value:" -ForegroundColor Green
Write-Host $adminKey -ForegroundColor Green

if ($UseTurso) {
  Write-Host "`n[6/8] Setting Turso secrets" -ForegroundColor Yellow
  $tursoUrl = Read-Host "Enter TURSO_DATABASE_URL (libsql://...)"
  $tursoToken = Read-Host "Enter TURSO_AUTH_TOKEN"
  if ([string]::IsNullOrWhiteSpace($tursoUrl) -or [string]::IsNullOrWhiteSpace($tursoToken)) {
    throw "Both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required when -UseTurso is set."
  }
  fly secrets set --app $AppName "TURSO_DATABASE_URL=$tursoUrl" "TURSO_AUTH_TOKEN=$tursoToken"

  $env:TURSO_DATABASE_URL = $tursoUrl
  $env:TURSO_AUTH_TOKEN = $tursoToken
  npm run db:migrate
  npm run db:check
} else {
  Write-Host "`n[6/8] Turso skipped; Fly volume SQLite will be used" -ForegroundColor Yellow
}

Write-Host "`n[7/8] Deploying" -ForegroundColor Yellow
fly deploy --app $AppName --remote-only --wait-timeout 300

Write-Host "`n[8/8] Smoke test" -ForegroundColor Yellow
$healthUrl = "https://$AppName.fly.dev/health"
$status = (Invoke-WebRequest -Uri $healthUrl -UseBasicParsing).StatusCode
if ($status -ne 200) {
  throw "Health check failed: $healthUrl returned $status"
}

Write-Host "`nDeploy complete: https://$AppName.fly.dev" -ForegroundColor Green
Write-Host "Open logs with: fly logs --app $AppName" -ForegroundColor Cyan
