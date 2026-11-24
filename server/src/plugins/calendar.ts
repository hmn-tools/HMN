import type { PluginManifest } from "../plugins";
import { LEGACY_ROLES } from "../kinds";
import { isPublicHost } from "../workers/config";

export const calendarManifest: PluginManifest = {
  id: "calendar",
  maxTier: "personal",
  // The calendar's own area, and the owner's area with the role `family` for a family date.
  areas: ["role:family"],
  permissions: ["propose"],
};

export type CalendarPerson = { id: string; title: string; kind: string | null };

export type ParsedEvent = {
  /** The UID of a single event, or the UID, "#", and the date of one occurrence of a repeating event. */
  uid: string;
  title: string;
  due: string;
  allDay: boolean;
  description: string | null;
  attendees: string[];
  /** The end. An instant for a timed event. For an all-day event, the first day after it, as iCalendar writes it. Null when the calendar gives no length. */
  end?: string | null;
  /** False when the calendar marks the event as free time, and for an all-day event with no mark. */
  busy?: boolean;
};

/** A mirrored row, as the parent process gives it to the plugin. */
export type MirroredEvent = {
  id: string;
  external_id: string | null;
  title?: string;
  due_at?: string | null;
  body?: string | null;
  status?: string | null;
  properties?: Record<string, unknown>;
};

export type CalendarSource = { id: string | null; areaId: string | null; tier: string | null };

export type ParseOptions = {
  now?: Date;
  /** The owner's time zone. A time with no zone is read in it. */
  timeZone?: string;
};

/** Events older than this are not mirrored. */
export const WINDOW_BACK_DAYS = 30;
/** A repeating event is expanded this far ahead. Each tick moves the window. */
export const RECUR_AHEAD_DAYS = 90;
const MAX_STEPS = 5000;
const DAY = 86_400_000;

/** A calendar document is at most this large. */
export const ICS_MAX_BYTES = 2_000_000;
const ICS_TIMEOUT_MS = 15_000;

/**
 * True for an address that HMN may read a calendar from: https or webcal, a host on the internet, no user in it.
 * `allowLocal` is for a CalDAV server that the owner named in the environment of the mini.
 */
export function calendarUrlAllowed(url: string, allowLocal = false): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/^webcal:/i, "https:"));
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  return allowLocal || isPublicHost(parsed.hostname);
}

