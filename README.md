# Production-Level WhatsApp AI Chatbot

Full Bun + Hono + Baileys chatbot with Groq AI, LanceDB RAG, Turso/libSQL storage, Drizzle schema, appointment booking, reminders, admin commands, and Urdu/English replies.

See `docs/ARCHITECTURE.md` for the full production analysis, hidden methods, and scale path.

## Features

### AI & RAG
- **Groq LLM** — Llama 3.3 70B with configurable temperature and model selection
- **RAG Knowledge Base** — LanceDB vector store with local fallback embeddings
- **AI Tool Calling** — Availability checking, appointment booking, knowledge search
- **Intent Gating** — Smart handoff detection before booking or escalation
- **Local Fallback Mode** — Continues working without Groq API key
- **Graceful Degradation** — App runs even if LanceDB initialization fails

### WhatsApp Integration
- **Baileys Transport** — WhatsApp Linked Devices (no official API needed)
- **Session Persistence** — Survives restarts via graceful WebSocket shutdown
- **Admin Commands** — `/help`, `/status`, `/appointments`, `/learn`
- **Urdu/English Replies** — Natural language responses in both languages
- **Human Handoff** — Keyword-based escalation to real staff

### Appointments & Reminders
- **Smart Scheduling** — Business hours enforcement, timezone-aware slots
- **Business Cache** — 5-minute in-memory cache with manual invalidation
- **Reminder Worker** — Configurable lead-time notifications before appointments

### Admin Dashboard
- **Modern SPA** — Glassmorphism UI with 3D tilt cards, particles, scroll animations
- **Real-Time Stats** — Conversation count, appointments, knowledge base size
- **Knowledge Management** — Add/remove RAG entries from the dashboard
- **Protected Endpoints** — API key authentication with rate limiting

### Chat Widget
- **Browser Testing** — Full WhatsApp-style chat UI at `/chat/test`
- **No Phone Required** — Test AI responses without scanning QR codes
- **Animated Interface** — Typing indicators, message bubbles, smooth transitions

### Landing Page
- **3D Animated Hero** — Gradient mesh, floating particles, parallax tilt
- **Scroll Reveal** — Staggered card animations on scroll
- **Responsive Design** — Works on mobile, tablet, and desktop

## Security & Production Hardening

- **HTTP Security Headers** — CSP, HSTS, X-Frame-Options, X-Content-Type-Options
- **Request Logging** — Pino-based structured logging with method, path, status, duration
- **IP Rate Limiting** — Sliding window rate limiter on all `/admin/*` endpoints
- **Zod Config Validation** — Cross-field validation, type coercion, safe env parsing
- **Non-Root Docker User** — Container runs as unprivileged `appuser` (UID 1001)
- **Session Preservation** — Graceful Baileys shutdown preserves WhatsApp auth across restarts
- **Graceful Shutdown** — Proper cleanup of DB, WhatsApp, and HTTP server on SIGTERM/SIGINT

## Quick Start

