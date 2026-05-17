// Only unambiguous Roman Urdu / Pakistani words — removed common English words
// like "time", "main", "ho", "sir", "ji", "jee" that caused false positives.
const romanUrduKeywords = new Set([
  "kya",
  "kia",
  "hai",
  "hain",
  "theek",
  "jazakallah",
  "han",
  "haan",
  "nahi",
  "nai",
  "nahin",
  "acha",
  "shukriya",
  "bhai",
  "salam",
  "assalam",
  "walaikum",
  "assalamualaikum",
  "kal",
  "aaj",
  "parso",
  "kab",
  "kahan",
  "kaise",
  "kidhar",
  "kitne",
  "kitna",
  "baje",
  "bje",
  "waqt",
  "kaam",
  "zaroor",
  "bilkul",
  "theek",
  "thik",
  "pls",
  "mujhe",
  "mera",
  "meri",
  "apka",
  "apki",
  "aap",
  "hum",
  "chahiye",
  "chahta",
  "chahti",
  "karna",
  "karein",
  "batao",
  "please",
  "zabardast",
  "inshallah",
  "mashallah",
]);

export function detectLanguage(text: string): "ur" | "en" | "roman_urdu" {
  if (/[\u0600-\u06FF]/.test(text)) return "ur";

  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/);
  let romanUrduMatches = 0;
  for (const word of words) {
    if (romanUrduKeywords.has(word)) romanUrduMatches++;
  }

  // Require at least 2 unambiguous Roman Urdu keywords to avoid misclassifying
  // common English sentences ("What time does the clinic open?") as Roman Urdu.
  if (romanUrduMatches >= 2) return "roman_urdu";

  return "en";
}

export function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

export function chunkText(text: string, maxChars = 900): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).trim().length > maxChars && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = (current + "\n\n" + paragraph).trim();
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
