/**
 * The yearly review: one card for a calendar year, made from the record. It has the goals, the projects that
 * finished, the year month by month, the people of the year, and what is still open. The owner adds one note.
 * The weekly review has the same rules: no charts, no streaks, no comparison with another year.
 * docs/STRATEGY.md, role 7, and docs/UX.md, "Yearly review".
 */
import type { EntityView } from "./policy";
import { isTaskRow, type ScreenInput, type ScreenItem, type ScreenSection, type SourcedLink } from "./screens";
import { dueDateKey, zoned } from "./time";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const PEOPLE_MAX = 5;
const OPEN_MAX = 5;

export type YearReview = {
  year: number;
  greeting: string;
  summary: string;
  closing: string;
  sections: ScreenSection[];
  entity_ids: string[];
};

/** The year of a moment, in the owner's zone. */
export function yearOf(iso: string, timeZone: string): number {
  return Number(dueDateKey(iso, timeZone).slice(0, 4));
}

/** When a task was done: the time the server wrote, or the last change of an older row. */
function doneAt(task: EntityView): string {
  return typeof task.properties.done_at === "string" ? task.properties.done_at : task.updated_at;
}

export function buildYear(input: ScreenInput, year: number, selfIds: Set<string>): YearReview {
  const { views, links, now, timeZone } = input;
  const familyKinds = input.roles?.familyEvent ?? new Set<string>();
  const all = [...views.values()].filter((entity) => !(entity.type === "note" && entity.properties.year_review !== undefined));
  const inYear = (iso: string | null | undefined) => Boolean(iso) && yearOf(iso!, timeZone) === year;
  const monthOf = (iso: string) => Number(dueDateKey(iso, timeZone).slice(5, 7)) - 1;
  const used: string[] = [];

  const done = all.filter((entity) => isTaskRow(entity) && entity.status === "done" && inYear(doneAt(entity)));
  const events = all.filter((entity) => entity.type === "event" && entity.status !== "cancelled" && inYear(entity.due_at));
  const family = events.filter((event) => familyKinds.has(event.kind ?? ""));
  const finished = all.filter((entity) => entity.type === "project" && entity.kind !== "list" && entity.status === "done" && inYear(entity.updated_at));
  // A goal of the year: made or changed in the year, or still active and made before its end.
  const goals = all.filter(
    (entity) => entity.type === "goal" && (inYear(entity.updated_at) || inYear(entity.created_at) || (entity.status === "active" && yearOf(entity.created_at, timeZone) <= year)),
  );
  const notes = all.filter((entity) => entity.type === "note" && inYear(entity.created_at));
  const thisYear = zoned(now, timeZone).dateKey.slice(0, 4) === String(year);
  const open = all
    .filter((entity) => isTaskRow(entity) && entity.status !== "done" && inYear(entity.created_at))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const sections: ScreenSection[] = [];
  const status: Record<string, string> = { active: "Active", done: "Reached", paused: "Paused" };
  if (goals.length) {
    sections.push({ id: "goals", label: "Goals", items: goals.map((goal) => item(goal, status[goal.status ?? ""] ?? goal.status ?? "", goal.status === "done", used)) });
  }
  if (finished.length) {
    sections.push({ id: "finished", label: "Finished", trailing: String(finished.length), items: finished.map((project) => item(project, `Done in ${MONTHS[monthOf(project.updated_at)]}`, true, used)) });
  }

  // Month by month: what was done, and the family dates. A month with neither is left out.
  const months: ScreenItem[] = [];
  for (let month = 0; month < 12; month++) {
    const doneCount = done.filter((task) => monthOf(doneAt(task)) === month).length;
    const familyCount = family.filter((event) => monthOf(event.due_at!) === month).length;
    if (!doneCount && !familyCount) continue;
    const parts = [doneCount ? count(doneCount, "thing done", "things done") : null, familyCount ? count(familyCount, "family date", "family dates") : null];
    months.push({ id: `month-${year}-${month + 1}`, title: MONTHS[month]!, subtitle: parts.filter(Boolean).join(" · "), glyph: "checkbox", done: false });
  }
  if (months.length) sections.push({ id: "months", label: "Month by month", items: months });

  // The people of the year: the dates and the tasks that were with them or for them.
  const tally = new Map<string, { person: EntityView; dates: number; tasks: number }>();
  const touch = (entity: EntityView, kind: "dates" | "tasks") => {
    for (const link of peers(links, entity.id)) {
      const person = views.get(link.peer.id);
      if (!person || person.type !== "person" || selfIds.has(person.id)) continue;
      const entry = tally.get(person.id) ?? { person, dates: 0, tasks: 0 };
      entry[kind] += 1;
      tally.set(person.id, entry);
    }
  };
  for (const event of events) touch(event, "dates");
  for (const task of done) touch(task, "tasks");
  const people = [...tally.values()].sort((a, b) => b.dates + b.tasks - (a.dates + a.tasks) || a.person.title.localeCompare(b.person.title)).slice(0, PEOPLE_MAX);
  if (people.length) {
    sections.push({
      id: "people",
      label: "People",
      items: people.map((entry) =>
        item(entry.person, [entry.dates ? count(entry.dates, "date", "dates") : null, entry.tasks ? count(entry.tasks, "task", "tasks") : null].filter(Boolean).join(" · "), false, used),
      ),
    });
  }

  if (open.length) {
    sections.push({
      id: "open",
      label: thisYear ? "Still open" : "Carried on",
      trailing: open.length > OPEN_MAX ? `${OPEN_MAX} of ${open.length}` : String(open.length),
      items: open.slice(0, OPEN_MAX).map((task) => item(task, `Added in ${MONTHS[monthOf(task.created_at)]}`, false, used)),
    });
  }

  const summaryParts = [
    done.length ? count(done.length, "thing done", "things done") : "nothing done",
    finished.length ? count(finished.length, "project finished", "projects finished") : null,
    goals.some((goal) => goal.status === "done") ? count(goals.filter((goal) => goal.status === "done").length, "goal reached", "goals reached") : null,
    notes.length ? count(notes.length, "note", "notes") : null,
  ].filter((part): part is string => Boolean(part));
  const summary = `${capital(listOf(summaryParts))}.`;
  return {
    year,
    greeting: thisYear ? `Your ${year} so far.` : `Your ${year}.`,
    summary,
    closing: "Write down what the year was for. Keep what matters.",
    sections,
    entity_ids: [...new Set(used)],
  };
}

function item(entity: EntityView, subtitle: string, done: boolean, used: string[]): ScreenItem {
  used.push(entity.id);
  return { id: entity.id, title: entity.title, subtitle, glyph: "checkbox", done };
}

function peers(links: SourcedLink[], id: string): SourcedLink[] {
  return links.filter((link) => link.source_id === id && (link.rel === "with" || link.rel === "for"));
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}
