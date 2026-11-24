// QR pairing at the fridge: the owner puts a member pairing code on the fridge, a child scans it with the phone
// camera, and the code leaves the fridge when it is used, ended, or old. docs/ONTOLOGY.md, section 5.4.
// All data is fictional.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app";
import { displayAccess } from "../src/devices/trmnl";
import { renderFridge } from "../src/fridge";
import { encodeQr, formatBits } from "../src/qr";
import { call } from "./helpers";

const MINI = "127.0.0.1";
const FRIDGE_IP = "10.0.0.41";
const AWAY = "10.7.7.9";
const FRIDGE = "41:B4:10:39:A1:61";

function clockedApp(iso: string) {
  const clock = { now: new Date(iso) };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-fridge-pair-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Australia/Perth" });
  return { app, clock };
}

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone", ip: AWAY });

async function pairFridge(app: App) {
  const setup = () => app.fetch(new Request("https://hmn.local/api/setup", { headers: { ID: FRIDGE, Model: "og_4clr" } }), FRIDGE_IP).then((r) => r.json() as Promise<{ api_key: string | null; friendly_id: string }>);
  const first = await setup();
  const claimed = await call(app, `/api/v1/trmnl/devices/${first.friendly_id}/claim`, { method: "POST", key: app.secrets!.owner, ip: MINI, body: { name: "Fridge", ceiling: "household" } });
  expect(claimed.status).toBe(200);
  return (await setup()).api_key!;
}

async function display(app: App, key: string) {
  const response = await app.fetch(new Request("https://hmn.local/api/display", { headers: { "Access-Token": key, ID: FRIDGE, Model: "og_4clr", Width: "800", Height: "480" } }), FRIDGE_IP);
  expect(response.status).toBe(200);
  return (await response.json()) as { filename: string; refresh_rate: number };
}

async function person(app: App, title: string, tier: string) {
  const made = await call(app, "/api/v1/person", { method: "POST", ...owner(app), body: { title, kind: "family", tier } });
  expect(made.status).toBe(201);
  return (made.json as { id: string }).id;
}

async function onFridge(app: App, personId: string) {
  const made = await call(app, "/api/v1/members/pairing", { method: "POST", ...owner(app), body: { person_id: personId, role: "child", fridge: true } });
  expect(made.status).toBe(201);
  return made.json as { code: string; expires_at: string; on_fridge: boolean; payload: string };
}

function fridgeNow(app: App, key: string) {
  const { access } = displayAccess(app.hmn, key, FRIDGE_IP);
  return app.hmn.fridgeScreen(access, "week", "https://192.168.1.20:8787");
}

test("the QR encoder: the size of each version, the three finders, and the format bits", () => {
  const short = encodeQr("HMN");
  expect(short.version).toBe(1);
  expect(short.size).toBe(21);
  const link = encodeQr(`hmn://pair?url=${encodeURIComponent("https://192.168.1.20:8787")}&code=ABCD2345&fp=${"a1".repeat(32)}`);
  expect(link.version).toBe(8);
  expect(link.size).toBe(49);
  for (const [x, y] of [[0, 0], [link.size - 7, 0], [0, link.size - 7]] as const) {
    // A finder: a dark ring, a light ring, and a dark 3 by 3 centre.
    expect(link.dark[y]![x]).toBe(true);
    expect(link.dark[y + 1]![x + 1]).toBe(false);
    expect(link.dark[y + 3]![x + 3]).toBe(true);
  }
  // Level M with mask 0 is the published 101010000010010.
  expect(formatBits(0).toString(2).padStart(15, "0")).toBe("101010000010010");
  expect(() => encodeQr("x".repeat(300))).toThrow();
});

