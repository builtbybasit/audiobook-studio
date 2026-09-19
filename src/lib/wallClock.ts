// Local wall-clock time, in somebody else's timezone.
//
// A rate schedule is written in the endpoint's own timezone — "cheaper 22:00–06:00 in Asia/Tokyo" —
// so deciding which rate is in force means knowing what day and what minute it is *there*, not here.
// That is the whole subject of this file, and it knows nothing about rates: the pricing rules read
// the clock, the clock never reads a rate card.
//
// `Intl.DateTimeFormat` is the only source of truth for a zone's offset, and constructing one is
// expensive enough to cache. The offset is derived by formatting an instant *into* the zone and
// reading the parts back, which is also why `zonedTime` takes two passes — see the note on it.

/** The browser's own timezone, and "UTC" where it cannot be asked. */
export const localTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();
export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const DAY_LABEL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export const DAY_SHORT = DAYS;

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  if (FORMATTERS.has(timezone)) return FORMATTERS.get(timezone)!;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    f = null;
  }
  FORMATTERS.set(timezone, f);
  return f;
}

export const timezoneValid = (timezone: string): boolean => formatterFor(timezone) !== null;

/** Day of week and minutes past midnight at `at`, read in `timezone`. Falls back to UTC. */
export function localClock(
  at: number,
  timezone: string,
): {
  day: number;
  minutes: number;
  ok: boolean;
} {
  const f = formatterFor(timezone);
  if (!f) {
    const d = new Date(at);
    return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), ok: false };
  }
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const part of f.formatToParts(at)) {
    if (part.type === "weekday") day = Math.max(0, DAYS.indexOf(part.value));
    else if (part.type === "hour") hour = Number(part.value) % 24;
    else if (part.type === "minute") minute = Number(part.value);
  }
  return { day, minutes: hour * 60 + minute, ok: true };
}

/**
 * Calendar dates, read and written in the endpoint's own timezone.
 *
 * A promotion's start and end are *dates*, not instants — "until Friday" means the end of Friday
 * where the endpoint is billed, not where the operator happens to be sitting. Reading them with the
 * browser's own timezone moves a New York promotion by a day when it is edited from Karachi, and
 * every other part of this page already displays them in `config.timezone`.
 *
 * There is no timezone library here, so the offset is found by formatting the instant in the target
 * zone and asking how far that is from UTC; one refinement pass settles the daylight-saving edge.
 */
const DATE_PARTS = new Map<string, Intl.DateTimeFormat | null>();

function dateFormatterFor(timezone: string): Intl.DateTimeFormat | null {
  if (DATE_PARTS.has(timezone)) return DATE_PARTS.get(timezone)!;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    f = null;
  }
  DATE_PARTS.set(timezone, f);
  return f;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(at: number, timezone: string): ZonedParts {
  const f = dateFormatterFor(timezone);
  const d = new Date(at);
  if (!f)
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    };
  const out: ZonedParts = { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  for (const part of f.formatToParts(at)) {
    const n = Number(part.value);
    if (part.type === "year") out.year = n;
    else if (part.type === "month") out.month = n;
    else if (part.type === "day") out.day = n;
    else if (part.type === "hour") out.hour = n % 24;
    else if (part.type === "minute") out.minute = n;
    else if (part.type === "second") out.second = n;
  }
  return out;
}

/** How far ahead of UTC `timezone` is at this instant, in ms. */
function zoneOffset(at: number, timezone: string): number {
  const p = zonedParts(at, timezone);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000
  );
}

/** The instant a wall-clock time in `timezone` corresponds to. */
export function zonedTime(
  timezone: string,
  y: number,
  m: number,
  d: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  const wall = Date.UTC(y, m - 1, d, hour, minute, second, ms);
  // two passes: the first offset is read at the wrong instant across a DST boundary, the second at
  // one within an hour of the answer, which is close enough for a calendar date
  const first = wall - zoneOffset(wall, timezone);
  return wall - zoneOffset(first, timezone);
}

/** `1758067200000` → `2026-09-17`, as the date input wants it, in the endpoint's timezone. */
export function calendarDay(at: number, timezone: string): string {
  const p = zonedParts(at, timezone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** `2026-09-17` → the first instant of that day in `timezone`; null when it isn't a date. */
export function startOfDay(text: string, timezone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  return zonedTime(timezone, Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, 0);
}

/** `2026-09-17` → the last instant of that day in `timezone`; null when it isn't a date. */
export function endOfDay(text: string, timezone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  return zonedTime(timezone, Number(m[1]), Number(m[2]), Number(m[3]), 23, 59, 59, 999);
}

/** `n` days on from the calendar day `at` falls on, in `timezone`, at the end of that day. */
export function endOfDayAfter(at: number, timezone: string, days: number): number {
  const p = zonedParts(at, timezone);
  return zonedTime(timezone, p.year, p.month, p.day + days, 23, 59, 59, 999);
}

/** `510` → `08:30`. */
export function clockLabel(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const parseClock = (text: string): number | null => {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

export function stamp(at: number, timezone: string): string {
  try {
    return new Date(at).toLocaleString([], {
      timeZone: timezoneValid(timezone) ? timezone : undefined,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return new Date(at).toISOString();
  }
}

/** "in 40 minutes", "tomorrow at 21:00", "on Friday" — for "when does this change". */
export function whenPhrase(at: number, now: number, timezone: string): string {
  const ms = at - now;
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const today = localClock(now, timezone);
  const then = localClock(at, timezone);
  const days = Math.floor((mins + today.minutes - then.minutes) / 1440);
  if (days <= 1) return `tomorrow at ${clockLabel(then.minutes)}`;
  if (days < 7) return `on ${DAY_LABEL[then.day]}`;
  return `in ${Math.round(days / 7)} week${Math.round(days / 7) === 1 ? "" : "s"}`;
}
