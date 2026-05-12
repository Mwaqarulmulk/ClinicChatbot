import type { WhatsAppTransport } from "../types";
import { logger } from "../logger";

export class NullWhatsApp implements WhatsAppTransport {
  // Return false so the reminder worker does NOT mark appointments as reminded
  // when WhatsApp is disabled — messages would be logged but never delivered.
  isReady(): boolean {
    return false;
  }

  async sendText(to: string, text: string): Promise<void> {
    logger.info({ to, text }, "whatsapp disabled; outbound message logged");
  }

  async stop(): Promise<void> {
    // Nothing to close — this transport doesn't hold any connections
  }
}
