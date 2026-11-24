/**
 * Routines: a habit for a person, mostly a child. "Feed the cat", "Pack the school bag". A routine has days of the
 * week and a check-in for today. There is no streak and no score. docs/ONTOLOGY.md, section 2.5.
 */
import { ApiError } from "./types";

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** The days of a routine, in week order. None means every day. A bad value from a client is refused. */
export function routineDays(value: unknown, strict = false): string[] {
  if (!Array.isArray(value)) {
    if (strict) throw new ApiError(422, "days", "Days are a list such as [\"mon\", \"wed\"].");
    return [];
  }
  const picked = new Set<string>();
  for (const item of value) {
    const day = typeof item === "string" ? item.toLowerCase().slice(0, 3) : "";
    if ((WEEK as readonly string[]).includes(day)) picked.add(day);
    else if (strict) throw new ApiError(422, "days", "Days are mon, tue, wed, thu, fri, sat, sun.");
  }
  const days = WEEK.filter((day) => picked.has(day));
  return days.length === 7 ? [] : days;
}

/** Is a routine with these days due on this weekday ("Mon", as the zoned clock gives it)? */
export function dueOn(days: string[], weekday: string): boolean {
  return days.length === 0 || days.includes(weekday.toLowerCase().slice(0, 3));
}

/** "Every day", "Weekdays", "Weekends", or "Mon, Wed". */
export function cadenceLabel(days: string[]): string {
  if (days.length === 0) return "Every day";
  if (days.join() === "mon,tue,wed,thu,fri") return "Weekdays";
  if (days.join() === "sat,sun") return "Weekends";
  return days.map((day) => day[0]!.toUpperCase() + day.slice(1)).join(", ");
}

/** A link list in the shape the screens read. */
type ForLink = { source_id: string; direction: string; rel: string; peer: { id: string; type: string; title: string } };

/** The people a habit is for. A habit with none is the owner's own habit, not a routine. */
export function routinePeople(habitId: string, links: ForLink[]): Array<{ id: string; title: string }> {
  return links.filter((link) => link.source_id === habitId && link.direction === "out" && link.rel === "for" && link.peer.type === "person").map((link) => ({ id: link.peer.id, title: link.peer.title }));
}
