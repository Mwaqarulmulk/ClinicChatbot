import { describe, expect, test } from "bun:test";
import { chunkText, detectLanguage, normalizePhone } from "./text";

describe("detectLanguage", () => {
  test("detects Urdu script", () => {
    expect(detectLanguage("مجھے کل ملنا ہے")).toBe("ur");
  });

  test("detects Urdu Unicode mixed with latin", () => {
    expect(detectLanguage("کیا hal hai")).toBe("ur");
  });

  test("detects Roman Urdu via keywords", () => {
    expect(detectLanguage("han bhai theek hai")).toBe("roman_urdu");
  });

  test("detects Roman Urdu for single keyword", () => {
    expect(detectLanguage("kya time hai")).toBe("roman_urdu");
  });

  test("detects English for plain English text", () => {
    expect(detectLanguage("Hello, what are your business hours?")).toBe("en");
  });

  test("returns en for empty string", () => {
    expect(detectLanguage("")).toBe("en");
  });

  test("detects ji as roman urdu keyword", () => {
    expect(detectLanguage("please book ji")).toBe("roman_urdu");
  });
});

describe("normalizePhone", () => {
  test("strips non-digit characters", () => {
    expect(normalizePhone("+92-300-1234567")).toBe("923001234567");
  });

  test("keeps digits only", () => {
    expect(normalizePhone("923001234567")).toBe("923001234567");
  });

  test("handles spaces and dashes", () => {
    expect(normalizePhone("(123) 456-7890")).toBe("1234567890");
  });

  test("returns empty string for non-digit input", () => {
    expect(normalizePhone("abc")).toBe("");
  });
});

describe("chunkText", () => {
  test("returns single chunk for short text", () => {
    const result = chunkText("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  test("splits on double newlines", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    const result = chunkText(text);
    expect(result).toEqual(["First paragraph.\n\nSecond paragraph."]);
  });

  test("splits large text into chunks respecting maxChars", () => {
    const para = "x".repeat(500);
    const text = `${para}\n\n${para}`;
    const result = chunkText(text, 900);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(para);
    expect(result[1]).toBe(para);
  });

  test("returns empty array for empty string", () => {
    expect(chunkText("")).toEqual([]);
  });

  test("trims leading/trailing whitespace in paragraphs", () => {
    const result = chunkText("  hello  \n\n  world  ");
    expect(result).toEqual(["hello\n\nworld"]);
  });

  test("filters blank-only paragraphs", () => {
    const result = chunkText("first\n\n   \n\nsecond");
    expect(result).toEqual(["first\n\nsecond"]);
  });
});
