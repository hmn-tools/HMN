import { afterAll, beforeAll, expect, test } from "bun:test";
import { call, testApp } from "./helpers";
import type { App } from "../src/app";
import { scheduleWords, whenWords, words } from "../src/garden";

let app: App;
beforeAll(() => {
  app = testApp();
});
afterAll(() => app.close());

test("the pages show stored values as words", () => {
  expect(words("morning_brief")).toBe("Morning brief");
  expect(whenWords("2026-11-13T14:05:00.000Z", "Never", new Date("2026-11-27T00:00:00Z"))).toBe("13 Nov, 14:05 UTC");
  expect(whenWords("2025-02-03T09:00:00.000Z", "Never", new Date("2026-11-27T00:00:00Z"))).toBe("3 Feb 2025, 09:00 UTC");
  expect(whenWords(null)).toBe("Never");
  expect(whenWords("nonsense", "Not yet")).toBe("Not yet");
  expect(scheduleWords("weekly:0:18:00")).toBe("Every Sunday at 18:00");
  expect(scheduleWords("daily:07:00")).toBe("Every day at 07:00");
});

test("a browse page names its type and does not show a screen rotation", async () => {
  const page = await call(app, "/api/v1/browse/person.html", { key: app.secrets!.owner, surface: "phone" });
  expect(page.text).toContain("<h1>People</h1>");
  expect(page.text).not.toContain("<h1>person</h1>");
  expect(page.text).not.toContain("→ next");
  expect(page.text).not.toContain("<nav>");
  expect(page.text).toContain("max-width:390px");
});

test("the connected page has no form that its own policy would block", async () => {
  const page = await call(app, "/api/v1/access.html", { key: app.secrets!.owner, surface: "phone" });
  expect(page.status).toBe(200);
  expect(page.text).not.toContain("<form");
  expect(page.text).not.toMatch(/20\d\d-\d\d-\d\dT/);
});

test("the root page is a Garden page", async () => {
  const page = await call(app, "/", {});
  expect(page.text).toContain("prefers-color-scheme:dark");
  expect(page.text).toContain("private server");
});
