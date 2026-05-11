import type { WhatsAppTransport } from "../types";
import { logger } from "../logger";

export class NullWhatsApp implements WhatsAppTransport {
  isReady(): boolean {
    return true;
  }

  async sendText(to: string, text: string): Promise<void> {
    logger.info({ to, text }, "whatsapp disabled; outbound message logged");
  }
}

