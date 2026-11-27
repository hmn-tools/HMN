/**
 * The person page: the hub of a relationship. The next dates with a person, the open tasks for them, the notes
 * about them, and the things linked to them. The links and views are the caller's own, through the policy layer,
 * so a hidden row is absent here as everywhere. docs/ONTOLOGY.md, sections 2.2 and 5.2.
 */
import type { EntityView, LinkView } from "./policy";
import { dueDateKey, eventOver, hasClock, zoned } from "./time";

/** A row linked to the person. `when` is "Fri 13/11 · 16:30", "today", or null for a row with no date. */
export type PersonLinked = { entity: EntityView; rel: string; direction: "out" | "in"; link_id: string; when: string | null };

export type PersonPage = {
  person: EntityView;
  kind_title: string | null;
  organisation: boolean;
  /** "Child · School concert · Fri 13/11": the relation, and the next date with them. */
  line: string;
  next: PersonLinked[];
  tasks: PersonLinked[];
  done: PersonLinked[];
  notes: PersonLinked[];
  things: PersonLinked[];
  people: PersonLinked[];
  other: PersonLinked[];
};

const NEXT_MAX = 5;
const DONE_DAYS = 14;

/** The linked rows of a person, sorted into the sections of the page. */
export function buildPersonPage(input: {
  person: EntityView;
  links: LinkView[];
  views: Map<string, EntityView>;
  now: Date;
  timeZone: string;
  kindTitle: string | null;
  organisation: boolean;
}): Omit<PersonPage, "line"> & { line: string } {
  const { person, links, views, now, timeZone } = input;
  const today = zoned(now, timeZone).dateKey;
  const linked: PersonLinked[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const entity = views.get(link.peer.id);
    // One row per peer: a task that is `for` and `with` the same person shows once.
    if (!entity || seen.has(entity.id)) continue;
    seen.add(entity.id);
    const when = entity.due_at ? [dayLabel(entity.due_at, now, timeZone), hasClock(entity.due_at) ? zoned(new Date(entity.due_at), timeZone).hm : null].filter(Boolean).join(" · ") : null;
    linked.push({ entity, rel: link.rel, direction: link.direction, link_id: link.id, when });
  }
  const byDue = (a: PersonLinked, b: PersonLinked) => String(a.entity.due_at ?? "9999").localeCompare(String(b.entity.due_at ?? "9999"));
  const isTask = (row: PersonLinked) => row.entity.type === "task" && row.entity.kind !== "item";
  const next = linked
    .filter((row) => row.entity.type === "event" && !eventOver(row.entity, now, timeZone))
    .sort(byDue)
    .slice(0, NEXT_MAX);
  const tasks = linked.filter((row) => isTask(row) && row.entity.status !== "done").sort(byDue);
  const cutoff = now.getTime() - DONE_DAYS * 86_400_000;
  const doneAt = (row: PersonLinked) => String(row.entity.properties.done_at ?? row.entity.updated_at);
  const done = linked
    .filter((row) => isTask(row) && row.entity.status === "done" && Date.parse(doneAt(row)) >= cutoff)
    .sort((a, b) => doneAt(b).localeCompare(doneAt(a)))
    .slice(0, NEXT_MAX);
  const notes = linked
    .filter((row) => row.entity.type === "note" && row.entity.status !== "archived")
    .sort((a, b) => b.entity.updated_at.localeCompare(a.entity.updated_at));
  const things = linked.filter((row) => row.entity.type === "asset" || row.entity.type === "place");
  const people = linked.filter((row) => row.entity.type === "person");
  // A routine is shown with its own tick, so it is not repeated here. A list item belongs to its list.
  const shown = new Set([...next, ...tasks, ...done, ...notes, ...things, ...people].map((row) => row.entity.id));
  // Goals, projects, and areas. A past event and an old done task are left out.
  const other = linked.filter((row) => !shown.has(row.entity.id) && !["habit", "event", "task"].includes(row.entity.type));
  // The next date: the next event, or else the next open task with a date.
  const firstDated = next[0] ?? tasks.find((row) => row.entity.due_at) ?? null;
  return {
    person,
    kind_title: input.kindTitle,
    organisation: input.organisation,
    line: personLine(input.kindTitle, firstDated?.entity ?? null, now, timeZone),
    next,
    tasks,
    done,
    notes,
    things,
    people,
    other,
  };
}

/** "Spouse · Dinner · Fri 13/11", "Child · Dentist · today", or only "Spouse". */
export function personLine(kindTitle: string | null, next: EntityView | null, now: Date, timeZone: string): string {
  const parts = [kindTitle];
  if (next?.due_at) parts.push(next.title, dayLabel(next.due_at, now, timeZone));
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

/** "today", "tomorrow", or "Fri 13/11", in the owner's time zone. */
export function dayLabel(due: string, now: Date, timeZone: string): string {
  const key = dueDateKey(due, timeZone);
  const today = zoned(now, timeZone).dateKey;
  const noon = new Date(`${today}T12:00:00Z`);
  noon.setUTCDate(noon.getUTCDate() + 1);
  if (key === today) return "today";
  if (key === noon.toISOString().slice(0, 10)) return "tomorrow";
  const day = zoned(new Date(`${key}T12:00:00Z`), "UTC");
  return `${day.weekday} ${Number(day.day)}/${Number(day.month)}`;
}
