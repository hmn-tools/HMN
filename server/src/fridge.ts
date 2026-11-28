/**
 * The fridge: the household's shared glance, on an e-ink panel. It reads the Household tier, through the same
 * policy layer as every reader, so the views here are already filtered. It changes by the time of day, and its
 * image name changes only when its picture changes, so a slow colour panel does not flash for nothing.
 * The layout follows Garden on the phone and the iOS widget: a header with the mark, four card segments, and
 * a dark focus pane for this moment. Colour is for marks, rails, and the one band — not for the words.
 * docs/ONTOLOGY.md, section 5.3, has the design.
 */
import {
  drawMark,
  drawText,
  faces,
  fillRect,
  fillRoundRect,
  measure,
  MARK_40,
  strokeCircle,
  strokeRoundRect,
} from "./devices/eink-type";
import type { EntityView } from "./policy";
import { isTaskRow, type ScreenInput, type SourcedLink } from "./screens";
import { dueDateKey, eventOver, hasClock, zoned } from "./time";
import { BWRY_INKS, encodeBmp1, encodePngIndexed, OG } from "./devices/image";
import { encodeQr } from "./qr";
import { dueOn, routineDays, routinePeople } from "./routines";

export const FRIDGE_SCREENS = ["morning", "week", "evening", "quiet"] as const;
export type FridgeScreenId = (typeof FRIDGE_SCREENS)[number];

/** A mark on a row or on the focus pane. The words themselves stay ink on paper, or paper on ink. */
export type FridgeMark = "now" | "due" | "left" | "list" | "open";

export type FridgeItem = { time: string; text: string; detail?: string; mark?: FridgeMark };
export type FridgePaneId = "focus" | "today" | "week" | "tonight" | "tomorrow" | "routines" | "todo" | "list";
export type FridgePane = {
  id: FridgePaneId;
  label: string;
  tone: "dark" | "light";
  kicker?: string;
  time?: string;
  title?: string;
  subtitle?: string;
  mark?: FridgeMark;
  items: FridgeItem[];
  empty?: string;
  accent?: "yellow";
};

export type FridgeScreen = {
  id: FridgeScreenId;
  title: string;
  date_label: string;
  panes: FridgePane[];
  entity_ids: string[];
  /** A member pairing code that the owner put on the fridge. It takes the whole panel while it lasts. */
  pairing?: { payload: string; name: string | null; until: string };
};

/** The four time windows of the day. A window starts at its hour, in the owner's time zone. */
const WINDOWS: Array<{ id: FridgeScreenId; from: number }> = [
  { id: "quiet", from: 0 },
  { id: "morning", from: 6 },
  { id: "week", from: 9 },
  { id: "evening", from: 16 },
  { id: "quiet", from: 21 },
];

export function fridgeWindow(hour: number): FridgeScreenId {
  let id: FridgeScreenId = "quiet";
  for (const window of WINDOWS) if (hour >= window.from) id = window.id;
  return id;
}

/** Seconds until the next window starts. The display asks again then, or sooner. */
export function secondsToNextWindow(now: Date, timeZone: string): number {
  const zone = zoned(now, timeZone);
  const minutes = zone.hour * 60 + Number(zone.minute);
  const next = WINDOWS.map((window) => window.from * 60).find((start) => start > minutes) ?? 24 * 60;
  return Math.max(60, (next - minutes) * 60);
}

/** Rows that fit one light pane at a readable size, seen from the kitchen. */
const PANE_ROWS = 4;

