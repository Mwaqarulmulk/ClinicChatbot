import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config";
import * as schema from "./schema";

const databaseUrl = normalizeFileDatabaseUrl(config.TURSO_DATABASE_URL);

// Ensure the directory containing the local SQLite file exists.
// Use resolve() so this works correctly regardless of the current working directory
// (e.g. Docker containers, test runners, deploy scripts).
if (databaseUrl.startsWith("file:")) {
  const filePath = resolve(databaseUrl.replace(/^file:/, ""));
  mkdirSync(dirname(filePath), { recursive: true });
}

export const libsql = createClient({
  url: databaseUrl,
  authToken: config.TURSO_AUTH_TOKEN || undefined,
});

export const db = drizzle(libsql, { schema });

function normalizeFileDatabaseUrl(url: string): string {
  if (!url.startsWith("file:")) return url;

  const rawPath = url.slice("file:".length);
  if (!rawPath) return url;

  return `file:${resolve(rawPath)}`;
}
