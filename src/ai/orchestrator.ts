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
import { formatLocal, parseLooseDateTime } from "../utils/time";
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

  // Get conversation history — 20 messages gives the AI enough context for
  // multi-turn flows (availability check → booking → confirmation)
  // without pushing the context window too hard.
  const history = await recentMessages(conversation.id, 20);

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
    {
      role: "system",
      content: `EXAMPLE CONVERSATIONS — follow this exact tone, length, and style:

[Greeting — English]
User: hi
Assistant: Hi ${input.customer.name ?? "there"}! 👋 Welcome to Demo Clinic. How can I help you today?

[Greeting — Roman Urdu]
User: Salam
Assistant: Wa alaikum assalam! 😊 Demo Clinic mein aap ka swagat hai. Kya main aap ki kuch madad kar sakta hoon?

[Services question]
User: What services do you offer?
Assistant: We offer General Consultation, Dental Care, Pediatrics, Gynecology, Dermatology, ENT, Eye Care, Lab Tests, and Minor Surgeries. Which service are you interested in? 😊

[Price question]
User: How much is a consultation?
Assistant: General consultation is Rs. 1,500 and specialist consultations are Rs. 2,500. Follow-ups within 7 days are just Rs. 800. Would you like to book an appointment?

[Booking — ask for time]
User: I want to book an appointment
Assistant: Sure! 📅 What day and time works for you? For example: "tomorrow at 10 AM" or "Friday at 3 PM".

[Booking — with time]
User: tomorrow at 3pm
Assistant: ✅ Done! Your appointment is booked for tomorrow at 3:00 PM. Please arrive 10 minutes early. See you then!

[Booking — Roman Urdu]
User: Kal 11 baje appointment chahiye
Assistant: Bilkul! ✅ Aap ki appointment kal 11:00 AM par book ho gayi. Koi masla ho to batayein!

[Appointment inquiry — has appointment]
User: When is my appointment?
(After calling get_my_appointments and finding one)
Assistant: Aap ki appointment May 15 ko 2:00 PM par scheduled hai for Dental Care. Kuch aur chahiye?

[Appointment inquiry — no appointment]
User: Do I have any appointments?
(After calling get_my_appointments and finding none)
Assistant: Aap ke abhi koi upcoming appointments nahi hain. Kya main aap ke liye ek book kar doon? 😊

[Cancellation]
User: I want to cancel my appointment
(After calling get_my_appointments first)
Assistant: I can see you have an appointment on May 15 at 2:00 PM for Dental Care. Shall I go ahead and cancel it?

[What is my name / profile]
User: What is my name?
Assistant: Your name is ${input.customer.name ?? "not on file yet"}! Is there anything else I can help you with? 😊

[Complaint / frustration]
User: This service is very bad, I waited so long!
Assistant: I'm really sorry to hear that, ${input.customer.name ?? "valued patient"}. 😔 Your experience matters a lot to us. Can you tell me more about what happened so we can make it right for you?

[Urdu reply]
User: کلینک کے اوقات کیا ہیں؟
Assistant: جی، Demo Clinic پیر سے ہفتہ تک صبح 9 بجے سے شام 6 بجے تک کھلا رہتا ہے۔ اتوار کو صرف خصوصی اجازت سے appointment ہوتی ہے۔ کوئی اور سوال؟

KEY STYLE RULES:
- Maximum 3 sentences per reply
- Use customer's name naturally (not every message)
- Mix emojis sparingly (1-2 per message max)
- For Pakistani customers: feel free to mix English + Urdu words naturally
- NEVER start with 'I' — vary your openings
- Sound like a warm, professional receptionist — NOT a robot or a formal document
`,
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
      max_completion_tokens: 800,
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
        ? "سلام! Demo Clinic کا WhatsApp اسسٹنٹ آپ کی خدمت میں حاضر ہے۔ کیا مدد کر سکتا ہوں؟"
        : isRU
          ? "Salam! Main Demo Clinic ka WhatsApp assistant hoon. Kya madad kar sakta hoon? \ud83d\ude0a"
          : "Hello! I'm the Demo Clinic assistant. How can I help you today? \ud83d\ude0a",
    };
  }

  // ── 2. Cancel / reschedule — check BEFORE inquiry so "cancel my appointment" routes here ──
  if (
    /(cancel|reschedule|change.*appoint|appoint.*cancel|appoint.*change)/i.test(
      lower,
    )
  ) {
    try {
      const upcomingApts = await getCustomerAppointments({
        businessId: input.businessId,
        customerId: input.customerId,
      });
      if (upcomingApts.length === 0) {
        return {
          text:
            isRU || isUR
              ? "Aap ke koi upcoming appointments nahi hain jo cancel ki ja saken."
              : "You don't have any upcoming appointments to cancel.",
        };
      }
      const apt = upcomingApts[0];
      const label = formatLocal(
        new Date(apt.startsAt),
        config.DEFAULT_TIMEZONE,
      );
      return {
        text:
          isRU || isUR
            ? `Aap ki appointment ${label} par hai (${apt.service}). Cancel ya reschedule karna chahte hain?`
            : `Your appointment is on ${label} for ${apt.service}. Would you like to cancel or reschedule it?`,
      };
    } catch {
      return {
        text:
          isRU || isUR
            ? "Appointment cancel karne ke liye date aur time batayein."
            : "To cancel, please provide your appointment date and time.",
      };
    }
  }

  // ── 3. Appointment INQUIRY — real DB lookup, no placeholder text ───────────────
  // Require BOTH a query word AND an appointment word to avoid "tell me about
  // services" being routed here.
  const hasQueryWord =
    /(tell me|show me|what is my|check|view|see|give me)/i.test(lower);
  const hasAptWord =
    /(appoint|booking|schedule|my time|my slot|mera appoint|meri appoint)/i.test(
      lower,
    );
  // Phrases that unambiguously reference an existing appointment
  const alreadyBookedPhrase =
    /(already book|i have book|i book|maine book|mujhe.*appoint|appoint.*detail|booking.*detail)/i.test(
      lower,
    );

  if ((hasQueryWord && hasAptWord) || alreadyBookedPhrase) {
    try {
      const upcomingApts = await getCustomerAppointments({
        businessId: input.businessId,
        customerId: input.customerId,
      });
      if (upcomingApts.length === 0) {
        return {
          text:
            isRU || isUR
              ? "Aap ke abhi koi upcoming appointments nahi hain. Kya main ek book kar doon? \ud83d\uddd3\ufe0f"
              : "You don't have any upcoming appointments right now. Would you like to book one? \ud83d\uddd3\ufe0f",
        };
      }
      const list = upcomingApts
        .map(
          (a) =>
            `\u2022 ${formatLocal(new Date(a.startsAt), config.DEFAULT_TIMEZONE)} \u2014 ${a.service}`,
        )
        .join("\n");
      return {
        text:
          (isRU || isUR
            ? "Aap ke upcoming appointments:\n"
            : "Your upcoming appointments:\n") + list,
      };
    } catch {
      return {
        text:
          isRU || isUR
            ? "Appointments check karne mein masla aaya. Dobara try karein."
            : "Couldn't load appointments right now. Please try again in a moment.",
      };
    }
  }

  // ── 4. New booking intent OR time-only continuation message ─────────────────────
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
          : "Sure! What date and time works for you? For example: tomorrow at 3 PM or Friday at 10 AM. \ud83d\uddd3\ufe0f",
      metadata: { bookingIntent: true },
    };
  }

  // ── 5. Generic — never return raw knowledge text ───────────────────────────────
  return {
    text: isUR
      ? "Shukriya Demo Clinic se rabta karne ka! Appointment, clinic hours ya kisi aur cheez ke bare mein pooch saktay hain."
      : isRU
        ? "Shukriya! Appointment book karna ho ya clinic ki info chahiye, batayein. \ud83d\ude0a"
        : "Thanks for reaching out to Demo Clinic! I can help with appointments, clinic hours, or any questions. \ud83d\ude0a",
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
