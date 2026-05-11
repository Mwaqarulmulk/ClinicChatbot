import * as baileys from "baileys";
import type { AnyMessageContent, WAMessage } from "baileys";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import { config } from "../config";
import { logger } from "../logger";
import { handleAdminCommand } from "../admin/commands";
import { handleInboundMessage } from "../ai/orchestrator";
import { transcribeAudio } from "../ai/transcription";
import type { WhatsAppTransport } from "../types";
import { TtlSet, WindowGuard } from "../utils/window-guard";

const {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  makeWASocket,
  useMultiFileAuthState
} = baileys;

export class BaileysWhatsApp implements WhatsAppTransport {
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private ready = false;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private processedMessages = new TtlSet(6 * 60 * 60 * 1000);
  private inboundGuard = new WindowGuard(20, 60_000);

  async start() {
    await this.connect();
  }

  isReady(): boolean {
    return this.ready;
  }

  async sendText(to: string, text: string): Promise<void> {
    if (!this.socket) throw new Error("WhatsApp socket not ready");
    await this.socket.sendMessage(to.includes("@") ? to : `${to}@s.whatsapp.net`, { text } satisfies AnyMessageContent);
  }

  private async connect() {
    this.clearReconnectTimer();
    const { state, saveCreds } = await useMultiFileAuthState(config.WHATSAPP_AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      shouldIgnoreJid: (jid) => isJidBroadcast(jid),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      logger: logger.child({ module: "baileys" }) as never
    });

    this.socket = socket;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", async (update) => {
      if (update.qr) {
        qrcode.generate(update.qr, { small: true });
        logger.info("scan the WhatsApp QR code printed in the terminal");
      }
      if (update.connection === "open") {
        this.ready = true;
        this.reconnecting = false;
        this.clearReconnectTimer();
        logger.info("whatsapp connected");
      }
      if (update.connection === "close") {
        this.ready = false;
        const statusCode = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        logger.warn({ statusCode, shouldReconnect }, "whatsapp disconnected");
        this.socket = null;
        if (shouldReconnect) this.scheduleReconnect(statusCode === 515 ? 1500 : 5000);
      }
    });

    socket.ev.on("messages.upsert", async ({ messages }) => {
      for (const message of messages) {
        await this.onMessage(message).catch((error) => logger.error({ err: error }, "message handling failed"));
      }
    });
  }

  private scheduleReconnect(delayMs: number) {
    if (this.reconnectTimer) return;
    this.reconnecting = true;
    logger.info({ delayMs }, "whatsapp reconnect scheduled");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        logger.error({ err: error }, "whatsapp reconnect failed");
        this.scheduleReconnect(5000);
      });
    }, delayMs);
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async onMessage(message: WAMessage) {
    if (!message.message || message.key.fromMe) return;
    const jid = message.key.remoteJid;
    if (!jid || jid.endsWith("@g.us")) return;
    if (message.key.id && this.processedMessages.hasOrAdd(message.key.id)) return;
    if (!this.inboundGuard.allow(jid)) {
      await this.sendText(jid, "Please slow down a little. I will continue replying in a moment.");
      return;
    }
    const media = await maybeAudio(message);
    const caption = extractText(message);
    const transcription = media ? await transcribeAudio(media.bytes, media.mimeType) : null;
    const text = (caption || transcription || "").trim();
    if (!text && !media) return;

    const adminReply = await handleAdminCommand({
      from: jid,
      text,
      businessId: config.DEFAULT_BUSINESS_ID
    });
    if (adminReply) {
      await this.sendText(jid, adminReply);
      return;
    }

    const reply = await handleInboundMessage({
      businessId: config.DEFAULT_BUSINESS_ID,
      channel: "whatsapp",
      from: jid,
      name: message.pushName ?? undefined,
      text: text || "[Voice note received. Please type the request if transcription is unavailable.]",
      messageId: message.key.id ?? undefined,
      timestamp: messageTimestamp(message),
      media
    });
    await this.sendText(jid, reply.text);
  }
}

function messageTimestamp(message: WAMessage): Date {
  const raw = Number(message.messageTimestamp);
  if (!Number.isFinite(raw) || raw <= 0) return new Date();
  return new Date(raw * 1000);
}

function extractText(message: WAMessage): string {
  const content = message.message;
  return (
    content?.conversation ??
    content?.extendedTextMessage?.text ??
    content?.imageMessage?.caption ??
    content?.videoMessage?.caption ??
    content?.documentMessage?.caption ??
    ""
  ).trim();
}

async function maybeAudio(message: WAMessage) {
  if (!message.message?.audioMessage) return undefined;
  const bytes = await downloadMediaMessage(message, "buffer", {});
  return {
    kind: "audio" as const,
    mimeType: message.message.audioMessage.mimetype ?? undefined,
    bytes: new Uint8Array(bytes)
  };
}
