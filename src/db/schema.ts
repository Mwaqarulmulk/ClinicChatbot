import { relations } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const businesses = sqliteTable("businesses", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  openHour: integer("open_hour").notNull(),
  closeHour: integer("close_hour").notNull(),
  appointmentDurationMinutes: integer("appointment_duration_minutes").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const customers = sqliteTable(
  "customers",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id),
    phone: text("phone").notNull(),
    name: text("name"),
    language: text("language").notNull().default("en"),
    notes: text("notes"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    phoneBusinessIdx: uniqueIndex("customers_phone_business_idx").on(table.businessId, table.phone)
  })
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    channel: text("channel").notNull(),
    status: text("status").notNull().default("active"),
    lastMessageAt: text("last_message_at").notNull(),
    handoff: integer("handoff", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    customerIdx: index("conversations_customer_idx").on(table.customerId)
  })
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text("role").notNull(),
    content: text("content").notNull(),
    providerMessageId: text("provider_message_id"),
    metadata: text("metadata"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    conversationIdx: index("messages_conversation_idx").on(table.conversationId)
  })
);

export const appointments = sqliteTable(
  "appointments",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull(),
    status: text("status").notNull().default("scheduled"),
    service: text("service").notNull().default("consultation"),
    notes: text("notes"),
    reminderSentAt: text("reminder_sent_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    scheduleIdx: index("appointments_schedule_idx").on(table.businessId, table.startsAt, table.status)
  })
);

export const analyticsEvents = sqliteTable(
  "analytics_events",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull(),
    customerId: text("customer_id"),
    event: text("event").notNull(),
    value: real("value"),
    metadata: text("metadata"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    eventIdx: index("analytics_event_idx").on(table.businessId, table.event, table.createdAt)
  })
);

export const businessRelations = relations(businesses, ({ many }) => ({
  customers: many(customers),
  appointments: many(appointments)
}));

export const customerRelations = relations(customers, ({ one, many }) => ({
  business: one(businesses, { fields: [customers.businessId], references: [businesses.id] }),
  conversations: many(conversations),
  appointments: many(appointments)
}));

