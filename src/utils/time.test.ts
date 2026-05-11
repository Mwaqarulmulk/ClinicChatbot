import { describe, expect, test } from "bun:test";
import { addMinutes, formatLocal, parseLooseDateTime, startOfZonedDay, toIsoMinute, zonedBusinessTime, zonedHourValue } from "./time";

const TZ = "Asia/Karachi"; // UTC+5

describe("toIsoMinute", () => {
  test("zeros out seconds and milliseconds", () => {
    const date = new Date("2024-06-15T10:30:45.500Z");
    const result = toIsoMinute(date);
    expect(result).toBe("2024-06-15T10:30:00.000Z");
  });
});

describe("addMinutes", () => {
  test("adds positive minutes", () => {
    const date = new Date("2024-06-15T10:00:00.000Z");
    const result = addMinutes(date, 30);
    expect(result.getTime()).toBe(new Date("2024-06-15T10:30:00.000Z").getTime());
  });

  test("adds 60 minutes (one hour)", () => {
    const date = new Date("2024-06-15T10:00:00.000Z");
    const result = addMinutes(date, 60);
    expect(result.getTime()).toBe(new Date("2024-06-15T11:00:00.000Z").getTime());
  });

  test("does not mutate the original date", () => {
    const date = new Date("2024-06-15T10:00:00.000Z");
    const original = date.getTime();
    addMinutes(date, 30);
    expect(date.getTime()).toBe(original);
  });
});

describe("parseLooseDateTime", () => {
  const now = new Date("2024-06-15T10:00:00.000Z"); // Saturday

  test("returns null when no time is present", () => {
    expect(parseLooseDateTime("book me an appointment", now)).toBeNull();
  });

  test("parses 12-hour AM time", () => {
    const result = parseLooseDateTime("Book at 10am today", now);
    expect(result).not.toBeNull();
  });

  test("parses 12-hour PM time", () => {
    const result = parseLooseDateTime("Book at 3pm today", now);
    expect(result).not.toBeNull();
    // 3pm is hour 15
    const localHour = result!.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "UTC" });
    expect(Number(localHour)).toBe(15);
  });

  test("parses 'tomorrow' with a time", () => {
    const result = parseLooseDateTime("Book for tomorrow at 10am", now);
    expect(result).not.toBeNull();
  });

  test("parses ISO date with time", () => {
    const result = parseLooseDateTime("appointment on 2024-12-25 at 2pm", now);
    expect(result).not.toBeNull();
    // December 25 2024, 2pm UTC
    expect(result!.getUTCMonth()).toBe(11); // December is 11
    expect(result!.getUTCDate()).toBe(25);
  });

  test("respects timezone", () => {
    const result = parseLooseDateTime("today at 9am", now, TZ);
    expect(result).not.toBeNull();
    // 9am Karachi (UTC+5) = 4am UTC
    expect(result!.getUTCHours()).toBe(4);
  });
});

describe("formatLocal", () => {
  test("returns a non-empty string", () => {
    const date = new Date("2024-06-15T09:00:00.000Z");
    const result = formatLocal(date, TZ);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("shows correct hour in timezone", () => {
    // 9am UTC → 2pm Karachi (UTC+5)
    const date = new Date("2024-06-15T09:00:00.000Z");
    const result = formatLocal(date, TZ);
    expect(result).toMatch(/2:00/);
  });
});

describe("startOfZonedDay", () => {
  test("returns midnight UTC offset by timezone", () => {
    // Midnight Karachi (UTC+5) = 19:00 UTC previous day
    const date = new Date("2024-06-15T10:00:00.000Z");
    const result = startOfZonedDay(date, TZ);
    expect(result.getUTCHours()).toBe(19);
    expect(result.getUTCDate()).toBe(14); // previous day in UTC
  });
});

describe("zonedBusinessTime", () => {
  test("converts business hour in timezone to UTC", () => {
    const date = new Date("2024-06-15T10:00:00.000Z");
    const result = zonedBusinessTime(date, TZ, 9, 0);
    // 9am Karachi = 4am UTC
    expect(result.getUTCHours()).toBe(4);
  });
});

describe("zonedHourValue", () => {
  test("returns fractional hour in timezone", () => {
    // 9:30am Karachi = 4:30am UTC
    const date = new Date("2024-06-15T04:30:00.000Z");
    const result = zonedHourValue(date, TZ);
    expect(result).toBeCloseTo(9.5);
  });

  test("returns integer for on-the-hour", () => {
    // 9am Karachi = 4am UTC
    const date = new Date("2024-06-15T04:00:00.000Z");
    const result = zonedHourValue(date, TZ);
    expect(result).toBe(9);
  });
});
