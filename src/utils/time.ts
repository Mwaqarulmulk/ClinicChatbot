export function toIsoMinute(date: Date): string {
  const copy = new Date(date);
  copy.setSeconds(0, 0);
  return copy.toISOString();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/**
 * Parse a loose natural-language date/time expression into a UTC Date.
 *
 * Supported phrases (case-insensitive):
 *   - "today", "tomorrow", "tomor", "tmrw", "tmr", "2mrw" (misspellings)
 *   - Roman Urdu: "kal" (tomorrow), Urdu Unicode: کل
 *   - Day names: "Monday", "next Friday", "this Wednesday"
 *   - ISO date: "2025-06-15"
 *   - Time: "3pm", "10:30am", "14:00"
 *   - Space-separated: "10 30 am", "10 30 pm"
 *   - Urdu clock: "5 bjy" / "5 baje" / "3 bje" → PM inference for hours 1–8
 */
export function parseLooseDateTime(
  text: string,
  now = new Date(),
  timeZone?: string,
): Date | null {
  const normalized = text.toLowerCase();
  const base = timeZone ? getZonedParts(now, timeZone) : getLocalParts(now);

  let year = base.year;
  let month = base.month;
  let day = base.day;

  // ── 1. Date resolution ───────────────────────────────────────────────────────────────────────
  const isTomorrow =
    // English variants including common misspellings
    /\b(tomorrow|tomor{1,4}w?|tmr{1,3}w?|2mrw?|nxt\s+day)\b/.test(normalized) ||
    // Roman Urdu "kal"
    /\bkal\b/.test(normalized) ||
    // Urdu Unicode کل
    /\u06A9\u0644/.test(text);

  if (isTomorrow) {
    const next = addDaysToYmd(year, month, day, 1);
    year = next.year;
    month = next.month;
    day = next.day;
  } else if (/\btoday\b/.test(normalized)) {
    // Keep the base date
  } else {
    // Day-of-week parsing: "Monday", "next Friday", "this Wednesday"
    const dayNames = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];
    const dayMatch = normalized.match(
      /\b(next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
    );
    if (dayMatch) {
      const targetDay = dayNames.indexOf(dayMatch[2]);
      const baseDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
      const currentDay = baseDate.getDay();
      const forceNext = dayMatch[1]?.trim() === "next";
      let daysAhead = targetDay - currentDay;
      if (daysAhead < 0 || (daysAhead === 0 && forceNext)) daysAhead += 7;
      const next = addDaysToYmd(year, month, day, daysAhead);
      year = next.year;
      month = next.month;
      day = next.day;
    } else {
      // ISO date: "2025-06-15"
      const isoMatch = normalized.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
      if (isoMatch) {
        year = Number(isoMatch[1]);
        month = Number(isoMatch[2]);
        day = Number(isoMatch[3]);
      }
    }
  }

  // ── 2. Time resolution (ordered by confidence) ────────────────────────────────────────

  // A. Urdu clock marker: "5 bjy", "5 baje", "3 bje", "5 بجے"
  //    In Pakistani business context, 1–8 o’clock = PM; 9–12 = AM/noon.
  const urduClockMatch = normalized.match(
    /\b(\d{1,2})\s*(?:baj[ey]?|bjy|bje|\u0628\u062c\u06d2|\u0628\u062c\u06d2)\b/,
  );
  if (urduClockMatch) {
    let h = Number(urduClockMatch[1]);
    if (h >= 1 && h <= 8) h += 12; // PM inference
    if (timeZone)
      return zonedTimeToUtc({ year, month, day, hour: h, minute: 0 }, timeZone);
    return new Date(year, month - 1, day, h, 0, 0, 0);
  }

  // B. "HH:MM am/pm" or "HH.MM am/pm"
  const colonMeridiem = normalized.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)\b/);
  if (colonMeridiem) {
    let h = Number(colonMeridiem[1]);
    const m = Number(colonMeridiem[2]);
    if (colonMeridiem[3] === "pm" && h < 12) h += 12;
    if (colonMeridiem[3] === "am" && h === 12) h = 0;
    if (timeZone)
      return zonedTimeToUtc({ year, month, day, hour: h, minute: m }, timeZone);
    return new Date(year, month - 1, day, h, m, 0, 0);
  }

  // C. Space-separated "HH MM am/pm" (e.g. "10 30 am", "10 30 pm")
  const spaceMeridiem = normalized.match(/\b(\d{1,2})\s+(\d{2})\s+(am|pm)\b/);
  if (spaceMeridiem) {
    let h = Number(spaceMeridiem[1]);
    const m = Number(spaceMeridiem[2]);
    if (spaceMeridiem[3] === "pm" && h < 12) h += 12;
    if (spaceMeridiem[3] === "am" && h === 12) h = 0;
    if (timeZone)
      return zonedTimeToUtc({ year, month, day, hour: h, minute: m }, timeZone);
    return new Date(year, month - 1, day, h, m, 0, 0);
  }

  // D. "HH am/pm" — hour only with explicit meridiem
  const hourMeridiem = normalized.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (hourMeridiem) {
    let h = Number(hourMeridiem[1]);
    if (hourMeridiem[2] === "pm" && h < 12) h += 12;
    if (hourMeridiem[2] === "am" && h === 12) h = 0;
    if (timeZone)
      return zonedTimeToUtc({ year, month, day, hour: h, minute: 0 }, timeZone);
    return new Date(year, month - 1, day, h, 0, 0, 0);
  }

  // E. "HH:MM" or "HH.MM" — no meridiem, treat as-is (24-hour)
  const colonOnly = normalized.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (colonOnly) {
    const h = Number(colonOnly[1]);
    const m = Number(colonOnly[2]);
    if (timeZone)
      return zonedTimeToUtc({ year, month, day, hour: h, minute: m }, timeZone);
    return new Date(year, month - 1, day, h, m, 0, 0);
  }

  // No time component found
  return null;
}

/**
 * Format a UTC date as a human-readable local string.
 *
 * @param date     - UTC Date to format
 * @param timeZone - IANA timezone (e.g. "Asia/Karachi")
 * @param locale   - BCP-47 locale tag (defaults to "en" for universal readability)
 */
export function formatLocal(
  date: Date,
  timeZone: string,
  locale = "en",
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

export function startOfZonedDay(date: Date, timeZone: string): Date {
  const parts = getZonedParts(date, timeZone);
  return zonedTimeToUtc({ ...parts, hour: 0, minute: 0 }, timeZone);
}

export function zonedBusinessTime(
  date: Date,
  timeZone: string,
  hour: number,
  minute = 0,
): Date {
  const parts = getZonedParts(date, timeZone);
  return zonedTimeToUtc(
    { year: parts.year, month: parts.month, day: parts.day, hour, minute },
    timeZone,
  );
}

export function zonedHourValue(date: Date, timeZone: string): number {
  const parts = getZonedParts(date, timeZone);
  return parts.hour + parts.minute / 60;
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function getLocalParts(date: Date): ZonedParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const hour = value("hour");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: hour === 24 ? 0 : hour,
    minute: value("minute"),
  };
}

function zonedTimeToUtc(parts: ZonedParts, timeZone: string): Date {
  let utc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
    0,
  );
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const zoned = getZonedParts(new Date(utc), timeZone);
    const zonedAsUtc = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      0,
      0,
    );
    const intendedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0,
    );
    utc -= zonedAsUtc - intendedAsUtc;
  }
  return new Date(utc);
}

function addDaysToYmd(year: number, month: number, day: number, days: number) {
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}
