import { db } from "../db/client";
import { analyticsEvents } from "../db/schema";
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
    createdAt: new Date().toISOString()
  });
}