1. Install Bun from [bun.sh](https://bun.sh).
2. Copy `.env.example` to `.env` and set `GROQ_API_KEY`.
3. Install dependencies:

```bash
bun install
```

4. Push database schema:

```bash
bun run db:push
```

5. Seed example knowledge:

```bash
bun run seed:knowledge
```

6. Start the bot:

```bash
bun run dev:whatsapp
```

7. Scan the QR code in the terminal with WhatsApp Linked Devices.

The HTTP API runs on `http://localhost:3000`.

For browser-only testing without WhatsApp QR:

```bash
bun run dev:test
```

Then open `http://localhost:3000/chat/test`.

On Windows, WhatsApp mode uses Node via `node --import tsx` because Baileys depends on WebSocket behavior that Bun does not fully implement yet.

## Local API Test

```bash
curl -X POST http://localhost:3000/chat/test \
  -H "content-type: application/json" \
  -d "{\"from\":\"923001234567\",\"text\":\"Can I book an appointment tomorrow at 3pm?\"}"
```

## Environment

Important variables:

| Variable | Description | Default |
|---|---|---|
| `NODE_ENV` | Runtime environment | `development` |
| `PORT` | HTTP server port | `3000` |
| `LOG_LEVEL` | Pino log level | `info` |
| `WHATSAPP_ENABLED` | Enable Baileys transport | `true` |
| `GROQ_API_KEY` | Groq API key for LLM | _(optional)_ |
| `GROQ_MODEL` | Groq model to use | `llama-3.3-70b-versatile` |
| `AI_TEMPERATURE` | LLM temperature (0-2) | `0.4` |
| `ADMIN_API_KEY` | Protects `/admin/*` endpoints | _(optional)_ |
| `ADMIN_PHONE_NUMBERS` | Comma-separated admin phone numbers | _(empty)_ |
| `TURSO_DATABASE_URL` | libSQL/Turso connection string | `file:.data/local.db` |
| `TURSO_AUTH_TOKEN` | Turso auth token (cloud only) | _(optional)_ |
| `LANCEDB_URI` | LanceDB vector store path | `.data/lancedb` |
| `EMBEDDING_API_URL` | OpenAI-compatible embedding service | _(optional)_ |
| `EMBEDDING_API_KEY` | Embedding service API key | _(optional)_ |
| `DEFAULT_BUSINESS_NAME` | Business display name | `Demo Clinic` |
| `DEFAULT_TIMEZONE` | IANA timezone | `Asia/Karachi` |
| `BUSINESS_OPEN_HOUR` | Opening hour (0-23) | `9` |
| `BUSINESS_CLOSE_HOUR` | Closing hour (1-24) | `18` |
| `APPOINTMENT_DURATION_MINUTES` | Default appointment length | `30` |
| `REMINDER_LEAD_MINUTES` | Reminder notification lead time | `60` |
| `HUMAN_HANDOFF_KEYWORDS` | Comma-separated handoff trigger words | `human,agent,representative,...` |

Admin API calls require `x-admin-key` header when `ADMIN_API_KEY` is set.

## Admin Commands

Send these from an admin WhatsApp number:

- `/help` — Show available commands
- `/status` — System health and stats
- `/appointments` — List upcoming appointments
- `/learn Pricing | Consultation fee is Rs. 2000. Follow-up within 7 days is Rs. 1000.` — Add knowledge

## HTTP Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Landing page (redesigned SPA) |
| `GET` | `/health` | Health check with DB status |
| `GET` | `/chat/test` | Browser chat widget |
| `POST` | `/chat/test` | Send test message (JSON body) |
| `GET` | `/admin` | Admin dashboard (SPA) |
| `GET` | `/admin/stats` | System statistics |
| `GET` | `/admin/appointments` | List all appointments |
| `GET` | `/admin/knowledge` | List RAG knowledge entries |
| `POST` | `/admin/knowledge` | Add knowledge entry |
| `DELETE` | `/admin/knowledge/:id` | Remove knowledge entry |

All `/admin/*` endpoints require `x-admin-key` header when `ADMIN_API_KEY` is configured.

## Scripts

| Command | Description |
|---|---|
| `bun run dev` | Hot-reload dev server (Bun) |
| `bun run dev:whatsapp` | WhatsApp mode (Node + tsx) |
| `bun run dev:test` | Test mode without WhatsApp |
| `bun run start` | Production start (Node + tsx) |
| `bun run start:test` | Test mode production start |
| `bun run build` | TypeScript type check |
| `bun run typecheck` | TypeScript type check |
| `bun run lint` | TypeScript type check |
| `bun run db:push` | Push Drizzle schema to DB |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run seed:knowledge` | Seed sample RAG knowledge |
| `bun run docker:build` | Build Docker image |
| `bun run docker:run` | Run Docker container |

## Deployment

### Docker

```bash
bun run docker:build
bun run docker:run
```

Dockerfile uses Node 22 LTS, non-root `appuser`, and production-optimized layer caching.

### Fly.io

Create a Fly app, volume, and secrets:

```bash
fly apps create whatsapp-ai-chatbot
fly volumes create chatbot_data --size 3 --region sin
fly secrets set GROQ_API_KEY=... TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... ADMIN_API_KEY=...
cp fly.example.toml fly.toml
fly deploy
```

Keep `min_machines_running = 1` because WhatsApp WebSocket sessions should stay warm.

### Production Checklist

- [ ] Rotate all default/exposed API keys
- [ ] Set `NODE_ENV=production`
- [ ] Configure `ADMIN_API_KEY` with a strong secret
- [ ] Set up automated SQLite backups (cron or Fly.io snapshot)
- [ ] Add error monitoring (Sentry, Datadog, or similar)
- [ ] Configure HTTPS/TLS termination
- [ ] Set up log aggregation
- [ ] Test graceful shutdown and session recovery
- [ ] Verify rate limiting thresholds for your traffic

## Architecture

```
src/
├── ai/           # Groq LLM, tool calling, transcription, orchestrator
├── config.ts     # Zod-validated environment configuration
├── db/           # libSQL/Turso connection, Drizzle schema
├── http/         # Hono server, middleware, SPA routes, API endpoints
├── rag/          # LanceDB vector store, embeddings, knowledge base
├── services/     # Business logic (appointments, reminders, knowledge)
├── utils/        # Shared utilities (text, time, validation)
└── whatsapp/     # Baileys transport, message handler, admin commands
```

## Swap-In Points

- `src/whatsapp/baileys.ts` — Replace with official WABA Cloud API transport
- `src/rag/embeddings.ts` — Replace fallback embeddings with production provider
- `src/ai/tools.ts` — Add CRM, payment, Google Calendar, or human-ticket tools
- `src/services/appointments.ts` — Replace simple business hours with staff calendars and location-specific capacity

## Tech Stack

- **Runtime**: Bun (dev) / Node.js 22 LTS (production)
- **HTTP**: Hono (lightweight web framework)
- **Database**: libSQL/Turso with Drizzle ORM
- **Vector Store**: LanceDB for RAG knowledge retrieval
- **AI**: Groq SDK (Llama 3.3 70B)
- **WhatsApp**: Baileys (unofficial linked device protocol)
- **Validation**: Zod (runtime config and input validation)
- **Logging**: Pino (structured JSON logging)
- **Language**: TypeScript (strict mode, zero `any` in core logic)
