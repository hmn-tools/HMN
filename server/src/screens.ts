import { calendarDays, daysLate, dueDateKey, eventOver, greetingWord, hasClock, plusHour, zoned } from "./time";
import { dueOn, routineDays, routinePeople } from "./routines";
import type { EntityView, LinkView, Surface, Tier } from "./types";
import { LEGACY_ROLES, type RoleSets } from "./kinds";


/** Today shows at most this many fixtures. */
const TODAY_FIXTURES = 3;
/** At most this many rows in the Overdue and Family sections of Today. The trailing count says how many there are. */
const TODAY_ROWS_MAX = 4;
/** A fixture is on Today when it starts within this many hours. */
const TODAY_FIXTURE_HOURS = 36;
export const DECK = [
  { id: "today", label: "today", ready: true },
  { id: "upcoming", label: "upcoming", ready: true },
  { id: "commitments", label: "commitments", ready: true },
  { id: "quiet", label: "quiet", ready: true },
] as const;

export const EXTRA_SCREENS = [
  { id: "week", label: "week", ready: true },
  { id: "inbox", label: "inbox", ready: true },
  { id: "agents", label: "agents", ready: true },
] as const;

export type ScreenItem = {
  id: string;
  title: string;
  subtitle: string;
  glyph: "checkbox" | "date" | "flag" | "dashed";
  done: boolean;
  badge?: string;
  date_mark?: string;
  accent?: "teal";
  /** The type of the row's entity, so that a client can open it. Absent for a row that is not an entity. */
  type?: string;
};

export type ScreenSection = {
  id: string;
  label: string;
  trailing?: string;
  accent?: "teal";
  items: ScreenItem[];
};

export type TodayScreen = {
  id: string;
  ready: true;
  index: number;
  count: number;
  label: string;
  closing: string | null;
  in_deck: boolean;
  generated_at: string;
  timezone: string;
  date_label: string;
  clock_label: string;
  greeting: string;
  summary: string;
  updated_label: string;
  next_label: string;
  refresh_seconds: 3600;
  surface: Surface;
  ceiling: Tier;
  due_count: number;
  next: { title: string; subtitle: string } | null;
  sections: ScreenSection[];
  entity_ids: string[];
};

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function countPhrase(count: number, singular: string, plural: string): string {
  const word = count < WORDS.length ? WORDS[count]! : String(count);
  return `${word} ${count === 1 ? singular : plural}`;
}