export async function fetchIcs(
  url: string,
  username: string | null,
  password: string | null,
  fetchImpl: typeof fetch = fetch,
  options: { allowLocal?: boolean } = {},
): Promise<string> {
  if (!calendarUrlAllowed(url, options.allowLocal)) throw new Error("HMN reads a calendar only from an https address on the internet.");
  const headers: Record<string, string> = {};
  if (username && password) {
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }
  // A calendar app gives a `webcal:` address. It is the same document over HTTPS. A redirect is refused: it could
  // lead to an address on this network.
  const response = await fetchImpl(url.replace(/^webcal:/i, "https:"), { headers, redirect: "error", signal: AbortSignal.timeout(ICS_TIMEOUT_MS) });
  if (!response.ok) throw new Error("The calendar did not answer.");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > ICS_MAX_BYTES) throw new Error("The calendar is too large.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ICS_MAX_BYTES) {
      await reader.cancel();
      throw new Error("The calendar is too large.");
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** True when the text is a calendar document. An error page or an empty reply must not remove mirrored events. */
export function isCalendar(ics: string): boolean {
  return /BEGIN:VCALENDAR/i.test(ics) && /END:VCALENDAR/i.test(ics);
}

type Prop = { params: string; value: string };
type RawEvent = {
  uid: string;
  title: string;
  start: Prop;
  description: string | null;
  attendees: string[];
  cancelled: boolean;
  end: Prop | null;
  duration: string | null;
  transparent: boolean | null;
  rrule: string | null;
  exdates: Prop[];
  recurrenceId: Prop | null;
};

type Local = { y: number; m: number; d: number; hh: number; mm: number; ss: number; allDay: boolean; zone: string | null; utc: boolean };

export function parseIcs(ics: string, options: ParseOptions = {}): ParsedEvent[] {
  const now = options.now ?? new Date();
  const ownerZone = validZone(options.timeZone) ?? "UTC";
  const today = dateKeyIn(now, ownerZone);
  const from = shiftKey(today, -WINDOW_BACK_DAYS);
  const until = shiftKey(today, RECUR_AHEAD_DAYS);

  const raws: RawEvent[] = [];
  for (const block of ics.split(/BEGIN:VEVENT/i).slice(1)) {
    const raw = readEvent(block.split(/END:VEVENT/i)[0] ?? "");
    if (raw) raws.push(raw);
  }
  // A slot of a repeating event is named by its date in the zone of the first event.
  const zones = new Map<string, string>();
  for (const raw of raws) {
    if (raw.recurrenceId) continue;
    const start = readLocal(raw.start, ownerZone);
    if (start) zones.set(raw.uid, start.utc ? "UTC" : start.zone ?? ownerZone);
  }
  const zoneOf = (uid: string) => zones.get(uid) ?? ownerZone;
  const overrides = new Map<string, Set<string>>();
  for (const raw of raws) {
    if (!raw.recurrenceId) continue;
    const slot = readLocal(raw.recurrenceId, ownerZone);
    if (!slot) continue;
    const set = overrides.get(raw.uid) ?? new Set<string>();
    set.add(slotKey(slot, ownerZone, zoneOf(raw.uid)));
    overrides.set(raw.uid, set);
  }

  const events: ParsedEvent[] = [];
  const push = (raw: RawEvent, uid: string, start: Local) => {
    const due = start.allDay ? keyOf(start) : toInstant(start, ownerZone);
    const day = start.allDay ? keyOf(start) : dateKeyIn(new Date(due), ownerZone);
    if (day < from) return;
    // The length is the same for each date of a repeating event.
    const length = lengthOf(raw, ownerZone);
    let end: string | null = null;
    if (start.allDay) end = shiftKey(due, Math.max(1, length.days));
    else if (length.ms > 0) end = new Date(Date.parse(due) + length.ms).toISOString();
    events.push({
      uid,
      title: raw.title,
      due,
      allDay: start.allDay,
      description: raw.description,
      attendees: raw.attendees,
      end,
      busy: raw.transparent === null ? !start.allDay : !raw.transparent,
    });
  };

  for (const raw of raws) {
    const start = readLocal(raw.start, ownerZone);
    if (!start) continue;
    if (raw.recurrenceId) {
      // One changed occurrence of a repeating event. It keeps the id of its original slot.
      const slot = readLocal(raw.recurrenceId, ownerZone);
      if (!slot || raw.cancelled) continue;
      push(raw, `${raw.uid}#${slotKey(slot, ownerZone, zoneOf(raw.uid))}`, start);
      continue;
    }
    if (raw.cancelled) continue;
    if (!raw.rrule) {
      push(raw, raw.uid, start);
      continue;
    }
    const skipped = new Set<string>(overrides.get(raw.uid) ?? []);
    for (const exdate of raw.exdates) {
      for (const part of exdate.value.split(",")) {
        const local = readLocal({ params: exdate.params, value: part.trim() }, ownerZone);
        if (local) skipped.add(slotKey(local, ownerZone, zoneOf(raw.uid)));
      }
    }
    const days = expand(raw.rrule, start, ownerZone, until);
    if (!days) {
      // A rule this parser does not read. The first date is still correct, so mirror that one.
      push(raw, raw.uid, start);
      continue;
    }
    for (const day of days) {
      const occurrence: Local = { ...start, y: day.y, m: day.m, d: day.d };
      const key = slotKey(occurrence, ownerZone, zoneOf(raw.uid));
      if (skipped.has(key)) continue;
      push(raw, `${raw.uid}#${key}`, occurrence);
    }
  }
  return events;
}

/**
 * Compare the calendar with the mirror. A new event is a create, a changed event is a patch, and an
 * event that left the calendar is a patch to `cancelled`. The mirror never deletes, so history stays.
 */
export function calendarDrafts(
  events: ParsedEvent[],
  people: CalendarPerson[],
  source: CalendarSource | string | null,
  existing: MirroredEvent[],
  options: { today?: string; mirror?: boolean; complete?: boolean; familyKinds?: string[] } = {},
) {
  const from: CalendarSource = typeof source === "string" || source === null ? { id: source, areaId: null, tier: null } : source;
  // The person kinds that have the role `family`. The parent process reads them from the owner's kinds.
  const familyKinds = options.familyKinds ? new Set(options.familyKinds) : LEGACY_ROLES.familyPerson;
  const byExternal = new Map(existing.filter((item) => item.external_id).map((item) => [item.external_id!, item]));
  const seen = new Set<string>();
  const drafts: Array<Record<string, unknown>> = [];
  for (const event of events) {
    seen.add(event.uid);
    const prior = byExternal.get(event.uid);
    if (prior) {
      // Without a calendar source there is no mirror. The first import stays as it is.
      if (!options.mirror) continue;
      const patch: Record<string, unknown> = {};
      if (prior.title !== event.title) patch.title = event.title;
      if ((prior.due_at ?? null) !== event.due) patch.due_at = event.due;
      if ((prior.body ?? null) !== (event.description ?? null)) patch.body = event.description;
      if (prior.status === "cancelled") patch.status = "upcoming";
      // The end and the busy mark are properties. A patch replaces the properties, so it carries the others too.
      const before = prior.properties ?? {};
      if ((before.end_at ?? null) !== (event.end ?? null) || (before.busy ?? null) !== (event.busy ?? null)) {
        patch.properties = { ...before, end_at: event.end ?? null, busy: event.busy ?? null };
      }
      if (Object.keys(patch).length === 0) continue;
      drafts.push({
        op: "update" as const,
        id: prior.id,
        external_id: event.uid,
        entity: { type: "event", title: event.title, external_id: event.uid },
        patch,
        reason: "The calendar changed this event.",
      });
      continue;
    }
    const known = event.attendees.map((name) => people.find((person) => person.title.toLowerCase() === name.toLowerCase()) ?? null).filter((person): person is CalendarPerson => person !== null);
    const unknown = event.attendees.filter((name) => !people.some((person) => person.title.toLowerCase() === name.toLowerCase()));
    const family = known.length > 0 && known.every((person) => familyKinds.has(person.kind ?? "")) && unknown.length === 0;
    drafts.push({
      op: "create" as const,
      external_id: event.uid,
      entity: {
        type: "event",
        title: event.title,
        body: event.description,
        status: "upcoming",
        kind: family ? "family" : "appointment",
        due_at: event.due,
        // A family date goes to the owner's area with the role `family`. The parent process finds it.
        // All other events take the calendar's own area.
        area_id: family ? null : from.areaId,
        ...(family ? { area_role: "family" } : {}),
        tier: from.tier,
        source_id: from.id,
        external_id: event.uid,
        properties: {
          plugin: "calendar",
          mirror: true,
          all_day: event.allDay,
          end_at: event.end ?? null,
          busy: event.busy ?? null,
          unmatched: unknown,
        },
      },
      links: family ? known.map((person) => ({ rel: "with", to_type: "person", to_id: person.id })) : [],
      reason: family ? "A family date from the calendar." : "A calendar event. Unknown names were not added as people.",
    });
  }
  if (options.mirror && options.complete && options.today) {
    for (const prior of existing) {
      if (!prior.external_id || seen.has(prior.external_id) || prior.status === "cancelled" || !prior.due_at) continue;
      // An event in the past is a record. Only an event from today on can leave the calendar.
      if (prior.due_at.slice(0, 10) < options.today) continue;
      drafts.push({
        op: "update" as const,
        id: prior.id,
        external_id: prior.external_id,
        entity: { type: "event", title: prior.title ?? "", external_id: prior.external_id },
        patch: { status: "cancelled" },
        reason: "The calendar no longer has this event.",
      });
    }
  }
  return drafts;
}

function readEvent(block: string): RawEvent | null {
  // An alarm inside an event has its own DESCRIPTION. It is not the event's text.
  const body = unfold(block).replace(/BEGIN:VALARM[\s\S]*?END:VALARM/gi, "");
  const props = new Map<string, Prop[]>();
  for (const line of body.split("\n")) {
    const match = /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(line.trim());
    if (!match) continue;
    const name = match[1]!.toUpperCase();
    const list = props.get(name) ?? [];
    list.push({ params: match[2] ?? "", value: (match[3] ?? "").trim() });
    props.set(name, list);
  }
  const one = (name: string) => props.get(name)?.[0] ?? null;
  const uid = one("UID")?.value;
  const title = text(one("SUMMARY")?.value ?? "").slice(0, 200);
  const start = one("DTSTART");
  if (!uid || !title || !start) return null;
  const description = text(one("DESCRIPTION")?.value ?? "").slice(0, 4000);
  const attendees = (props.get("ATTENDEE") ?? [])
    .map((prop) => {
      const name = /CN=([^;:]+)/i.exec(prop.params);
      return (name?.[1] ?? prop.value).replaceAll('"', "").trim();
    })
    .filter(Boolean);
  return {
    uid,
    title,
    start,
    description: description || null,
    attendees,
    cancelled: (one("STATUS")?.value ?? "").toUpperCase() === "CANCELLED",
    end: one("DTEND"),
    duration: one("DURATION")?.value ?? null,
    transparent: one("TRANSP") ? (one("TRANSP")!.value.toUpperCase() === "TRANSPARENT") : null,
    rrule: one("RRULE")?.value ?? null,
    exdates: props.get("EXDATE") ?? [],
    recurrenceId: one("RECURRENCE-ID"),
  };
}

/** The length of an event, from DTEND or DURATION. An all-day event is at least one day. */
function lengthOf(raw: RawEvent, ownerZone: string): { ms: number; days: number } {
  const start = readLocal(raw.start, ownerZone);
  if (!start) return { ms: 0, days: 1 };
  if (raw.end) {
    const end = readLocal(raw.end, ownerZone);
    if (end) {
      if (start.allDay) return { ms: 0, days: Math.round((Date.parse(`${keyOf(end)}T00:00:00Z`) - Date.parse(`${keyOf(start)}T00:00:00Z`)) / DAY) };
      const ms = Date.parse(toInstant(end, ownerZone)) - Date.parse(toInstant(start, ownerZone));
      return { ms: ms > 0 ? ms : 0, days: 1 };
    }
  }
  if (raw.duration) {
    const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(raw.duration.trim().toUpperCase());
    if (match) {
      const days = Number(match[1] ?? 0) * 7 + Number(match[2] ?? 0);
      const ms = days * DAY + Number(match[3] ?? 0) * 3_600_000 + Number(match[4] ?? 0) * 60_000 + Number(match[5] ?? 0) * 1000;
      return { ms, days: Math.max(1, days) };
    }
  }
  return { ms: 0, days: 1 };
}

/** The instant at which a day starts in a zone. `2026-11-20` in Australia/Perth is `2026-11-19T16:00:00.000Z`. */
export function startOfDay(dateKey: string, zone: string): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return toInstant({ y, m, d, hh: 0, mm: 0, ss: 0, allDay: false, zone: validZone(zone), utc: false }, validZone(zone) ?? "UTC");
}

