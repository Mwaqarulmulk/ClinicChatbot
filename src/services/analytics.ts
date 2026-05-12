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
    createdAt: new Date().toISOString(),
  });
}
// Note: analytics queries (aggregated stats) live inline in src/http/app.ts
// inside the GET /admin/analytics route handler for co-location with the API.
