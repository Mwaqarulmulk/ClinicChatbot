import * as Sentry from "@sentry/node";
import { config } from "../config";
import { logger } from "../logger";

let initialized = false;

export function initSentry() {
  if (initialized) return;
  if (!config.SENTRY_DSN) {
    logger.info("sentry not configured — set SENTRY_DSN to enable");
    return;
  }

  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    tracesSampleRate: config.NODE_ENV === "production" ? 0.5 : 1.0,
    integrations: [
      Sentry.consoleIntegration(),
    ],
  });

  initialized = true;
  logger.info({ env: config.NODE_ENV }, "sentry initialized");
}

export function captureError(error: unknown, context?: Record<string, unknown>) {
  if (!initialized) return;
  Sentry.captureException(error, {
    extra: context,
    tags: { service: "whatsapp-ai-chatbot" },
  });
}

export { Sentry };
