// The fridge: a TRMNL BWRY claimed at Household. It draws four household screens by the time of day, in four
// inks, and it shows nothing above Household. All data is fictional.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { createApp, type App } from "../src/app";
import { encodePngIndexed, BWRY_INKS } from "../src/devices/image";
import { displayAccess } from "../src/devices/trmnl";
import { fridgeWindow, renderFridge, secondsToNextWindow, type FridgeScreen } from "../src/fridge";
import { call } from "./helpers";

const MINI = "127.0.0.1";
const FRIDGE_IP = "10.0.0.40";

function clockedApp(iso: string) {
  const clock = { now: new Date(iso) };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-fridge-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Australia/Perth" });
  return { app, clock };
}

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });

/** The chunks of a PNG, and its pixels as palette indices for a 2-bit image. */
function readPng(png: Buffer) {
  const chunks: Record<string, Buffer[]> = {};
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString("latin1");
    (chunks[type] ??= []).push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const ihdr = chunks.IHDR![0]!;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(chunks.IDAT!));
  const rowBytes = Math.ceil(width / 4);
  const counts = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = raw[y * (rowBytes + 1) + 1 + Math.floor(x / 4)]!;
      counts[(byte >> ((3 - (x % 4)) * 2)) & 3]! += 1;
    }
  }
  return { width, height, bitDepth: ihdr[8], colorType: ihdr[9], plte: chunks.PLTE?.[0], counts };
}

async function pairFridge(app: App, mac: string, body: Record<string, unknown>) {
  const setup = (headers: Record<string, string>) => app.fetch(new Request("https://hmn.local/api/setup", { headers }), FRIDGE_IP).then((r) => r.json() as Promise<{ api_key: string | null; friendly_id: string }>);
  const first = await setup({ ID: mac, Model: "og_4clr" });
  const claimed = await call(app, `/api/v1/trmnl/devices/${first.friendly_id}/claim`, { method: "POST", key: app.secrets!.owner, ip: MINI, body: { name: "Fridge", ...body } });
  expect(claimed.status).toBe(200);
  const key = (await setup({ ID: mac, Model: "og_4clr" })).api_key!;
  expect(key.startsWith("hmn_")).toBe(true);
  return key;
}

async function display(app: App, key: string, mac: string) {
  const response = await app.fetch(new Request("https://hmn.local/api/display", { headers: { "Access-Token": key, ID: mac, Model: "og_4clr", Width: "800", Height: "480" } }), FRIDGE_IP);
  expect(response.status).toBe(200);
  return (await response.json()) as { image_url: string; filename: string; refresh_rate: number; screen: string };
}

function accounted(screen: FridgeScreen): number {
  let count = 0;
  for (const pane of screen.panes) {
    if (pane.id === "focus" && pane.title && pane.kicker !== "HMN" && pane.title !== "A free morning." && pane.title !== "A clear week." && pane.title !== "Nothing later tonight." && pane.title !== "Nothing early tomorrow.") {
      count += 1;
    }
    for (const row of pane.items) {
      const more = /^\+\d+ more$/.exec(row.text);
      count += more ? Number(/\d+/.exec(row.text)![0]) : 1;
    }
  }
  return count;
}

async function event(app: App, title: string, due: string, tier: string) {
  const made = await call(app, "/api/v1/event", { method: "POST", ...owner(app), body: { title, due_at: due, status: "upcoming", kind: "appointment", tier } });
  expect(made.status).toBe(201);
  return (made.json as { id: string }).id;
}

test("the time windows of the day", () => {
  expect([3, 6, 8, 9, 15, 16, 20, 21, 23].map(fridgeWindow)).toEqual(["quiet", "morning", "morning", "week", "week", "evening", "evening", "quiet", "quiet"]);
  // 07:30 in Perth: the week screen starts at 09:00, in 90 minutes.
  expect(secondsToNextWindow(new Date("2026-11-11T23:30:00.000Z"), "Australia/Perth")).toBe(90 * 60);
});

