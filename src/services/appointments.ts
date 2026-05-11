import { and, asc, eq, gte, lt, ne } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db/client";
import { appointments, businesses } from "../db/schema";
import { addMinutes, formatLocal, startOfZonedDay, zonedBusinessTime, zonedHourValue } from "../utils/time";
import { createId } from "../utils/id";

export async function getBusiness(businessId: string) {
  const business = await db.query.businesses.findFirst({ where: eq(businesses.id, businessId) });
  if (!business) throw new Error(`Business not found: ${businessId}`);
  return business;
}

export async function getAvailability(input: { businessId: string; date: Date }) {
  const business = await getBusiness(input.businessId);
  const dayStart = startOfZonedDay(input.date, business.timezone);
  const dayEnd = addMinutes(dayStart, 24 * 60);

  const existing = await db.query.appointments.findMany({
    where: and(
      eq(appointments.businessId, input.businessId),
      gte(appointments.startsAt, dayStart.toISOString()),
      lt(appointments.startsAt, dayEnd.toISOString()),
      ne(appointments.status, "cancelled")
    )
  });

  const occupied = new Set(existing.map((appointment) => appointment.startsAt));
  const slots: Date[] = [];
  const cursor = zonedBusinessTime(input.date, business.timezone, business.openHour);
  const close = zonedBusinessTime(input.date, business.timezone, business.closeHour);

  while (cursor < close) {
    if (cursor > new Date() && !occupied.has(cursor.toISOString())) {
      slots.push(new Date(cursor));
    }
    cursor.setMinutes(cursor.getMinutes() + business.appointmentDurationMinutes);
  }

  return {
    timezone: business.timezone,
    slots: slots.slice(0, 12).map((slot) => ({ iso: slot.toISOString(), label: formatLocal(slot, business.timezone) }))
  };
}

export async function bookAppointment(input: {
  businessId: string;
  customerId: string;
  startsAt: Date;
  service?: string;
  notes?: string;
}) {
  const business = await getBusiness(input.businessId);
  const startsAt = new Date(input.startsAt);
  const endsAt = addMinutes(startsAt, business.appointmentDurationMinutes);
  if (!isInsideBusinessHours(startsAt, business.timezone, business.openHour, business.closeHour)) {
    return { ok: false as const, reason: "outside_business_hours" };
  }

  const conflicting = await db.query.appointments.findFirst({
    where: and(
      eq(appointments.businessId, input.businessId),
      eq(appointments.startsAt, startsAt.toISOString()),
      ne(appointments.status, "cancelled")
    )
  });
  if (conflicting) return { ok: false as const, reason: "slot_unavailable" };

  const now = new Date().toISOString();
  const appointment = {
    id: createId("apt"),
    businessId: input.businessId,
    customerId: input.customerId,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    status: "scheduled",
    service: input.service ?? "consultation",
    notes: input.notes,
    reminderSentAt: null,
    createdAt: now,
    updatedAt: now
  };
  await db.insert(appointments).values(appointment);
  return {
    ok: true as const,
    appointment,
    label: formatLocal(startsAt, business.timezone)
  };
}

export async function upcomingAppointments(businessId = config.DEFAULT_BUSINESS_ID, limit = 20) {
  return db.query.appointments.findMany({
    where: and(
      eq(appointments.businessId, businessId),
      gte(appointments.startsAt, new Date().toISOString()),
      eq(appointments.status, "scheduled")
    ),
    orderBy: [asc(appointments.startsAt)],
    limit
  });
}

export async function getCustomerAppointments(input: { businessId: string; customerId: string }) {
  return db.query.appointments.findMany({
    where: and(
      eq(appointments.businessId, input.businessId),
      eq(appointments.customerId, input.customerId),
      gte(appointments.startsAt, new Date().toISOString()),
      eq(appointments.status, "scheduled")
    ),
    orderBy: [asc(appointments.startsAt)]
  });
}

export async function cancelAppointment(input: { businessId: string; customerId: string; startsAt: Date }) {
  const targetIso = input.startsAt.toISOString();
  const match = await db.query.appointments.findFirst({
    where: and(
      eq(appointments.businessId, input.businessId),
      eq(appointments.customerId, input.customerId),
      eq(appointments.startsAt, targetIso),
      eq(appointments.status, "scheduled")
    )
  });

  if (!match) return { ok: false, reason: "appointment_not_found" };

  await db
    .update(appointments)
    .set({ status: "cancelled", updatedAt: new Date().toISOString() })
    .where(eq(appointments.id, match.id));

  return { ok: true, appointmentId: match.id };
}

function isInsideBusinessHours(date: Date, timeZone: string, openHour: number, closeHour: number): boolean {
  const hour = zonedHourValue(date, timeZone);
  return hour >= openHour && hour < closeHour;
}
