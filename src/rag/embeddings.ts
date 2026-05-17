import { config } from "../config";
import { logger } from "../logger";

export async function embedText(text: string): Promise<number[]> {
  if (config.EMBEDDING_API_URL) {
    try {
      const response = await fetch(config.EMBEDDING_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.EMBEDDING_API_KEY ? { authorization: `Bearer ${config.EMBEDDING_API_KEY}` } : {})
        },
        body: JSON.stringify({
          input: text,
          model: "text-embedding-3-small",
          dimensions: config.EMBEDDING_DIMENSIONS,
        })
      });
      if (!response.ok) throw new Error(`embedding api ${response.status}`);
      const json = (await response.json()) as {
        embedding?: number[];
        data?: Array<{ embedding: number[]; index: number }>;
        output?: number[];
      };
      // Support multiple response formats:
      // OpenAI: { data: [{ embedding: [...] }] }
      // Direct: { embedding: [...] }
      // Cohere: { embeddings: { float: [[...]] } }
      const embedding = json.embedding
        ?? json.data?.[0]?.embedding
        ?? json.output;
      if (embedding?.length) return embedding;
    } catch (error) {
      logger.warn({ err: error }, "embedding api failed; using local fallback");
    }
  }

  return localSemanticHash(text, config.EMBEDDING_DIMENSIONS);
}

function localSemanticHash(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];

  for (const token of tokens) {
    for (const gram of ngrams(token)) {
      const idx = fnv1a(gram) % dimensions;
      vector[idx] += 1;
    }
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function ngrams(token: string): string[] {
  if (token.length <= 3) return [token];
  const grams = [token];
  for (let index = 0; index <= token.length - 3; index += 1) {
    grams.push(token.slice(index, index + 3));
  }
  return grams;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
