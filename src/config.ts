import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

loadDotEnv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  ADMIN_API_KEY: z.string().optional(),
  WHATSAPP_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value === "true"),
  WHATSAPP_AUTH_DIR: z.string().default(".data/baileys-auth"),
  ADMIN_PHONE_NUMBERS: z.string().default(""),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),
  TURSO_DATABASE_URL: z.string().default("file:.data/local.db"),
  TURSO_AUTH_TOKEN: z.string().optional(),
  LANCEDB_URI: z.string().default(".data/lancedb"),
  RAG_TABLE: z.string().default("business_knowledge"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(256),
  EMBEDDING_API_URL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  DEFAULT_BUSINESS_ID: z.string().default("default"),
  DEFAULT_BUSINESS_NAME: z.string().default("Demo Clinic"),
  DEFAULT_TIMEZONE: z.string().default("Asia/Karachi"),
  BUSINESS_OPEN_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  BUSINESS_CLOSE_HOUR: z.coerce.number().int().min(1).max(24).default(18),
  APPOINTMENT_DURATION_MINUTES: z.coerce.number().int().positive().default(30),
  REMINDER_LEAD_MINUTES: z.coerce.number().int().positive().default(60),
  HUMAN_HANDOFF_KEYWORDS: z.string().default("human,agent,representative,admin,owner")
});

export const config = envSchema.parse(process.env);

export const adminPhones = new Set(
  config.ADMIN_PHONE_NUMBERS.split(",")
    .map((phone) => phone.replace(/\D/g, ""))
    .filter(Boolean)
);

export const handoffKeywords = config.HUMAN_HANDOFF_KEYWORDS.split(",")
  .map((word) => word.trim().toLowerCase())
  .filter(Boolean);

function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = unquote(rawValue);
  }
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