function capital(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function summaryLine(due: number, family: number, quiet: number, surface: Surface, calendar = 0, overdue = 0): string {
  if (surface === "display" && due + overdue === 0) return "Nothing public is due.";
  if (due + family + quiet + calendar + overdue === 0) return "The day is clear.";
  const parts: string[] = [];
  if (overdue) parts.push(countPhrase(overdue, "thing overdue", "things overdue"));
  if (due || !overdue) parts.push(due ? countPhrase(due, "thing due", "things due") : "nothing due");
  if (calendar) parts.push(countPhrase(calendar, "event on the calendar", "events on the calendar"));
  if (family) parts.push(countPhrase(family, "family date", "family dates"));
  if (quiet) parts.push(countPhrase(quiet, "thing that has gone quiet", "things that have gone quiet"));
  const sentence =
    parts.length === 1
      ? capital(parts[0]!)
      : capital(`${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`);
  return `${sentence}.`;
}

function weekdayDate(due: string, timeZone: string): string {
  const when = due.length === 10 ? new Date(`${due}T12:00:00Z`) : new Date(due);
  const zone = zoned(when, timeZone);
  return `${zone.weekday} ${Number(zone.day)}/${zone.month}`;
}

function clockOf(due: string, timeZone: string): string | null {
  if (!hasClock(due)) return null;
  return zoned(new Date(due), timeZone).hm;
}

export function buildToday(input: ScreenInput): TodayScreen {
  return assemble(input, zoned(input.now, input.timeZone));
}

export type SourcedLink = LinkView & { source_id: string };

function peerNamed(links: SourcedLink[], sourceId: string, rels: string[], types: string[]): string | null {
  const link = links.find((item) => item.source_id === sourceId && item.direction === "out" && rels.includes(item.rel) && types.includes(item.peer.type));
  return link?.peer.title ?? null;
}

function assemble(
  input: ScreenInput,
  zone: ReturnType<typeof zoned>,
): TodayScreen {
  const { views, links, now, timeZone, surface, ceiling } = input;
  const roles = input.roles ?? LEGACY_ROLES;
  const tasks = [...views.values()].filter((entity) => isTaskRow(entity) && entity.status === "open");
  // A task whose day has passed is overdue. It stays on Today, first, until it is done or has a new date.
  const overdue = tasks
    .filter((task) => task.due_at && dueDateKey(task.due_at, timeZone) < zone.dateKey)
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const due = tasks
    .filter((task) => task.due_at && dueDateKey(task.due_at, timeZone) === zone.dateKey)
    .sort((a, b) => {
      const key = (task: { due_at: string | null; title: string }) =>
        task.due_at && task.due_at.length > 10 ? task.due_at : `9999-${task.title}`;
      return key(a).localeCompare(key(b));
    });
  const quiet = tasks
    .filter((task) => !task.due_at && calendarDays(task.updated_at, now, timeZone) >= 14)
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  // An event leaves a screen when it is over: a game that started this afternoon is gone when it ends.
  const family = [...views.values()]
    .filter((entity) => entity.type === "event" && isKind(entity, roles.familyEvent) && !eventOver(entity, now, timeZone))
    // The next seven days. A date further out is on Upcoming.
    .filter((entity) => withinDays(entity.due_at!, now, timeZone, 7))
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  // Today's events from a mirrored calendar that are not over, with an event of several days that covers today.
  const calendar = [...views.values()]
    .filter((entity) => entity.type === "event" && entity.properties.mirror === true && !isKind(entity, roles.familyEvent) && !isKind(entity, roles.fixtureEvent))
    .filter((entity) => !eventOver(entity, now, timeZone) && dueDateKey(entity.due_at!, timeZone) <= zone.dateKey)
    // An all-day event that is free time goes after the rest of the day.
    .sort((a, b) => Number(a.properties.busy === false) - Number(b.properties.busy === false) || String(a.due_at).localeCompare(String(b.due_at)));
  // The next fixtures that are not over, for To watch and the next event.
  const fixtures = [...views.values()]
    .filter((entity) => entity.type === "event" && isKind(entity, roles.fixtureEvent) && !eventOver(entity, now, timeZone, true))
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  // Today is about today. Its section shows a fixture that starts in the next TODAY_FIXTURE_HOURS (tonight, or early
  // tomorrow in another time zone), at most TODAY_FIXTURES. The Upcoming screen has the rest of the week.
  const watchToday = fixtures.filter((entity) => Date.parse(entity.due_at!) - now.getTime() <= TODAY_FIXTURE_HOURS * 3_600_000);

  const sections: ScreenSection[] = [];
  if (overdue.length) {
    sections.push({
      id: "overdue",
      label: "Overdue",
      trailing: String(overdue.length),
      items: overdue.slice(0, TODAY_ROWS_MAX).map((task) => {
        const late = daysLate(task.due_at!, now, timeZone);
        return { id: task.id, title: task.title, subtitle: late === 1 ? "1 day late" : `${late} days late`, glyph: "checkbox" as const, done: false };
      }),
    });
  }
  if (due.length) {
    sections.push({
      id: "due",
      label: "Due today",
      trailing: String(due.length),
      items: due.map((task) => ({
        id: task.id,
        title: task.title,
        subtitle: taskSubtitle(task, links, timeZone),
        glyph: "checkbox",
        done: false,
      })),
    });
  }
  if (family.length) {
    sections.push({
      id: "family",
      label: "Family",
      ...(family.length > TODAY_ROWS_MAX ? { trailing: `${TODAY_ROWS_MAX} of ${family.length}` } : {}),
      items: family.slice(0, TODAY_ROWS_MAX).map((event) => {
        const person = peerNamed(links, event.id, ["with"], ["person"]);
        const title = person && !event.title.includes(person) ? `${person} · ${event.title}` : event.title;
        const when = event.due_at ? weekdayDate(event.due_at, timeZone) : "";
        const clock = event.due_at ? clockOf(event.due_at, timeZone) : null;
        const day = event.due_at ? String(Number(dueDateKey(event.due_at, timeZone).slice(8, 10))) : "";
        return {
          id: event.id,
          title,
          subtitle: clock ? `${when} · ${clock}` : when,
          glyph: "date" as const,
          done: false,
          date_mark: day,
        };
      }),
    });
  }
  if (calendar.length) {
    sections.push({
      id: "calendar",
      label: "On the calendar",
      items: calendar.map((event) => {
        const clock = event.due_at ? clockOf(event.due_at, timeZone) : null;
        const started = dueDateKey(event.due_at!, timeZone) < zone.dateKey;
        return {
          id: event.id,
          title: event.title,
          subtitle: started ? `Since ${weekdayDate(event.due_at!, timeZone)}` : clock ?? "All day",
          glyph: "date" as const,
          done: false,
          date_mark: String(Number(zone.dateKey.slice(8, 10))),
        };
      }),
    });
  }
  if (watchToday.length) {
    sections.push({
      id: "watch",
      label: "To watch",
      ...(watchToday.length > TODAY_FIXTURES ? { trailing: String(watchToday.length) } : {}),
      items: watchToday.slice(0, TODAY_FIXTURES).map((event) => {
        const when = event.due_at ? weekdayDate(event.due_at, timeZone) : "";
        const clock = event.due_at ? clockOf(event.due_at, timeZone) : null;
        const badge = typeof event.properties.badge === "string" ? event.properties.badge : undefined;
        const time = clock ?? "";
        return {
          id: event.id,
          title: event.title,
          subtitle: `${when}${time ? ` · ${time}` : ""}`,
          glyph: "flag" as const,
          done: false,
          badge,
        };
      }),
    });
  }
  // A routine for a child is the household's. The owner's Today shows the owner's own habits only.
  const habits = [...views.values()].filter(
    (entity) => entity.type === "habit" && entity.status !== "paused" && routinePeople(entity.id, links).length === 0 && dueOn(routineDays(entity.properties.days), zone.weekday),
  );
  if (habits.length) {
    sections.push({
      id: "routines",
      label: "Routines",
      items: habits.map((habit) => {
        const cadence = typeof habit.properties.cadence === "string" ? habit.properties.cadence : "";
        const when = typeof habit.properties.time_of_day === "string" ? habit.properties.time_of_day : "";
        const subtitle = [cadence, when].filter(Boolean).join(" · ") || "Today";
        const done = habit.properties.last_check_in === zone.dateKey;
        return { id: habit.id, title: habit.title, subtitle, glyph: "checkbox" as const, done };
      }),
    });
  }
  if (quiet.length) {
    const days = calendarDays(quiet[0]!.updated_at, now, timeZone);
    sections.push({
      id: "quiet",
      label: quiet.length === 1 ? `Quiet for ${days} days` : "Quiet",
      accent: "teal",
      items: quiet.map((task) => ({
        id: task.id,
        title: task.title,
        subtitle: "No date",
        glyph: "dashed" as const,
        done: false,
        accent: "teal" as const,
      })),
    });
  }

  const self = [...views.values()].find((entity) => entity.type === "person" && isKind(entity, roles.selfPerson));
  const hello = greetingWord(zone.hour);
  const greeting = self ? `${hello}, ${self.title}.` : `${hello}.`;
  // The next event: the first one that has not started, else one that is on now.
  const upcomingEvents = [...family, ...calendar, ...fixtures].sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const nextEvent = upcomingEvents.find((event) => !hasClock(event.due_at!) ? dueDateKey(event.due_at!, timeZone) > zone.dateKey : Date.parse(event.due_at!) >= now.getTime()) ?? upcomingEvents[0] ?? null;
  let next: TodayScreen["next"] = null;
  if (nextEvent) {
    const short = typeof nextEvent.properties.short_title === "string" ? nextEvent.properties.short_title : nextEvent.title;
    const when = nextEvent.due_at ? weekdayDate(nextEvent.due_at, timeZone) : "";
    const clock = nextEvent.due_at ? clockOf(nextEvent.due_at, timeZone) : null;
    const line = clock ? `${when} · ${clock}` : when;
    next = { title: short, subtitle: line };
  }
  const ids = sections.flatMap((section) => section.items.map((item) => item.id));
  if (self) ids.push(self.id);

  return {
    id: "today",
    ready: true,
    index: 1,
    count: DECK.length,
    label: "today",
    closing: null,
    in_deck: true,
    generated_at: now.toISOString(),
    timezone: timeZone,
    date_label: `${zone.weekday.toUpperCase()} ${Number(zone.day)}/${zone.month}/${zone.year}`,
    clock_label: zone.hm,
    greeting,
    summary: summaryLine(due.length, family.length, quiet.length, surface, calendar.length, overdue.length),
    updated_label: zone.hm,
    next_label: plusHour(zone.hm),
    refresh_seconds: 3600,
    surface,
    ceiling,
    due_count: due.length + overdue.length,
    next,
    sections,
    entity_ids: ids,
  };
}

/**
 * The second line of a task: its project or person, and when. With `now`, a task on another day names the day,
 * and a task whose day has passed says how late it is, so "by 17:00" never hides the date.
 */
function taskSubtitle(task: EntityView, links: SourcedLink[], timeZone: string, now?: Date): string {
  const name =
    peerNamed(links, task.id, ["part_of"], ["project"]) ??
    peerNamed(links, task.id, ["for"], ["person"]) ??
    peerNamed(links, task.id, ["about"], ["person"]) ??
    peerNamed(links, task.id, ["about"], ["asset"]) ??
    peerNamed(links, task.id, ["about"], ["note"]);
  const clock = task.due_at ? clockOf(task.due_at, timeZone) : null;
  let when = clock ? `by ${clock}` : "";
  if (now && task.due_at) {
    const key = dueDateKey(task.due_at, timeZone);
    const today = zoned(now, timeZone).dateKey;
    if (key < today) {
      const late = daysLate(task.due_at, now, timeZone);
      when = late === 1 ? "1 day late" : `${late} days late`;
    } else if (key > today) {
      when = [weekdayDate(task.due_at, timeZone), clock ? `by ${clock}` : null].filter(Boolean).join(" · ");
    }
  }
  return [name, when].filter(Boolean).join(" · ");
}

export type ScreenInput = {
  views: Map<string, EntityView>;
  links: SourcedLink[];
  now: Date;
  timeZone: string;
  surface: Surface;
  ceiling: Tier;
  /** The kinds that have each role. The screens read a role, and never the name of a kind. */
  roles?: RoleSets;
  /** The ids of the areas whose kind has the role `work`. */
  workAreas?: Set<string>;
};

/** A task that the screens show. An item of a list, or a step of a task, shows only on its list or its task. */
export function isTaskRow(entity: EntityView): boolean {
  return entity.type === "task" && entity.kind !== "item";
}

function isKind(entity: EntityView, kinds: Set<string>): boolean {
  return entity.kind !== null && kinds.has(entity.kind);
}

export function nextDeckIndex(current: number, ready: boolean[], advance: boolean): number {
  const indexes = ready.map((isReady, index) => (isReady ? index : -1)).filter((index) => index >= 0);
  if (indexes.length === 0) return 0;
  if (!indexes.includes(current)) return indexes[0]!;
  if (!advance || indexes.length === 1) return current;
  const position = indexes.indexOf(current);
  return indexes[(position + 1) % indexes.length]!;
}

function frame(
  input: ScreenInput,
  fields: {
    id: string;
    label: string;
    index: number;
    greeting: string;
    summary: string;
    closing?: string | null;
    in_deck?: boolean;
    sections: ScreenSection[];
    due_count?: number;
    next?: TodayScreen["next"];
  },
): TodayScreen {
  const zone = zoned(input.now, input.timeZone);
  const ids = fields.sections.flatMap((section) => section.items.map((item) => item.id));
  return {
    id: fields.id,
    ready: true,
    index: fields.index,
    count: DECK.length,
    label: fields.label,
    closing: fields.closing ?? null,
    in_deck: fields.in_deck ?? false,
    generated_at: input.now.toISOString(),
    timezone: input.timeZone,
    date_label: `${zone.weekday.toUpperCase()} ${Number(zone.day)}/${zone.month}/${zone.year}`,
    clock_label: zone.hm,
    greeting: fields.greeting,
    summary: fields.summary,
    updated_label: zone.hm,
    next_label: plusHour(zone.hm),
    refresh_seconds: 3600,
    surface: input.surface,
    ceiling: input.ceiling,
    due_count: fields.due_count ?? 0,
    next: fields.next ?? null,
    sections: fields.sections,
    entity_ids: ids,
  };
}

function eventItem(event: EntityView, links: SourcedLink[], timeZone: string, fixture: boolean): ScreenItem {
  const person = peerNamed(links, event.id, ["with"], ["person"]);
  const title = !fixture && person && !event.title.includes(person) ? `${person} · ${event.title}` : event.title;
  const when = event.due_at ? weekdayDate(event.due_at, timeZone) : "";
  const clock = event.due_at ? clockOf(event.due_at, timeZone) : null;
  if (fixture) {
    // The clock is already in the owner's zone, so a stored zone label (from the fixture file) would be wrong abroad.
    const badge = typeof event.properties.badge === "string" ? event.properties.badge : undefined;
    const time = clock ?? "";
    return {
      id: event.id,
      title: event.title,
      subtitle: `${when}${time ? ` · ${time}` : ""}`,
      glyph: "flag",
      done: false,
      badge,
    };
  }
  const day = event.due_at ? String(Number(dueDateKey(event.due_at, timeZone).slice(8, 10))) : "";
  return {
    id: event.id,
    title,
    subtitle: clock ? `${when} · ${clock}` : when,
    glyph: "date",
    done: false,
    date_mark: day,
  };
}

function withinDays(due: string, now: Date, timeZone: string, days: number): boolean {
  const today = zoned(now, timeZone).dateKey;
  const key = dueDateKey(due, timeZone);
  const delta = calendarDays(`${today}T00:00:00.000Z`, new Date(`${key}T12:00:00Z`), timeZone);
  return delta >= 0 && delta <= days;
}

export function buildUpcoming(input: ScreenInput): TodayScreen {
  const { views, links, now, timeZone } = input;
  const roles = input.roles ?? LEGACY_ROLES;
  const today = zoned(now, timeZone).dateKey;
  void today;
  // The next two weeks. An event that is over, or cancelled, is not coming.
  const family = [...views.values()]
    .filter((entity) => entity.type === "event" && isKind(entity, roles.familyEvent) && !eventOver(entity, now, timeZone) && withinDays(entity.due_at!, now, timeZone, UPCOMING_DAYS))
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const fixtures = [...views.values()]
    .filter((entity) => entity.type === "event" && isKind(entity, roles.fixtureEvent) && !eventOver(entity, now, timeZone, true) && withinDays(entity.due_at!, now, timeZone, UPCOMING_DAYS))
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const sections: ScreenSection[] = [];
  const capped = (list: EntityView[], max: number) => (list.length > max ? { trailing: `${max} of ${list.length}` } : {});
  if (family.length) {
    sections.push({ id: "family", label: "Family", ...capped(family, UPCOMING_ROWS_MAX), items: family.slice(0, UPCOMING_ROWS_MAX).map((event) => eventItem(event, links, timeZone, false)) });
  }
  if (fixtures.length) {
    sections.push({
      id: "watch",
      label: "To watch",
      ...capped(fixtures, UPCOMING_ROWS_MAX),
      items: fixtures.slice(0, UPCOMING_ROWS_MAX).map((event) => eventItem(event, links, timeZone, true)),
    });
  }
  const count = family.length + fixtures.length;
  return frame(input, {
    id: "upcoming",
    label: "upcoming",
    index: 2,
    in_deck: true,
    greeting: "Coming up.",
    summary: count === 0 ? "Nothing coming." : capital(`${countPhrase(count, "thing", "things")} coming.`),
    sections,
  });
}

/** Upcoming covers the next two weeks, with at most this many rows in a section. */
const UPCOMING_DAYS = 14;
const UPCOMING_ROWS_MAX = 8;

/** The Week screen shows at most this many mirrored events. */
const WEEK_CALENDAR_MAX = 12;

/** "Work", "Work and Side project", or "Work, Home, and Side project". */
function listOf(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function buildCommitments(input: ScreenInput): TodayScreen {
  // The areas whose kind has the role `work`. The label is made from their titles.
  const areas = input.workAreas ?? new Set<string>();
  const names = [...input.views.values()].filter((entity) => entity.type === "area" && areas.has(entity.id)).map((entity) => entity.title);
  const named = names.length ? listOf(names) : "work";
  const tasks = [...input.views.values()]
    .filter((entity) => isTaskRow(entity) && entity.status === "open" && entity.area_id && areas.has(entity.area_id))
    .sort((a, b) => String(a.due_at ?? "9999").localeCompare(String(b.due_at ?? "9999")));
  const sections: ScreenSection[] = tasks.length
    ? [{ id: "commitments", label: named, trailing: String(tasks.length), items: tasks.map((task) => ({ id: task.id, title: task.title, subtitle: taskSubtitle(task, input.links, input.timeZone, input.now), glyph: "checkbox" as const, done: false })) }]
    : [];
  return frame(input, {
    id: "commitments",
    label: "commitments",
    index: 3,
    in_deck: true,
    greeting: "What you owe the work.",
    summary: tasks.length ? capital(`${countPhrase(tasks.length, "open task", "open tasks")} in ${named}.`) : `Nothing open in ${named}.`,
    sections,
  });
}

export function buildQuiet(input: ScreenInput): TodayScreen {
  const quiet = [...input.views.values()]
    .filter((entity) => isTaskRow(entity) && entity.status === "open" && !entity.due_at && calendarDays(entity.updated_at, input.now, input.timeZone) >= 14)
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  const days = quiet[0] ? calendarDays(quiet[0].updated_at, input.now, input.timeZone) : 0;
  const sections: ScreenSection[] = quiet.length
    ? [{
        id: "quiet",
        label: quiet.length === 1 ? `Quiet for ${days} days` : "Quiet",
        accent: "teal",
        items: quiet.map((task) => ({ id: task.id, title: task.title, subtitle: "No date", glyph: "dashed" as const, done: false, accent: "teal" as const })),
      }]
    : [];
  return frame(input, {
    id: "quiet",
    label: "quiet",
    index: 4,
    in_deck: true,
    greeting: "Left alone.",
    summary: quiet.length ? capital(`${countPhrase(quiet.length, "thing", "things")} with no date.`) : "Nothing has gone quiet.",
    sections,
  });
}

export function buildWeek(input: ScreenInput): TodayScreen {
  const { views, links, now, timeZone } = input;
  const roles = input.roles ?? LEGACY_ROLES;
  const today = zoned(now, timeZone).dateKey;
  // Done in the last seven days, by the time it was done. A later edit of a done task does not bring it back.
  const doneAt = (task: EntityView) => (typeof task.properties.done_at === "string" ? task.properties.done_at : task.updated_at);
  const done = [...views.values()]
    .filter((entity) => isTaskRow(entity) && entity.status === "done" && calendarDays(doneAt(entity), now, timeZone) <= 7 && calendarDays(doneAt(entity), now, timeZone) >= 0)
    .sort((a, b) => doneAt(b).localeCompare(doneAt(a)));
  const slipped = [...views.values()]
    .filter((entity) => isTaskRow(entity) && entity.status === "open" && entity.due_at && dueDateKey(entity.due_at, timeZone) < today)
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  // Today and the next seven days, in one list in time order: tasks, family dates, and fixtures that are not over.
  const upcomingTasks = [...views.values()].filter((entity) => isTaskRow(entity) && entity.status === "open" && entity.due_at && dueDateKey(entity.due_at, timeZone) >= today && withinDays(entity.due_at, now, timeZone, 7));
  const dates = [...views.values()].filter(
    (entity) =>
      entity.type === "event" &&
      (isKind(entity, roles.familyEvent) || isKind(entity, roles.fixtureEvent)) &&
      !eventOver(entity, now, timeZone, isKind(entity, roles.fixtureEvent)) &&
      withinDays(entity.due_at!, now, timeZone, 7),
  );
  // The mirrored events of the next seven days. A family date and a fixture are in `dates`.
  const calendar = [...views.values()]
    .filter((entity) => entity.type === "event" && entity.properties.mirror === true && !eventOver(entity, now, timeZone))
    .filter((entity) => !isKind(entity, roles.familyEvent) && !isKind(entity, roles.fixtureEvent))
    .filter((entity) => withinDays(entity.due_at!, now, timeZone, 7))
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const quiet = [...views.values()].filter((entity) => isTaskRow(entity) && entity.status === "open" && !entity.due_at && calendarDays(entity.updated_at, now, timeZone) >= 14);
  const goals = [...views.values()].filter((entity) => entity.type === "goal" && entity.status === "active");
  const moved = new Set(done.map((task) => peerNamed(links, task.id, ["part_of"], ["project"])).filter(Boolean));
  const sections: ScreenSection[] = [];
  // What needs a decision comes first: what slipped, then the week ahead. What was done and the goals come after.
  if (slipped.length) {
    sections.push({
      id: "slipped",
      label: "Slipped",
      trailing: String(slipped.length),
      items: slipped.map((task) => {
        const late = daysLate(task.due_at!, now, timeZone);
        return { id: task.id, title: task.title, subtitle: late === 1 ? "1 day late" : `${late} days late`, glyph: "checkbox" as const, done: false };
      }),
    });
  }
  const nextRows = [...upcomingTasks, ...dates].sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const nextItems = nextRows.map((entity) =>
    entity.type === "event"
      ? eventItem(entity, links, timeZone, isKind(entity, roles.fixtureEvent))
      : { id: entity.id, title: entity.title, subtitle: taskSubtitle(entity, links, timeZone, now) || "Today", glyph: "checkbox" as const, done: false },
  );
  if (nextItems.length) sections.push({ id: "next", label: "Next 7 days", items: nextItems });
  if (calendar.length) {
    // A full calendar does not fill the review. The count says how many there are.
    const shown = calendar.slice(0, WEEK_CALENDAR_MAX);
    sections.push({
      id: "calendar",
      label: "On the calendar",
      trailing: calendar.length > shown.length ? `${shown.length} of ${calendar.length}` : "next 7 days",
      items: shown.map((event) => eventItem(event, links, timeZone, false)),
    });
  }
  if (done.length) {
    sections.push({
      id: "done",
      label: "Done",
      trailing: String(done.length),
      items: done.map((task) => ({ id: task.id, title: task.title, subtitle: `Done ${weekdayDate(doneAt(task), timeZone)}`, glyph: "checkbox" as const, done: true })),
    });
  }
  if (goals.length) sections.push({ id: "goals", label: "Goals", items: goals.map((goal) => ({ id: goal.id, title: goal.title, subtitle: capital(goal.status ?? ""), glyph: "checkbox" as const, done: false })) });
  if (quiet.length) sections.push({ id: "quiet", label: "Quiet", accent: "teal", items: quiet.map((task) => ({ id: task.id, title: task.title, subtitle: "No date", glyph: "dashed" as const, done: false, accent: "teal" as const })) });
  const doneText = done.length === 0 ? "nothing done" : countPhrase(done.length, "thing done", "things done");
  const slippedText = slipped.length === 0 ? "nothing slipped" : countPhrase(slipped.length, "thing slipped", "things slipped");
  const movedText = moved.size === 0 ? "no project moved" : countPhrase(moved.size, "project moved", "projects moved");
  const summary = `${capital(`${doneText}, ${slippedText}, and ${movedText}`)}.`;
  return frame(input, {
    id: "week",
    label: "week",
    index: 0,
    in_deck: false,
    greeting: "This week.",
    summary,
    closing: "Decide what next week is for. Leave the rest.",
    sections,
  });
}

export function buildInbox(input: ScreenInput): TodayScreen {
  return buildInboxQueue(input, []);
}

export function buildInboxQueue(
  input: ScreenInput,
  items: Array<{ id: string; body: string; tags: string[]; suggestion: { label: string } | null }>,
): TodayScreen {
  const sections: ScreenSection[] = items.length
    ? [{
        id: "inbox",
        label: "Inbox",
        trailing: String(items.length),
        items: items.map((item) => ({
          id: item.id,
          title: item.body.slice(0, 80) || "Untitled",
          subtitle: item.suggestion ? item.suggestion.label : item.tags.length ? item.tags.map((tag) => `#${tag}`).join(" ") : "Waiting",
          glyph: "checkbox" as const,
          done: false,
        })),
      }]
    : [];
  return frame(input, {
    id: "inbox",
    label: "inbox",
    index: 0,
    in_deck: false,
    greeting: items.length ? "Inbox." : "Inbox zero.",
    summary: items.length ? capital(`${countPhrase(items.length, "thing", "things")} waiting.`) : "Nothing waiting to be placed.",
    sections,
  });
}

export function buildAgents(
  input: ScreenInput,
  proposals: Array<{ id: string; agent_name: string; redacted: boolean; op: string; reason?: string | null; payload?: unknown }>,
): TodayScreen {
  const items: ScreenItem[] = proposals.slice(0, 4).map((proposal) => {
    if (proposal.redacted) {
      return { id: proposal.id, title: `A sealed proposal from ${proposal.agent_name}`, subtitle: "Open the vault to read it.", glyph: "dashed" as const, done: false, accent: "teal" as const };
    }
    const payload = proposal.payload && typeof proposal.payload === "object" ? (proposal.payload as { entity?: { title?: string } }) : {};
    return { id: proposal.id, title: payload.entity?.title ?? proposal.op, subtitle: proposal.reason ?? "", glyph: "checkbox" as const, done: false };
  });
  const sections: ScreenSection[] = items.length ? [{ id: "agents", label: "Waiting", items }] : [];
  return frame(input, {
    id: "agents",
    label: "agents",
    index: 0,
    in_deck: false,
    greeting: items.length ? "Something is waiting." : "Nothing is waiting.",
    summary: items.length ? capital(`${countPhrase(items.length, "proposal waits", "proposals wait")}.`) : "Nothing is waiting.",
    sections,
  });
}

export function browseItems(views: EntityView[]): ScreenItem[] {
  return views.map((entity) => ({
    id: entity.id,
    title: entity.title,
    subtitle: [entity.kind, entity.status, entity.tier].filter(Boolean).join(" · "),
    glyph: "checkbox" as const,
    done: false,
  }));
}

/**
 * Home: the household Today of a member's phone. It names the member, not the owner. It shows what is for the
 * member, the household's day, the next days, and the next fixture. The views are the member's own, through the
 * policy layer. docs/ONTOLOGY.md, section 5.4.
 */
export function buildHome(input: ScreenInput, member: { personId: string | null; name: string; role?: string | null }): TodayScreen {
  const { views, links, now, timeZone } = input;
  const roles = input.roles ?? LEGACY_ROLES;
  const zone = zoned(now, timeZone);
  const today = zone.dateKey;
  const all = [...views.values()];
  const isFor = (task: EntityView) =>
    member.personId !== null && links.some((link) => link.source_id === task.id && link.direction === "out" && link.rel === "for" && link.peer.id === member.personId);
  const byDue = (a: EntityView, b: EntityView) => String(a.due_at ?? "9999").localeCompare(String(b.due_at ?? "9999"));
  const open = all.filter((entity) => isTaskRow(entity) && entity.status === "open");
  const mine = open.filter(isFor).sort(byDue);
  const dueToday = open.filter((task) => !isFor(task) && task.due_at && dueDateKey(task.due_at, timeZone) <= today).sort(byDue);
  // An event that is over leaves Home, as it leaves Today.
  const events = all
    .filter((entity) => entity.type === "event" && !isKind(entity, roles.fixtureEvent) && !eventOver(entity, now, timeZone))
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const todays = events.filter((event) => dueDateKey(event.due_at!, timeZone) <= today);
  const later = events.filter((event) => dueDateKey(event.due_at!, timeZone) > today && withinDays(event.due_at!, now, timeZone, 7));
  const soon = later.slice(0, 6);
  const fixture = all
    .filter((entity) => entity.type === "event" && isKind(entity, roles.fixtureEvent) && !eventOver(entity, now, timeZone, true))
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)))[0];
  const task = (item: EntityView): ScreenItem => ({ id: item.id, title: item.title, subtitle: taskSubtitle(item, links, timeZone, now), glyph: "checkbox", done: false });
  // Today's routines. A child sees the child's own. A partner sees every child's, with the name.
  const partner = member.role === "partner";
  const routines = all
    .filter((habit) => habit.type === "habit" && habit.status !== "paused" && dueOn(routineDays(habit.properties.days), zone.weekday))
    .map((habit) => ({ habit, people: routinePeople(habit.id, links) }))
    .filter((entry) => entry.people.length > 0 && (partner || entry.people.some((person) => person.id === member.personId)))
    .sort((a, b) => a.people[0]!.title.localeCompare(b.people[0]!.title) || a.habit.title.localeCompare(b.habit.title));
  const routineItem = ({ habit, people }: { habit: EntityView; people: Array<{ title: string }> }): ScreenItem => {
    const done = habit.properties.last_check_in === today;
    const by = typeof habit.properties.checked_by === "string" && habit.properties.checked_by !== member.name ? habit.properties.checked_by : null;
    const at = done && typeof habit.properties.checked_at === "string" ? zoned(new Date(habit.properties.checked_at), timeZone).hm : null;
    const doneLine = done ? ["Done", at, by ? `by ${by === "owner" ? "a parent" : by}` : null].filter(Boolean).join(" ") : null;
    const subtitle = [partner ? people.map((person) => person.title).join(", ") : null, doneLine ?? (habit.properties.time_of_day as string | undefined) ?? null].filter(Boolean).join(" · ");
    return { id: habit.id, title: habit.title, subtitle, glyph: "checkbox", done };
  };
  const routinesLeft = routines.filter((entry) => entry.habit.properties.last_check_in !== today).length;
  const sections: ScreenSection[] = [];
  if (mine.length) sections.push({ id: "mine", label: "For you", trailing: String(mine.length), items: mine.map(task) });
  if (routines.length) sections.push({ id: "routines", label: "Routines", trailing: routinesLeft ? `${routinesLeft} left` : "All done", items: routines.map(routineItem) });
  // Overdue household tasks first, then today's events and tasks, in time order.
  const late = dueToday.filter((item) => dueDateKey(item.due_at!, timeZone) < today);
  const dueNow = dueToday.filter((item) => dueDateKey(item.due_at!, timeZone) === today);
  if (late.length) sections.push({ id: "overdue", label: "Overdue", trailing: String(late.length), items: late.map(task) });
  const day = [...todays, ...dueNow]
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)))
    .map((entity) => (entity.type === "event" ? eventItem(entity, links, timeZone, false) : task(entity)));
  if (day.length) sections.push({ id: "today", label: "Today", trailing: String(day.length), items: day });
  if (soon.length) {
    sections.push({
      id: "soon",
      label: "Coming up",
      ...(later.length > soon.length ? { trailing: `${soon.length} of ${later.length}` } : {}),
      items: soon.map((event) => eventItem(event, links, timeZone, false)),
    });
  }
  if (fixture) sections.push({ id: "watch", label: "To watch", items: [eventItem(fixture, links, timeZone, true)] });
  const forToday = mine.filter((item) => item.due_at && dueDateKey(item.due_at, timeZone) <= today).length + (partner ? 0 : routinesLeft);
  const summary = forToday
    ? capital(`${countPhrase(forToday, "thing", "things")} for you today.`)
    : day.length + late.length
      ? capital(`${countPhrase(day.length + late.length, "thing", "things")} on today.`)
      : "A quiet day.";
  return frame(input, {
    id: "home",
    label: "home",
    index: 1,
    greeting: `${greetingWord(zone.hour)}, ${member.name}.`,
    summary,
    sections,
    due_count: forToday,
  });
}