import { LEGACY_ROLES } from "../kinds";
import { calendarDays, dueDateKey, hasClock, zoned } from "../time";
import { SPOILER_KEYS } from "../types";

const SPOILER_TEXT = /\b(score|scores|result|results|winner|winners|won|beat|beaten|defeated|standing|standings|points)\b/i;
const SCORE_TEXT = /\d+\s*[-–:]\s*\d+/;
const WINDOW = 14;

export type WatchItem = {
  id: string;
  title: string;
  body?: string | null;
  kind?: string | null;
  status?: string | null;
  due_at?: string | null;
  properties?: Record<string, unknown>;
};

export type WatchLine = { id: string; line: string };

/**
 * A weekly list of start times. Spoiler keys are never read. A title or badge
 * that already looks like a result is left off the list.
 */
/** `fixtureKinds` is each event kind with the role `fixture`. */
export function watchLines(items: WatchItem[], now: Date, timeZone: string, fixtureKinds: Set<string> = LEGACY_ROLES.fixtureEvent): WatchLine[] {
  const today = zoned(now, timeZone).dateKey;
  const lines: WatchLine[] = [];
  for (const item of items) {
    if (!item.kind || !fixtureKinds.has(item.kind) || item.status === "past" || item.status === "cancelled" || !item.due_at) continue;
    const key = dueDateKey(item.due_at, timeZone);
    if (key < today) continue;
    const ahead = calendarDays(today, new Date(`${key}T12:00:00Z`), timeZone);
    if (ahead < 0 || ahead > WINDOW) continue;
    const title = item.title.trim();
    const props = item.properties ?? {};
    const badge = typeof props.badge === "string" ? props.badge.trim() : "";
    const category = props.category === "motorsport" ? "motorsport" : props.category === "sport" ? "sport" : "";
    if (!clean(title) || (badge && !clean(badge)) || (category && !clean(category))) continue;
    const when = hasClock(item.due_at) ? `${key} ${zoned(new Date(item.due_at), timeZone).hm}` : key;
    const line = [title, badge, category, when].filter(Boolean).join(" · ");
    if (spoilerValueLeaked(line, props)) continue;
    lines.push({ id: item.id, line });
  }
  return lines;
}

function clean(value: string): boolean {
  return value.length > 0 && !SPOILER_TEXT.test(value) && !SCORE_TEXT.test(value);
}

function spoilerValueLeaked(line: string, props: Record<string, unknown>): boolean {
  for (const key of SPOILER_KEYS) {
    const value = props[key];
    if (value == null || value === "") continue;
    if (line.toLowerCase().includes(String(value).toLowerCase())) return true;
  }
  return false;
}
