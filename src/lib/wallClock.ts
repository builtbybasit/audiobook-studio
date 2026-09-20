// Local wall-clock time, in somebody else's timezone.
//
// A rate schedule is written in the endpoint's own timezone — "cheaper 22:00–06:00 in Asia/Tokyo" —
// so deciding which rate is in force means knowing what day and what minute it is *there*, not here.
// That is the whole subject of this file, and it knows nothing about rates: the pricing rules read
// the clock, the clock never reads a rate card.
//
// `TZDate` from `@date-fns/tz` is a `Date` whose getters answer in a named zone, and whose
// constructor takes wall-clock components in that zone and finds the instant they name, daylight
// saving included. It is silent about a zone it does not know — every getter comes back `NaN` —
// so the one thing this file still asks `Intl` for is whether a zone name is real, and everything
// below falls back to UTC when it is not.
import { TZDate } from "@date-fns/tz";

/** The browser's own timezone, and "UTC" where it cannot be asked. */
export const localTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

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

const KNOWN = new Map<string, boolean>();

export function timezoneValid(timezone: string): boolean {
  let ok = KNOWN.get(timezone);
  if (ok == null) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      ok = true;
    } catch {
      ok = false;
    }
    KNOWN.set(timezone, ok);
  }
  return ok;
}

/** The instant `at`, read in `timezone` — or in UTC when the zone is not one the runtime knows. */
const zoned = (at: number, timezone: string): TZDate =>
  new TZDate(at, timezoneValid(timezone) ? timezone : "UTC");

/** Day of week and minutes past midnight at `at`, read in `timezone`. Falls back to UTC. */
export function localClock(
  at: number,
  timezone: string,
): {
  day: number;
  minutes: number;
  ok: boolean;
} {
  const d = zoned(at, timezone);
  return {
    day: d.getDay(),
    minutes: d.getHours() * 60 + d.getMinutes(),
    ok: timezoneValid(timezone),
  };
}

/**
 * The instant a wall-clock time in `timezone` corresponds to.
 *
 * A promotion's start and end are *dates*, not instants — "until Friday" means the end of Friday
 * where the endpoint is billed, not where the operator happens to be sitting. Reading them with the
 * browser's own timezone moves a New York promotion by a day when it is edited from Karachi, and
 * every other part of this page already displays them in `config.timezone`. A day past the end of
 * the month rolls over, as it does for `Date`.
 */
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
  const zone = timezoneValid(timezone) ? timezone : "UTC";
  return new TZDate(y, m - 1, d, hour, minute, second, ms, zone).getTime();
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** `1758067200000` → `2026-09-17`, as the date input wants it, in the endpoint's timezone. */
export function calendarDay(at: number, timezone: string): string {
  const d = zoned(at, timezone);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `2026-09-17` → the first instant of that day in `timezone`; null when it isn't a date. */
export function startOfDay(text: string, timezone: string): number | null {
  const m = DATE.exec(text.trim());
  if (!m) return null;
  return zonedTime(timezone, Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, 0);
}

/** `2026-09-17` → the last instant of that day in `timezone`; null when it isn't a date. */
export function endOfDay(text: string, timezone: string): number | null {
  const m = DATE.exec(text.trim());
  if (!m) return null;
  return zonedTime(timezone, Number(m[1]), Number(m[2]), Number(m[3]), 23, 59, 59, 999);
}

/** `n` days on from the calendar day `at` falls on, in `timezone`, at the end of that day. */
export function endOfDayAfter(at: number, timezone: string, days: number): number {
  const d = zoned(at, timezone);
  return zonedTime(
    timezone,
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate() + days,
    23,
    59,
    59,
    999,
  );
}

/** `510` → `08:30`. */
export function clockLabel(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
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