test("a code on the fridge: the QR has the fridge's address, the code works once, and then the fridge is back", async () => {
  // 10:00 in Perth on Thursday 12 November: the week screen.
  const { app } = clockedApp("2026-11-12T02:00:00.000Z");
  try {
    const key = await pairFridge(app);
    const before = await display(app, key);
    const kid = await person(app, "Example Kid", "household");
    const made = await onFridge(app, kid);
    expect(made.on_fridge).toBe(true);
    // Twenty minutes, not ten: the fridge asks for a new picture only every few minutes.
    expect(made.expires_at).toBe("2026-11-12T02:20:00.000Z");

    const screen = fridgeNow(app, key);
    expect(screen.pairing).toBeDefined();
    expect(screen.pairing!.name).toBe("Example Kid");
    expect(screen.pairing!.until).toBe("10:20");
    expect(screen.entity_ids).toEqual([]);
    const link = new URL(screen.pairing!.payload);
    expect(link.protocol).toBe("hmn:");
    expect(link.searchParams.get("url")).toBe("https://192.168.1.20:8787");
    expect(link.searchParams.get("code")).toBe(made.code);
    // The test app pins the fingerprint "test". The live server gives the SHA-256 of its certificate.
    expect(link.searchParams.get("fp")).toBeTruthy();
    expect(renderFridge(screen, "bwry").length).toBeGreaterThan(100);

    // The fridge asks every minute while the code is up, and its picture changes.
    const showing = await display(app, key);
    expect(showing.refresh_rate).toBe(60);
    expect(showing.filename).not.toBe(before.filename);

    // The owner's app sees whose code is up and until when, and never the code.
    const status = await call(app, "/api/v1/members/pairing/fridge", owner(app));
    expect(status.json).toEqual({ fridge: { person_name: "Example Kid", expires_at: "2026-11-12T02:20:00.000Z" }, ready: true });
    expect(JSON.stringify(status.json)).not.toContain(made.code);

    const paired = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: made.code, device_name: "Example kid phone" } });
    expect(paired.status).toBe(201);
    expect((paired.json as { member: { role: string } }).member.role).toBe("child");
    expect(fridgeNow(app, key).pairing).toBeUndefined();
    expect((await display(app, key)).refresh_rate).toBeGreaterThan(60);
    expect((await call(app, "/api/v1/members/pairing/fridge", owner(app))).json).toEqual({ fridge: null, ready: true });
    // The same code does not pair a second phone.
    expect((await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: made.code, device_name: "Example other phone" } })).status).toBe(401);
  } finally {
    app.close();
  }
});

test("taking the code off the fridge kills it, and an old code leaves by itself", async () => {
  const { app, clock } = clockedApp("2026-11-12T02:00:00.000Z");
  try {
    const key = await pairFridge(app);
    const kid = await person(app, "Example Kid", "household");
    const first = await onFridge(app, kid);
    const ended = await call(app, "/api/v1/members/pairing/fridge", { method: "DELETE", ...owner(app) });
    expect(ended.status).toBe(200);
    expect(fridgeNow(app, key).pairing).toBeUndefined();
    // A photo of the fridge does not pair a phone after the owner took the code off.
    expect((await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: first.code, device_name: "Example phone" } })).status).toBe(401);

    // A new code replaces the old one on the fridge, and the old one dies.
    const second = await onFridge(app, kid);
    const third = await onFridge(app, kid);
    expect(new URL(fridgeNow(app, key).pairing!.payload).searchParams.get("code")).toBe(third.code);
    expect((await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: second.code, device_name: "Example phone" } })).status).toBe(401);

    clock.now = new Date("2026-11-12T02:21:00.000Z");
    expect(fridgeNow(app, key).pairing).toBeUndefined();
    expect((await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: third.code, device_name: "Example phone" } })).status).toBe(401);
  } finally {
    app.close();
  }
});

test("a name above Household stays off the fridge, and a hidden fridge shows no code", async () => {
  const { app } = clockedApp("2026-11-12T02:00:00.000Z");
  try {
    const key = await pairFridge(app);
    const quiet = await person(app, "Example Private Person", "private");
    await onFridge(app, quiet);
    const screen = fridgeNow(app, key);
    expect(screen.pairing!.name).toBeNull();
    expect(JSON.stringify(screen)).not.toContain("Example Private Person");

    // Hide from the mini drops the fridge to Public. A Public fridge never draws a pairing code.
    const { access } = displayAccess(app.hmn, key, FRIDGE_IP);
    app.hmn.store.db.query("UPDATE credentials SET forced_ceiling = 'public' WHERE id = ?").run(access.principal.id);
    expect(fridgeNow(app, key).pairing).toBeUndefined();

    // A member cannot put a code on the fridge.
    const kid = await person(app, "Example Kid", "household");
    const made = await call(app, "/api/v1/members/pairing", { method: "POST", ...owner(app), body: { person_id: kid, role: "partner" } });
    const paired = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: (made.json as { code: string }).code, device_name: "Example partner phone" } });
    const memberKey = (paired.json as { secret: string }).secret;
    const refused = await call(app, "/api/v1/members/pairing", { method: "POST", key: memberKey, surface: "phone", ip: AWAY, body: { person_id: kid, role: "child", fridge: true } });
    expect(refused.status).toBe(403);
    expect((await call(app, "/api/v1/members/pairing/fridge", { method: "DELETE", key: memberKey, surface: "phone", ip: AWAY })).status).toBe(403);
  } finally {
    app.close();
  }
});
