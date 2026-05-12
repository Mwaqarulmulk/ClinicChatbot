import { adminPhones, config } from "../config";
import { upsertKnowledge } from "../rag/knowledge-base";
import { getBusiness, upcomingAppointments } from "../services/appointments";
import { normalizePhone } from "../utils/text";
import { formatLocal } from "../utils/time";

export async function handleAdminCommand(input: {
  from: string;
  text: string;
  businessId: string;
}): Promise<string | null> {
  const phone = normalizePhone(input.from);
  if (!adminPhones.has(phone)) return null;
  if (!input.text.startsWith("/")) return null;

  const [command, ...rest] = input.text.trim().split(/\s+/);
  const body = rest.join(" ");

  if (command === "/help") {
    return [
      "Admin commands:",
      "/appointments - list upcoming appointments",
      "/learn <title> | <content> - add knowledge",
      "/status - bot status",
    ].join("\n");
  }

  if (command === "/status") {
    return `Bot online. Business: ${config.DEFAULT_BUSINESS_ID}. AI: ${config.GROQ_API_KEY ? "Groq enabled" : "fallback mode"}.`;
  }

  if (command === "/appointments") {
    const rows = await upcomingAppointments(input.businessId, 10);
    if (!rows.length) return "No upcoming appointments.";
    // Get business timezone for human-readable formatting
    const business = await getBusiness(input.businessId);
    return rows
      .map(
        (row, index) =>
          `${index + 1}. ${formatLocal(new Date(row.startsAt), business.timezone)} — ${row.service} (${row.status})`,
      )
      .join("\n");
  }

  if (command === "/learn") {
    const [title, content] = body.split("|").map((part) => part?.trim());
    if (!title || !content) return "Usage: /learn <title> | <content>";
    const count = await upsertKnowledge({
      businessId: input.businessId,
      title,
      content,
      source: "whatsapp-admin",
    });
    return `Knowledge saved in ${count} chunk(s).`;
  }

  return "Unknown admin command. Send /help.";
}
