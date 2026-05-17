import { z } from "zod";
import {
  bookAppointment,
  cancelAppointment,
  getAvailability,
  getBusiness,
  getCustomerAppointments,
} from "../services/appointments";
import { parseLooseDateTime, formatLocal } from "../utils/time";

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "get_availability",
      description: "Get open appointment slots for a business date.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description:
              "Requested date as ISO date, ISO datetime, or natural date phrase.",
          },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book an appointment only after the customer has provided enough details.",
      parameters: {
        type: "object",
        properties: {
          startsAt: {
            type: "string",
            description:
              "Appointment start time as natural phrase like 'tomorrow at 10am' or 'Friday 3pm'. Do NOT pass ISO strings.",
          },
          service: { type: "string" },
          notes: { type: "string" },
        },
        required: ["startsAt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description:
        "Cancel an existing scheduled appointment for the customer. Pass the EXACT startsAt ISO string from get_my_appointments results.",
      parameters: {
        type: "object",
        properties: {
          startsAt: {
            type: "string",
            description:
              "The exact startsAt ISO string from get_my_appointments (e.g. '2026-05-14T05:00:00.000Z'). Use it exactly as returned — do not format or convert.",
          },
        },
        required: ["startsAt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_customer_name",
      description: "Update or save the customer's name if they mention it.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The customer's name." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_customer_preferences",
      description:
        "Store personal preferences or important context about the customer (e.g., preferred languages, favorite services, constraints).",
      parameters: {
        type: "object",
        properties: {
          notes: {
            type: "string",
            description:
              "Context or preferences to remember about the customer.",
          },
        },
        required: ["notes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_appointments",
      description:
        "Get the list of upcoming appointments for the current customer. Returns appointments with BOTH raw startsAt (use for cancel_appointment) and localTime (use for displaying to user).",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "handoff_to_human",
      description:
        "Escalate only when the customer explicitly asks for a human, is angry, requests a policy exception, or the answer cannot be found in tools or knowledge. Do not use this for ordinary FAQ answers.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
] as const;

const availabilitySchema = z.object({ date: z.string() });
const bookingSchema = z.object({
  startsAt: z.string(),
  service: z.string().optional(),
  notes: z.string().optional(),
});
const handoffSchema = z.object({ reason: z.string() });
const cancelSchema = z.object({ startsAt: z.string() });
const updateNameSchema = z.object({ name: z.string() });
const updatePreferencesSchema = z.object({ notes: z.string() });

/**
 * Detect whether a string is already a proper ISO datetime string.
 * These must be parsed with `new Date()` directly — NOT through parseLooseDateTime,
 * because parseLooseDateTime extracts hour/minute components and re-applies the
 * business timezone, causing a double-conversion that shifts the time.
 */
function isIsoDatetime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

/**
 * Parse a datetime argument from an AI tool call.
 * - ISO datetime strings (from get_my_appointments) → parse directly as UTC, no conversion
 * - Natural language ("tomorrow at 10am") → run through parseLooseDateTime with timezone
 */
function parseDatetimeArg(value: string, timezone: string): Date {
  if (isIsoDatetime(value)) {
    // Already UTC — use directly to avoid double timezone conversion
    return new Date(value);
  }
  // Natural language phrase
  return parseLooseDateTime(value, new Date(), timezone) ?? new Date(value);
}

export async function executeTool(input: {
  name: string;
  args: Record<string, unknown>;
  businessId: string;
  customerId: string;
}) {
  if (input.name === "get_availability") {
    const args = availabilitySchema.parse(input.args);
    const business = await getBusiness(input.businessId);
    const date = parseDateArg(args.date, business.timezone);
    if (Number.isNaN(date.getTime()))
      return { ok: false, reason: "invalid_date" };
    return {
      ok: true,
      ...(await getAvailability({ businessId: input.businessId, date })),
    };
  }

  if (input.name === "book_appointment") {
    const args = bookingSchema.parse(input.args);
    const business = await getBusiness(input.businessId);
    // For booking, always use natural language parsing (AI should pass phrases not ISO)
    const startsAt =
      parseLooseDateTime(args.startsAt, new Date(), business.timezone) ??
      new Date(args.startsAt);
    if (Number.isNaN(startsAt.getTime()))
      return { ok: false, reason: "invalid_datetime" };
    return bookAppointment({
      businessId: input.businessId,
      customerId: input.customerId,
      startsAt,
      service: args.service,
      notes: args.notes,
    });
  }

  if (input.name === "cancel_appointment") {
    const args = cancelSchema.parse(input.args);
    const business = await getBusiness(input.businessId);

    // Use parseDatetimeArg which handles ISO strings WITHOUT double timezone conversion
    const startsAt = parseDatetimeArg(args.startsAt, business.timezone);
    if (Number.isNaN(startsAt.getTime()))
      return { ok: false, reason: "invalid_datetime" };

    // Try exact match first
    const exactResult = await cancelAppointment({
      businessId: input.businessId,
      customerId: input.customerId,
      startsAt,
    });
    if (exactResult.ok) return exactResult;

    // Fuzzy fallback: find the appointment closest in time (within ±2 hours)
    // This handles cases where the AI passes a slightly different ISO string
    const allAppts = await getCustomerAppointments({
      businessId: input.businessId,
      customerId: input.customerId,
    });
    if (allAppts.length > 0) {
      const targetMs = startsAt.getTime();
      const closest = allAppts.reduce((prev, curr) => {
        const pd = Math.abs(new Date(prev.startsAt).getTime() - targetMs);
        const cd = Math.abs(new Date(curr.startsAt).getTime() - targetMs);
        return cd < pd ? curr : prev;
      });
      const diffMs = Math.abs(new Date(closest.startsAt).getTime() - targetMs);
      if (diffMs < 2 * 60 * 60 * 1000) {
        return cancelAppointment({
          businessId: input.businessId,
          customerId: input.customerId,
          startsAt: new Date(closest.startsAt),
        });
      }
    }

    return exactResult; // Return the "not found" result
  }

  if (input.name === "update_customer_name") {
    const args = updateNameSchema.parse(input.args);
    const { db } = await import("../db/client");
    const { customers } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(customers)
      .set({ name: args.name })
      .where(eq(customers.id, input.customerId));
    return { ok: true, name: args.name };
  }

  if (input.name === "update_customer_preferences") {
    const args = updatePreferencesSchema.parse(input.args);
    const { db } = await import("../db/client");
    const { customers } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(customers)
      .set({ notes: args.notes })
      .where(eq(customers.id, input.customerId));
    return { ok: true, notes: args.notes };
  }

  if (input.name === "get_my_appointments") {
    const business = await getBusiness(input.businessId);
    const appts = await getCustomerAppointments({
      businessId: input.businessId,
      customerId: input.customerId,
    });
    // Return BOTH raw ISO (for cancel_appointment) and formatted local time (for display)
    return {
      ok: true,
      timezone: business.timezone,
      currentTime: formatLocal(new Date(), business.timezone),
      appointments: appts.map((a) => ({
        id: a.id,
        startsAt: a.startsAt, // Raw ISO — pass this exact string to cancel_appointment
        localTime: formatLocal(new Date(a.startsAt), business.timezone), // Human-readable — use for display
        service: a.service,
        status: a.status,
      })),
    };
  }

  if (input.name === "handoff_to_human") {
    const args = handoffSchema.parse(input.args);
    return { ok: true, handoff: true, reason: args.reason };
  }

  return { ok: false, reason: "unknown_tool" };
}

function parseDateArg(value: string, timeZone: string): Date {
  const lower = value.toLowerCase();
  if (lower.includes("tomorrow")) {
    return (
      parseLooseDateTime("tomorrow 12am", new Date(), timeZone) ??
      new Date(value)
    );
  }
  if (lower.includes("today")) {
    return (
      parseLooseDateTime("today 12am", new Date(), timeZone) ?? new Date(value)
    );
  }
  return parseDatetimeArg(value, timeZone);
}
