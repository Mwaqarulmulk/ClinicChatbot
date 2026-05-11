import * as lancedb from "@lancedb/lancedb";
import { mkdirSync } from "node:fs";
import { config } from "../config";
import { logger } from "../logger";
import { chunkText } from "../utils/text";
import { embedText } from "./embeddings";

export type KnowledgeHit = {
  id: string;
  businessId: string;
  title: string;
  content: string;
  source?: string;
  score?: number;
};

type KnowledgeRow = KnowledgeHit & {
  vector: number[];
  createdAt: string;
  updatedAt: string;
};

let connection: Awaited<ReturnType<typeof lancedb.connect>> | null = null;
let initialized = false;

async function getConnection() {
  mkdirSync(config.LANCEDB_URI, { recursive: true });
  connection ??= await lancedb.connect(config.LANCEDB_URI);
  return connection;
}

export async function initKnowledgeBase() {
  if (initialized) return;
  const db = await getConnection();
  try {
    await db.openTable(config.RAG_TABLE);
  } catch {
    await db.createTable(config.RAG_TABLE, [
      {
        id: "bootstrap",
        businessId: config.DEFAULT_BUSINESS_ID,
        title: "Getting started",
        content: "Add business knowledge with POST /admin/knowledge or bun run seed:knowledge.",
        source: "system",
        vector: await embedText("getting started business knowledge"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]);
  }
  initialized = true;
  logger.info("knowledge base ready");
}

export async function upsertKnowledge(input: {
  businessId: string;
  title: string;
  content: string;
  source?: string;
}) {
  await initKnowledgeBase();
  const db = await getConnection();
  const table = await db.openTable(config.RAG_TABLE);
  const chunks = chunkText(input.content);
  const now = new Date().toISOString();
  const rows: KnowledgeRow[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const content = chunks[index];
    rows.push({
      id: `${input.businessId}:${slug(input.title)}:${index}`,
      businessId: input.businessId,
      title: chunks.length > 1 ? `${input.title} (${index + 1})` : input.title,
      content,
      source: input.source,
      vector: await embedText(`${input.title}\n${content}`),
      createdAt: now,
      updatedAt: now
    });
  }

  await table.add(rows);
  return rows.length;
}

export async function searchKnowledge(input: {
  businessId: string;
  query: string;
  limit?: number;
}): Promise<KnowledgeHit[]> {
  await initKnowledgeBase();
  const db = await getConnection();
  const table = await db.openTable(config.RAG_TABLE);
  const vector = await embedText(input.query);
  const rows = (await table
    .search(vector)
    .limit(Math.max(input.limit ?? 4, 20))
    .toArray()) as Array<KnowledgeRow & { _distance?: number; score?: number }>;

  const hits = rows
    .filter((row) => row.businessId === input.businessId)
    .filter(uniqueById())
    .slice(0, input.limit ?? 4)
    .map(toKnowledgeHit);

  if (hits.length) return hits;

  const fallbackRows = (await table.query().limit(500).toArray()) as KnowledgeRow[];
  return fallbackRows
    .filter((row) => row.businessId === input.businessId)
    .filter(uniqueById())
    .map((row) => ({ row, score: keywordScore(input.query, `${row.title} ${row.content}`) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 4)
    .map((match) => toKnowledgeHit({ ...match.row, score: match.score }));
}

function uniqueById() {
  const seen = new Set<string>();
  return (row: KnowledgeRow) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  };
}

function toKnowledgeHit(row: KnowledgeRow & { _distance?: number; score?: number }): KnowledgeHit {
  return {
    id: row.id,
    businessId: row.businessId,
    title: row.title,
    content: row.content,
    source: row.source,
    score: row.score ?? (typeof row._distance === "number" ? 1 / (1 + row._distance) : undefined)
  };
}

function keywordScore(query: string, content: string): number {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return 0;
  const contentTokens = new Set(tokenize(content));
  return queryTokens.reduce((score, token) => score + (contentTokens.has(token) ? 1 : 0), 0) / queryTokens.length;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .match(/[\p{L}\p{N}]{3,}/gu) ?? [];
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}
