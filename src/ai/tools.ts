import { z } from "zod";
import { bookAppointment, cancelAppointment, getAvailability, getBusiness, getCustomerAppointments } from "../services/appointments";
import { parseLooseDateTime } from "../utils/time";

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "get_availability",
      description: "Get open appointment slots for a business date.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Requested date as ISO date, ISO datetime, or natural date phrase." }
        },
        required: ["date"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description: "Book an appointment only after the customer has provided enough details.",
      parameters: {
        type: "object",
        properties: {
          startsAt: { type: "string", description: "Appointment start time as ISO datetime or natural phrase." },
          service: { type: "string" },
          notes: { type: "string" }
        },
        required: ["startsAt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description: "Cancel an existing scheduled appointment for the customer.",
      parameters: {
        type: "object",
        properties: {
          startsAt: { type: "string", description: "The start time of the appointment to cancel." }
        },
        required: ["startsAt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_customer_name",
      description: "Update or save the customer's name if they mention it.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The customer's name." }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_customer_preferences",
      description: "Store personal preferences or important context about the customer (e.g., preferred languages, favorite services, constraints).",
      parameters: {
        type: "object",
        properties: {
          notes: { type: "string", description: "Context or preferences to remember about the customer." }
        },
        required: ["notes"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_my_appointments",
      description: "Get the list of upcoming appointments for the current customer so you can show them their schedule.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "handoff_to_human",
      description: "Escalate only when the customer explicitly asks for a human, is angry, requests a policy exception, or the answer cannot be found in tools or knowledge. Do not use this for ordinary FAQ answers.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" }
        },
        required: ["reason"]
      }
    }
  }
] as const;

const availabilitySchema = z.object({ date: z.string() });
const bookingSchema = z.object({
  startsAt: z.string(),
  service: z.string().optional(),
  notes: z.string().optional()
});
const handoffSchema = z.object({ reason: z.string() });

const cancelSchema = z.object({ startsAt: z.string() });
const updateNameSchema = z.object({ name: z.string() });
const updatePreferencesSchema = z.object({ notes: z.string() });

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
    if (Number.isNaN(date.getTime())) return { ok: false, reason: "invalid_date" };
    return { ok: true, ...(await getAvailability({ businessId: input.businessId, date })) };
  }

  if (input.name === "book_appointment") {
    const args = bookingSchema.parse(input.args);
    const business = await getBusiness(input.businessId);
    const startsAt = parseLooseDateTime(args.startsAt, new Date(), business.timezone) ?? new Date(args.startsAt);
    if (Number.isNaN(startsAt.getTime())) return { ok: false, reason: "invalid_datetime" };
    return bookAppointment({
      businessId: input.businessId,
      customerId: input.customerId,
      startsAt,
      service: args.service,
      notes: args.notes
    });
  }

  if (input.name === "cancel_appointment") {
    const args = cancelSchema.parse(input.args);
    const business = await getBusiness(input.businessId);
    const startsAt = parseLooseDateTime(args.startsAt, new Date(), business.timezone) ?? new Date(args.startsAt);
    if (Number.isNaN(startsAt.getTime())) return { ok: false, reason: "invalid_datetime" };
    return cancelAppointment({
      businessId: input.businessId,
      customerId: input.customerId,
      startsAt
    });
  }

  if (input.name === "update_customer_name") {
    const args = updateNameSchema.parse(input.args);
    const { db } = await import("../db/client");
    const { customers } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(customers).set({ name: args.name }).where(eq(customers.id, input.customerId));
    return { ok: true, name: args.name };
  }

  if (input.name === "update_customer_preferences") {
    const args = updatePreferencesSchema.parse(input.args);
    const { db } = await import("../db/client");
    const { customers } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(customers).set({ notes: args.notes }).where(eq(customers.id, input.customerId));
    return { ok: true, notes: args.notes };
  }

  if (input.name === "get_my_appointments") {
    const appointments = await getCustomerAppointments({
      businessId: input.businessId,
      customerId: input.customerId
    });
    return { ok: true, appointments };
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
    return parseLooseDateTime("tomorrow 12am", new Date(), timeZone) ?? new Date(value);
  }
  if (lower.includes("today")) {
    return parseLooseDateTime("today 12am", new Date(), timeZone) ?? new Date(value);
  }
  return parseLooseDateTime(value, new Date(), timeZone) ?? new Date(value);
}
