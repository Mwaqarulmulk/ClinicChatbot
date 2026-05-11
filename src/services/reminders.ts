import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db/client";
import { appointments, customers } from "../db/schema";
import { logger } from "../logger";
import type { WhatsAppTransport } from "../types";
import { addMinutes, formatLocal } from "../utils/time";

export function startReminderWorker(transport: WhatsAppTransport) {
  const timer = setInterval(() => {
    void sendDueReminders(transport).catch((error) => logger.error({ err: error }, "reminder worker failed"));
  }, 60_000);
  timer.unref?.();
  void sendDueReminders(transport);
}

async function sendDueReminders(transport: WhatsAppTransport) {
  if (!transport.isReady()) return;
  const now = new Date();
  const reminderWindow = addMinutes(now, config.REMINDER_LEAD_MINUTES);
  const rows = await db
    .select({
      appointment: appointments,
      customer: customers
    })
    .from(appointments)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        eq(appointments.status, "scheduled"),
        isNull(appointments.reminderSentAt),
        gte(appointments.startsAt, now.toISOString()),
        lte(appointments.startsAt, reminderWindow.toISOString())
      )
    );

  for (const row of rows) {
    const startsAt = new Date(row.appointment.startsAt);
    const label = formatLocal(startsAt, config.DEFAULT_TIMEZONE);
    const text =
      row.customer.language === "ur"
        ? `Reminder: aap ki appointment ${label} par hai. Reschedule ke liye reply karein.`
        : `Reminder: your appointment is at ${label}. Reply here if you need to reschedule.`;
    await transport.sendText(row.customer.phone, text);
    await db
      .update(appointments)
      .set({ reminderSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(appointments.id, row.appointment.id));
    logger.info({ appointmentId: row.appointment.id }, "appointment reminder sent");
  }
}
