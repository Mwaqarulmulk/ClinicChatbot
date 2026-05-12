import { config, handoffKeywords } from "../config";
import { db } from "../db/client";
import { businesses } from "../db/schema";
import { groq } from "./groq";
import { executeTool, toolDefinitions } from "./tools";
import { searchKnowledge } from "../rag/knowledge-base";
import {
  bookAppointment,
  getCustomerAppointments,
} from "../services/appointments";
import {
  appendMessage,
  getOrCreateConversation,
  markHandoff,
  recentMessages,
  upsertCustomer,
} from "../services/customer-store";
import { trackEvent } from "../services/analytics";
import { logger } from "../logger";
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

// Intent types for query analysis
type QueryIntent = {
  type:
    | "greeting"
    | "booking"
    | "availability"
    | "cancel"
    | "inquiry"
    | "complaint"
    | "general";
  confidence: number;
  details?: string;
};

function analyzeIntent(
  text: string,
  language: "en" | "ur" | "roman_urdu",
): QueryIntent {
  const lower = text.toLowerCase();

  // Greeting patterns
  if (
    /^(hi+|hello|hey|salam|assalamualikum|namaste|aoa|good morning|good afternoon|good evening)/i.test(
      lower.trim(),
    )
  ) {
    return { type: "greeting", confidence: 0.9 };
  }

  // ── Inquiry about EXISTING appointments (check BEFORE booking) ────────────
  // Prevents "tell me my booking" from being misclassified as a new booking request.
  if (
    /\b(tell me|show me|what is my|my booking|booking detail|appointment detail|already book|i have book|i book|maine book|mera appointment|meri appointment|appoint.*status|check.*appoint|what.*appoint|my appoint|detail.*appoint|mujhe.*appoint|appoint.*deta|apna appointment|cancel|reschedule)/i.test(
      lower,
    )
  ) {
    if (/cancel|reschedule/i.test(lower)) {
      return { type: "cancel", confidence: 0.9 };
    }
    return { type: "inquiry", confidence: 0.9 };
  }

  // Booking intent (only after inquiry check)
  if (
    /book|appointment|visit|meeting|consult|schedule|reserve|waqt|appoint|chahiye|karna/i.test(
      lower,
    )
  ) {
    if (/check|availability|slots|time|kitne|kaun sa/i.test(lower)) {
      return { type: "availability", confidence: 0.8 };
    }
    return { type: "booking", confidence: 0.85 };
  }

  // Cancel/Reschedule
  if (/cancel|reschedule|change|remove|delete/i.test(lower)) {
    return { type: "cancel", confidence: 0.85 };
  }

  // Inquiry about services, prices, hours
  if (
    /what|how|tell me|information|info|hours|timing|price|fee|policy|service/i.test(
      lower,
    )
  ) {
    return { type: "inquiry", confidence: 0.75 };
  }

  // Complaint/frustration
  if (
    /bad|worst|terrible|complaint|problem|issue|not happy|disappointed|frustrat/i.test(
      lower,
    )
  ) {
    return { type: "complaint", confidence: 0.8 };
  }

  return { type: "general", confidence: 0.5 };
}

