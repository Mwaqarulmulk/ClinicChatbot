import { defineConfig } from "drizzle-kit";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

loadDotEnv();

const url = normalizeFileDatabaseUrl(process.env.TURSO_DATABASE_URL ?? "file:.data/local.db");
const authToken = process.env.TURSO_AUTH_TOKEN ?? "";

// Use 'turso' dialect when connecting to a remote libsql/Turso instance so that
// drizzle-kit passes the auth token. Fall back to 'sqlite' for local file URLs.
const isRemote = url.startsWith("libsql://") || url.startsWith("wss://");

if (isRemote && !authToken) {
  throw new Error("TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL points to a remote Turso database.");
}

export default defineConfig(
  isRemote
    ? {
        schema: "./src/db/schema.ts",
        out: "./drizzle",
        dialect: "turso",
        dbCredentials: {
          url,
          authToken,
        },
        strict: true,
        verbose: true,
      }
    : {
        schema: "./src/db/schema.ts",
        out: "./drizzle",
        dialect: "sqlite",
        dbCredentials: { url },
        strict: true,
        verbose: true,
      },
);

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

function normalizeFileDatabaseUrl(url: string): string {
  if (!url.startsWith("file:")) return url;

  const rawPath = url.slice("file:".length);
  if (!rawPath) return url;

  return `file:${resolve(rawPath)}`;
}
