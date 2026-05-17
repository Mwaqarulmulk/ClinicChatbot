#!/usr/bin/env node
// SQLite backup script — copies the local database to a timestamped backup file.
// Designed for Fly.io cron jobs or manual runs.
// Usage: bun run scripts/backup-db.ts
//
// Environment:
//   BACKUP_DIR        — where to store backups (default: .data/backups)
//   TURSO_DATABASE_URL — source database URL (default: file:.data/local.db)
//   MAX_BACKUPS       — keep only the N most recent backups (default: 30)
//   SENTRY_DSN        — optional Sentry DSN for error reporting

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function main() {
  const dbUrl = env("TURSO_DATABASE_URL", "file:.data/local.db");

  // Only file: URLs are supported for direct copy
  if (!dbUrl.startsWith("file:")) {
    console.log(`[backup] skipping — TURSO_DATABASE_URL is not a file: URL (${dbUrl})`);
    console.log("[backup] for Turso cloud databases, use turso db shell dump instead");
    process.exit(0);
  }

  const dbPath = resolve(dbUrl.slice(5));
  if (!existsSync(dbPath)) {
    console.error(`[backup] database file not found: ${dbPath}`);
    process.exit(1);
  }

  const backupDir = resolve(env("BACKUP_DIR", ".data/backups"));
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const backupName = `local-${timestamp}.db`;
  const backupPath = join(backupDir, backupName);

  console.log(`[backup] copying ${dbPath} → ${backupPath}`);
  copyFileSync(dbPath, backupPath);

  const stats = statSync(backupPath);
  const sizeKb = (stats.size / 1024).toFixed(1);
  console.log(`[backup] done — ${backupName} (${sizeKb} KB)`);

  // Prune old backups
  const maxBackups = parseInt(env("MAX_BACKUPS", "30"), 10);
  const files = readdirSync(backupDir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => ({
      name: f,
      path: join(backupDir, f),
      mtime: statSync(join(backupDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length > maxBackups) {
    const toDelete = files.slice(maxBackups);
    for (const file of toDelete) {
      unlinkSync(file.path);
      console.log(`[backup] pruned old backup: ${file.name}`);
    }
  }

  console.log(`[backup] kept ${Math.min(files.length, maxBackups)} backups (max: ${maxBackups})`);
}

main();
