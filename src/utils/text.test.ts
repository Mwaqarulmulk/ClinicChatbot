import { describe, it, expect } from "bun:test";
import { detectLanguage, normalizePhone, chunkText } from "../utils/text";
import { parseLooseDateTime, formatLocal, addMinutes, toIsoMinute } from "../utils/time";
import { WindowGuard, TtlSet } from "../utils/window-guard";
import { createId } from "../utils/id";

// ── Text utilities ──────────────────────────────────────────────────────────

describe("detectLanguage", () => {
  it("detects Urdu script", () => {
    expect(detectLanguage("کلینک کے اوقات کیا ہیں؟")).toBe("ur");
  });

  it("detects Roman Urdu with 2+ keywords", () => {
    expect(detectLanguage("kal appointment chahiye")).toBe("roman_urdu");
    expect(detectLanguage("mujhe chahiye")).toBe("roman_urdu");
  });

  it("detects English for common sentences", () => {
    expect(detectLanguage("What time does the clinic open?")).toBe("en");
    expect(detectLanguage("Hello, I need help")).toBe("en");
  });

  it("returns English for single Roman Urdu word", () => {
    expect(detectLanguage("kya")).toBe("en");
  });
});

describe("normalizePhone", () => {
  it("strips non-digit characters", () => {
    expect(normalizePhone("+92-300-1234567")).toBe("923001234567");
    expect(normalizePhone("92300 123 4567")).toBe("923001234567");
  });

  it("returns digits only", () => {
    expect(normalizePhone("abc123def456")).toBe("123456");
  });
});

describe("chunkText", () => {
  it("combines small paragraphs into one chunk", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const chunks = chunkText(text, 900);
    // All paragraphs fit within 900 chars, so they're combined
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("Paragraph one.");
    expect(chunks[0]).toContain("Paragraph two.");
  });

  it("splits when exceeding maxChars", () => {
    const text = "A".repeat(500) + "\n\n" + "B".repeat(500);
    const chunks = chunkText(text, 600);
    expect(chunks.length).toBe(2);
  });

  it("handles empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });
});

// ── Time utilities ──────────────────────────────────────────────────────────

describe("parseLooseDateTime", () => {
  const now = new Date("2026-05-15T12:00:00Z");

  it("parses 'tomorrow'", () => {
    const result = parseLooseDateTime("tomorrow 10am", now, "UTC");
    expect(result).not.toBeNull();
    expect(result!.getUTCDate()).toBe(16);
    expect(result!.getUTCHours()).toBe(10);
  });

  it("parses 'today'", () => {
    const result = parseLooseDateTime("today 3pm", now, "UTC");
    expect(result).not.toBeNull();
    expect(result!.getUTCDate()).toBe(15);
    expect(result!.getUTCHours()).toBe(15);
  });

  it("parses day names", () => {
    const result = parseLooseDateTime("Monday 9am", now, "UTC");
    expect(result).not.toBeNull();
  });

  it("parses HH:MM am/pm", () => {
    const result = parseLooseDateTime("tomorrow 2:30pm", now, "UTC");
    expect(result).not.toBeNull();
    expect(result!.getUTCHours()).toBe(14);
    expect(result!.getUTCMinutes()).toBe(30);
  });

  it("parses Urdu clock 'baje'", () => {
    const result = parseLooseDateTime("kal 5 baje", now, "UTC");
    expect(result).not.toBeNull();
  });

  it("returns null for no time component", () => {
    const result = parseLooseDateTime("hello world", now, "UTC");
    expect(result).toBeNull();
  });
});

describe("formatLocal", () => {
  it("formats a date in the given timezone", () => {
    const date = new Date("2026-05-15T12:00:00Z");
    const formatted = formatLocal(date, "Asia/Karachi");
    expect(formatted).toContain("2026");
    expect(formatted).toContain("5");
  });
});

describe("addMinutes", () => {
  it("adds minutes correctly", () => {
    const date = new Date("2026-05-15T12:00:00Z");
    const result = addMinutes(date, 30);
    expect(result.getTime() - date.getTime()).toBe(30 * 60_000);
  });
});

describe("toIsoMinute", () => {
  it("truncates seconds and milliseconds", () => {
    const date = new Date("2026-05-15T12:30:45.123Z");
    const result = toIsoMinute(date);
    expect(result).toBe("2026-05-15T12:30:00.000Z");
  });
});

// ── WindowGuard (rate limiter) ──────────────────────────────────────────────

describe("WindowGuard", () => {
  it("allows requests within limit", () => {
    const guard = new WindowGuard(3, 60_000);
    expect(guard.allow("user1")).toBe(true);
    expect(guard.allow("user1")).toBe(true);
    expect(guard.allow("user1")).toBe(true);
    expect(guard.allow("user1")).toBe(false);
    guard.destroy();
  });

  it("tracks different keys independently", () => {
    const guard = new WindowGuard(1, 60_000);
    expect(guard.allow("user1")).toBe(true);
    expect(guard.allow("user1")).toBe(false);
    expect(guard.allow("user2")).toBe(true);
    guard.destroy();
  });

  it("resets after window expires", () => {
    const guard = new WindowGuard(1, 100); // 100ms window
    expect(guard.allow("user1")).toBe(true);
    expect(guard.allow("user1")).toBe(false);
    // Wait for window to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(guard.allow("user1")).toBe(true);
        guard.destroy();
        resolve();
      }, 150);
    });
  });
});

// ── TtlSet ──────────────────────────────────────────────────────────────────

describe("TtlSet", () => {
  it("returns false on first add, true on duplicate", () => {
    const set = new TtlSet(60_000);
    expect(set.hasOrAdd("msg1")).toBe(false);
    expect(set.hasOrAdd("msg1")).toBe(true);
    expect(set.hasOrAdd("msg2")).toBe(false);
  });

  it("expires entries after TTL", () => {
    const set = new TtlSet(100); // 100ms TTL
    expect(set.hasOrAdd("msg1")).toBe(false);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(set.hasOrAdd("msg1")).toBe(false); // expired, so false again
        resolve();
      }, 150);
    });
  });
});

// ── ID generator ────────────────────────────────────────────────────────────

describe("createId", () => {
  it("generates unique IDs with prefix", () => {
    const id1 = createId("cus");
    const id2 = createId("cus");
    expect(id1.startsWith("cus_")).toBe(true);
    expect(id2.startsWith("cus_")).toBe(true);
    expect(id1).not.toBe(id2);
  });

  it("generates IDs of consistent length", () => {
    const id = createId("test");
    // prefix_ + 32 hex chars = prefix length + 1 + 32
    expect(id.length).toBe(4 + 1 + 32);
  });
});
