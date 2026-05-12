export type Channel = "whatsapp" | "api";

export type InboundMessage = {
  businessId: string;
  channel: Channel;
  from: string;
  name?: string;
  text: string;
  messageId?: string;
  timestamp: Date;
  media?: {
    kind: "audio" | "image" | "document";
    mimeType?: string;
    bytes?: Uint8Array;
  };
};

export type OutboundMessage = {
  to: string;
  text: string;
};

export type ChatReply = {
  text: string;
  handoff?: boolean;
  metadata?: Record<string, unknown>;
};

export type WhatsAppTransport = {
  sendText(to: string, text: string): Promise<void>;
  isReady(): boolean;
  /** Gracefully close the underlying connection. Called during SIGTERM shutdown. */
  stop?(): Promise<void>;
};
