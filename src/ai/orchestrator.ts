import { config, handoffKeywords } from "../config";
import { db } from "../db/client";
import { businesses } from "../db/schema";
import { groq } from "./groq";
import { executeTool, toolDefinitions } from "./tools";
import { searchKnowledge } from "../rag/knowledge-base";
import { bookAppointment, getCustomerAppointments } from "../services/appointments";
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

// Intent types for query analysis
type QueryIntent = {
  type: "greeting" | "booking" | "availability" | "cancel" | "inquiry" | "complaint" | "general";
  confidence: number;
  details?: string;
};

function analyzeIntent(text: string, language: "en" | "ur" | "roman_urdu"): QueryIntent {
  const lower = text.toLowerCase();
  
  // Greeting patterns
  if (/^(hi|hello|hey|salam|assalamualikum|namaste|good morning|good afternoon|good evening)/i.test(lower)) {
    return { type: "greeting", confidence: 0.9 };
  }
  
  // Booking intent
  if (/book|appointment|visit|meeting|consultation|schedule|reserve|waqt|appoint|chahiye|karna/i.test(lower)) {
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
  if (/what|how|tell me|information|info|hours|timing|price|fee|policy|service/i.test(lower)) {
    return { type: "inquiry", confidence: 0.75 };
  }
  
  // Complaint/frustration
  if (/bad|worst|terrible|complaint|problem|issue|not happy|disappointed|frustrat/i.test(lower)) {
    return { type: "complaint", confidence: 0.8 };
  }
  
  return { type: "general", confidence: 0.5 };
}

export async function handleInboundMessage(message: InboundMessage): Promise<ChatReply> {
  const language = detectLanguage(message.text);
  const phone = normalizePhone(message.from);
  
  // Get or create customer with full context
  const customer = await upsertCustomer({
    businessId: message.businessId,
    phone,
    name: message.name,
    language: language === "roman_urdu" ? "en" : language
  });
  
  const conversation = await getOrCreateConversation({
    businessId: message.businessId,
    customerId: customer.id,
    channel: message.channel
  });

  // Store the user message
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

  // Analyze query intent first
  const intent = analyzeIntent(message.text, language);
  
  // Handle handoff requests
  if (shouldHandoff(message.text)) {
    await markHandoff(conversation.id);
    const text = language === "ur"
      ? "Theek hai, main aap ko human team se connect kar raha hoon."
      : "Sure, I am connecting you with a human team member.";
    await appendMessage({ conversationId: conversation.id, role: "assistant", content: text });
    return { text, handoff: true };
  }

  // Get business info
  const business = await db.query.businesses.findFirst({ where: eq(businesses.id, message.businessId) });
  if (!business) throw new Error(`Business not found: ${message.businessId}`);

  // Handle deterministic booking (fast path)
  const deterministicBooking = await tryDeterministicBooking({
    text: message.text,
    language,
    timeZone: business.timezone,
    businessId: message.businessId,
    customerId: customer.id
  });
  if (deterministicBooking && !deterministicBooking.handoff) {
    await appendMessage({ conversationId: conversation.id, role: "assistant", content: deterministicBooking.text });
    await trackEvent({
      businessId: message.businessId,
      customerId: customer.id,
      event: deterministicBooking.metadata?.booked ? "appointment_booked" : "booking_info_requested"
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
    customerId: customer.id
  });

  // Generate AI reply with full context
  console.log('[DEBUG] groq exists:', !!groq, '| text:', message.text.substring(0, 20));
  
  const reply = groq
    ? await aiReply({
      business,
      customer: { 
        id: customer.id, 
        name: customer.name, 
        notes: customer.notes,
        phone: customer.phone
      },
      language,
      history,
      knowledge,
      intent,
      customerAppointments: customerAppointments.map(a => ({
        startsAt: a.startsAt,
        service: a.service,
        status: a.status
      }))
    }).catch((err) => {
      console.error('[DEBUG] AI reply error:', err.message);
      return fallbackReply({ text: message.text, language, businessId: message.businessId, customerId: customer.id });
    })
    : await fallbackReply({ text: message.text, language, businessId: message.businessId, customerId: customer.id });

  if (reply.handoff) await markHandoff(conversation.id);
  await appendMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: reply.text,
    metadata: { ...reply.metadata, intent: intent.type }
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
  customer: { id: string; name?: string | null; notes?: string | null; phone: string };
  language: "en" | "ur" | "roman_urdu";
  history: Array<{ role: string; content: string }>;
  knowledge: Array<{ title: string; content: string; source?: string }>;
  intent: QueryIntent;
  customerAppointments: Array<{ startsAt: string; service: string; status: string }>;
}): Promise<ChatReply> {
  
  let languageInstruction = "Reply in English.";
  if (input.language === "ur") languageInstruction = "Reply in Urdu script (اردو).";
  if (input.language === "roman_urdu") languageInstruction = "Reply in Roman Urdu / Pakistani English (e.g. 'han sir, apka appointment book ho gaya hai. Jazakallah!'). Match the user's friendly Pakistani tone.";

  // Build user context - this is a known customer, provide personalized service
  const customerNameStr = input.customer.name 
    ? `Customer profile: ${input.customer.name} (Phone: ${input.customer.phone}). Use their name naturally in responses.` 
    : "This is a returning customer. Ask for their name politely if they haven't provided it.";
    
  const preferencesStr = input.customer.notes 
    ? `\nKnown customer preferences: ${input.customer.notes}\nUse this to personalize your responses.` 
    : "";

  // Include appointment history for context
  const appointmentContext = input.customerAppointments.length > 0 
    ? `\nThis customer's appointment history:\n` + input.customerAppointments.map(a => 
      `- ${a.startsAt}: ${a.service} (${a.status})`
    ).join("\n")
    : "\nThis is a new customer with no prior appointments.";

  // Include intent analysis in system prompt
  const intentStr = `\nCustomer query analysis: ${input.intent.type} (confidence: ${input.intent.confidence}). ` +
    `Tailor your response based on this intent. For greetings - be warm. For booking - help them book. For availability - show slots. For cancel - help them cancel.`;

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        input.business.systemPrompt,
        customerNameStr,
        preferencesStr,
        appointmentContext,
        intentStr,
        `Detected customer language/style: ${input.language}. ${languageInstruction}`,
        `Current business date and time is ${new Date().toLocaleString("en-US", { timeZone: input.business.timezone })}.`,
        `Current business hours: ${input.business.openHour}:00-${input.business.closeHour}:00, timezone ${input.business.timezone}.`,
        "IMPORTANT: You are talking to a returning customer. Reference their history when relevant. Be consistent with previous conversations.",
        "Act completely human. Be warm, empathetic, and conversational. Adapt your personality, politeness, and tone perfectly to how the customer approaches you. Do not sound like a robot. Use a friendly tone, occasional emojis, and keep replies short and natural like a real text message.",
        "When a user says hi, greet them warmly by name if known. If you don't know their name, ask how you can help them.",
        "Use get_my_appointments tool to check the customer's existing appointments. Always provide this information to the customer - never say you don't know if they ask about their appointments.",
        "Use book_appointment tool to book appointments. Use get_availability to check open slots.",
        "NEVER call handoff_to_human just because you're unsure - check the tools first. Only escalate to human for explicit requests, serious complaints, or policy violations."
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
    console.log('[DEBUG] Calling Groq, turn:', turn);
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