export async function handleInboundMessage(
  message: InboundMessage,
): Promise<ChatReply> {
  const language = detectLanguage(message.text);
  const phone = normalizePhone(message.from);

  // Get or create customer with full context
  const customer = await upsertCustomer({
    businessId: message.businessId,
    phone,
    name: message.name,
    language: language === "roman_urdu" ? "en" : language,
  });

  const conversation = await getOrCreateConversation({
    businessId: message.businessId,
    customerId: customer.id,
    channel: message.channel,
  });

  // Store the user message
  await appendMessage({
    conversationId: conversation.id,
    role: "user",
    content: message.text,
    providerMessageId: message.messageId,
  });

  await trackEvent({
    businessId: message.businessId,
    customerId: customer.id,
    event: "message_received",
  });

  // Analyze query intent first
  const intent = analyzeIntent(message.text, language);

  // Handle handoff requests
  if (shouldHandoff(message.text)) {
    await markHandoff(conversation.id);
    const text =
      language === "ur"
        ? "Theek hai, main aap ko human team se connect kar raha hoon."
        : "Sure, I am connecting you with a human team member.";
    await appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: text,
    });
    return { text, handoff: true };
  }

  // Get business info
  const business = await db.query.businesses.findFirst({
    where: eq(businesses.id, message.businessId),
  });
  if (!business) throw new Error(`Business not found: ${message.businessId}`);

  // Handle deterministic booking (fast path)
  const deterministicBooking = await tryDeterministicBooking({
    text: message.text,
    language,
    timeZone: business.timezone,
    businessId: message.businessId,
    customerId: customer.id,
  });
  if (deterministicBooking && !deterministicBooking.handoff) {
    await appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: deterministicBooking.text,
    });
    await trackEvent({
      businessId: message.businessId,
      customerId: customer.id,
      event: deterministicBooking.metadata?.booked
        ? "appointment_booked"
        : "booking_info_requested",
    });
    return deterministicBooking;
  }

  // Get knowledge base results
  const knowledge = await safeSearchKnowledge(message.businessId, message.text);

  // Get conversation history for consistent context
  const history = await recentMessages(conversation.id, 10);

  // Get customer's appointments for context
  const customerAppointments = await getCustomerAppointments({
    businessId: message.businessId,
    customerId: customer.id,
  });

  // Generate AI reply with full context
  logger.debug(
    { groqEnabled: !!groq, textPreview: message.text.substring(0, 20) },
    "generating ai reply",
  );

  const reply = groq
    ? await aiReply({
        business,
        customer: {
          id: customer.id,
          name: customer.name,
          notes: customer.notes,
          phone: customer.phone,
        },
        language,
        history,
        knowledge,
        intent,
        customerAppointments: customerAppointments.map((a) => ({
          startsAt: a.startsAt,
          service: a.service,
          status: a.status,
        })),
      }).catch((err: Error) => {
        logger.error({ err }, "ai reply failed; using fallback");
        return fallbackReply({
          text: message.text,
          language,
          businessId: message.businessId,
          customerId: customer.id,
        });
      })
    : await fallbackReply({
        text: message.text,
        language,
        businessId: message.businessId,
        customerId: customer.id,
      });

  if (reply.handoff) await markHandoff(conversation.id);
  await appendMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: reply.text,
    metadata: { ...reply.metadata, intent: intent.type },
  });
  await trackEvent({
    businessId: message.businessId,
    customerId: customer.id,
    event: reply.handoff ? "handoff_created" : "message_replied",
  });
  return reply;
}