test("a four-ink PNG: indexed, 2 bits, the exact inks, under the size limit of the panel", () => {
  const png = encodePngIndexed(2, BWRY_INKS, (x) => x % 4, 800, 480);
  const read = readPng(png);
  expect(read).toMatchObject({ width: 800, height: 480, bitDepth: 2, colorType: 3 });
  expect([...read.plte!]).toEqual([0, 0, 0, 255, 255, 255, 255, 0, 0, 255, 255, 0]);
  const screen: FridgeScreen = {
    id: "morning",
    title: "This morning",
    date_label: "Wed 11/11",
    entity_ids: [],
    panes: [
      { id: "focus", label: "", tone: "dark", kicker: "Next", time: "08:00", title: "Example school run", mark: "now", items: [] },
      { id: "today", label: "Today", tone: "light", items: [{ time: "16:30", text: "Example swimming" }] },
      { id: "routines", label: "Routines", tone: "light", items: [], empty: "Caught up." },
      { id: "todo", label: "To do today", tone: "light", items: [], empty: "Caught up." },
    ],
  };
  const drawn = renderFridge(screen, "bwry");
  expect(drawn.length).toBeLessThan(90_000);
  const counts = readPng(drawn).counts;
  // Black ink, a red mark on the focus pane, and the yellow Garden band are all on the panel.
  expect(counts[0]).toBeGreaterThan(0);
  expect(counts[2]).toBeGreaterThan(0);
  expect(counts[3]).toBeGreaterThan(0);
  // A black and white panel gets a 1-bit BMP with the same layout.
  expect(renderFridge(screen, "bw").subarray(0, 2).toString("latin1")).toBe("BM");
});

test("the fridge reads Household, a Public display does not, and the image name changes only with the picture", async () => {
  // 07:10 in Perth, on Thursday 12 November: the morning screen.
  const { app } = clockedApp("2026-11-11T23:10:00.000Z");
  try {
    const kid = await call(app, "/api/v1/person", { method: "POST", ...owner(app), body: { title: "Example Kid", kind: "family", tier: "household" } });
    const kidId = (kid.json as { id: string }).id;
    const swim = await event(app, "Example swimming", "2026-11-12T00:30:00.000Z", "household");
    await call(app, "/api/v1/links", { method: "POST", ...owner(app), body: { from_type: "event", from_id: swim, to_type: "person", to_id: kidId, rel: "with" } });
    await event(app, "Example work review", "2026-11-12T02:00:00.000Z", "personal");

    const fridgeKey = await pairFridge(app, "41:B4:10:39:A1:51", { ceiling: "household" });
    const body = await display(app, fridgeKey, "41:B4:10:39:A1:51");
    expect(body.screen).toBe("morning");
    expect(body.image_url).toContain("/api/trmnl/fridge.png");
    expect(body.filename).toMatch(/^fr-morning-[0-9a-f]{10}$/);
    expect(body.refresh_rate).toBeLessThanOrEqual(600);

    const { access } = displayAccess(app.hmn, fridgeKey, FRIDGE_IP);
    const screen = app.hmn.fridgeScreen(access, "morning");
    const text = JSON.stringify(screen);
    expect(text).toContain("Example swimming");
    expect(text).toContain("Example Kid");
    expect(text).not.toContain("Example work review");
    // The seed's Private family rows are not on the fridge either.
    for (const name of ["Yves", "Luca", "Sam", "dentist", "passport"]) expect(text).not.toContain(name);

    const image = await app.fetch(new Request(`https://hmn.local${new URL(body.image_url).pathname}${new URL(body.image_url).search}`), FRIDGE_IP);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(readPng(Buffer.from(await image.arrayBuffer())).colorType).toBe(3);

    // The same picture keeps its name, so the panel does not refresh. A change gives a new name.
    expect((await display(app, fridgeKey, "41:B4:10:39:A1:51")).filename).toBe(body.filename);
    await event(app, "Example piano", "2026-11-12T02:00:00.000Z", "household");
    expect((await display(app, fridgeKey, "41:B4:10:39:A1:51")).filename).not.toBe(body.filename);

    // A display claimed at Public, also a BWRY, gets the Public deck as a palette PNG, and no household row.
    const hallKey = await pairFridge(app, "41:B4:10:39:A1:52", {});
    const hall = await display(app, hallKey, "41:B4:10:39:A1:52");
    expect(hall.image_url).toContain("/api/trmnl/image.png");
    expect(hall.image_url).toContain("depth=bwry");
    expect((await app.fetch(new Request(`https://hmn.local${new URL(hall.image_url).pathname}${new URL(hall.image_url).search}`), FRIDGE_IP)).status).toBe(200);
    const fromHall = await app.fetch(new Request(`https://hmn.local/api/trmnl/fridge.png?access_token=${hallKey}`), FRIDGE_IP);
    expect(fromHall.status).toBe(404);
    // The owner key does not draw the fridge either.
    expect((await app.fetch(new Request(`https://hmn.local/api/trmnl/fridge.png?access_token=${app.secrets!.owner}`), MINI)).status).toBe(404);

    // Hide from the mini pushes the fridge down to Public.
    expect((await call(app, "/api/v1/admin/panic", { method: "POST", key: app.secrets!.owner, ip: MINI })).status).toBe(200);
    const hidden = JSON.stringify(app.hmn.fridgeScreen(displayAccess(app.hmn, fridgeKey, FRIDGE_IP).access, "morning"));
    expect(hidden).not.toContain("Example swimming");
  } finally {
    app.close();
  }
});

