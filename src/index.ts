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
  await bootstrapDatabase();
  await initKnowledgeBase();

  const transport = config.WHATSAPP_ENABLED ? new BaileysWhatsApp() : new NullWhatsApp();
  if (config.WHATSAPP_ENABLED && transport instanceof BaileysWhatsApp) {
    void transport.start().catch((error) => logger.error({ err: error }, "whatsapp startup failed"));
  }

  startReminderWorker(transport);

  const app = createApp(transport);
  serve({ fetch: app.fetch, port: config.PORT });
  logger.info({ port: config.PORT }, "server listening");
}

main().catch((error) => {
  logger.fatal({ err: error }, "fatal startup failure");
  process.exit(1);
});
