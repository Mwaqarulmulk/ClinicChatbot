# Architecture Analysis

## What This Project Builds

The service is a production-oriented WhatsApp AI assistant with these runtime paths:

1. WhatsApp message arrives through Baileys WebSocket.
2. The transport deduplicates message ids and rate-limits noisy senders.
3. The orchestrator stores customer, conversation, and message history in libSQL/Turso.
4. LanceDB retrieves relevant business knowledge.
5. Groq Llama 3.3 70B replies with tool calling enabled.
6. Booking tools check availability and create appointments.
7. Reminder worker sends appointment reminders through WhatsApp.

## Hidden Production Methods Included

- Dedupe replayed WhatsApp messages after reconnects.
- Per-sender rate limits to protect AI spend and avoid spam behavior.
- RAG is advisory, not blindly trusted; the system prompt tells the model to hand off on missing or conflicting facts.
- Appointment booking is tool-gated, so the model cannot invent confirmed slots.
- Admin HTTP endpoints are protected by `ADMIN_API_KEY`.
- WhatsApp admin learning lets the business update RAG without redeploying.
- Groq outage fallback keeps the bot responsive.
- LanceDB outage fallback avoids crashing ordinary chat flow.
- Local deterministic embeddings make development work without another provider.
- Voice notes use Groq transcription when a key is configured.

## Important Tradeoffs

Baileys is not the official WhatsApp Business API. It is practical for many small-business automations, but high-volume or compliance-heavy deployments should replace `src/whatsapp/baileys.ts` with an official WABA transport.

The default Baileys `useMultiFileAuthState` is functional and persistent on a mounted volume. For a large production deployment, implement a SQL/Redis auth state so auth writes are atomic and easier to back up.

The local embedding fallback is good enough for development and small FAQ retrieval. For best production accuracy, set `EMBEDDING_API_URL` to a real embedding model and keep `EMBEDDING_DIMENSIONS` aligned with that model.

## Scale Path

- Move WhatsApp auth state to Redis or Turso.
- Add staff calendars and per-service capacity in `src/services/appointments.ts`.
- Add a queue for outbound reminders and follow-ups.
- Add tenant routing from phone number to `businessId`.
- Add an admin dashboard over the existing `/admin/*` API.
- Replace simple in-memory rate limits with Redis if running multiple replicas.

