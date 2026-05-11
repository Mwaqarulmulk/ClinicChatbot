import "../src/config";
import { bootstrapDatabase } from "../src/db/bootstrap";
import { initKnowledgeBase, upsertKnowledge } from "../src/rag/knowledge-base";
import { config } from "../src/config";

await bootstrapDatabase();
await initKnowledgeBase();

const examples = [
  {
    title: "Business hours",
    content: "We are open Monday to Saturday from 9:00 AM to 6:00 PM. Sunday appointments are available only by special approval."
  },
  {
    title: "Appointment policy",
    content: "Customers can book, reschedule, or cancel appointments on WhatsApp. For cancellations, please inform us at least 2 hours before the appointment time."
  },
  {
    title: "Languages",
    content: "The business supports English and Urdu. Replies should match the customer's language and stay concise for WhatsApp."
  }
];

for (const item of examples) {
  const chunks = await upsertKnowledge({
    businessId: config.DEFAULT_BUSINESS_ID,
    title: item.title,
    content: item.content,
    source: "seed"
  });
  console.log(`Seeded ${item.title}: ${chunks} chunk(s)`);
}

