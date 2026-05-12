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
 *   - "today", "tomorrow"
 *   - Day names: "Monday", "next Friday", "this Wednesday"
 *   - ISO date: "2025-06-15"
 *   - Time: "3pm", "10:30am", "14:00"
 */
export function parseLooseDateTime(
  text: string,
  now = new Date(),
  timeZone?: string,
): Date | null {
  const normalized = text.toLowerCase();
  const timeMatch = normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const base = timeZone ? getZonedParts(now, timeZone) : getLocalParts(now);

  let year = base.year;
  let month = base.month;
  let day = base.day;

  if (/\btomorrow\b/.test(normalized) || /\u06A9\u0644/.test(text)) {
    const next = addDaysToYmd(year, month, day, 1);
    year = next.year;
    month = next.month;
    day = next.day;
  } else if (/\btoday\b/.test(normalized)) {
    // Keep the base date
  } else {
    // ── Day-of-week parsing: "Monday", "next Friday", "this Wednesday" ─────────
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
      // "this Friday" when today is Friday → same day; "next Friday" → +7 days
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

  if (!timeMatch) return null;
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] ?? "0");
  const meridiem = timeMatch[3];
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (timeZone)
    return zonedTimeToUtc({ year, month, day, hour, minute }, timeZone);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
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
