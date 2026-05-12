import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { analyticsEvents, customers } from "../db/schema";
import { createId } from "../utils/id";

export async function trackEvent(input: {
  businessId: string;
  customerId?: string;
  event: string;
  value?: number;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(analyticsEvents).values({
    id: createId("evt"),
    businessId: input.businessId,
    customerId: input.customerId,
    event: input.event,
    value: input.value,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt: new Date().toISOString(),
  });
}

export async function getAnalyticsSummary(businessId: string) {
  const now = new Date();

  // Today: midnight local time expressed as UTC ISO string
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  // Week: most recent Sunday at midnight
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);

  // Month: first day of the current month at midnight
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

  const todayStr = todayStart.toISOString();
  const weekStr = weekStart.toISOString();
  const monthStr = monthStart.toISOString();

  /**
   * Count rows in analytics_events for a given event type since a given ISO timestamp.
   */
  const countEvents = async (event: string, since: string): Promise<number> => {
    const rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(analyticsEvents)
      .where(
        and(
          eq(analyticsEvents.businessId, businessId),
          eq(analyticsEvents.event, event),
          gte(analyticsEvents.createdAt, since),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  };

  // Fire all queries in parallel for efficiency
  const [
    msgsToday,
    msgsWeek,
    msgsMonth,
    replToday,
    replWeek,
    replMonth,
    apptToday,
    apptWeek,
    apptMonth,
    handToday,
    handWeek,
    handMonth,
    totalCustomersRows,
    newCustomersWeekRows,
  ] = await Promise.all([
    // message_received
    countEvents("message_received", todayStr),
    countEvents("message_received", weekStr),
    countEvents("message_received", monthStr),

    // message_replied
    countEvents("message_replied", todayStr),
    countEvents("message_replied", weekStr),
    countEvents("message_replied", monthStr),

    // appointment_booked
    countEvents("appointment_booked", todayStr),
    countEvents("appointment_booked", weekStr),
    countEvents("appointment_booked", monthStr),

    // handoff_created
    countEvents("handoff_created", todayStr),
    countEvents("handoff_created", weekStr),
    countEvents("handoff_created", monthStr),

    // total customers for this business
    db
      .select({ count: sql<number>`count(*)` })
      .from(customers)
      .where(eq(customers.businessId, businessId)),

    // new customers since the start of this week
    db
      .select({ count: sql<number>`count(*)` })
      .from(customers)
      .where(
        and(
          eq(customers.businessId, businessId),
          gte(customers.createdAt, weekStr),
        ),
      ),
  ]);

  const totalCustomers = Number(totalCustomersRows[0]?.count ?? 0);
  const newThisWeek = Number(newCustomersWeekRows[0]?.count ?? 0);

  // Handoff rate: handoffs this month as a percentage of messages received this month
  const handoffRate =
    msgsMonth > 0 ? Math.round((handMonth / msgsMonth) * 100) : 0;

  return {
    period: {
      today: todayStr,
      weekStart: weekStr,
      monthStart: monthStr,
    },
    messages: {
      today: msgsToday,
      week: msgsWeek,
      month: msgsMonth,
    },
    replies: {
      today: replToday,
      week: replWeek,
      month: replMonth,
    },
    appointments: {
      today: apptToday,
      week: apptWeek,
      month: apptMonth,
    },
    handoffs: {
      today: handToday,
      week: handWeek,
      month: handMonth,
    },
    customers: {
      total: totalCustomers,
      newThisWeek,
    },
    handoffRate,
  };
}
