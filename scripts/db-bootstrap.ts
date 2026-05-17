#!/usr/bin/env node
import { bootstrapDatabase } from "../src/db/bootstrap";
import { config } from "../src/config";

await bootstrapDatabase();

const target = config.TURSO_DATABASE_URL.startsWith("file:")
  ? config.TURSO_DATABASE_URL
  : config.TURSO_DATABASE_URL.replace(/\/\/.*?@/, "//***@");

console.log(`[db:bootstrap] database initialized: ${target}`);
