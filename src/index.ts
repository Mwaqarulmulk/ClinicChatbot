import { serve } from "@hono/node-server";
import { config } from "./config";
import { bootstrapDatabase } from "./db/bootstrap";
import { createApp } from "./http/app";
import { logger } from "./logger";
import { initKnowledgeBase } from "./rag/knowledge-base";
import { startReminderWorker } from "./services/reminders";
import { BaileysWhatsApp } from "./whatsapp/baileys";
import { NullWhatsApp } from "./whatsapp/null-transport";

async function main() {
  logger.info({ env: config.NODE_ENV, port: config.PORT }, "starting server");

  await bootstrapDatabase();
  await initKnowledgeBase();

  const transport = config.WHATSAPP_ENABLED
    ? new BaileysWhatsApp()
    : new NullWhatsApp();
  if (config.WHATSAPP_ENABLED && transport instanceof BaileysWhatsApp) {
    void transport
      .start()
      .catch((error) =>
        logger.error({ err: error }, "whatsapp startup failed"),
      );
  }

  startReminderWorker(transport);

  const app = createApp(transport);
  const server = serve({ fetch: app.fetch, port: config.PORT });
  logger.info({ port: config.PORT }, "server listening");

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  // Fly.io sends SIGTERM before restarting or stopping a machine.
  // Handle it so in-flight requests and database writes finish cleanly.
  // ─────────────────────────────────────────────────────────────────────────────
  function shutdown(signal: string) {
    logger.info({ signal }, "shutdown signal received — closing server");
    server.close(() => {
      logger.info("http server closed — exiting");
      process.exit(0);
    });

    // Force-exit after 10 seconds if something hangs
    const force = setTimeout(() => {
      logger.warn("graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000);
    // Allow Node to exit naturally if the server closes before the timer fires
    if (typeof force.unref === "function") force.unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  logger.fatal({ err: error }, "fatal startup failure");
  process.exit(1);
});
