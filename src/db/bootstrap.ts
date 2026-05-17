import { sql } from "drizzle-orm";
import { config } from "../config";
import { logger } from "../logger";
import { db } from "./client";

const statements = [
  sql`CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL,
    open_hour INTEGER NOT NULL,
    close_hour INTEGER NOT NULL,
    appointment_duration_minutes INTEGER NOT NULL,
    system_prompt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  sql`CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    phone TEXT NOT NULL,
    name TEXT,
    language TEXT NOT NULL DEFAULT 'en',
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  sql`CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_business_idx ON customers (business_id, phone)`,
  sql`CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    customer_id TEXT NOT NULL REFERENCES customers(id),
    channel TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_message_at TEXT NOT NULL,
    handoff INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  sql`CREATE INDEX IF NOT EXISTS conversations_customer_idx ON conversations (customer_id)`,
  sql`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    provider_message_id TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL
  )`,
  sql`CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id)`,
  sql`CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    customer_id TEXT NOT NULL REFERENCES customers(id),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    service TEXT NOT NULL DEFAULT 'consultation',
    notes TEXT,
    reminder_sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  sql`CREATE INDEX IF NOT EXISTS appointments_schedule_idx ON appointments (business_id, starts_at, status)`,
  sql`CREATE UNIQUE INDEX IF NOT EXISTS appointments_active_slot_idx
    ON appointments (business_id, starts_at)
    WHERE status != 'cancelled'`,
  sql`CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    customer_id TEXT,
    event TEXT NOT NULL,
    value REAL,
    metadata TEXT,
    created_at TEXT NOT NULL
  )`,
  sql`CREATE INDEX IF NOT EXISTS analytics_event_idx ON analytics_events (business_id, event, created_at)`,
];

export async function bootstrapDatabase(): Promise<void> {
  for (const statement of statements) {
    await db.run(statement);
  }

  const now = new Date().toISOString();
  await db.run(sql`
    INSERT INTO businesses (
      id, name, timezone, open_hour, close_hour, appointment_duration_minutes,
      system_prompt, created_at, updated_at
    )
    VALUES (
      ${config.DEFAULT_BUSINESS_ID},
      ${config.DEFAULT_BUSINESS_NAME},
      ${config.DEFAULT_TIMEZONE},
      ${config.BUSINESS_OPEN_HOUR},
      ${config.BUSINESS_CLOSE_HOUR},
      ${config.APPOINTMENT_DURATION_MINUTES},
      ${defaultSystemPrompt(config.DEFAULT_BUSINESS_NAME)},
      ${now},
      ${now}
    )
    ON CONFLICT(id) DO NOTHING
  `);

  logger.info("database ready");
}

function defaultSystemPrompt(name: string): string {
  return [
    `You are the friendly WhatsApp AI assistant for ${name}.`,
    "Be warm, natural, and brief — WhatsApp messages should be 2-3 sentences maximum.",
    "Reply in the customer's language. Match their exact tone and style.",
    "NEVER copy knowledge snippet text verbatim. Always paraphrase in your own friendly words.",
    "For appointment queries, ALWAYS call get_my_appointments before responding.",
    "For new bookings, ask for date and time if missing, then call book_appointment. Never invent availability.",
    "For greetings, reply warmly by name — no tool calls needed.",
  ].join(" ");
}
