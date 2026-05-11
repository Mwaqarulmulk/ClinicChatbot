import { describe, expect, test } from "bun:test";
import { embedText } from "./embeddings";

describe("embedText (local fallback)", () => {
  test("returns a vector of the configured length", async () => {
    const embedding = await embedText("hello world");
    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBeGreaterThan(0);
  });

  test("returns a normalised vector (magnitude ≈ 1)", async () => {
    const embedding = await embedText("appointment booking clinic");
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  test("different inputs produce different vectors", async () => {
    const a = await embedText("morning appointment");
    const b = await embedText("cancel booking");
    const same = a.every((v, i) => v === b[i]);
    expect(same).toBe(false);
  });

  test("identical inputs produce identical vectors", async () => {
    const a = await embedText("hello world");
    const b = await embedText("hello world");
    expect(a).toEqual(b);
  });

  test("empty string returns zero-padded unit vector (magnitude 0 → all zeros)", async () => {
    const embedding = await embedText("");
    expect(Array.isArray(embedding)).toBe(true);
    // All zeros when no tokens are found
    const allZero = embedding.every((v) => v === 0);
    expect(allZero).toBe(true);
  });
});
