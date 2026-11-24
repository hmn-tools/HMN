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
