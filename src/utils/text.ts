const romanUrduKeywords = new Set([
  "kya", "kia", "hal", "hai", "mai", "main", "teakh", "theek", "ho", "jazakallah",
  "han", "haan", "nahi", "nai", "acha", "acha", "shukriya", "bhai", "sir", "jee",
  "ji", "salam", "assalam", "walaikum", "kal", "aaj", "kab", "kahan", "kaise",
  "kidhar", "kitne", "kitna", "baje", "bje", "time", "waqt", "kaam", "kam"
]);

export function detectLanguage(text: string): "ur" | "en" | "roman_urdu" {
  if (/[\u0600-\u06FF]/.test(text)) return "ur";
  
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/);
  let romanUrduMatches = 0;
  for (const word of words) {
    if (romanUrduKeywords.has(word)) {
      romanUrduMatches++;
    }
  }
  
  // If we have enough Pakistani English / Roman Urdu keywords, classify as roman_urdu
  if (romanUrduMatches >= 1 || words.some(w => romanUrduKeywords.has(w))) {
    return "roman_urdu";
  }
  
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