test("each window shows its own content", async () => {
  // 18:00 in Perth on Thursday 12 November.
  const { app, clock } = clockedApp("2026-11-12T10:00:00.000Z");
  try {
    await event(app, "Example dinner with friends", "2026-11-12T11:30:00.000Z", "household");
    await event(app, "Example early flight", "2026-11-12T22:30:00.000Z", "household");
    const key = await pairFridge(app, "41:B4:10:39:A1:53", { ceiling: "household", palette: "bwry" });
    const access = displayAccess(app.hmn, key, FRIDGE_IP).access;
    expect(app.hmn.fridgeWindowNow()).toBe("evening");
    const evening = app.hmn.fridgeScreen(access, "evening");
    expect(evening.title).toBe("This evening");
    const tomorrow = evening.panes.find((pane) => pane.id === "tomorrow")!;
    expect(tomorrow).toBeDefined();
    // A start before 09:00 tomorrow is marked, so it is seen the evening before. The words stay black.
    expect(tomorrow.items[0]).toMatchObject({ time: "06:30", mark: "now", text: "Example early flight" });
    clock.now = new Date("2026-11-12T14:00:00.000Z");
    expect(app.hmn.fridgeWindowNow()).toBe("quiet");
    expect(JSON.stringify(app.hmn.fridgeScreen(access, "quiet"))).toContain("Example early flight");
    const week = app.hmn.fridgeScreen(access, "week");
    expect(week.panes.some((pane) => pane.id === "week" || pane.id === "focus")).toBe(true);
    // An empty morning still has a calm line in the focus pane or the Today card.
    const morning = app.hmn.fridgeScreen(access, "morning");
    const morningText = JSON.stringify(morning);
    expect(morningText.includes("A free morning.") || morning.panes.some((pane) => pane.items.length || pane.title)).toBe(true);
  } finally {
    app.close();
  }
});

test("the evening shows the newest list as a yellow card, and a Private list stays off the fridge", async () => {
  // 18:00 in Perth on Thursday 12 November.
  const { app } = clockedApp("2026-11-12T10:00:00.000Z");
  try {
    const list = await call(app, "/api/v1/project", { method: "POST", ...owner(app), body: { title: "Groceries", kind: "list", status: "active", tier: "household" } });
    const listId = (list.json as { id: string }).id;
    for (const title of ["Example milk", "Example eggs"]) {
      expect((await call(app, "/api/v1/items", { method: "POST", ...owner(app), body: { parent_id: listId, title } })).status).toBe(201);
    }
    const gifts = await call(app, "/api/v1/project", { method: "POST", ...owner(app), body: { title: "Example gifts", kind: "list", status: "active", tier: "private" } });
    await call(app, "/api/v1/items", { method: "POST", ...owner(app), body: { parent_id: (gifts.json as { id: string }).id, title: "Example secret book" } });
    // Many rows above the list do not push it off the panel.
    for (let hour = 11; hour < 14; hour++) await event(app, `Example evening ${hour}`, `2026-11-12T${hour}:00:00.000Z`, "household");
    for (let hour = 0; hour < 4; hour++) await event(app, `Example tomorrow ${hour}`, `2026-11-13T0${hour}:00:00.000Z`, "household");

    const key = await pairFridge(app, "41:B4:10:39:A1:54", { ceiling: "household" });
    const screen = app.hmn.fridgeScreen(displayAccess(app.hmn, key, FRIDGE_IP).access, "evening");
    const listPane = screen.panes.find((pane) => pane.id === "list")!;
    expect(listPane.label).toBe("Groceries");
    expect(listPane.accent).toBe("yellow");
    expect(listPane.items.map((item) => item.text)).toEqual(["Example milk", "Example eggs"]);
    expect(JSON.stringify(screen)).not.toContain("Example secret book");
    const tomorrow = screen.panes.find((pane) => pane.id === "tomorrow")!;
    expect(tomorrow.items[0]?.text).toContain("Example tomorrow");
    const png = renderFridge(screen, "bwry");
    expect(png.length).toBeLessThan(90_000);
    const counts = readPng(png).counts;
    // The Garden band plus the list's yellow rail: colour as an element, not as the words.
    expect(counts[3]).toBeGreaterThan(4_000);
  } finally {
    app.close();
  }
});

