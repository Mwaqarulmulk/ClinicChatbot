import { config, handoffKeywords } from "../config";
import { db } from "../db/client";
import { businesses } from "../db/schema";
import { groq } from "./groq";
import { executeTool, toolDefinitions } from "./tools";
import { searchKnowledge } from "../rag/knowledge-base";
import { bookAppointment } from "../services/appointments";
import { appendMessage, getOrCreateConversation, markHandoff, recentMessages, upsertCustomer } from "../services/customer-store";
import { trackEvent } from "../services/analytics";
import type { ChatReply, InboundMessage } from "../types";
import { detectLanguage, normalizePhone } from "../utils/text";
import { parseLooseDateTime } from "../utils/time";
import { eq } from "drizzle-orm";

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export async function handleInboundMessage(message: InboundMessage): Promise<ChatReply> {
  const language = detectLanguage(message.text);
  const phone = normalizePhone(message.from);
  const customer = await upsertCustomer({
    businessId: message.businessId,
    phone,
    name: message.name,
    language: language === "roman_urdu" ? "en" : language // keep DB enum happy
  });
  const conversation = await getOrCreateConversation({
    businessId: message.businessId,
    customerId: customer.id,
    channel: message.channel
  });

  await appendMessage({
    conversationId: conversation.id,
    role: "user",
    content: message.text,
    providerMessageId: message.messageId
  });

  await trackEvent({
    businessId: message.businessId,
    customerId: customer.id,
    event: "message_received"
  });

  if (shouldHandoff(message.text)) {
    await markHandoff(conversation.id);
    const text =
      language === "ur"
        ? "Theek hai, main aap ko human team se connect kar raha hoon."
        : "Sure, I am connecting you with a human team member.";
    await appendMessage({ conversationId: conversation.id, role: "assistant", content: text });
    return { text, handoff: true };
  }

  const business = await db.query.businesses.findFirst({ where: eq(businesses.id, message.businessId) });
  if (!business) throw new Error(`Business not found: ${message.businessId}`);

  const deterministicBooking = await tryDeterministicBooking({
    text: message.text,
    language,
    timeZone: business.timezone,
    businessId: message.businessId,
    customerId: customer.id
  });
  if (deterministicBooking) {
    // If the tool says "handoff: true", it's yielding back to the main LLM flow
    // rather than genuinely booking deterministically.
    if (!deterministicBooking.handoff) {
      await appendMessage({ conversationId: conversation.id, role: "assistant", content: deterministicBooking.text });
      await trackEvent({
        businessId: message.businessId,
        customerId: customer.id,
        event: deterministicBooking.metadata?.booked ? "appointment_booked" : "booking_info_requested"
      });
      return deterministicBooking;
    }
  }

  const knowledge = await safeSearchKnowledge(message.businessId, message.text);
  const history = await recentMessages(conversation.id);

  const reply = groq
    ? await aiReply({ business, customer: { id: customer.id, name: customer.name, notes: customer.notes }, language, history, knowledge }).catch(() =>
        fallbackReply({ text: message.text, language, businessId: message.businessId, customerId: customer.id })
      )
    : await fallbackReply({ text: message.text, language, businessId: message.businessId, customerId: customer.id });

  if (reply.handoff) await markHandoff(conversation.id);
  await appendMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: reply.text,
    metadata: reply.metadata
  });
  await trackEvent({
    businessId: message.businessId,
    customerId: customer.id,
    event: reply.handoff ? "handoff_created" : "message_replied"
  });
  return reply;
}

async function aiReply(input: {
  business: typeof businesses.$inferSelect;
  customer: { id: string; name?: string | null; notes?: string | null };
  language: "en" | "ur" | "roman_urdu";
  history: Array<{ role: string; content: string }>;
  knowledge: Array<{ title: string; content: string; source?: string }>;
}): Promise<ChatReply> {
  const customerNameStr = input.customer.name ? `The customer's name is ${input.customer.name}. Use it naturally but don't overuse it.` : "You don't know the customer's name yet. If you need it for booking, ask for it politely.";
  const preferencesStr = input.customer.notes ? `\nCustomer Context/Preferences: ${input.customer.notes}\nUse this context to personalize your responses. If they mention new preferences, use update_customer_preferences to save them.` : "If the user mentions any preferences or important context about themselves, use update_customer_preferences to save them.";
  
  let languageInstruction = "Reply in English.";
  if (input.language === "ur") languageInstruction = "Reply in Urdu script (اردو).";
  if (input.language === "roman_urdu") languageInstruction = "Reply in Roman Urdu / Pakistani English (e.g. 'han sir, apka appointment book ho gaya hai. Jazakallah!'). Match the user's friendly Pakistani tone.";

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        input.business.systemPrompt,
        customerNameStr,
        preferencesStr,
        `Detected customer language/style: ${input.language}. ${languageInstruction}`,
        `Current business date and time is ${new Date().toLocaleString("en-US", { timeZone: input.business.timezone })}.`,
        `Current business hours: ${input.business.openHour}:00-${input.business.closeHour}:00, timezone ${input.business.timezone}.`,
        "Act completely human. Be warm, empathetic, and conversational. Adapt your personality, politeness, and tone perfectly to how the customer approaches you (e.g. respectful to elders, professional to formal users, friendly to casual users). Do not sound like a robot. Use a friendly tone, occasional emojis, and keep replies short and natural like a real text message.",
        "When a user says hi, greet them warmly. If you don't know their name, ask how you can help them and politely ask for their name.",
        "Hidden production method: classify intent silently, retrieve only relevant facts, use tools before making commitments.",
        "Answer normal FAQ questions directly when business knowledge or business settings contain the answer.",
        "Only call handoff_to_human for explicit human requests, complaints, unsafe uncertainty, or policy exceptions."
      ].join("\n")
    },
    {
      role: "system",
      content:
        "Business knowledge snippets:\n" +
        (input.knowledge.length
          ? input.knowledge.map((hit, index) => `[${index + 1}] ${hit.title}: ${hit.content}`).join("\n\n")
          : "No relevant snippets found.")
    },
    ...input.history.map((item): ChatMessage => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: item.content
    }))
  ];

  for (let turn = 0; turn < 2; turn += 1) {
    const completion = await groq!.chat.completions.create({
      model: config.GROQ_MODEL,
      temperature: config.AI_TEMPERATURE,
      messages: messages as never,
      tools: toolDefinitions as never,
      tool_choice: "auto",
      max_completion_tokens: 600
    });
    const assistant = completion.choices[0]?.message;
    if (!assistant) return { text: "I could not generate a reply right now. A team member will help you shortly.", handoff: true };
    messages.push(assistant);

    if (!assistant.tool_calls?.length) {
      return {
        text: assistant.content?.trim() || "Thanks. A team member will follow up shortly.",
        metadata: { model: config.GROQ_MODEL, knowledgeCount: input.knowledge.length }
      };
    }

    for (const call of assistant.tool_calls) {
      const result = await executeTool({
        name: call.function.name,
        args: safeJson(call.function.arguments),
        businessId: input.business.id,
        customerId: input.customer.id
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result)
      });
      if (isHandoffResult(result)) {
        return { text: "I am connecting you with a human team member now.", handoff: true, metadata: result };
      }
    }
  }

  return { text: "Thanks, I have noted this. A team member will follow up shortly.", handoff: true };
}

