// Wall-clock time in an endpoint's own timezone, for rate schedules. `TZDate` returns `NaN` for an
// unknown zone, so `Intl` checks the name and everything falls back to UTC.
import { TZDate } from "@date-fns/tz";

export const localTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const DAY_LABEL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

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

const zoned = (at: number, timezone: string): TZDate =>
  new TZDate(at, timezoneValid(timezone) ? timezone : "UTC");

/** Day of week and minutes past midnight. */
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
 * A promotion's dates are read in the endpoint's zone, not the browser's ("until Friday" is Friday
 * where it is billed). A day past month end rolls over, as for `Date`.
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

/** `1758067200000` → `2026-09-17`, as the date input wants it. */
export function calendarDay(at: number, timezone: string): string {
  const d = zoned(at, timezone);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function startOfDay(text: string, timezone: string): number | null {
  const m = DATE.exec(text.trim());
  if (!m) return null;
  return zonedTime(timezone, Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, 0);
}

export function endOfDay(text: string, timezone: string): number | null {
  const m = DATE.exec(text.trim());
  if (!m) return null;
  return zonedTime(timezone, Number(m[1]), Number(m[2]), Number(m[3]), 23, 59, 59, 999);
}

/** The end of the day `days` after the one `at` falls on. */
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
