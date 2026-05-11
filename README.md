# Production-Level WhatsApp AI Chatbot

Full Bun + Hono + Baileys chatbot with Groq AI, LanceDB RAG, Turso/libSQL storage, Drizzle schema, appointment booking, reminders, admin commands, and Urdu/English replies.

See `docs/ARCHITECTURE.md` for the full production analysis, hidden methods, and scale path.

## Production Notes

Baileys connects through WhatsApp Linked Devices over WhatsApp Web. It is powerful, but it is not Meta's official WhatsApp Business API. For regulated or high-volume businesses, keep opt-in records, avoid bulk unsolicited messaging, and consider swapping the transport layer for WABA later.

Best hidden production methods already built in:

- intent gating before handoff and booking
- RAG-first answers with short WhatsApp replies
- AI tool calling for availability and bookings
- local fallback mode when Groq is not configured
- deterministic local embeddings for development, pluggable embedding API for production
- admin learning command from WhatsApp
- health and readiness endpoints
- reminder worker
- Docker and Fly.io-ready deployment

## Quick Start

1. Install Bun from [bun.sh](https://bun.sh).
2. Copy `.env.example` to `.env` and set `GROQ_API_KEY`.
3. Install dependencies:

```bash
bun install
```

4. Seed example knowledge:

```bash
bun run seed:knowledge
```

5. Start the bot:

```bash
bun run dev:whatsapp
```

6. Scan the QR code in the terminal with WhatsApp Linked Devices.

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

- `WHATSAPP_ENABLED=false` disables Baileys and logs outbound messages.
- `ADMIN_API_KEY` protects `/admin/*` HTTP endpoints with the `x-admin-key` header.
- `GROQ_API_KEY` enables Llama 3.3 70B on Groq.
- `TURSO_DATABASE_URL=file:.data/local.db` works locally; replace with Turso URL in production.
- `LANCEDB_URI=.data/lancedb` stores local vector data.
- `ADMIN_PHONE_NUMBERS=923001234567` allows WhatsApp admin commands.
- `EMBEDDING_API_URL` can point to your own OpenAI-compatible embedding service; without it, local hash embeddings are used.

Admin API calls require `x-admin-key` when `ADMIN_API_KEY` is set.

## Admin Commands

Send these from an admin WhatsApp number:

- `/help`
- `/status`
- `/appointments`
- `/learn Pricing | Consultation fee is Rs. 2000. Follow-up within 7 days is Rs. 1000.`

## Deployment

Create a Fly app, volume, and secrets:

```bash
fly apps create whatsapp-ai-chatbot
fly volumes create chatbot_data --size 3 --region sin
fly secrets set GROQ_API_KEY=... TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=...
copy fly.example.toml fly.toml
fly deploy
```

Keep `min_machines_running = 1` because WhatsApp WebSocket sessions should stay warm.

## Swap-In Points

- `src/whatsapp/baileys.ts`: replace with official WABA Cloud API transport.
- `src/rag/embeddings.ts`: replace fallback embeddings with a production embedding provider.
- `src/ai/tools.ts`: add CRM, payment, Google Calendar, or human-ticket tools.
- `src/services/appointments.ts`: replace simple business hours with staff calendars and location-specific capacity.