test("rows that do not fit are counted, never dropped in silence, and the picture fits the panel", async () => {
  // 07:00 in Perth on Thursday 12 November: eight things today, and tasks due today.
  const { app } = clockedApp("2026-11-11T23:00:00.000Z");
  try {
    for (let hour = 0; hour < 8; hour++) {
      await event(app, `Example meeting ${hour + 1}`, `2026-11-12T${String(hour).padStart(2, "0")}:00:00.000Z`, "household");
    }
    for (const title of ["Example form", "Example parcel"]) {
      const made = await call(app, "/api/v1/task", { method: "POST", ...owner(app), body: { title, status: "open", kind: "task", due_at: "2026-11-12", tier: "household" } });
      expect(made.status).toBe(201);
    }
    const key = await pairFridge(app, "41:B4:10:39:A1:77", { ceiling: "household", palette: "bwry" });
    const access = displayAccess(app.hmn, key, FRIDGE_IP).access;
    const morning = app.hmn.fridgeScreen(access, "morning");
    const more = morning.panes.flatMap((pane) => pane.items).find((item) => /^\+\d+ more$/.test(item.text));
    expect(more?.text).toMatch(/^\+\d+ more$/);
    expect(accounted(morning)).toBe(10);
    const png = renderFridge(morning, "bwry");
    expect(readPng(png)).toMatchObject({ width: 800, height: 480 });
    expect(png.length).toBeLessThan(90_000);
  } finally {
    app.close();
  }
});

test("morning is the first part of the day, and an event that has begun stays marked as now", async () => {
  // 07:40 in Hong Kong on Wednesday 2 December: school has started, piano is later, dinner is for the evening.
  const clock = { now: new Date("2026-12-01T23:40:00.000Z") };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-fridge-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Asia/Hong_Kong" });
  try {
    await event(app, "Example school run", "2026-12-01T23:30:00.000Z", "household");
    await event(app, "Example piano", "2026-12-02T07:00:00.000Z", "household");
    await event(app, "Example dinner", "2026-12-02T10:30:00.000Z", "household");
    const key = await pairFridge(app, "41:B4:10:39:A1:80", { ceiling: "household" });
    const access = displayAccess(app.hmn, key, FRIDGE_IP).access;
    const morning = app.hmn.fridgeScreen(access, "morning");
    const focus = morning.panes.find((pane) => pane.id === "focus")!;
    expect(focus).toMatchObject({ time: "07:30", title: "Example school run", kicker: "Now", mark: "now" });
    const today = morning.panes.find((pane) => pane.id === "today")!;
    expect(today.items.map((row) => row.text)).toEqual(["Example piano"]);
    expect(today.items[0]).toMatchObject({ time: "15:00" });
    expect(JSON.stringify(morning)).not.toContain("Example dinner");
    const evening = app.hmn.fridgeScreen(access, "evening");
    expect(evening.title).toBe("This evening");
    expect(JSON.stringify(evening)).toContain("Example dinner");
  } finally {
    app.close();
  }
});

test("this evening keeps tomorrow's early start when leftover tasks would fill the panel", async () => {
  // 18:20 in Hong Kong on Wednesday 2 December.
  const clock = { now: new Date("2026-12-02T10:20:00.000Z") };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-fridge-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Asia/Hong_Kong" });
  try {
    await event(app, "Example dinner", "2026-12-02T10:30:00.000Z", "household");
    await event(app, "Example school run", "2026-12-02T23:15:00.000Z", "household");
    for (const title of ["Example form", "Example parcel", "Example call", "Example letter"]) {
      expect((await call(app, "/api/v1/task", { method: "POST", ...owner(app), body: { title, status: "open", kind: "task", due_at: "2026-12-02", tier: "household" } })).status).toBe(201);
    }
    const key = await pairFridge(app, "41:B4:10:39:A1:81", { ceiling: "household" });
    const access = displayAccess(app.hmn, key, FRIDGE_IP).access;
    const evening = app.hmn.fridgeScreen(access, "evening");
    expect(evening.panes.some((pane) => pane.id === "tomorrow")).toBe(true);
    const tomorrow = evening.panes.find((pane) => pane.id === "tomorrow")!;
    expect(tomorrow.items[0]).toMatchObject({ time: "07:15", mark: "now", text: "Example school run" });
    expect(evening.panes.find((pane) => pane.id === "focus")?.title).toBe("Example dinner");
  } finally {
    app.close();
  }
});