export function buildFridge(input: ScreenInput, id: FridgeScreenId): FridgeScreen {
  const { views, links, now, timeZone } = input;
  const zone = zoned(now, timeZone);
  const today = zone.dateKey;
  const tomorrow = dayKey(now, timeZone, 1);
  const nowMs = now.getTime();
  const fixtureKinds = input.roles?.fixtureEvent ?? new Set<string>();
  const all = [...views.values()];
  const events = all
    .filter((item) => item.type === "event" && !eventOver(item, now, timeZone, fixtureKinds.has(item.kind ?? "")))
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const tasks = all
    .filter((item) => isTaskRow(item) && item.status === "open" && item.due_at)
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const on = (item: EntityView, key: string) => dueDateKey(item.due_at!, timeZone) === key;
  const used: string[] = [];
  const take = (item: EntityView) => {
    used.push(item.id);
    return item;
  };
  const peopleLine = (item: EntityView) => {
    const people = links
      .filter((link) => link.source_id === item.id && link.direction === "out" && (link.rel === "with" || link.rel === "for") && link.peer.type === "person")
      .map((link) => link.peer.title);
    return [...new Set(people)].filter((name) => !item.title.includes(name)).join(", ");
  };
  const itemOf = (item: EntityView, mark: FridgeMark | undefined, time?: string): FridgeItem => {
    take(item);
    const who = peopleLine(item);
    return { time: time ?? clock(item, timeZone), text: label(item, links), detail: who || undefined, mark };
  };
  const date_label = `${zone.weekday} ${Number(zone.day)}/${zone.month}`;
  const early = (item: EntityView) => hasClock(item.due_at!) && zoned(new Date(item.due_at!), timeZone).hour < 9;
  const inProgress = (item: EntityView) => hasClock(item.due_at!) && Date.parse(item.due_at!) <= nowMs && !eventOver(item, now, timeZone, false);
  const routines = routineItems(all, links, zone, used);
  const list = shoppingList(all, links);
  const listPane = (): FridgePane | null => {
    if (!list) return null;
    used.push(list.list.id, ...list.items.map((item) => item.id));
    return {
      id: "list",
      label: list.list.title,
      tone: "light",
      accent: "yellow",
      items: fitItems(
        list.items.map((item) => ({ time: "", text: item.title, mark: "list" as const })),
        PANE_ROWS,
      ),
    };
  };
  const routinePane = (): FridgePane | null =>
    routines.length
      ? { id: "routines", label: "Routines", tone: "light", items: fitItems(routines, PANE_ROWS) }
      : null;
  const focusFrom = (item: EntityView, kicker: string, mark: FridgeMark, subtitle?: string): FridgePane => {
    take(item);
    const who = peopleLine(item);
    return {
      id: "focus",
      label: "",
      tone: "dark",
      kicker,
      time: clock(item, timeZone) || undefined,
      title: item.title,
      subtitle: subtitle ?? (who || undefined),
      mark,
      items: [],
    };
  };
  const emptyFocus = (line: string): FridgePane => ({
    id: "focus",
    label: "",
    tone: "dark",
    kicker: "HMN",
    title: line,
    items: [],
  });

  let panes: FridgePane[] = [];

  if (id === "morning") {
    const todays = events.filter((item) => {
      if (!on(item, today) || fixtureKinds.has(item.kind ?? "")) return false;
      if (!hasClock(item.due_at!)) return true;
      return zoned(new Date(item.due_at!), timeZone).hour < 16;
    });
    const current =
      todays.find((item) => inProgress(item)) ??
      todays.find((item) => !hasClock(item.due_at!) || Date.parse(item.due_at!) >= nowMs);
    const due = tasks.filter((item) => dueDateKey(item.due_at!, timeZone) <= today);
    const focusItem = current ?? due[0];
    const focus = focusItem
      ? focusFrom(
          focusItem,
          current && inProgress(current) ? "Now" : current ? "Next" : "Due today",
          current && inProgress(current) ? "now" : current ? "now" : "due",
        )
      : emptyFocus("A free morning.");
    const todayRows = todays.filter((item) => item.id !== focusItem?.id).map((item) => itemOf(item, undefined));
    const dueRows = due.filter((item) => item.id !== focusItem?.id).map((item) => itemOf(item, "due", ""));
    panes = [
      focus,
      { id: "today", label: "Today", tone: "light", items: fitItems(todayRows, PANE_ROWS), empty: todayRows.length || focusItem ? "Nothing else this morning." : "A free morning." },
      routinePane() ?? { id: "routines", label: "Routines", tone: "light", items: [], empty: "Caught up." },
      dueRows.length
        ? { id: "todo", label: "To do today", tone: "light", items: fitItems(dueRows, PANE_ROWS), empty: "Caught up." }
        : listPane() ?? { id: "todo", label: "To do today", tone: "light", items: [], empty: "Caught up." },
    ];
  } else if (id === "week") {
    const week = [...events, ...tasks]
      .filter((item) => !fixtureKinds.has(item.kind ?? ""))
      .filter((item) => {
        const key = dueDateKey(item.due_at!, timeZone);
        return key >= today && key <= dayKey(now, timeZone, 6);
      })
      .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
    const packed: EntityView[] = [];
    const seen = new Set<string>();
    for (let offset = 0; offset <= 6; offset++) {
      const first = week.find((item) => dueDateKey(item.due_at!, timeZone) === dayKey(now, timeZone, offset));
      if (first) {
        packed.push(first);
        seen.add(first.id);
      }
    }
    for (const item of week) if (!seen.has(item.id)) packed.push(item);
    const todayItems = packed.filter((item) => on(item, today) || (item.type === "task" && dueDateKey(item.due_at!, timeZone) <= today));
    const later = packed.filter((item) => !todayItems.includes(item));
    const focusItem = todayItems[0] ?? later[0];
    const focus = focusItem
      ? focusFrom(
          focusItem,
          on(focusItem, today) || (focusItem.type === "task" && dueDateKey(focusItem.due_at!, timeZone) <= today)
            ? focusItem.type === "task"
              ? "Due today"
              : "Today"
            : dayName(focusItem, timeZone),
          focusItem.type === "task" && dueDateKey(focusItem.due_at!, timeZone) <= today ? "due" : "open",
        )
      : emptyFocus("A clear week.");
    const laterRows = later.filter((item) => item.id !== focusItem?.id).map((item) => itemOf(item, undefined, dayAndClock(item, timeZone)));
    const restToday = todayItems.filter((item) => item.id !== focusItem?.id).map((item) => itemOf(item, item.type === "task" ? "due" : undefined, clock(item, timeZone) || ""));
    panes = [
      focus,
      { id: "week", label: "This week", tone: "light", items: fitItems(laterRows, PANE_ROWS), empty: "A clear week." },
      { id: "today", label: "Also today", tone: "light", items: fitItems(restToday, PANE_ROWS), empty: "Nothing else today." },
      listPane() ?? routinePane() ?? { id: "todo", label: "To do", tone: "light", items: [], empty: "Caught up." },
    ];
  } else if (id === "evening") {
    const tonight = events.filter((item) => {
      if (!on(item, today) || !hasClock(item.due_at!)) return false;
      if (zoned(new Date(item.due_at!), timeZone).hour < 16) return false;
      return Date.parse(item.due_at!) >= nowMs || !eventOver(item, now, timeZone, false);
    });
    const current = tonight.find((item) => inProgress(item)) ?? tonight.find((item) => Date.parse(item.due_at!) >= nowMs);
    const next = [...events.filter((item) => on(item, tomorrow)), ...tasks.filter((item) => on(item, tomorrow))].sort((a, b) =>
      String(a.due_at).localeCompare(String(b.due_at)),
    );
    const undone = tasks.filter((item) => on(item, today));
    // The focus is tonight's current or next start. If the evening is clear, tomorrow's first start takes the pane.
    const focus = current
      ? { ...focusFrom(current, inProgress(current) ? "Now" : "Next", "now"), items: tonight.filter((item) => item !== current).slice(0, 2).map((item) => itemOf(item, undefined)) }
      : next[0]
        ? focusFrom(next[0], "Tomorrow", early(next[0]) ? "now" : "open")
        : emptyFocus("Nothing later tonight.");
    // Tomorrow's first start always has a row in the Tomorrow pane, even when leftover tasks or a list compete.
    const tomorrowRows = next.map((item) => itemOf(item, early(item) ? "now" : undefined));
    const todoRows = undone.map((item) => itemOf(item, "due", ""));
    const routinesP = routinePane();
    const listP = listPane();
    // Four quarters: focus, tomorrow, routines or leftover tasks, list (or the remaining of those).
    const third = routinesP ?? (todoRows.length
      ? { id: "todo" as const, label: "Still to do", tone: "light" as const, items: fitItems(todoRows, PANE_ROWS), empty: "Caught up." }
      : { id: "tonight" as const, label: "Tonight", tone: "light" as const, items: [], empty: "Nothing later tonight." });
    const fourth = listP ?? (routinesP && third.id !== "routines" ? routinesP : todoRows.length && third.id !== "todo"
      ? { id: "todo" as const, label: "Still to do", tone: "light" as const, items: fitItems(todoRows, PANE_ROWS), empty: "Caught up." }
      : { id: "list" as const, label: "List", tone: "light" as const, items: [], empty: "Nothing on the list." });
    panes = [
      focus,
      {
        id: "tomorrow",
        label: "Tomorrow",
        tone: "light",
        items: fitItems(tomorrowRows, PANE_ROWS),
        empty: "Nothing early tomorrow.",
      },
      third,
      fourth,
    ];
  } else {
    const key = zone.hour < 6 ? today : tomorrow;
    const coming = [...events.filter((item) => on(item, key)), ...tasks.filter((item) => on(item, key))].sort((a, b) =>
      String(a.due_at).localeCompare(String(b.due_at)),
    );
    const first = coming[0];
    const focus = first
      ? focusFrom(first, zone.hour < 6 ? "Today" : "Tomorrow", early(first) ? "now" : "open")
      : emptyFocus("Nothing early tomorrow.");
    const rest = coming.filter((item) => item.id !== first?.id).map((item) => itemOf(item, early(item) ? "now" : undefined));
    panes = [
      focus,
      {
        id: zone.hour < 6 ? "today" : "tomorrow",
        label: zone.hour < 6 ? "Today" : "Tomorrow",
        tone: "light",
        items: fitItems(rest, PANE_ROWS),
        empty: "Nothing early tomorrow.",
      },
      routinePane() ?? { id: "routines", label: "Routines", tone: "light", items: [], empty: "Caught up." },
      listPane() ?? { id: "list", label: "List", tone: "light", items: [], empty: "Nothing on the list." },
    ];
  }

  return {
    id,
    title: TITLES[id],
    date_label,
    panes,
    entity_ids: [...new Set(used)],
  };
}

