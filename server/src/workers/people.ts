import { calendarDays, zoned } from "../time";
import { LEGACY_ROLES } from "../kinds";
import type { Visible } from "./context";

const WINDOW = 14;
const QUIET_DAYS = 45;

export type PeopleDraft = {
  sourceId: string;
  title: string;
  reason: string;
  summary: string;
  area_id: string | null;
  personId: string;
  /** The last day on which the draft is useful. A date draft has one. */
  expiresOn?: string;
};

/** Birthdays and anniversaries are dates we parse. Anything else in the field is ignored, not repeated. */
export function peopleDrafts(people: Visible[], now: Date, timeZone: string, selfKinds: Set<string> = LEGACY_ROLES.selfPerson): PeopleDraft[] {
  const today = zoned(now, timeZone).dateKey;
  const drafts: PeopleDraft[] = [];
  for (const person of people) {
    // The owner is not reminded of the owner.
    if (person.type !== "person" || (person.kind && selfKinds.has(person.kind))) continue;
    const name = person.title.trim().slice(0, 80);
    if (!name) continue;
    const birthday = monthDay(person.properties.birthday);
    const nextBirthday = birthday ? nextDate(birthday, today) : null;
    if (nextBirthday && nextBirthday.days <= WINDOW) {
      drafts.push({
        // The date is in the id, so a decision this year does not stop next year's draft.
        sourceId: `${person.id}:birthday:${nextBirthday.date}`,
        expiresOn: nextBirthday.date,
        title: `Wish ${name} well`,
        reason: `${name}'s birthday is soon.`,
        summary: "People",
        area_id: person.area_id,
        personId: person.id,
      });
    }
    const anniversary = monthDay(person.properties.anniversary);
    const nextAnniversary = anniversary ? nextDate(anniversary, today) : null;
    if (nextAnniversary && nextAnniversary.days <= WINDOW) {
      drafts.push({
        sourceId: `${person.id}:anniversary:${nextAnniversary.date}`,
        expiresOn: nextAnniversary.date,
        title: `Remember ${name}`,
        reason: `${name}'s anniversary is soon.`,
        summary: "People",
        area_id: person.area_id,
        personId: person.id,
      });
    }
    const last = isoDate(person.properties.last_contact);
    if (last && calendarDays(last, now, timeZone) >= QUIET_DAYS) {
      drafts.push({
        // The last contact date is in the id. A new contact date starts a new count.
        sourceId: `${person.id}:quiet:${last}`,
        title: `Write to ${name}`,
        reason: `It has been a while since ${name}.`,
        summary: "People",
        area_id: person.area_id,
        personId: person.id,
      });
    }
  }
  return drafts;
}

function monthDay(value: unknown): { month: number; day: number } | null {
  if (typeof value !== "string") return null;
  const match = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : null;
}

function nextDate(when: { month: number; day: number }, today: string): { date: string; days: number } {
  const year = Number(today.slice(0, 4));
  const month = String(when.month).padStart(2, "0");
  const day = String(when.day).padStart(2, "0");
  let target = `${year}-${month}-${day}`;
  if (target < today) target = `${year + 1}-${month}-${day}`;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${target}T00:00:00Z`);
  return { date: target, days: Math.round((b - a) / 86_400_000) };
}