test("this week shows the first item of later days before filling today, and leftover routines are marked", async () => {
  // 11:00 in Hong Kong on Wednesday 2 December.
  const clock = { now: new Date("2026-12-02T03:00:00.000Z") };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-fridge-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Asia/Hong_Kong" });
  try {
    for (let hour = 1; hour <= 5; hour++) {
      await event(app, `Example today ${hour}`, `2026-12-02T0${hour}:00:00.000Z`, "household");
    }
    await event(app, "Example Friday dinner", "2026-12-04T10:00:00.000Z", "household");
    const kid = await call(app, "/api/v1/person", { method: "POST", ...owner(app), body: { title: "Example Kid", kind: "family", tier: "household" } });
    const kidId = (kid.json as { id: string }).id;
    const made = await call(app, "/api/v1/routines", { method: "POST", ...owner(app), body: { title: "Pack the bag", person_id: kidId } });
    expect(made.status).toBe(201);
    const key = await pairFridge(app, "41:B4:10:39:A1:82", { ceiling: "household" });
    const access = displayAccess(app.hmn, key, FRIDGE_IP).access;
    const week = app.hmn.fridgeScreen(access, "week");
    const texts = week.panes.flatMap((pane) => [pane.title ?? "", ...pane.items.map((row) => row.text)]);
    expect(texts).toContain("Example Friday dinner");
    const morning = app.hmn.fridgeScreen(access, "morning");
    const routines = morning.panes.find((pane) => pane.id === "routines")!;
    expect(routines.items[0]).toMatchObject({ time: "Example Kid", text: "Pack the bag", mark: "left" });
    // 22:00 the same day: tomorrow is Thursday, no event, so the empty line is calm.
    clock.now = new Date("2026-12-02T14:00:00.000Z");
    const late = app.hmn.fridgeScreen(access, "quiet");
    const focus = late.panes.find((pane) => pane.id === "focus")!;
    expect(focus.title).toBe("Nothing early tomorrow.");
  } finally {
    app.close();
  }
});

test("an evening with tonight, tomorrow, routines, and a list still fits the panel", async () => {
  // 18:20 in Hong Kong on Wednesday 2 December: four quarters hold tonight, tomorrow, routines, and the list.
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-fridge-")), kek: randomBytes(32), now: () => new Date("2026-12-02T10:20:00.000Z"), timeZone: "Asia/Hong_Kong" });
  try {
    await event(app, "Example dinner", "2026-12-02T10:00:00.000Z", "household");
    await event(app, "Example school run", "2026-12-02T23:15:00.000Z", "household");
    await event(app, "Example early swim", "2026-12-02T23:30:00.000Z", "household");
    const list = await call(app, "/api/v1/project", { method: "POST", ...owner(app), body: { title: "Groceries", kind: "list", status: "active", tier: "household" } });
    const listId = (list.json as { id: string }).id;
    for (const title of ["Example milk", "Example eggs", "Example bread"]) {
      expect((await call(app, "/api/v1/items", { method: "POST", ...owner(app), body: { parent_id: listId, title } })).status).toBe(201);
    }
    for (const name of ["Example Ada", "Example Ben"]) {
      const kid = await call(app, "/api/v1/person", { method: "POST", ...owner(app), body: { title: name, kind: "family", tier: "household" } });
      const kidId = (kid.json as { id: string }).id;
      const made = await call(app, "/api/v1/routines", { method: "POST", ...owner(app), body: { title: "Pack the bag", person_id: kidId } });
      expect(made.status).toBe(201);
    }
    const key = await pairFridge(app, "41:B4:10:39:A1:93", { ceiling: "household" });
    const evening = app.hmn.fridgeScreen(displayAccess(app.hmn, key, FRIDGE_IP).access, "evening");
    const ids = evening.panes.map((pane) => pane.id);
    expect(ids).toContain("focus");
    expect(ids).toContain("tomorrow");
    expect(ids).toContain("routines");
    expect(ids).toContain("list");
    expect(evening.panes.find((pane) => pane.id === "focus")?.title).toBe("Example dinner");
    const tomorrow = evening.panes.find((pane) => pane.id === "tomorrow")!;
    expect(tomorrow.items[0]).toMatchObject({ time: "07:15", mark: "now", text: "Example school run" });
    const png = renderFridge(evening, "bwry");
    expect(readPng(png)).toMatchObject({ width: 800, height: 480 });
    expect(png.length).toBeLessThan(90_000);
    expect(readPng(png).counts[3]!).toBeGreaterThan(4_000);
  } finally {
    app.close();
  }
});