function readLocal(prop: Prop, ownerZone: string): Local | null {
  const digits = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/.exec(prop.value.trim());
  if (!digits) return null;
  const allDay = /VALUE=DATE(?!-)/i.test(prop.params) || digits[4] === undefined;
  const zone = /TZID=([^;:]+)/i.exec(prop.params)?.[1]?.replaceAll('"', "") ?? null;
  return {
    y: Number(digits[1]),
    m: Number(digits[2]),
    d: Number(digits[3]),
    hh: Number(digits[4] ?? 0),
    mm: Number(digits[5] ?? 0),
    ss: Number(digits[6] ?? 0),
    allDay,
    zone: validZone(zone) ?? (zone ? ownerZone : null),
    utc: digits[7] === "Z",
  };
}

function keyOf(local: Local): string {
  return `${String(local.y).padStart(4, "0")}-${String(local.m).padStart(2, "0")}-${String(local.d).padStart(2, "0")}`;
}

/** The id of one slot of a repeating event: its date in the zone of the first event. */
function slotKey(local: Local, ownerZone: string, eventZone: string): string {
  if (local.allDay) return keyOf(local).replaceAll("-", "");
  return dateKeyIn(new Date(toInstant(local, ownerZone)), eventZone).replaceAll("-", "");
}

function toInstant(local: Local, ownerZone: string): string {
  const wall = Date.UTC(local.y, local.m - 1, local.d, local.hh, local.mm, local.ss);
  if (local.utc) return new Date(wall).toISOString();
  const zone = local.zone ?? ownerZone;
  // Find the instant whose wall time in the zone is the one written. Two passes cover a change of offset.
  let guess = wall - offsetAt(wall, zone);
  guess = wall - offsetAt(guess, zone);
  return new Date(guess).toISOString();
}

