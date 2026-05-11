import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";
import * as schema from "./schema";

if (config.TURSO_DATABASE_URL.startsWith("file:")) {
  const filePath = config.TURSO_DATABASE_URL.replace(/^file:/, "");
  mkdirSync(dirname(filePath), { recursive: true });
}

export const libsql = createClient({
  url: config.TURSO_DATABASE_URL,
  authToken: config.TURSO_AUTH_TOKEN || undefined
});

export const db = drizzle(libsql, { schema });
