/**
 * The fridge: the household's shared glance, on an e-ink panel. It reads the Household tier, through the same
 * policy layer as every reader, so the views here are already filtered. It changes by the time of day, and its
 * image name changes only when its picture changes, so a slow colour panel does not flash for nothing.
 * docs/ONTOLOGY.md, section 5.3, has the design.
 */
import { GLYPH_H, GLYPH_W, GLYPHS } from "./glyphs";
import type { EntityView } from "./policy";
import { isTaskRow, type ScreenInput, type SourcedLink } from "./screens";
import { dueDateKey, eventOver, hasClock, zoned } from "./time";
import { BWRY_INKS, encodeBmp1, encodePngIndexed, OG } from "./devices/image";
import { encodeQr } from "./qr";
import { dueOn, routineDays, routinePeople } from "./routines";

export const FRIDGE_SCREENS = ["morning", "week", "evening", "quiet"] as const;
export type FridgeScreenId = (typeof FRIDGE_SCREENS)[number];

/** Black for text, red for now and today, yellow for one highlight. */
export type Ink = "black" | "red" | "yellow";

export type FridgeRow = { time: string; text: string; ink: Ink };
export type FridgeSection = { label: string; rows: FridgeRow[] };
export type FridgeScreen = {
  id: FridgeScreenId;
  title: string;
  date_label: string;
  sections: FridgeSection[];
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

/** At most this many rows on the panel, so that a row is readable across a kitchen. */
const ROWS_MAX = 6;

export function buildFridge(input: ScreenInput, id: FridgeScreenId): FridgeScreen {
  const { views, links, now, timeZone } = input;
  const zone = zoned(now, timeZone);
  const today = zone.dateKey;
  const tomorrow = dayKey(now, timeZone, 1);
  const nowMs = now.getTime();
  const fixtureKinds = input.roles?.fixtureEvent ?? new Set<string>();
  const all = [...views.values()];
  // An event that is over is not on the fridge: a game that started this afternoon is gone when it ends.
  const events = all
    .filter((item) => item.type === "event" && !eventOver(item, now, timeZone, fixtureKinds.has(item.kind ?? "")))
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const tasks = all
    .filter((item) => isTaskRow(item) && item.status === "open" && item.due_at)
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const on = (item: EntityView, key: string) => dueDateKey(item.due_at!, timeZone) === key;
  const used: string[] = [];
  const row = (item: EntityView, ink: Ink, time?: string): FridgeRow => {
    used.push(item.id);
    return { time: time ?? clock(item, timeZone), text: label(item, links), ink };
  };
  const date_label = `${zone.weekday} ${Number(zone.day)}/${zone.month}`;
  const sections: FridgeSection[] = [];
  // Sections that keep their place at the end, whatever the rows above them.
  const tail: FridgeSection[] = [];

  if (id === "morning") {
    const todays = events.filter((item) => on(item, today) && !fixtureKinds.has(item.kind ?? ""));
    // The next thing that starts is red. The rest of the day is black.
    const next = todays.find((item) => !hasClock(item.due_at!) || Date.parse(item.due_at!) >= nowMs);
    sections.push({ label: "Today", rows: todays.map((item) => row(item, item === next ? "red" : "black")) });
    const due = tasks.filter((item) => dueDateKey(item.due_at!, timeZone) <= today);
    if (due.length) sections.push({ label: "To do today", rows: due.map((item) => row(item, "red", "")) });
    routinesTail(all, links, zone, used, tail);
  } else if (id === "week") {
    const week = [...events, ...tasks]
      .filter((item) => !fixtureKinds.has(item.kind ?? ""))
      .filter((item) => {
        const key = dueDateKey(item.due_at!, timeZone);
        return key >= today && key <= dayKey(now, timeZone, 6);
      })
      .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
    // The day name shows once, at its first row. Only a task that is due today is red: a whole week in red is noise.
    let lastDay = "";
    const rows = week.map((item) => {
      const day = dayName(item, timeZone);
      const time = `${day === lastDay ? " ".repeat(day.length) : day} ${clock(item, timeZone)}`.trimEnd();
      lastDay = day;
      return row(item, item.type === "task" && dueDateKey(item.due_at!, timeZone) <= today ? "red" : "black", time);
    });
    sections.push({ label: "", rows });
    const fixture = events.find((item) => fixtureKinds.has(item.kind ?? "") && Date.parse(item.due_at!) >= nowMs);
    if (fixture) sections.push({ label: "To watch", rows: [row(fixture, "black", dayAndClock(fixture, timeZone))] });
  } else if (id === "evening") {
    const tonight = events.filter((item) => on(item, today) && hasClock(item.due_at!) && Date.parse(item.due_at!) >= nowMs);
    if (tonight.length) sections.push({ label: "Tonight", rows: tonight.map((item) => row(item, "black")) });
    // A task due today that is not done yet is red in the evening, so it is not missed.
    const undone = tasks.filter((item) => on(item, today));
    if (undone.length) sections.push({ label: "Still to do today", rows: undone.map((item) => row(item, "red", "")) });
    // An early start tomorrow is red, so it is seen the evening before.
    const early = (item: EntityView) => hasClock(item.due_at!) && zoned(new Date(item.due_at!), timeZone).hour < 9;
    const next = [...events.filter((item) => on(item, tomorrow)), ...tasks.filter((item) => on(item, tomorrow))].sort((a, b) =>
      String(a.due_at).localeCompare(String(b.due_at)),
    );
    sections.push({ label: "Tomorrow", rows: next.map((item) => row(item, early(item) ? "red" : "black")) });
    routinesTail(all, links, zone, used, tail);
    // The list that changed last, on one yellow row, so the shopping is seen before the shops close.
    const list = shoppingList(all, links);
    if (list) {
      used.push(list.list.id, ...list.items.map((item) => item.id));
      tail.push({ label: list.list.title, rows: [{ time: "", text: list.items.map((item) => item.title).join(", "), ink: "yellow" }] });
    }
  } else {
    // After midnight the coming day is today, so a 06:30 flight shows at 02:00.
    const key = zone.hour < 6 ? today : tomorrow;
    const first = events.find((item) => on(item, key));
    sections.push({ label: zone.hour < 6 ? "Today" : "Tomorrow", rows: first ? [row(first, "black")] : [] });
  }

  return {
    id,
    title: TITLES[id],
    date_label,
    sections: [...fit(sections, ROWS_MAX - trimTail(tail)), ...tail],
    entity_ids: [...new Set(used)],
  };
}

const TITLES: Record<FridgeScreenId, string> = {
  morning: "This morning",
  week: "This week",
  evening: "Tonight and tomorrow",
  quiet: "Good night",
};

/** The empty line of each section. Short, and with a little character. */
const EMPTY: Record<string, string> = {
  Today: "Nothing booked. A free day.",
  "": "A clear week.",
  Tomorrow: "Nothing early. Sleep in.",
};

/** The rows that the dates and tasks of a screen keep, whatever the routines and the list take. */
const MAIN_ROWS_MIN = 3;

/**
 * The routines and the list keep their place at the end, but they do not push today's dates and tasks off the panel.
 * When they would leave fewer than MAIN_ROWS_MIN rows, the routines give up rows first. Returns the rows they keep.
 */
function trimTail(tail: FridgeSection[]): number {
  const count = () => tail.reduce((sum, section) => sum + section.rows.length, 0);
  const routines = tail.find((section) => section.label === "Routines");
  while (routines && ROWS_MAX - count() < MAIN_ROWS_MIN && routines.rows.length > 1) {
    const cut = routines.rows.pop()!;
    const last = routines.rows[routines.rows.length - 1]!;
    // The names of the children who lost a row stay on the last row, so no child is left out.
    last.text = `${last.text} · ${cut.text}`;
  }
  return count();
}

/** Keep the panel to its rows. The first section keeps its rows first. A section that is cut says how many more. */
function fit(sections: FridgeSection[], rows = ROWS_MAX): FridgeSection[] {
  let left = rows;
  const out: FridgeSection[] = [];
  for (const section of sections) {
    if (left <= 0) break;
    if (section.rows.length === 0) {
      out.push({ label: section.label, rows: [{ time: "", text: EMPTY[section.label] ?? "Nothing here.", ink: "black" }] });
      left -= 1;
      continue;
    }
    if (section.rows.length > left && left >= 2) {
      const kept = section.rows.slice(0, left - 1);
      out.push({ label: section.label, rows: [...kept, { time: "", text: `+${section.rows.length - kept.length} more`, ink: "black" }] });
      left = 0;
      continue;
    }
    const rows = section.rows.slice(0, left);
    out.push({ label: section.label, rows });
    left -= rows.length;
  }
  return out;
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

/**
 * Today's routines, one row for each person: what is left, or "all done". The row changes when a child checks in,
 * so the picture changes too, and the fridge shows it at its next refresh.
 */
function routinesTail(all: EntityView[], links: SourcedLink[], zone: { dateKey: string; weekday: string }, used: string[], tail: FridgeSection[]) {
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
  if (!byPerson.size) return;
  const rows = [...byPerson.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry): FridgeRow => ({ time: "", text: `${entry.name}: ${entry.left.length ? entry.left.join(", ") : "all done"}`, ink: "black" }));
  tail.push({ label: "Routines", rows });
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

export type FridgePalette = "bwry" | "bw";

/**
 * Draw a fridge screen at 800 × 480. The BWRY panel gets an indexed PNG with its four inks. A black and white
 * panel gets a 1-bit BMP, with red as black and yellow as white.
 */
export function renderFridge(screen: FridgeScreen, palette: FridgePalette): Buffer {
  const { width, height } = OG;
  const canvas = new Uint8Array(width * height).fill(WHITE);
  const margin = 28;
  if (screen.pairing) {
    drawPairing(canvas, width, height, margin, screen.pairing);
    return encodeCanvas(canvas, width, height, palette);
  }
  // The title, large, and the date at the right.
  text(canvas, width, height, screen.title, margin, 22, BLACK, 3);
  const date = clean(screen.date_label);
  text(canvas, width, height, date, width - margin - date.length * GLYPH_W * 2, 34, BLACK, 2);
  // The one yellow line of the screen, under the title.
  rect(canvas, width, margin, 78, width - margin * 2, 6, YELLOW);
  let y = 100;
  for (const section of screen.sections) {
    // A section with no label is the screen's own list: the title already names it.
    if (section.label) {
      text(canvas, width, height, section.label.toUpperCase(), margin, y, BLACK, 1);
      y += 22;
    }
    // The time column is as wide as the longest time of the section, and one space more.
    const column = Math.max(0, ...section.rows.map((row) => clean(row.time).length));
    for (const row of section.rows) {
      if (y > height - 44) break;
      // A yellow row is a highlight: a yellow band with black text. Yellow text on white is not readable.
      if (row.ink === "yellow") rect(canvas, width, margin - 8, y - 6, width - (margin - 8) * 2, GLYPH_H * 2 + 12, YELLOW);
      const ink = row.ink === "red" ? RED : BLACK;
      const time = clean(row.time);
      if (time.trim()) text(canvas, width, height, time, margin, y, ink, 2);
      const left = margin + (column ? (column + 1) * GLYPH_W * 2 : 0);
      const room = Math.floor((width - margin - left) / (GLYPH_W * 2));
      text(canvas, width, height, ellipsis(clean(row.text), room), left, y, row.ink === "red" ? RED : BLACK, 2);
      y += 40;
    }
    y += 8;
  }
  return encodeCanvas(canvas, width, height, palette);
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
function drawPairing(canvas: Uint8Array, width: number, height: number, margin: number, pairing: NonNullable<FridgeScreen["pairing"]>) {
  const title = pairing.name ? `${pairing.name}'s phone` : "Pair a phone";
  const until = `until ${pairing.until}`;
  const titleRoom = Math.floor((width - margin * 2 - until.length * GLYPH_W * 2 - 24) / (GLYPH_W * 3));
  text(canvas, width, height, ellipsis(clean(title), titleRoom), margin, 22, BLACK, 3);
  text(canvas, width, height, until, width - margin - until.length * GLYPH_W * 2, 34, BLACK, 2);
  rect(canvas, width, margin, 78, width - margin * 2, 6, YELLOW);
  const qr = encodeQr(pairing.payload);
  // Four modules of quiet zone above the code, and as large a module as fits under the yellow line.
  const top = 108;
  const module = Math.max(3, Math.min(9, Math.floor((height - top - 20) / qr.size)));
  const left = margin;
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.dark[y]![x]) rect(canvas, width, left + x * module, top + y * module, module, module, BLACK);
    }
  }
  const column = left + qr.size * module + 40;
  const lines: Array<[string, number]> = [
    ["Open the camera", BLACK],
    ["and point it here.", BLACK],
    ["", BLACK],
    ["HMN opens and", BLACK],
    ["pairs the phone.", BLACK],
    ["", BLACK],
    ["Works once.", RED],
  ];
  const room = Math.floor((width - margin - column) / (GLYPH_W * 2));
  let y = top + 8;
  for (const [line, ink] of lines) {
    if (line) text(canvas, width, height, ellipsis(line, room), column, y, ink, 2);
    y += 40;
  }
}