function offsetAt(instant: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(instant / 1000) * 1000;
}

function validZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

function dateKeyIn(date: Date, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftKey(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

type Day = { y: number; m: number; d: number };
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function dayOf(ms: number): Day {
  const date = new Date(ms);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function msOf(day: Day): number {
  return Date.UTC(day.y, day.m - 1, day.d);
}

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The dates of a repeating event, up to `untilKey`. Null means the rule has a part this parser does not read.
 * It reads FREQ, INTERVAL, COUNT, UNTIL, BYDAY for a week, and BYDAY or BYMONTHDAY for a month.
 * For a month, BYDAY can be a list, each weekday with or without a number, and BYSETPOS selects from the dates of the month.
 */
function expand(rrule: string, start: Local, ownerZone: string, untilKey: string): Day[] | null {
  const rule = new Map(rrule.split(";").map((part) => part.split("=") as [string, string]).filter((pair) => pair.length === 2).map(([name, value]) => [name.toUpperCase(), value.toUpperCase()]));
  const freq = rule.get("FREQ");
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  for (const name of ["BYWEEKNO", "BYYEARDAY", "BYHOUR", "BYMINUTE", "BYSECOND"]) if (rule.has(name)) return null;
  if (rule.has("BYSETPOS") && freq !== "MONTHLY") return null;
  if (freq !== "MONTHLY" && rule.has("BYMONTHDAY")) return null;
  if ((freq === "DAILY" || freq === "YEARLY") && rule.has("BYDAY")) return null;
  if (freq !== "YEARLY" && rule.has("BYMONTH")) return null;
  const interval = Math.max(1, Number(rule.get("INTERVAL") ?? 1) || 1);
  const count = rule.has("COUNT") ? Number(rule.get("COUNT")) : null;
  if (count !== null && !(count > 0)) return null;
  let last = Date.parse(`${untilKey}T00:00:00Z`);
  if (rule.has("UNTIL")) {
    const until = readLocal({ params: "", value: rule.get("UNTIL")! }, ownerZone);
    if (!until) return null;
    // UNTIL is a UTC instant for a timed event. Read it as a date in the event's zone.
    const key = until.utc && !start.allDay ? dateKeyIn(new Date(toInstant(until, ownerZone)), start.zone ?? ownerZone) : keyOf(until);
    last = Math.min(last, Date.parse(`${key}T00:00:00Z`));
  }
  const first: Day = { y: start.y, m: start.m, d: start.d };
  const firstMs = msOf(first);
  const out: Day[] = [];
  let made = 0;
  const take = (ms: number): boolean => {
    if (ms < firstMs) return true;
    if (ms > last) return false;
    out.push(dayOf(ms));
    made += 1;
    return count === null || made < count;
  };

  if (freq === "DAILY") {
    for (let step = 0, ms = firstMs; step < MAX_STEPS; step++, ms += interval * DAY) if (!take(ms)) break;
    return out;
  }
  if (freq === "WEEKLY") {
    const named = (rule.get("BYDAY") ?? "").split(",").filter(Boolean);
    if (named.some((name) => !WEEKDAYS.includes(name))) return null;
    const days = (named.length ? named.map((name) => WEEKDAYS.indexOf(name)) : [new Date(firstMs).getUTCDay()]).sort((a, b) => a - b);
    const weekStart = firstMs - new Date(firstMs).getUTCDay() * DAY;
    for (let step = 0, week = weekStart; step < MAX_STEPS; step++, week += interval * 7 * DAY) {
      let open = true;
      for (const day of days) {
        open = take(week + day * DAY);
        if (!open) break;
      }
      if (!open || week > last) break;
    }
    return out;
  }
  if (freq === "MONTHLY") {
    const byDay = rule.get("BYDAY");
    const byMonthDay = rule.get("BYMONTHDAY");
    if (byDay && byMonthDay) return null;
    // `2TU` is the second Tuesday, `-1FR` the last Friday, and `MO` each Monday of the month.
    const named = byDay ? byDay.split(",").map((item) => /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item)) : null;
    if (named && (named.length === 0 || named.some((item) => !item || item[1] === "0" || item[1] === "+0" || item[1] === "-0"))) return null;
    // `BYSETPOS=-1` with the five weekdays is the last weekday of the month.
    const positions = rule.has("BYSETPOS") ? rule.get("BYSETPOS")!.split(",").map(Number) : null;
    if (positions && (positions.some((pos) => !Number.isInteger(pos) || pos === 0 || Math.abs(pos) > 31) || (!byDay && !byMonthDay))) return null;
    const monthDays = byMonthDay ? byMonthDay.split(",").map(Number) : null;
    if (monthDays && monthDays.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) return null;
    for (let step = 0, y = first.y, m = first.m; step < MAX_STEPS; step++) {
      const size = daysIn(y, m);
      let dates: number[];
      if (named) {
        const picked = new Set<number>();
        for (const item of named) {
          const weekday = WEEKDAYS.indexOf(item![2]!);
          const matches = Array.from({ length: size }, (_, index) => index + 1).filter((day) => new Date(Date.UTC(y, m - 1, day)).getUTCDay() === weekday);
          if (!item![1]) for (const day of matches) picked.add(day);
          else {
            const nth = Number(item![1]);
            const pick = nth > 0 ? matches[nth - 1] : matches[matches.length + nth];
            if (pick) picked.add(pick);
          }
        }
        dates = [...picked].sort((a, b) => a - b);
      } else {
        dates = (monthDays ?? [first.d]).filter((day) => day <= size).sort((a, b) => a - b);
      }
      if (positions) {
        const chosen = new Set<number>();
        for (const pos of positions) {
          const pick = pos > 0 ? dates[pos - 1] : dates[dates.length + pos];
          if (pick) chosen.add(pick);
        }
        dates = [...chosen].sort((a, b) => a - b);
      }
      let open = true;
      for (const day of dates) {
        open = take(Date.UTC(y, m - 1, day));
        if (!open) break;
      }
      if (!open || Date.UTC(y, m - 1, 1) > last) break;
      m += interval;
      while (m > 12) {
        m -= 12;
        y += 1;
      }
    }
    return out;
  }
  if (rule.has("BYMONTH") && Number(rule.get("BYMONTH")) !== first.m) return null;
  for (let step = 0, y = first.y; step < MAX_STEPS; step++, y += interval) {
    // 29 February repeats only in a leap year.
    if (first.d > daysIn(y, first.m)) {
      if (Date.UTC(y, 0, 1) > last) break;
      continue;
    }
    if (!take(Date.UTC(y, first.m - 1, first.d))) break;
  }
  return out;
}

function unfold(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

function text(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();
}
