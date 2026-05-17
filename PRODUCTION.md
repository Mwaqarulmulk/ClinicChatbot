# Production Deployment Guide

This guide covers deploying the WhatsApp AI Chatbot to production using **Fly.io** (recommended) or a VPS.

---

## Option 1: Deploy to Fly.io (Recommended)

### Prerequisites
1. Install Fly CLI: https://fly.io/docs/flyctl/install/
2. Create a Fly account: `fly auth signup`

### Step 1: Prepare Your Environment

Edit `.env` file for production:

```env
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# IMPORTANT: Change this to a secure random string
ADMIN_API_KEY=your-secure-random-key-here

# WhatsApp
WHATSAPP_ENABLED=true
WHATSAPP_AUTH_DIR=/app/.data/baileys-auth
ADMIN_PHONE_NUMBERS=923136535775

# AI - Get free API key at https://console.groq.com
GROQ_API_KEY=your-groq-api-key
GROQ_MODEL=llama-3.3-70b-versatile
AI_TEMPERATURE=0.4

# Database - Use Turso for production (free tier available)
# Sign up at https://turso.tech
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your-turso-auth-token

# RAG
LANCEDB_URI=/app/.data/lancedb
RAG_TABLE=business_knowledge
EMBEDDING_DIMENSIONS=256
EMBEDDING_API_URL=
EMBEDDING_API_KEY=

# Business
DEFAULT_BUSINESS_ID=default
DEFAULT_BUSINESS_NAME=Your Clinic Name
DEFAULT_TIMEZONE=Asia/Karachi
BUSINESS_OPEN_HOUR=9
BUSINESS_CLOSE_HOUR=18
APPOINTMENT_DURATION_MINUTES=30
REMINDER_LEAD_MINUTES=60
HUMAN_HANDOFF_KEYWORDS=human,agent,representative,admin,owner
```

### Step 2: Create Fly App

```bash
# Login to Fly
fly auth login

# Create the app (if not already created)
fly apps create clinic-chatbot-waqar

# Create a volume for persistent data (WhatsApp auth, database)
fly volumes create chatbot_data --size 3 --region sin
```

### Step 3: Set Production Secrets

```bash
# Set Groq API Key
fly secrets set GROQ_API_KEY=your-groq-api-key

# Set Turso credentials
fly secrets set TURSO_DATABASE_URL=libsql://your-database.turso.io
fly secrets set TURSO_AUTH_TOKEN=your-turso-auth-token

# Set a secure admin key
fly secrets set ADMIN_API_KEY=your-secure-random-key
```

### Step 4: Deploy

```bash
fly deploy
```

The repository's `fly.toml` includes a release command that runs `scripts/db-bootstrap.ts` before the machine is promoted. This creates missing tables/indexes and the default business row without overwriting existing data.

### Step 5: Initialize Turso Schema

Run these once from your local machine after `.env` contains the Turso URL/token, or run them in a trusted CI job with the same secrets:

```bash
bun run db:migrate
bun run db:bootstrap
bun run db:check
```

`db:migrate` applies the committed Drizzle SQL migrations. `db:bootstrap` creates any missing app tables/indexes and seeds the default business id. `db:check` verifies connectivity plus the required tables and indexes, including the active appointment slot uniqueness index.

### Step 6: Check Status

```bash
fly status
fly logs
```

---

## Option 2: Deploy to VPS (DigitalOcean/Render/Railway)

### Using Docker

1. Build the Docker image:
```bash
docker build -t whatsapp-chatbot .
```

2. Run with environment variables:
```bash
docker run -d \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e GROQ_API_KEY=your-key \
  -e TURSO_DATABASE_URL=your-turso-url \
  -e TURSO_AUTH_TOKEN=your-token \
  -e ADMIN_API_KEY=your-admin-key \
  -v $(pwd)/data:/app/.data \
  whatsapp-chatbot
```

---

## Production Checklist

### Security
- [ ] Change `ADMIN_API_KEY` to a secure random string
- [ ] Use Turso database (not local SQLite)
- [ ] Enable HTTPS (automatic on Fly.io)
- [ ] Don't expose unnecessary ports

### WhatsApp Session
- WhatsApp auth is persisted in `.data/baileys-auth/`
- On Fly.io, this is stored in the volume
- Once deployed, scan the QR code with your phone to connect

### Monitoring
```bash
# View logs on Fly.io
fly logs

# Check metrics
fly metrics
```

### Backup
- Turso database has automatic backups
- Export WhatsApp auth periodically:
```bash
fly ssh -C "cat /app/.data/baileys-auth/creds.json"
```

---

## Troubleshooting

### GitHub Actions Deployment

Set this repository secret before relying on automatic deploys from `main`:

```text
FLY_API_TOKEN
```

If you use remote Turso, also set:

```text
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
```

The workflow runs `npm ci`, type-checks, runs tests, optionally applies Turso migrations when both Turso secrets are present, deploys with `flyctl deploy --remote-only`, then smoke-tests `/health`.

### WhatsApp Disconnects
```bash
# Restart the machine
fly machines restart <machine-id>
```

### View Logs
```bash
fly logs --follow
```

### Connect to Production Shell
```bash
fly ssh console
```

---

## API Endpoints in Production

- `https://your-app.fly.io/health` - Health check
- `https://your-app.fly.io/ready` - Readiness check
- `https://your-app.fly.io/chat/test` - Test chat UI
- `https://your-app.fly.io/admin/appointments` - Admin API (requires x-admin-key header)
