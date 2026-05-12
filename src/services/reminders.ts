import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db/client";
import { appointments, customers } from "../db/schema";
import { logger } from "../logger";
import type { WhatsAppTransport } from "../types";
import { addMinutes, formatLocal } from "../utils/time";

export function startReminderWorker(transport: WhatsAppTransport) {
  const timer = setInterval(() => {
    void sendDueReminders(transport).catch((error) =>
      logger.error({ err: error }, "reminder worker failed"),
    );
  }, 60_000);
  // Allow Node to exit naturally without the timer keeping the process alive
  timer.unref?.();
  // Do NOT fire immediately on startup — WhatsApp may not be connected yet.
  // The first run happens after the first 60-second tick.
}

async function sendDueReminders(transport: WhatsAppTransport) {
  if (!transport.isReady()) return;

  const now = new Date();
  const reminderWindow = addMinutes(now, config.REMINDER_LEAD_MINUTES);

  const rows = await db
    .select({ appointment: appointments, customer: customers })
    .from(appointments)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        eq(appointments.status, "scheduled"),
        isNull(appointments.reminderSentAt),
        gte(appointments.startsAt, now.toISOString()),
        lte(appointments.startsAt, reminderWindow.toISOString()),
      ),
    );

  for (const row of rows) {
    const startsAt = new Date(row.appointment.startsAt);
    const label = formatLocal(startsAt, config.DEFAULT_TIMEZONE);
    const text =
      row.customer.language === "ur"
        ? `Reminder: aap ki appointment ${label} par hai. Reschedule ke liye reply karein.`
        : `Reminder: your appointment is at ${label}. Reply here if you need to reschedule.`;

    // ── Mark as sent BEFORE sending ───────────────────────────────────────────
    // This prevents a duplicate-send race condition when multiple instances (e.g.
    // during a blue-green Fly.io deploy) query the same un-marked rows at the same
    // time. Marking first means a missed send is preferable to a double send.
    // ─────────────────────────────────────────────────────────────────────────
    await db
      .update(appointments)
      .set({
        reminderSentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(appointments.id, row.appointment.id));

    try {
      await transport.sendText(row.customer.phone, text);
      logger.info(
        { appointmentId: row.appointment.id },
        "appointment reminder sent",
      );
    } catch (error) {
      // Log but don't revert the mark — better a missed reminder than a double one
      logger.error(
        { err: error, appointmentId: row.appointment.id },
        "reminder WhatsApp send failed",
      );
    }
  }
}
