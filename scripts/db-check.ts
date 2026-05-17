#!/usr/bin/env node
import { sql } from "drizzle-orm";
import { config } from "../src/config";
import { db } from "../src/db/client";

const requiredTables = [
  "businesses",
  "customers",
  "conversations",
  "messages",
  "appointments",
  "analytics_events",
];

const requiredIndexes = [
  "customers_phone_business_idx",
  "conversations_customer_idx",
  "messages_conversation_idx",
  "appointments_schedule_idx",
  "appointments_active_slot_idx",
  "analytics_event_idx",
];

await db.run(sql`SELECT 1`);

const tableRows = await db.all<{ name: string }>(
  sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
);
const indexRows = await db.all<{ name: string }>(
  sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`,
);

const tables = new Set(tableRows.map((row) => row.name));
const indexes = new Set(indexRows.map((row) => row.name));
const missingTables = requiredTables.filter((name) => !tables.has(name));
const missingIndexes = requiredIndexes.filter((name) => !indexes.has(name));

if (missingTables.length || missingIndexes.length) {
  console.error("[db:check] database schema is incomplete");
  if (missingTables.length) console.error(`missing tables: ${missingTables.join(", ")}`);
  if (missingIndexes.length) console.error(`missing indexes: ${missingIndexes.join(", ")}`);
  process.exit(1);
}

const target = config.TURSO_DATABASE_URL.startsWith("file:")
  ? config.TURSO_DATABASE_URL
  : config.TURSO_DATABASE_URL.replace(/\/\/.*?@/, "//***@");

console.log(`[db:check] connected: ${target}`);
console.log(`[db:check] tables: ${requiredTables.length}, indexes: ${requiredIndexes.length}`);
