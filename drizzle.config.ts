import { defineConfig } from "drizzle-kit";

const url = process.env.TURSO_DATABASE_URL ?? "file:.data/local.db";

// Use 'turso' dialect when connecting to a remote libsql/Turso instance so that
// drizzle-kit passes the auth token. Fall back to 'sqlite' for local file URLs.
const isRemote = url.startsWith("libsql://") || url.startsWith("wss://");

export default defineConfig(
  isRemote
    ? {
        schema: "./src/db/schema.ts",
        out: "./drizzle",
        dialect: "turso",
        dbCredentials: {
          url,
          authToken: process.env.TURSO_AUTH_TOKEN ?? "",
        },
      }
    : {
        schema: "./src/db/schema.ts",
        out: "./drizzle",
        dialect: "sqlite",
        dbCredentials: { url },
      },
);
