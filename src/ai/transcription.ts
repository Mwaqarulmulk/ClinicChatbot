import { groq } from "./groq";
import { logger } from "../logger";

export async function transcribeAudio(bytes: Uint8Array, mimeType = "audio/ogg"): Promise<string | null> {
  if (!groq) return null;
  try {
    const extension = mimeType.includes("mpeg") ? "mp3" : mimeType.includes("wav") ? "wav" : "ogg";
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const file = new File([body], `voice-note.${extension}`, { type: mimeType });
    const response = await groq.audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo",
      response_format: "text",
    });
    // Groq SDK returns a transcription object with a `text` field
    return String((response as { text: string }).text).trim();
  } catch (error) {
    logger.warn({ err: error }, "voice transcription failed");
    return null;
  }
}