async function fallbackReply(input: { text: string; language: "en" | "ur" | "roman_urdu"; businessId: string; customerId: string }): Promise<ChatReply> {
  const lower = input.text.toLowerCase();
  
  // Only trigger handoff for explicit cancellation requests, not for checking appointments
  const isCancel = /(cancel|reschedule|change|my appointments|what appointments|mera appointment|meri appointment|check|show)/i.test(lower);
  // Don't handoff - let the AI handle it via get_my_appointments tool
  if (isCancel) return { text: "Let me check your appointments for you." };

  const isBooking = /(book|visit|meeting|consultation|schedule|reserve|waqt|appoint|chahiye|karna)/i.test(lower);
  if (isBooking && !isCancel) {
    return { text: "Sure! What time would you like to book?", metadata: { bookingIntent: true } };
  }

  const knowledge = await safeSearchKnowledge(input.businessId, input.text, 1);
  if (knowledge[0]) {
    return { text: knowledge[0].content.slice(0, 900), metadata: { fallback: true } };
  }

  return {
    text:
      input.language === "ur"
        ? "Shukriya! Is bare mein hamari team aap ko jald reply karegi."
        : "Thanks! Our team will reply shortly with the right details.",
    handoff: true
  };
}

async function tryDeterministicBooking(input: {
  text: string;
  language: "en" | "ur" | "roman_urdu";
  timeZone: string;
  businessId: string;
  customerId: string;
}): Promise<ChatReply | null> {
  const lower = input.text.toLowerCase();
  
  // Explicitly exit deterministic handler early for checks or cancellations
  const isCancel = /(cancel|reschedule|change|my appointments|what appointments|mera appointment|meri appointment|check|show)/i.test(lower);
  if (isCancel) return null;

  const isBooking = /(visit|meeting|consultation|schedule|reserve|waqt|appoint|chahiye|karna|book)/i.test(lower);
  
  // Only attempt deterministic booking if there is a date parseable OR if they definitely asked to book
  if (isBooking && !isCancel) {
    const startsAt = parseLooseDateTime(input.text, new Date(), input.timeZone);
    if (!startsAt) {
      return null;
    }

    const result = await bookAppointment({
      businessId: input.businessId,
      customerId: input.customerId,
      startsAt,
      service: inferService(input.text),
      notes: input.text
    });

    if (result.ok) {
      return {
        text:
          input.language === "ur"
            ? `Done, aap ki appointment ${result.label} par book ho gayi hai.`
            : input.language === "roman_urdu"
            ? `Zabardast! Apki appointment book ho gayi hai for ${result.label}.`
            : `Done, your appointment is booked for ${result.label}.`,
        metadata: { booked: true, appointmentId: result.appointment.id }
      };
    }

    return {
      text:
        result.reason === "slot_unavailable"
          ? input.language === "ur" || input.language === "roman_urdu"
            ? "Ye slot available nahi hai. Please koi aur time bhej dein."
            : "That slot is not available. Please send another time."
          : input.language === "ur" || input.language === "roman_urdu"
            ? "Ye time business hours ke bahar hai. Please working hours mein koi time bhej dein."
            : "That time is outside business hours. Please choose a time during working hours.",
      metadata: { bookingIntent: true, reason: result.reason }
    };
  }

  return null;
}

function inferService(text: string): string {
  if (/consult/i.test(text)) return "consultation";
  if (/follow/i.test(text)) return "follow-up";
  return "appointment";
}

function safeJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function shouldHandoff(text: string): boolean {
  const lower = text.toLowerCase();
  return handoffKeywords.some((keyword) => lower.includes(keyword));
}

function isHandoffResult(value: unknown): value is { handoff: true } {
  return typeof value === "object" && value !== null && "handoff" in value && value.handoff === true;
}

async function safeSearchKnowledge(businessId: string, query: string, limit?: number) {
  try {
    return await searchKnowledge({ businessId, query, limit });
  } catch {
    return [];
  }
}