const TITLES: Record<FridgeScreenId, string> = {
  morning: "This morning",
  week: "This week",
  evening: "This evening",
  quiet: "Good night",
};

function fitItems(items: FridgeItem[], rows = PANE_ROWS): FridgeItem[] {
  if (items.length <= rows) return items;
  const keep = Math.max(0, rows - 1);
  return [...items.slice(0, keep), { time: "", text: `+${items.length - keep} more` }];
}

function dayKey(now: Date, timeZone: string, offset: number): string {
  const today = zoned(now, timeZone).dateKey;
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function clock(item: EntityView, timeZone: string): string {
  if (!item.due_at || !hasClock(item.due_at)) return "";
  return zoned(new Date(item.due_at), timeZone).hm;
}

function dayName(item: EntityView, timeZone: string): string {
  const when = item.due_at!.length === 10 ? new Date(`${item.due_at}T12:00:00Z`) : new Date(item.due_at!);
  return zoned(when, timeZone).weekday;
}

function dayAndClock(item: EntityView, timeZone: string): string {
  const when = item.due_at!.length === 10 ? new Date(`${item.due_at}T12:00:00Z`) : new Date(item.due_at!);
  const zone = zoned(when, timeZone);
  const time = hasClock(item.due_at!) ? ` ${zone.hm}` : "";
  return `${zone.weekday}${time}`;
}

function routineItems(all: EntityView[], links: SourcedLink[], zone: { dateKey: string; weekday: string }, used: string[]): FridgeItem[] {
  const byPerson = new Map<string, { name: string; left: string[]; total: number }>();
  for (const habit of all) {
    if (habit.type !== "habit" || habit.status === "paused" || !dueOn(routineDays(habit.properties.days), zone.weekday)) continue;
    for (const person of routinePeople(habit.id, links)) {
      const entry = byPerson.get(person.id) ?? { name: person.title, left: [], total: 0 };
      entry.total += 1;
      if (habit.properties.last_check_in !== zone.dateKey) entry.left.push(habit.title);
      byPerson.set(person.id, entry);
      used.push(habit.id);
    }
  }
  const items: FridgeItem[] = [];
  for (const entry of byPerson.values()) {
    items.push({
      time: entry.name,
      text: entry.left.length ? entry.left.join(", ") : "all done",
      mark: entry.left.length ? "left" : undefined,
    });
  }
  return items;
}

/** The list with open items whose newest item is the newest, and its open items in the order they were added. */
function shoppingList(all: EntityView[], links: SourcedLink[]): { list: EntityView; items: EntityView[] } | null {
  const lists = all.filter((item) => item.type === "project" && item.kind === "list" && item.status !== "done");
  let best: { list: EntityView; items: EntityView[]; newest: string } | null = null;
  for (const list of lists) {
    const items = all
      .filter((item) => item.type === "task" && item.kind === "item" && item.status !== "done")
      .filter((item) => links.some((link) => link.source_id === item.id && link.direction === "out" && link.rel === "part_of" && link.peer.id === list.id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (!items.length) continue;
    const newest = items[items.length - 1]!.created_at;
    if (!best || newest > best.newest) best = { list, items, newest };
  }
  return best ? { list: best.list, items: best.items } : null;
}

/** "Yves · School concert": the people of a row come first, from the links that the reader may see. */
function label(item: EntityView, links: SourcedLink[]): string {
  const people = links
    .filter((link) => link.source_id === item.id && link.direction === "out" && (link.rel === "with" || link.rel === "for") && link.peer.type === "person")
    .map((link) => link.peer.title);
  const names = [...new Set(people)].filter((name) => !item.title.includes(name));
  return names.length ? `${names.join(", ")} · ${item.title}` : item.title;
}

// ---- drawing --------------------------------------------------------------------------------------

const BLACK = 0;
const WHITE = 1;
const RED = 2;
const YELLOW = 3;

const MARGIN = 12;
const HEADER_Y = 10;
const HEADER_H = 44;
const BAND_Y = 56;
const BAND_H = 4;
const GAP = 12;
const CARD_Y = 72;
const CARD_R = 16;
const CARD_PAD = 16;
const CARD_W = (OG.width - MARGIN * 3) / 2;
const CARD_H = (OG.height - CARD_Y - MARGIN - GAP) / 2;

export type FridgePalette = "bwry" | "bw";

/**
 * Draw a fridge screen at 800 × 480. The BWRY panel gets an indexed PNG with its four inks. A black and white
 * panel gets a 1-bit BMP, with red as black and yellow as white.
 */
export function renderFridge(screen: FridgeScreen, palette: FridgePalette): Buffer {
  const { width, height } = OG;
  const canvas = new Uint8Array(width * height).fill(WHITE);
  if (screen.pairing) {
    drawPairing(canvas, width, height, screen.pairing);
    return encodeCanvas(canvas, width, height, palette);
  }
  const panes = screen.panes;
  // Header: the official mark, the window title in Plex Sans, the date in Plex Mono.
  drawMark(canvas, width, height, MARK_40, MARGIN, HEADER_Y + Math.floor((HEADER_H - MARK_40.size) / 2), BLACK);
  const titleX = MARGIN + MARK_40.size + 12;
  const titleFace = faces.sansSemibold32;
  const titleY = HEADER_Y + Math.floor((HEADER_H - titleFace.height) / 2);
  drawText(canvas, width, height, titleFace, screen.title, titleX, titleY, BLACK);
  const dateFace = faces.monoMedium18;
  const date = screen.date_label;
  const dateW = measure(dateFace, date);
  const dateY = HEADER_Y + Math.floor((HEADER_H - dateFace.height) / 2);
  drawText(canvas, width, height, dateFace, date, width - MARGIN - dateW, dateY, BLACK);
  // The one Garden band of the screen, in yellow: colour as a stripe, never as the words.
  fillRect(canvas, width, height, MARGIN, BAND_Y, width - MARGIN * 2, BAND_H, YELLOW);

  const slots: Array<{ x: number; y: number }> = [
    { x: MARGIN, y: CARD_Y },
    { x: MARGIN + CARD_W + GAP, y: CARD_Y },
    { x: MARGIN, y: CARD_Y + CARD_H + GAP },
    { x: MARGIN + CARD_W + GAP, y: CARD_Y + CARD_H + GAP },
  ];
  for (let i = 0; i < 4; i++) {
    const pane = panes[i];
    const slot = slots[i]!;
    if (!pane) {
      strokeRoundRect(canvas, width, height, slot.x, slot.y, CARD_W, CARD_H, CARD_R, BLACK, 2);
      continue;
    }
    drawPane(canvas, width, height, pane, slot.x, slot.y, CARD_W, CARD_H);
  }
  return encodeCanvas(canvas, width, height, palette);
}

function drawPane(
  canvas: Uint8Array,
  width: number,
  height: number,
  pane: FridgePane,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  if (pane.tone === "dark") {
    fillRoundRect(canvas, width, height, x, y, w, h, CARD_R, BLACK);
    const ink = WHITE;
    let cy = y + CARD_PAD;
    if (pane.kicker) {
      const markColor = pane.mark === "due" || pane.mark === "now" || pane.mark === "left" ? RED : pane.mark === "list" ? YELLOW : YELLOW;
      if (pane.mark || pane.kicker !== "HMN") {
        fillRect(canvas, width, height, x + CARD_PAD, cy + 5, 8, 8, pane.mark ? markColor : YELLOW);
      }
      drawText(canvas, width, height, faces.monoMedium14, pane.kicker.toUpperCase(), x + CARD_PAD + (pane.mark || pane.kicker !== "HMN" ? 16 : 0), cy, ink, w - CARD_PAD * 2 - 16);
      cy += faces.monoMedium14.height + 4;
    }
    if (pane.time) {
      drawText(canvas, width, height, faces.sansSemibold48, pane.time, x + CARD_PAD, cy, ink, w - CARD_PAD * 2);
      cy += faces.sansSemibold48.height - 8;
    }
    if (pane.title) {
      drawText(canvas, width, height, faces.sansSemibold24, pane.title, x + CARD_PAD, cy, ink, w - CARD_PAD * 2);
      cy += faces.sansSemibold24.height + 2;
    }
    if (pane.subtitle) {
      drawText(canvas, width, height, faces.sansRegular16, pane.subtitle, x + CARD_PAD, cy, ink, w - CARD_PAD * 2);
      cy += faces.sansRegular16.height + 8;
    }
    for (const row of pane.items) {
      if (cy + 22 > y + h - 12) break;
      const timeFace = faces.monoMedium18;
      const textFace = faces.sansRegular16;
      let tx = x + CARD_PAD;
      if (row.time) {
        drawText(canvas, width, height, timeFace, row.time, tx, cy, ink);
        tx += Math.max(measure(timeFace, "00:00"), measure(timeFace, row.time)) + 10;
      }
      drawText(canvas, width, height, textFace, row.text, tx, cy + 2, ink, w - CARD_PAD - (tx - x));
      cy += 26;
    }
    return;
  }

  strokeRoundRect(canvas, width, height, x, y, w, h, CARD_R, BLACK, 2);
  if (pane.accent === "yellow") {
    // A yellow rail on the list card: colour as an element, words stay black.
    fillRoundRect(canvas, width, height, x + 3, y + 3, 10, h - 6, 8, YELLOW);
    fillRect(canvas, width, height, x + 8, y + 3, 5, h - 6, YELLOW);
  }
  const innerLeft = x + CARD_PAD + (pane.accent === "yellow" ? 6 : 0);
  const innerRoom = w - CARD_PAD * 2 - (pane.accent === "yellow" ? 6 : 0);
  let cy = y + 12;
  if (pane.label) {
    drawText(canvas, width, height, faces.monoMedium14, pane.label.toUpperCase(), innerLeft, cy, BLACK, innerRoom);
    cy += faces.monoMedium14.height + 8;
  }
  if (!pane.items.length) {
    const line = pane.empty ?? "";
    if (line) drawText(canvas, width, height, faces.sansRegular16, line, innerLeft, cy, BLACK, innerRoom);
    return;
  }
  const pitch = 34;
  for (const row of pane.items) {
    if (cy + 24 > y + h - 10) break;
    drawRow(canvas, width, height, row, innerLeft, cy, innerRoom);
    cy += pitch;
  }
}

function drawRow(
  canvas: Uint8Array,
  width: number,
  height: number,
  row: FridgeItem,
  x: number,
  y: number,
  room: number,
) {
  let textX = x;
  if (row.mark === "now" || row.mark === "due" || row.mark === "left") {
    fillRect(canvas, width, height, x, y + 8, 8, 8, RED);
    textX = x + 16;
  } else if (row.mark === "list") {
    fillRect(canvas, width, height, x, y + 8, 8, 8, YELLOW);
    textX = x + 16;
  } else if (row.mark === "open") {
    strokeCircle(canvas, width, height, x + 4, y + 12, 5, BLACK, 2);
    textX = x + 16;
  }
  const textFace = faces.sansMedium20;
  const timeFace = faces.monoMedium18;
  const time = row.time;
  if (time) {
    drawText(canvas, width, height, timeFace, time, textX, y + 1, BLACK);
    const col = Math.max(measure(timeFace, "00:00"), measure(timeFace, time));
    drawText(canvas, width, height, textFace, row.text, textX + col + 12, y, BLACK, room - (textX - x) - col - 12);
  } else {
    drawText(canvas, width, height, textFace, row.text, textX, y, BLACK, room - (textX - x));
  }
}

function encodeCanvas(canvas: Uint8Array, width: number, height: number, palette: FridgePalette): Buffer {
  if (palette === "bwry") {
    return encodePngIndexed(2, BWRY_INKS, (x, py) => canvas[py * width + x] ?? WHITE, width, height);
  }
  return encodeBmp1((x, py) => {
    const ink = canvas[py * width + x] ?? WHITE;
    return ink === WHITE || ink === YELLOW;
  });
}

/**
 * The pairing screen: a QR code at the left, black on white with a white quiet zone, and the words at the right.
 * Yellow stays off the code: a phone camera reads yellow as light, but a black and white panel draws it white.
 */
function drawPairing(canvas: Uint8Array, width: number, height: number, pairing: NonNullable<FridgeScreen["pairing"]>) {
  const title = pairing.name ? `${pairing.name}'s phone` : "Pair a phone";
  const until = `until ${pairing.until}`;
  drawMark(canvas, width, height, MARK_40, MARGIN, HEADER_Y + 2, BLACK);
  const titleFace = faces.sansSemibold32;
  const dateFace = faces.monoMedium18;
  drawText(canvas, width, height, titleFace, title, MARGIN + MARK_40.size + 12, HEADER_Y + 2, BLACK, width - MARGIN * 2 - MARK_40.size - 12 - measure(dateFace, until) - 16);
  drawText(canvas, width, height, dateFace, until, width - MARGIN - measure(dateFace, until), HEADER_Y + 10, BLACK);
  fillRect(canvas, width, height, MARGIN, BAND_Y, width - MARGIN * 2, BAND_H, YELLOW);
  const qr = encodeQr(pairing.payload);
  const top = 80;
  const module = Math.max(3, Math.min(9, Math.floor((height - top - 20) / qr.size)));
  const left = MARGIN;
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.dark[y]![x]) fillRect(canvas, width, height, left + x * module, top + y * module, module, module, BLACK);
    }
  }
  const column = left + qr.size * module + 32;
  const lines = ["Open the camera", "and point it here.", "", "HMN opens and", "pairs the phone.", "", "Works once."];
  let y = top + 8;
  for (const line of lines) {
    if (line) drawText(canvas, width, height, faces.sansMedium20, line, column, y, BLACK, width - MARGIN - column);
    y += 36;
  }
}

