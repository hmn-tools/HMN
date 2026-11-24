import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { call, testApp } from "./helpers";
import type { App } from "../src/app";
import { decryptFile } from "../src/crypto";

let app: App;
const forbidden = ["Yves", "Luca", "Sam", "dentist", "passport", "clinic", "Coupe", "weekly notes", "Alex", "Trip helper", "SRS"];

beforeAll(() => {
  app = testApp();
});
afterAll(() => app.close());

test("phone ceiling shows the designed day and hides sealed notes", async () => {
  const response = await call(app, "/api/v1/screens/today", { key: app.secrets!.owner, surface: "phone" });
  expect(response.status).toBe(200);
  const body = response.json as { greeting: string; summary: string; due_count: number; sections: Array<{ id: string; items: Array<{ title: string }> }> };
  expect(body.greeting).toBe("Good afternoon, Alex.");
  expect(body.summary).toBe("Three things due, one family date, and one thing that has gone quiet.");
  expect(body.due_count).toBe(3);
  const titles = body.sections.flatMap((section) => section.items.map((item) => item.title));
  expect(titles).toContain("Send weekly notes");
  expect(titles).toContain("Book Luca's dentist");
  expect(titles).toContain("Yves · school concert");
  // The race is eleven days away. Today shows a fixture of the next 36 hours, and Upcoming shows the race.
  expect(titles).not.toContain("Lakeside Grand Prix");
  expect(titles).toContain("Coupe SRS light");
  const upcoming = await call(app, "/api/v1/screens/upcoming", { key: app.secrets!.owner, surface: "phone" });
  expect(upcoming.text).toContain("Lakeside Grand Prix");
  expect(response.text).not.toContain("passport");
  expect(response.text).not.toContain("clinic");
  expect(response.text).not.toContain("seal1:");
});

test("widget ceiling drops family and sealed rows", async () => {
  const response = await call(app, "/api/v1/screens/today", { key: app.secrets!.owner, surface: "widget" });
  const body = response.json as { due_count: number; next: { title: string }; sections: Array<{ items: Array<{ title: string }> }> };
  expect(body.due_count).toBe(2);
  expect(body.next.title).toBe("Lakeside Grand Prix");
  const titles = body.sections.flatMap((section) => section.items.map((item) => item.title));
  expect(titles).toContain("Send weekly notes");
  expect(titles).toContain("Reply to garage about the coupe service");
  expect(titles).not.toContain("Book Luca's dentist");
  expect(response.text).not.toContain("Yves");
  expect(response.text).not.toContain("Luca");
});

test("display endpoint stays public even for the owner key", async () => {
  // The race is on the Upcoming screen of the display. Today has only the next 36 hours.
  const upcoming = await call(app, "/api/display/upcoming.html", { key: app.secrets!.owner, surface: "phone" });
  expect(upcoming.status).toBe(200);
  expect(upcoming.text).toContain("Lakeside Grand Prix");
  expect(upcoming.text).not.toContain("no results");
  expect(upcoming.text).not.toContain("Alex");
  const html = await call(app, "/api/display/today.html", { key: app.secrets!.owner, surface: "phone" });
  expect(html.status).toBe(200);
  expect(html.text).toContain("Nothing public is due.");
  expect(html.text).not.toContain("Alex");
  for (const word of forbidden.filter((item) => item !== "Alex")) {
    expect(html.text.includes(word), word).toBe(false);
  }
  const display = await call(app, "/api/display", { key: app.secrets!.display });
  expect(display.status).toBe(200);
  const payload = display.json as { image_url: string; refresh_rate: number };
  expect(payload.refresh_rate).toBe(3600);
  expect(payload.image_url).toContain("/api/display/today.png");
  const pngResponse = await app.fetch(
    new Request("https://hmn.local/api/display/today.png", { headers: { authorization: `Bearer ${app.secrets!.display}` } }),
    "127.0.0.1",
  );
  expect(pngResponse.status).toBe(200);
  expect(pngResponse.headers.get("content-type")).toBe("image/png");
  const bytes = Buffer.from(await pngResponse.arrayBuffer());
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const latin = bytes.toString("latin1");
  for (const word of ["Yves", "Luca", "passport", "dentist", "clinic", "Alex"]) {
    expect(latin.includes(word), word).toBe(false);
  }
});

test("default surface is personal, not private", async () => {
  const response = await call(app, "/api/v1/screens/today", { key: app.secrets!.owner });
  expect(response.text).not.toContain("Luca");
  expect(response.text).not.toContain("Yves");
  expect(response.text).toContain("Send weekly notes");
});

test("search and get do not leak above the ceiling", async () => {
  const agentYves = await call(app, "/api/v1/search?q=Yves", { key: app.secrets!.agent, surface: "mcp" });
  expect(agentYves.status).toBe(200);
  expect((agentYves.json as { results: unknown[] }).results).toEqual([]);
  expect(agentYves.text).not.toContain("Yves");
  const missing = await call(app, "/api/v1/person/person_yves", { key: app.secrets!.agent, surface: "mcp" });
  expect(missing.status).toBe(404);
  expect(missing.text).not.toContain("Yves");
  const note = await call(app, "/api/v1/note/note_trip", { key: app.secrets!.owner, surface: "phone" });
  expect(note.status).toBe(404);
  expect(note.text).not.toContain("passport");
  const clinic = await call(app, "/api/v1/note/note_health", { key: app.secrets!.agent, surface: "mcp" });
  expect(clinic.status).toBe(404);
  const race = await call(app, "/api/v1/search?q=Grand%20Prix", { key: app.secrets!.agent, surface: "mcp" });
  expect(race.text).toContain("Lakeside Grand Prix");
});

test("a sealed proposal is a placeholder until the vault opens", async () => {
  const listed = await call(app, "/api/v1/proposals", { key: app.secrets!.owner, surface: "phone" });
  expect(listed.text).toContain("sealed");
  expect(listed.text).not.toContain("Renew");
  expect(listed.text).not.toContain("passport");
  expect(listed.text).not.toContain("Yves");
  const agent = await call(app, "/api/v1/proposals", { key: app.secrets!.agent, surface: "mcp" });
  expect(agent.text).not.toContain("Renew");
  expect(agent.text).not.toContain("passport");
});

test("the database file and sealed columns do not hold plaintext secrets", () => {
  const enc = readFileSync(app.store.encPath);
  expect(enc.subarray(0, 16).toString("utf8")).not.toContain("SQLite format 3");
  expect(enc.toString("utf8")).not.toContain("expires 02/2027");
  expect(enc.toString("utf8")).not.toContain("Example clinic");
  expect(enc.toString("utf8")).not.toContain("Renew Yves");
  const plain = app.store.plainBytes().toString("utf8");
  expect(plain.startsWith("SQLite format 3")).toBe(true);
  expect(plain).toContain("Yves");
  expect(plain).not.toContain("expires 02/2027");
  expect(plain).not.toContain("Example clinic");
  expect(plain).not.toContain("Renew Yves");
  expect(() => decryptFile(Buffer.alloc(32), enc)).toThrow();
});