async function aiReply(input: {
  business: typeof businesses.$inferSelect;
  customer: {
    id: string;
    name?: string | null;
    notes?: string | null;
    phone: string;
  };
  language: "en" | "ur" | "roman_urdu";
  history: Array<{ role: string; content: string }>;
  knowledge: Array<{ title: string; content: string; source?: string }>;
  intent: QueryIntent;
  customerAppointments: Array<{
    startsAt: string;
    service: string;
    status: string;
  }>;
}): Promise<ChatReply> {
  let languageInstruction = "Reply in English.";
  if (input.language === "ur")
    languageInstruction = "Reply in Urdu script (اردو).";
  if (input.language === "roman_urdu")
    languageInstruction =
      "Reply in Roman Urdu / Pakistani English (e.g. 'han sir, apka appointment book ho gaya hai. Jazakallah!'). Match the user's friendly Pakistani tone.";

  // Build user context - this is a known customer, provide personalized service
  const customerNameStr = input.customer.name
    ? `Customer profile: ${input.customer.name} (Phone: ${input.customer.phone}). Use their name naturally in responses.`
    : "This is a returning customer. Ask for their name politely if they haven't provided it.";

  const preferencesStr = input.customer.notes
    ? `\nKnown customer preferences: ${input.customer.notes}\nUse this to personalize your responses.`
    : "";

  // Include appointment history for context
  const appointmentContext =
    input.customerAppointments.length > 0
      ? `\nThis customer's appointment history:\n` +
        input.customerAppointments
          .map((a) => `- ${a.startsAt}: ${a.service} (${a.status})`)
          .join("\n")
      : "\nThis is a new customer with no prior appointments.";

  // Include intent analysis in system prompt
  const intentStr =
    `\nCustomer query analysis: ${input.intent.type} (confidence: ${input.intent.confidence}). ` +
    `Tailor your response based on this intent. For greetings - be warm. For booking - help them book. For availability - show slots. For cancel - help them cancel.`;

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        // ── ROLE & PERSONA ────────────────────────────────────────────────────────────────────────
        input.business.systemPrompt,
        "",
        // ── CUSTOMER CONTEXT ──────────────────────────────────────────────────────────
        customerNameStr,
        preferencesStr,
        appointmentContext,
        "",
        // ── STRICT RULES (follow every single one) ──────────────────────────────────
        "STRICT RULES:",
        "1. NEVER copy or repeat any knowledge snippet text verbatim. Use snippets as background only; always write your reply in your own words.",
        "2. Keep replies SHORT — 2–3 sentences max. This is WhatsApp, not email.",
        "3. Greetings (hi / hello / salam / aoa): reply warmly using the customer's name. Do NOT call any tools.",
        "4. 'What is my name' / 'tell me about me' / 'who am I': answer directly from the Customer Context above. Do NOT call any tools.",
        "5. 'My appointments' / 'my booking' / 'booking detail' / 'already booked': call get_my_appointments FIRST, then reply with the result. Do NOT ask for a date/time.",
        "6. Booking a new appointment: ask for date+time if not provided, then call book_appointment.",
        "7. Cancellation: call get_my_appointments first to see what exists, then call cancel_appointment.",
        "8. NEVER call handoff_to_human for ordinary questions. Only escalate when the customer explicitly demands a human, or for a serious unresolvable complaint.",
        "",
        // ── CURRENT CONTEXT ─────────────────────────────────────────────────────────────────────
        `Language: ${input.language}. ${languageInstruction}`,
        `Business hours: ${input.business.openHour}:00–${input.business.closeHour}:00 (${input.business.timezone})`,
        `Current time: ${new Date().toLocaleString("en-US", { timeZone: input.business.timezone })}`,
        intentStr,
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      role: "system",
      content:
        // Label these clearly as reference material to prevent verbatim repetition
        "REFERENCE KNOWLEDGE — use to answer questions naturally; NEVER repeat verbatim:\n" +
        (input.knowledge.length
          ? input.knowledge
              .map(
                (hit, index) => `[${index + 1}] ${hit.title}: ${hit.content}`,
              )
              .join("\n\n")
          : "No knowledge snippets found."),
    },
    ...input.history.map(
      (item): ChatMessage => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: item.content,
      }),
    ),
  ];

  // 5 turns: typical flows are get_appointments(1) → reply(2) or
  // get_availability(1) → book(2) → reply(3). 2 was always too tight.
  for (let turn = 0; turn < 5; turn += 1) {
    logger.debug({ turn }, "calling groq");
    const completion = await groq!.chat.completions.create({
      model: config.GROQ_MODEL,
      temperature: config.AI_TEMPERATURE,
      messages: messages as never,
      tools: toolDefinitions as never,
      tool_choice: "auto",
      max_completion_tokens: 600,
    });
    const assistant = completion.choices[0]?.message;
    if (!assistant)
      return {
        text: "I could not generate a reply right now. A team member will help you shortly.",
        handoff: true,
      };
    messages.push(assistant);

    if (!assistant.tool_calls?.length) {
      return {
        text:
          assistant.content?.trim() ||
          "Thanks. A team member will follow up shortly.",
        metadata: {
          model: config.GROQ_MODEL,
          knowledgeCount: input.knowledge.length,
        },
      };
    }

    for (const call of assistant.tool_calls) {
      const result = await executeTool({
        name: call.function.name,
        args: safeJson(call.function.arguments),
        businessId: input.business.id,
        customerId: input.customer.id,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
      if (isHandoffResult(result)) {
        return {
          text: "I am connecting you with a human team member now.",
          handoff: true,
          metadata: result,
        };
      }
    }
  }

  return {
    text: "Thanks, I have noted this. A team member will follow up shortly.",
    handoff: true,
  };
}

async function fallbackReply(input: {
  text: string;
  language: "en" | "ur" | "roman_urdu";
  businessId: string;
  customerId: string;
}): Promise<ChatReply> {
  const lower = input.text.toLowerCase().trim();
  const isRU = input.language === "roman_urdu";
  const isUR = input.language === "ur";

  // ── 1. Greetings ───────────────────────────────────────────────────────────────────
  if (/^(hi+|hello|hey|salam|assalam|namaste|aoa|aslam\s*u)\b/i.test(lower)) {
    return {
      text: isUR
        ? "سلام! آپ کیسہ ہیں؟ Demo Clinic کا WhatsApp اسسٹنٹ کیا مدد کر سکتا ہڼوں؟"
        : isRU
          ? "Salam! Main Demo Clinic ka WhatsApp assistant hoon. Kya madad kar sakta hoon? 😊"
          : "Hello! I'm the WhatsApp assistant for Demo Clinic. How can I help you today? 😊",
    };
  }

  // ── 2. Inquiry about EXISTING appointments ("already booked", "my booking", etc.) ───
  // IMPORTANT: check this BEFORE isBooking to prevent false booking prompt.
  const isInquiry =
    /(tell me|show me|what is my|my booking|booking detail|appointment detail|already book|i have book|i book|maine book|mera appointment|meri appointment|apna appointment|appoint.*status|appoint.*detail|detail.*appoint|check.*appoint|what.*appoint|my appoint|mujhe.*appoint)/i.test(
      lower,
    );
  if (isInquiry) {
    return {
      text:
        isRU || isUR
          ? "Aap ke appointments check kar raha hoon. Agar koi appointment hai to abhi bata deta hoon."
          : "Let me look up your appointments. I’ll share any upcoming bookings right away. If you don’t have one yet, I can help you book! 🗓️",
    };
  }

  // ── 3. Cancel / reschedule ────────────────────────────────────────────────────────
  if (
    /(cancel|reschedule|change.*appoint|appoint.*cancel|appoint.*change)/i.test(
      lower,
    )
  ) {
    return {
      text:
        isRU || isUR
          ? "Appointment cancel ya reschedule karne ke liye date aur time batayein."
          : "To cancel or reschedule, please provide the date and time of your appointment.",
    };
  }

  // ── 4. New booking intent OR time-only continuation message ─────────────────────
  // Catches:
  //   a) Explicit booking keywords ("book", "consult", "appointment", …)
  //   b) Continuation time messages after a booking conversation
  //      ("tomor 2 pm", "10 30 am", "kal 5 bjy") that have no booking keyword
  //      but are clearly a time/date reply.
  const hasBookingKeyword =
    /(book|visit|meeting|consult|schedule|reserve|waqt|appoint|chahiye|karna|available|slot)/i.test(
      lower,
    );
  const hasTimeOrDate =
    /\b\d{1,2}\s*(?:[:. ]\s*\d{2})?\s*(?:am|pm|bjy|baje|bje)\b/i.test(lower) ||
    /\b(tomorrow|tomor|tmrw?|tmr|2mrw?|kal|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
      lower,
    );

  if (hasBookingKeyword || hasTimeOrDate) {
    return {
      text:
        isRU || isUR
          ? "Zaroor! Kab ka appointment chahiye? Date aur time batayein, maslan: kal 3 baje."
          : "Sure! What date and time would you like? For example: tomorrow at 3 PM or Wednesday at 10 AM. 🗓️",
      metadata: { bookingIntent: true },
    };
  }

  // ── 5. Generic fallback — NEVER return raw knowledge text ───────────────────────
  return {
    text: isUR
      ? "Shukriya Demo Clinic se rabta karne ka! Appointment, clinic hours ya kisi aur cheez ke bare mein pooch saktay hain."
      : isRU
        ? "Shukriya! Appointment book karna ho ya clinic ki info chahiye, batayein. Hum madad karenge! 😊"
        : "Thanks for reaching out to Demo Clinic! I can help with appointments, clinic hours, or any questions. What do you need? 😊",
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

  // Exit deterministic handler for lookups, cancellations, and inquiries—let AI handle them.
  const isLookup =
    /(cancel|reschedule|my\s+appointment|what\s+appointment|mera\s+appointment|meri\s+appointment|my\s+booking|booking\s+detail|appointment\s+detail|already\s+book|i\s+have\s+book|i\s+book|appoint.*status|tell\s+me.*appoint|check.*appoint)/i.test(
      lower,
    );
  if (isLookup) return null;

  // "consult" prefix matches "consultation", "consulting", AND typos like "consultantation"
  const isBooking =
    /(visit|meeting|consult|schedule|reserve|waqt|appoint|chahiye|karna|book|available|slot)/i.test(
      lower,
    );

  // Only attempt deterministic booking if there is a date parseable OR if they definitely asked to book
  if (isBooking) {
    const startsAt = parseLooseDateTime(input.text, new Date(), input.timeZone);
    if (!startsAt) {
      return null;
    }

    const result = await bookAppointment({
      businessId: input.businessId,
      customerId: input.customerId,
      startsAt,
      service: inferService(input.text),
      notes: input.text,
    });

    if (result.ok) {
      return {
        text:
          input.language === "ur"
            ? `Done, aap ki appointment ${result.label} par book ho gayi hai.`
            : input.language === "roman_urdu"
              ? `Zabardast! Apki appointment book ho gayi hai for ${result.label}.`
              : `Done, your appointment is booked for ${result.label}.`,
        metadata: { booked: true, appointmentId: result.appointment.id },
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
      metadata: { bookingIntent: true, reason: result.reason },
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
  return (
    typeof value === "object" &&
    value !== null &&
    "handoff" in value &&
    value.handoff === true
  );
}

async function safeSearchKnowledge(
  businessId: string,
  query: string,
  limit?: number,
) {
  try {
    return await searchKnowledge({ businessId, query, limit });
  } catch {
    return [];
  }
}
