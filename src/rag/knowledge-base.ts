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
let initFailed = false;

async function getConnection() {
  if (initFailed) return null;
  try {
    mkdirSync(config.LANCEDB_URI, { recursive: true });
    connection ??= await lancedb.connect(config.LANCEDB_URI);
    return connection;
  } catch (error) {
    initFailed = true;
    logger.warn({ err: error }, "lancedb connection failed; RAG disabled");
    return null;
  }
}

export async function initKnowledgeBase() {
  if (initialized || initFailed) return;
  const db = await getConnection();
  if (!db) return; // initFailed is true
  try {
    await db.openTable(config.RAG_TABLE);
  } catch {
    // Use the standard ID format (businessId:titleSlug:index) so the admin UI
    // delete function can find and remove this entry via the LIKE filter.
    const bootstrapSlug = "getting-started";
    await db.createTable(config.RAG_TABLE, [
      {
        id: `${config.DEFAULT_BUSINESS_ID}:${bootstrapSlug}:0`,
        businessId: config.DEFAULT_BUSINESS_ID,
        title: "Getting started",
        content:
          "Add business knowledge with POST /admin/knowledge or bun run seed:knowledge.",
        source: "system",
        vector: await embedText("getting started business knowledge"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
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
  if (!db) throw new Error("knowledge base unavailable");
  const table = await db.openTable(config.RAG_TABLE);
  const chunks = chunkText(input.content);
  const now = new Date().toISOString();
  const titleSlug = slug(input.title);
  const idPrefix = `${input.businessId}:${titleSlug}:`;

  // ── True upsert: delete all existing chunks for this title/business ──────────
  // Without this, repeated calls silently append duplicates that degrade RAG quality.
  try {
    // LanceDB delete accepts a SQL-like WHERE expression
    await table.delete(`id LIKE '${idPrefix.replace(/'/g, "''")}%'`);
  } catch {
    // Expected on first insert — no rows exist yet
  }

  const rows: KnowledgeRow[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const content = chunks[index];
    rows.push({
      id: `${idPrefix}${index}`,
      businessId: input.businessId,
      title: chunks.length > 1 ? `${input.title} (${index + 1})` : input.title,
      content,
      source: input.source,
      vector: await embedText(`${input.title}\n${content}`),
      createdAt: now,
      updatedAt: now,
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
  if (!db) return []; // Graceful degradation — RAG unavailable
  const table = await db.openTable(config.RAG_TABLE);
  const vector = await embedText(input.query);
  const limit = input.limit ?? 4;

  // Fetch a generous multiple of the desired limit before filtering by businessId.
  // In multi-tenant setups, results from other businesses fill the ANN window;
  // without over-fetch, filtering leaves too few results.
  const fetchLimit = Math.max(limit * 10, 50);

  const rows = (await table
    .search(vector)
    .limit(fetchLimit)
    .toArray()) as Array<KnowledgeRow & { _distance?: number; score?: number }>;

  const hits = rows
    .filter((row) => row.businessId === input.businessId)
    .filter(uniqueById())
    .slice(0, limit)
    .map(toKnowledgeHit);

  if (hits.length) return hits;

  // Vector search returned nothing relevant — keyword fallback.
  // Scan up to 2 000 rows so larger knowledge bases still get results.
  const fallbackRows = (await table
    .query()
    .limit(2000)
    .toArray()) as KnowledgeRow[];

  const ownRows = fallbackRows
    .filter((row) => row.businessId === input.businessId)
    .filter(uniqueById());

  // ── Title-priority scoring ────────────────────────────────────────────────────────
  // A query token that exactly matches a word in the TITLE gets a much
  // higher weight (3×) than a content match. This means "hours" in the
  // query strongly prefers the "Business Hours" entry over any entry that
  // merely mentions "hours" somewhere in its body text.
  const queryTokens = tokenize(input.query);
  return ownRows
    .map((row) => {
      const titleTokens = new Set(tokenize(row.title));
      const contentTokens = new Set(tokenize(row.content));
      const titleHits = queryTokens.filter((t) => titleTokens.has(t)).length;
      const contentHits = queryTokens.filter((t) =>
        contentTokens.has(t),
      ).length;
      // Title matches are weighted 3× more than content matches
      const score =
        queryTokens.length > 0
          ? (titleHits * 3 + contentHits) / (queryTokens.length * 4)
          : 0;
      return { row, score };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
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

function toKnowledgeHit(
  row: KnowledgeRow & { _distance?: number; score?: number },
): KnowledgeHit {
  return {
    id: row.id,
    businessId: row.businessId,
    title: row.title,
    content: row.content,
    source: row.source,
    score:
      row.score ??
      (typeof row._distance === "number" ? 1 / (1 + row._distance) : undefined),
  };
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

/**
 * Find the single best knowledge entry whose title contains the given keyword.
 * Bypasses vector/ANN search entirely — uses substring title matching which is
 * 100% reliable for known clinic topics (Hours, Fees, Services, etc.).
 */
export async function searchKnowledgeByTitle(
  businessId: string,
  titleKeyword: string,
): Promise<KnowledgeHit | null> {
  await initKnowledgeBase();
  const db = await getConnection();
  if (!db) return null;
  const table = await db.openTable(config.RAG_TABLE);
  const rows = (await table.query().limit(2000).toArray()) as KnowledgeRow[];
  const lower = titleKeyword.toLowerCase();
  const match = rows
    .filter((row) => row.businessId === businessId)
    .filter(uniqueById())
    .find((row) => row.title.toLowerCase().includes(lower));
  return match ? toKnowledgeHit(match) : null;
}

/**
 * List all knowledge entries for a business (for admin display).
 * Returns entries ordered by title, deduped by id.
 */
export async function listKnowledge(
  businessId: string,
): Promise<KnowledgeHit[]> {
  await initKnowledgeBase();
  const db = await getConnection();
  if (!db) return [];
  const table = await db.openTable(config.RAG_TABLE);
  const rows = (await table.query().limit(2000).toArray()) as KnowledgeRow[];
  return rows
    .filter((row) => row.businessId === businessId)
    .filter(uniqueById())
    .map(toKnowledgeHit)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Delete all knowledge chunks matching a given id prefix (title slug).
 * Pass the full id of any chunk to delete all chunks with the same title.
 */
export async function deleteKnowledgeByTitle(
  businessId: string,
  titleSlug: string,
): Promise<void> {
  await initKnowledgeBase();
  const db = await getConnection();
  if (!db) return;
  const table = await db.openTable(config.RAG_TABLE);
  const escapedPrefix = `${businessId}:${titleSlug}`.replace(/'/g, "''");
  try {
    await table.delete(`id LIKE '${escapedPrefix}%'`);
  } catch {
    // no rows matched — that's fine
  }
}
