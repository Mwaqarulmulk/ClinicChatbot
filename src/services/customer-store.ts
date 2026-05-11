import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { conversations, customers, messages } from "../db/schema";
import type { Channel } from "../types";
import { createId } from "../utils/id";

export async function upsertCustomer(input: {
  businessId: string;
  phone: string;
  name?: string;
  language: "en" | "ur";
}) {
  const now = new Date().toISOString();
  const existing = await db.query.customers.findFirst({
    where: and(eq(customers.businessId, input.businessId), eq(customers.phone, input.phone))
  });

  if (existing) {
    await db
      .update(customers)
      .set({
        name: input.name ?? existing.name,
        language: input.language,
        updatedAt: now
      })
      .where(eq(customers.id, existing.id));
    return { ...existing, name: input.name ?? existing.name, language: input.language };
  }

  const customer = {
    id: createId("cus"),
    businessId: input.businessId,
    phone: input.phone,
    name: input.name,
    language: input.language,
    notes: null,
    createdAt: now,
    updatedAt: now
  };
  await db.insert(customers).values(customer);
  return customer;
}

export async function getOrCreateConversation(input: {
  businessId: string;
  customerId: string;
  channel: Channel;
}) {
  const existing = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.businessId, input.businessId),
      eq(conversations.customerId, input.customerId),
      eq(conversations.status, "active")
    ),
    orderBy: [desc(conversations.lastMessageAt)]
  });

  const now = new Date().toISOString();
  if (existing) {
    await db.update(conversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(conversations.id, existing.id));
    return { ...existing, lastMessageAt: now, updatedAt: now };
  }

  const conversation = {
    id: createId("con"),
    businessId: input.businessId,
    customerId: input.customerId,
    channel: input.channel,
    status: "active",
    lastMessageAt: now,
    handoff: false,
    createdAt: now,
    updatedAt: now
  };
  await db.insert(conversations).values(conversation);
  return conversation;
}

export async function appendMessage(input: {
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  providerMessageId?: string;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(messages).values({
    id: createId("msg"),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    providerMessageId: input.providerMessageId,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt: new Date().toISOString()
  });
}

export async function recentMessages(conversationId: string, limit = 12) {
  const rows = await db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: [desc(messages.createdAt)],
    limit
  });
  return rows.reverse();
}

export async function markHandoff(conversationId: string, value = true) {
  await db
    .update(conversations)
    .set({ handoff: value, updatedAt: new Date().toISOString() })
    .where(eq(conversations.id, conversationId));
}