function clean(value: string): string {
  return [...value].map((ch) => (GLYPHS[ch] ? ch : ch === "·" ? "-" : ch === "—" || ch === "–" ? "-" : " ")).join("");
}

function ellipsis(value: string, room: number): string {
  if (value.length <= room) return value;
  return `${value.slice(0, Math.max(0, room - 3)).trimEnd()}...`;
}

function rect(canvas: Uint8Array, width: number, x: number, y: number, w: number, h: number, ink: number) {
  const height = canvas.length / width;
  for (let py = y; py < y + h && py < height; py++) {
    for (let px = x; px < x + w && px < width; px++) canvas[py * width + px] = ink;
  }
}

function text(canvas: Uint8Array, width: number, height: number, value: string, x: number, y: number, ink: number, scale: number) {
  let cursor = x;
  for (const ch of clean(value)) {
    const glyph = GLYPHS[ch] ?? [];
    for (let gy = 0; gy < GLYPH_H; gy++) {
      const bits = glyph[gy] ?? 0;
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if ((bits & (1 << (GLYPH_W - 1 - gx))) === 0) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = cursor + gx * scale + sx;
            const py = y + gy * scale + sy;
            if (px >= 0 && py >= 0 && px < width && py < height) canvas[py * width + px] = ink;
          }
        }
      }
    }
    cursor += GLYPH_W * scale;
  }
}
