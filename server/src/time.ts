export type Zoned = {
  weekday: string;
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: string;
  dateKey: string;
  hm: string;
};

export function zoned(date: Date, timeZone: string): Zoned {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour);
  const minute = parts.minute ?? "00";
  return {
    weekday: parts.weekday ?? "",
    year: parts.year ?? "",
    month: parts.month ?? "",
    day: parts.day ?? "",
    hour,
    minute,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${String(hour).padStart(2, "0")}:${minute}`,
  };
}

export function calendarDays(fromIso: string, now: Date, timeZone: string): number {
  const from = fromIso.length === 10 ? fromIso : zoned(new Date(fromIso), timeZone).dateKey;
  const to = zoned(now, timeZone).dateKey;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function dueDateKey(due: string, timeZone: string): string {
  if (due.length === 10) return due;
  return zoned(new Date(due), timeZone).dateKey;
}

export function hasClock(due: string): boolean {
  return due.length > 10;
}

export function greetingWord(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function plusHour(hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  return `${String(((h ?? 0) + 1) % 24).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}`;
}

/** A `due_at` that HMN can read: a date (YYYY-MM-DD) or a full instant. A screen skips any other value. */
export function readableDue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // The day must be a real day: 2026-02-31 would roll over to 3 March, so it is refused.
  if (!realDay(value.slice(0, 10))) return false;
  if (value.length === 10) return true;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

/** True for a YYYY-MM-DD that names a day of the calendar. */
export function realDay(key: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The days from one date key to another, by the calendar alone. No zone can move either day. */
export function keyDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The day after a date key. */
export function nextDayKey(key: string): string {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** How long an event lasts when its calendar gives no end. A fixture is a game or a race. */
export const EVENT_HOURS = 1;
export const FIXTURE_HOURS = 2;

/**
 * True when an event is over, or cancelled. An all-day event lasts through its last day (iCalendar writes the end as
 * the first day after it). A timed event ends at `properties.end_at`, or a fixed time after its start. A screen does
 * not show an event that is over, so a game that started this afternoon leaves Today when it ends.
 */
export function eventOver(
  event: { due_at: string | null; status?: string | null; properties: Record<string, unknown> },
  now: Date,
  timeZone: string,
  fixture = false,
): boolean {
  if (!readableDue(event.due_at)) return true;
  if (event.status === "cancelled" || event.status === "past") return true;
  const end = typeof event.properties.end_at === "string" && readableDue(event.properties.end_at) ? event.properties.end_at : null;
  if (!hasClock(event.due_at)) {
    const after = end && !hasClock(end) ? end : nextDayKey(event.due_at);
    return after <= zoned(now, timeZone).dateKey;
  }
  const endMs = end && hasClock(end) ? Date.parse(end) : Date.parse(event.due_at) + (fixture ? FIXTURE_HOURS : EVENT_HOURS) * 3_600_000;
  return endMs <= now.getTime();
}

/** Whole days between a date and today: 1 for yesterday. */
export function daysLate(due: string, now: Date, timeZone: string): number {
  return calendarDays(dueDateKey(due, timeZone), now, timeZone);
}
