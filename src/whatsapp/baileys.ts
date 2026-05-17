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
  useMultiFileAuthState,
} = baileys;

// Reconnect backoff: starts at BASE_DELAY_MS, doubles each attempt, caps at MAX_DELAY_MS
const BASE_RECONNECT_DELAY_MS = 5_000; // 5 seconds
const MAX_RECONNECT_DELAY_MS = 5 * 60_000; // 5 minutes

export class BaileysWhatsApp implements WhatsAppTransport {
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private ready = false;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private processedMessages = new TtlSet(6 * 60 * 60 * 1000);
  private inboundGuard = new WindowGuard(20, 60_000);

  async start() {
    await this.connect();
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Gracefully close the socket — called from shutdown handler in index.ts */
  async stop(): Promise<void> {
    this.clearReconnectTimer();
    this.reconnecting = false;
    if (this.socket) {
      try {
        // Use ws.close() to cleanly terminate the WebSocket without
        // logging out — preserves the session for next startup.
        this.socket.ws?.close();
      } catch {
        // close can fail if already disconnected; that's fine
      }
      this.socket = null;
    }
    this.ready = false;
    logger.info("whatsapp socket closed");
  }

  async sendText(to: string, text: string): Promise<void> {
    if (!this.socket) throw new Error("WhatsApp socket not ready");
    await this.socket.sendMessage(
      to.includes("@") ? to : `${to}@s.whatsapp.net`,
      { text } satisfies AnyMessageContent,
    );
  }

  private async connect() {
    this.clearReconnectTimer();
    const { state, saveCreds } = await useMultiFileAuthState(
      config.WHATSAPP_AUTH_DIR,
    );
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      shouldIgnoreJid: (jid) => isJidBroadcast(jid),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      logger: logger.child({ module: "baileys" }) as never,
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
        this.reconnectAttempt = 0; // reset backoff on successful connect
        this.clearReconnectTimer();
        logger.info("whatsapp connected");
      }

      if (update.connection === "close") {
        this.ready = false;
        this.socket = null;
        const statusCode = (update.lastDisconnect?.error as Boom | undefined)
          ?.output?.statusCode;
        // loggedOut (401) = user de-linked the device — do not reconnect
        // forbidden (403) = account banned — reconnecting makes a ban permanent
        // 401 = loggedOut (user de-linked), 403 = forbidden (account banned)
        // Use literal 403 to avoid the type-cast issue with DisconnectReason enum
        const permanentFailure =
          statusCode === DisconnectReason.loggedOut || statusCode === 403;
        const shouldReconnect = !permanentFailure;
        logger.warn(
          { statusCode, shouldReconnect, permanentFailure },
          "whatsapp disconnected",
        );
        if (!shouldReconnect) {
          logger.error(
            { statusCode },
            "permanent whatsapp disconnect — will NOT reconnect",
          );
        }
        if (shouldReconnect) {
          // Status 515 = stream conflict — reconnect quickly; otherwise use backoff
          const baseDelay =
            statusCode === 515 ? 1_500 : BASE_RECONNECT_DELAY_MS;
          this.scheduleReconnect(baseDelay);
        }
      }
    });

    socket.ev.on("messages.upsert", async ({ messages }) => {
      for (const message of messages) {
        await this.onMessage(message).catch((error) =>
          logger.error({ err: error }, "message handling failed"),
        );
      }
    });
  }

  /**
   * Schedule a reconnect attempt with exponential backoff + ±20 % jitter.
   * Caps at MAX_RECONNECT_DELAY_MS so it never waits more than 5 minutes.
   */
  private scheduleReconnect(baseDelayMs: number) {
    if (this.reconnectTimer) return;
    this.reconnecting = true;

    const exponential = Math.min(
      baseDelayMs * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    );
    // Add ±20 % jitter to avoid thundering-herd if multiple bots restart together
    const jitter = exponential * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.round(exponential + jitter);

    this.reconnectAttempt += 1;
    logger.info(
      { delayMs: delay, attempt: this.reconnectAttempt },
      "whatsapp reconnect scheduled",
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        logger.error({ err: error }, "whatsapp reconnect failed");
        this.scheduleReconnect(BASE_RECONNECT_DELAY_MS);
      });
    }, delay);
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
    if (message.key.id && this.processedMessages.hasOrAdd(message.key.id))
      return;
    if (!this.inboundGuard.allow(jid)) {
      await this.sendText(
        jid,
        "Please slow down a little. I will continue replying in a moment.",
      );
      return;
    }
    const media = await maybeAudio(message);
    const caption = extractText(message);
    const transcription = media
      ? await transcribeAudio(media.bytes, media.mimeType)
      : null;
    const text = (caption || transcription || "").trim();
    if (!text && !media) return;

    const adminReply = await handleAdminCommand({
      from: jid,
      text,
      businessId: config.DEFAULT_BUSINESS_ID,
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
      text:
        text ||
        "[Voice note received. Please type the request if transcription is unavailable.]",
      messageId: message.key.id ?? undefined,
      timestamp: messageTimestamp(message),
      media,
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
    bytes: new Uint8Array(bytes),
  };
}
